/**
 * HTTP client for /api/v1 (KTD14, KTD15, KTD16).
 *
 * Origin comes from HTMLDOC_API_URL (https anywhere; http only on loopback
 * hosts) or the production default. Every request carries the bearer key,
 * Accept, User-Agent, and a timeout. Failures become one-line CliErrors.
 */
import pkg from '../package.json' with { type: 'json' };

import { CliError, PACKAGE_NAME } from './output.js';

export const VERSION = pkg.version;
export const DEFAULT_ORIGIN = 'https://htmldoc.space';
export const DEFAULT_TIMEOUT_MS = 60_000;
export const API_PREFIX = '/api/v1';

export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = 512 * 1024;
export const TOO_LARGE = 'file is too large: HTML files up to 2 MB, Markdown files up to 512 KB';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopback(hostname) {
  return LOOPBACK.has(hostname) || hostname.endsWith('.localhost');
}

/** @returns {{ origin: string, overridden: boolean }} */
export function resolveOrigin(env = process.env) {
  const raw = typeof env.HTMLDOC_API_URL === 'string' ? env.HTMLDOC_API_URL.trim() : '';
  if (raw === '') return { origin: DEFAULT_ORIGIN, overridden: false };

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`invalid API URL ${raw}: HTMLDOC_API_URL must be an origin such as https://htmldoc.space`);
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
  if (!secure) {
    throw new CliError(`insecure API URL ${raw}: use https://, or http:// only for localhost`);
  }
  const bare = url.pathname === '/' || url.pathname === '';
  if (!bare || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new CliError(`invalid API URL ${raw}: HTMLDOC_API_URL must be an origin with no path, query, or credentials`);
  }
  return { origin: url.origin, overridden: true };
}

export function dashboardUrl(origin) {
  return `${origin}/dashboard`;
}

function looksLikeSizeError(message) {
  return /\b(too large|greater than|exceeds?|size|kilobytes?|kb|mb)\b/i.test(message);
}

function fetchFailureReason(error) {
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return null;
  const cause = error && error.cause;
  if (cause && typeof cause.code === 'string' && cause.code !== '') return cause.code;
  if (cause && typeof cause.message === 'string' && cause.message !== '') return cause.message;
  return (error && error.message) || String(error);
}

export class ApiClient {
  constructor({ origin, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl }) {
    this.origin = origin;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(method, route, { body } = {}) {
    const url = `${this.origin}${API_PREFIX}${route}`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `${PACKAGE_NAME}/${VERSION}`,
    };
    // Resolve fetch at call time so tests can mock globalThis.fetch.
    const doFetch = this.fetchImpl || globalThis.fetch;

    let response;
    try {
      response = await doFetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const reason = fetchFailureReason(error) ?? `timed out after ${this.timeoutMs / 1000}s`;
      throw new CliError(`could not reach ${this.origin}: ${reason}`);
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      const reason = fetchFailureReason(error) ?? `timed out after ${this.timeoutMs / 1000}s`;
      throw new CliError(`could not reach ${this.origin}: ${reason}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (response.ok) {
      if (!json || typeof json !== 'object') throw new CliError(`server returned HTTP ${response.status} with an unreadable body`);
      return json;
    }

    const serverLine = json && typeof json.error === 'string' && json.error.trim() !== '' ? json.error.trim().split('\n')[0] : null;
    const status = response.status;

    if (status === 413 || (status === 422 && serverLine && looksLikeSizeError(serverLine))) {
      throw new CliError(TOO_LARGE, { status });
    }
    if (serverLine === null) {
      throw new CliError(`server returned HTTP ${status}`, { status });
    }
    if (status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      const hint = Number.isFinite(retryAfter) && retryAfter > 0 ? `retry after ${retryAfter} seconds` : 'try again later';
      // The server's 429 line already carries the retry-after wording; only add ours when it does not.
      const alreadyHinted = /retry after|try again/i.test(serverLine);
      throw new CliError(alreadyHinted ? serverLine : `${serverLine} (${hint})`, { status });
    }
    throw new CliError(serverLine, { status });
  }

  me() {
    return this.request('GET', '/me');
  }

  listPages() {
    return this.request('GET', '/pages');
  }

  createPage(file) {
    return this.request('POST', '/pages', { body: multipart(file) });
  }

  updatePage(id, file) {
    return this.request('POST', `/pages/${encodeURIComponent(id)}`, { body: multipart(file) });
  }

  deletePage(id) {
    return this.request('DELETE', `/pages/${encodeURIComponent(id)}`);
  }
}

function multipart({ bytes, filename, kind }) {
  const form = new FormData();
  const type = kind === 'html' ? 'text/html' : 'text/markdown';
  form.append('file', new File([bytes], filename, { type }));
  return form;
}

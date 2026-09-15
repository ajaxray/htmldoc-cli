/**
 * HTTP client for /api/v1 (KTD14, KTD15, KTD16).
 *
 * Origin comes from HTMLDOC_API_URL (https anywhere; http only on loopback
 * hosts) or the production default. Every request carries Accept, User-Agent,
 * and a timeout; all but the pairing calls carry the bearer key. Failures
 * become one-line CliErrors.
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

/** Positive integer seconds from Retry-After, else undefined. */
function retryAfterSeconds(response) {
  const value = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
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

  /**
   * Send one request and parse the body. Returns { response, json, serverLine }
   * without judging the status; `request()` and the pairing calls decide.
   */
  async send(method, route, { body, auth = true, contentType } = {}) {
    const url = `${this.origin}${API_PREFIX}${route}`;
    const headers = {
      Accept: 'application/json',
      'User-Agent': `${PACKAGE_NAME}/${VERSION}`,
    };
    if (auth) headers.Authorization = `Bearer ${this.apiKey}`;
    if (contentType) headers['Content-Type'] = contentType;
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
    const serverLine = json && typeof json.error === 'string' && json.error.trim() !== '' ? json.error.trim().split('\n')[0] : null;
    return { response, json, serverLine };
  }

  /** Turn a non-2xx response into the one-line CliError the commands print. */
  failure({ response, serverLine }) {
    const status = response.status;

    if (status === 413 || (status === 422 && serverLine && looksLikeSizeError(serverLine))) {
      return new CliError(TOO_LARGE, { status });
    }
    if (serverLine === null) {
      return new CliError(`server returned HTTP ${status}`, { status });
    }
    if (status === 429) {
      const retryAfter = retryAfterSeconds(response);
      const hint = retryAfter !== undefined ? `retry after ${retryAfter} seconds` : 'try again later';
      // The server's 429 line already carries the retry-after wording; only add ours when it does not.
      const alreadyHinted = /retry after|try again/i.test(serverLine);
      return new CliError(alreadyHinted ? serverLine : `${serverLine} (${hint})`, { status });
    }
    return new CliError(serverLine, { status });
  }

  async request(method, route, options = {}) {
    const result = await this.send(method, route, options);
    const { response, json } = result;
    if (response.ok) {
      if (!json || typeof json !== 'object') throw new CliError(`server returned HTTP ${response.status} with an unreadable body`);
      return json;
    }
    throw this.failure(result);
  }

  /** Start a handoff (KTD5): { user_code, device_secret, expires_in, interval }. No bearer header. */
  pair() {
    return this.request('POST', '/pair', { auth: false });
  }

  /**
   * Poll a handoff with the device secret. Never throws for the four expected
   * outcomes; the secret is never placed in any message.
   * @returns {Promise<
   *   | { status: 'pending' }
   *   | { status: 'ok', apiKey: string, githubLogin: string|undefined }
   *   | { status: 'gone', reason: string|null }
   *   | { status: 'slow_down', reason: string|null, retryAfterSeconds: number|undefined }
   * >}
   */
  async pollPair(deviceSecret) {
    const result = await this.send('POST', '/pair/poll', {
      auth: false,
      contentType: 'application/json',
      body: JSON.stringify({ device_secret: deviceSecret }),
    });
    const { response, json, serverLine } = result;
    switch (response.status) {
      case 202:
        return { status: 'pending' };
      case 200: {
        const apiKey = json && typeof json.api_key === 'string' ? json.api_key.trim() : '';
        if (apiKey === '') throw new CliError('server approved the pairing but sent no API key');
        const githubLogin = json && typeof json.github_login === 'string' ? json.github_login : undefined;
        return { status: 'ok', apiKey, githubLogin };
      }
      case 410:
        return { status: 'gone', reason: serverLine };
      case 429:
        return { status: 'slow_down', reason: serverLine, retryAfterSeconds: retryAfterSeconds(response) };
      default:
        if (response.ok) throw new CliError(`server returned HTTP ${response.status} while polling the pairing`);
        throw this.failure(result);
    }
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

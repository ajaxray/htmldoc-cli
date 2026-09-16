/**
 * Command layer: login, upload, list, delete (KTD15, KTD16, KTD5).
 *
 * `main(argv, deps)` returns the exit code and never throws a CliError; the
 * bin maps anything else to one stderr line. `deps` exist so tests can inject
 * streams, env, cwd, the timeout, the hidden-input reader, the browser
 * opener, the poll sleep, the clock, and the platform.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ApiClient, MAX_HTML_BYTES, MAX_MARKDOWN_BYTES, TOO_LARGE, VERSION, dashboardUrl, resolveOrigin } from './api.js';
import { openUrl, openerFor } from './browser.js';
import { clearPairing, configDir, readConfig, readPairing, resolveApiKey, writeConfig, writePairing } from './config.js';
import { CliError, createIO, keyInstructions, PACKAGE_NAME } from './output.js';
import { forgetPage, lookupPage, readState, recordPage } from './state.js';

const RESERVED = new Set(['login', 'list', 'delete']);
const KINDS = { '.html': 'html', '.htm': 'html', '.md': 'markdown', '.markdown': 'markdown' };
const ID_PATTERN = /^[0-9A-Za-z]+$/;

/** A pairing user code: 12 base62 characters (KTD1). Only such a code is ever placed in a link. */
const USER_CODE_PATTERN = /^[0-9A-Za-z]{12}$/;
const MIN_INTERVAL_S = 1;
const MAX_INTERVAL_S = 60;
const DEFAULT_INTERVAL_S = 5;
const MAX_EXPIRES_IN_S = 15 * 60;
const DEFAULT_EXPIRES_IN_S = 10 * 60;
const BACKOFF_S = 5;
/** Consecutive unreachable/5xx polls tolerated before `--wait` gives up (the pairing stays saved to resume). */
const MAX_POLL_FAILURES = 5;

export const USAGE = [
  'Usage:',
  '  htmldoc <file> [--update <id|url>] [--json]   share an .html, .htm, .md, or .markdown file',
  '  htmldoc login [--no-browser]                  start signing in: prints an approval link and opens it',
  '  htmldoc login --wait [--timeout <seconds>]    wait for that approval, then store the key',
  '  htmldoc login --paste                         paste and store your API key (interactive terminal)',
  '  htmldoc list [--json]                         list your live pages',
  '  htmldoc delete <id|url>                       delete a page',
  '',
  'Environment:',
  '  HTMLDOC_API_KEY      use this key instead of the stored one',
  '  HTMLDOC_API_URL      API origin (default https://htmldoc.space)',
  '  HTMLDOC_NO_BROWSER   set to 1 to never open a browser on login',
].join('\n');

const loginHint = () => `run: npx ${PACKAGE_NAME} login`;

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const io = createIO({ stdout: deps.stdout, stderr: deps.stderr });
  const ctx = {
    env,
    io,
    stdin: deps.stdin ?? process.stdin,
    stderr: deps.stderr ?? process.stderr,
    cwd: deps.cwd ?? process.cwd(),
    timeoutMs: deps.timeoutMs,
    readSecret: deps.readSecret ?? readSecretFromTty,
    openUrl: deps.openUrl ?? openUrl,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => Date.now()),
    platform: deps.platform ?? process.platform,
    dir: configDir(env),
  };

  try {
    if (argv[0] === '--version' || argv[0] === '-v') {
      io.out(VERSION);
      return 0;
    }
    if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
      io.out(USAGE);
      return 0;
    }

    const { origin, overridden } = resolveOrigin(env);
    if (overridden) io.err(`using API at ${origin}`);
    ctx.origin = origin;

    const command = RESERVED.has(argv[0]) ? argv[0] : 'upload';
    const rest = command === 'upload' ? argv : argv.slice(1);
    switch (command) {
      case 'login':
        return await login(ctx, rest);
      case 'list':
        return await list(ctx, rest);
      case 'delete':
        return await remove(ctx, rest);
      default:
        return await upload(ctx, rest);
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      for (const hint of error.hints) io.err(hint);
      return 1;
    }
    throw error;
  }
}

function parse(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliError(`${error.message.split('\n')[0]}`, { hints: USAGE.split('\n') });
  }
}

async function client(ctx, apiKey) {
  return new ApiClient({ origin: ctx.origin, apiKey, timeoutMs: ctx.timeoutMs });
}

async function requireKey(ctx) {
  const config = await readConfig(ctx.dir);
  const apiKey = resolveApiKey(ctx.env, config);
  if (!apiKey) {
    throw new CliError('no API key configured.', { hints: keyInstructions(dashboardUrl(ctx.origin)) });
  }
  return apiKey;
}

function withKeyHints(ctx, error) {
  if (error instanceof CliError && error.status === 401 && error.hints.length === 0) {
    error.hints = keyInstructions(dashboardUrl(ctx.origin));
  }
  return error;
}

/** Bare id or a share URL whose last path segment is the id. */
export function parsePageRef(ref, flag) {
  let id = ref.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(id)) {
    try {
      const segments = new URL(id).pathname.split('/').filter((s) => s !== '');
      id = segments.pop() ?? '';
    } catch {
      id = '';
    }
  }
  if (id === '' || !ID_PATTERN.test(id)) {
    throw new CliError(`${flag} expects a page id or share URL, got: ${ref}`);
  }
  return id;
}

async function readUploadFile(ctx, fileArg) {
  const absolute = path.resolve(ctx.cwd, fileArg);
  const ext = path.extname(absolute).toLowerCase();
  const kind = KINDS[ext];
  if (!kind) {
    throw new CliError(`unsupported file type "${ext || path.basename(absolute)}": use .html, .htm, .md, or .markdown`);
  }

  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new CliError(`file not found: ${absolute}`);
    throw new CliError(`cannot read ${absolute}: ${error.code ?? error.message}`);
  }
  if (!info.isFile()) throw new CliError(`not a file: ${absolute}`);
  if (info.size === 0) throw new CliError(`file is empty: ${absolute}`);
  const cap = kind === 'html' ? MAX_HTML_BYTES : MAX_MARKDOWN_BYTES;
  if (info.size > cap) throw new CliError(TOO_LARGE);

  const bytes = await readFile(absolute);
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    throw new CliError('file is UTF-16 (byte-order mark found); save it as UTF-8');
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CliError('file is not valid UTF-8');
  }
  return { absolute, bytes, filename: path.basename(absolute), kind };
}

async function upload(ctx, args) {
  const { values, positionals } = parse(args, {
    update: { type: 'string' },
    json: { type: 'boolean', default: false },
  });
  if (positionals.length !== 1) {
    throw new CliError(positionals.length === 0 ? 'missing file to share' : `expected exactly one file, got ${positionals.length}`, {
      hints: USAGE.split('\n'),
    });
  }
  const updateId = values.update === undefined ? undefined : parsePageRef(values.update, '--update');

  const apiKey = await requireKey(ctx);
  const file = await readUploadFile(ctx, positionals[0]);

  if (updateId === undefined) {
    const previous = lookupPage(await readState(ctx.dir), file.absolute);
    if (previous) {
      ctx.io.err(`note: ${file.absolute} was shared before as ${previous.url}; to update that page instead run: npx ${PACKAGE_NAME} ${positionals[0]} --update ${previous.id}`);
    }
  }

  const api = await client(ctx, apiKey);
  let page;
  try {
    page = updateId === undefined ? await api.createPage(file) : await api.updatePage(updateId, file);
  } catch (error) {
    throw withKeyHints(ctx, error);
  }
  if (typeof page.url !== 'string' || typeof page.id !== 'string') {
    throw new CliError('server response is missing the page id or url');
  }

  try {
    await recordPage(ctx.dir, file.absolute, { id: page.id, url: page.url });
  } catch (error) {
    ctx.io.err(`warning: could not write ${path.join(ctx.dir, 'state.json')}: ${error.code ?? error.message}`);
  }

  if (values.json) {
    ctx.io.out(JSON.stringify({ id: page.id, url: page.url, expires_at: page.expires_at }));
  } else {
    ctx.io.out(page.url);
  }
  ctx.io.err(`id: ${page.id}  expires: ${page.expires_at}`);
  return 0;
}

async function list(ctx, args) {
  const { values, positionals } = parse(args, { json: { type: 'boolean', default: false } });
  if (positionals.length !== 0) throw new CliError(`list takes no arguments, got: ${positionals.join(' ')}`, { hints: USAGE.split('\n') });

  const apiKey = await requireKey(ctx);
  let payload;
  try {
    payload = await (await client(ctx, apiKey)).listPages();
  } catch (error) {
    throw withKeyHints(ctx, error);
  }
  const pages = Array.isArray(payload.pages) ? payload.pages : [];

  if (values.json) {
    ctx.io.out(JSON.stringify(payload));
    return 0;
  }
  if (pages.length === 0) {
    ctx.io.err('no pages');
    return 0;
  }
  ctx.io.out(table(pages));
  return 0;
}

function table(pages) {
  const columns = [
    ['ID', (p) => p.id],
    ['STATE', (p) => p.state],
    ['EXPIRES', (p) => p.expires_at],
    ['FILENAME', (p) => p.filename],
    ['URL', (p) => p.url],
  ];
  const rows = pages.map((p) => columns.map(([, pick]) => String(pick(p) ?? '')));
  const widths = columns.map(([name], i) => Math.max(name.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  return [line(columns.map(([name]) => name)), ...rows.map(line)].join('\n');
}

async function remove(ctx, args) {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1) throw new CliError('delete expects exactly one page id or share URL', { hints: USAGE.split('\n') });
  const id = parsePageRef(positionals[0], 'delete');

  const apiKey = await requireKey(ctx);
  let result;
  try {
    result = await (await client(ctx, apiKey)).deletePage(id);
  } catch (error) {
    throw withKeyHints(ctx, error);
  }
  try {
    await forgetPage(ctx.dir, id);
  } catch {
    // state is a cache; a stale entry only costs a hint next time
  }
  ctx.io.err(`deleted ${result.url ?? id}`);
  return 0;
}

async function login(ctx, args) {
  const { values, positionals } = parse(args, {
    paste: { type: 'boolean', default: false },
    wait: { type: 'boolean', default: false },
    timeout: { type: 'string' },
    'no-browser': { type: 'boolean', default: false },
  });
  if (positionals.length !== 0) throw new CliError('login takes no arguments; the key is never passed on the command line', { hints: USAGE.split('\n') });
  if (values.paste && values.wait) throw new CliError('login takes --paste or --wait, not both', { hints: USAGE.split('\n') });
  if (values.timeout !== undefined && !values.wait) throw new CliError('--timeout only applies to login --wait', { hints: USAGE.split('\n') });

  if (values.paste) return loginPaste(ctx);
  if (values.wait) return loginWait(ctx, values.timeout);
  return loginStart(ctx, { noBrowser: values['no-browser'] });
}

function clampNumber(value, { min, max, fallback }) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Phase one (KTD5): create the pairing, print the link and code, try the
 * browser, save pairing.json, exit 0. Never blocks on approval.
 */
async function loginStart(ctx, { noBrowser }) {
  const api = await client(ctx, undefined);
  const pairing = await api.pair();

  const userCode = typeof pairing.user_code === 'string' ? pairing.user_code : '';
  if (!USER_CODE_PATTERN.test(userCode)) throw new CliError('server sent an invalid pairing code; try again in a moment');
  const deviceSecret = typeof pairing.device_secret === 'string' ? pairing.device_secret.trim() : '';
  if (deviceSecret === '') throw new CliError('server sent no pairing secret; try again in a moment');

  const intervalSeconds = clampNumber(pairing.interval, { min: MIN_INTERVAL_S, max: MAX_INTERVAL_S, fallback: DEFAULT_INTERVAL_S });
  const expiresIn = clampNumber(pairing.expires_in, { min: 1, max: MAX_EXPIRES_IN_S, fallback: DEFAULT_EXPIRES_IN_S });
  const expiresAt = new Date(ctx.now() + expiresIn * 1000).toISOString();

  // The link is built here from the origin and the validated code; any URL the server sends is ignored.
  const link = `${ctx.origin}/connect/${userCode}`;

  await writePairing(ctx.dir, { deviceSecret, userCode, expiresAt, intervalSeconds, origin: ctx.origin });

  const host = new URL(ctx.origin).host;
  ctx.io.err(`${host} needs an account signed in with GitHub, so we're sending you there.`);
  ctx.io.err(`Open this link to approve: ${link}`);
  ctx.io.err(`Code: ${userCode}`);

  const skipBrowser = noBrowser || ctx.env.HTMLDOC_NO_BROWSER === '1';
  if (!skipBrowser && openerFor(ctx.platform, ctx.env)) {
    ctx.io.err('Opening your browser…');
    let opened = false;
    try {
      opened = ctx.openUrl(link, { platform: ctx.platform, env: ctx.env }) === true;
    } catch {
      opened = false;
    }
    if (!opened) ctx.io.err('Could not open a browser; open the link above yourself.');
  }
  ctx.io.err(`After approving, run: npx ${PACKAGE_NAME} login --wait`);
  return 0;
}

function parseTimeoutSeconds(raw) {
  if (raw === undefined) return undefined;
  const seconds = /^\d+$/.test(raw.trim()) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new CliError(`--timeout expects a positive number of seconds, got: ${raw}`);
  return seconds;
}

function goneMessage(reason) {
  switch (reason) {
    case 'denied':
      return 'the approval was denied.';
    case 'expired':
      return 'the pairing code expired before it was approved.';
    case 'used':
      return 'this approval was already consumed, possibly by a poll whose reply was lost; run login again.';
    default:
      return reason ? `pairing ended: ${reason}` : 'pairing ended before it was approved.';
  }
}

/**
 * Phase two (KTD5): poll with the saved device secret until the key arrives,
 * the server says the pairing is gone, or the deadline passes. The secret is
 * never placed in a message.
 */
async function loginWait(ctx, timeoutArg) {
  const timeoutSeconds = parseTimeoutSeconds(timeoutArg);

  const pairing = await readPairing(ctx.dir);
  const deviceSecret = pairing && typeof pairing.deviceSecret === 'string' ? pairing.deviceSecret : '';
  const expiresAtMs = pairing ? Date.parse(pairing.expiresAt) : Number.NaN;
  if (!pairing || deviceSecret === '' || Number.isNaN(expiresAtMs)) {
    if (pairing) await clearPairing(ctx.dir);
    throw new CliError('no sign-in is waiting for approval.', { hints: [loginHint()] });
  }
  if (typeof pairing.origin === 'string' && pairing.origin !== ctx.origin) {
    throw new CliError(`the pending sign-in is for ${pairing.origin}, not ${ctx.origin}.`, { hints: [`${loginHint()} again against this origin`] });
  }
  const userCode = typeof pairing.userCode === 'string' ? pairing.userCode : '';
  const intervalSeconds = clampNumber(pairing.intervalSeconds, { min: MIN_INTERVAL_S, max: MAX_INTERVAL_S, fallback: DEFAULT_INTERVAL_S });

  const start = ctx.now();
  const deadline = timeoutSeconds === undefined ? expiresAtMs : Math.min(expiresAtMs, start + timeoutSeconds * 1000);
  const budget = Math.max(0, Math.round((deadline - start) / 1000));
  ctx.io.err(`Waiting for approval${userCode ? ` of code ${userCode}` : ''} (up to ${budget}s)…`);

  try {
    return await pollUntilDone(ctx, { deviceSecret, intervalSeconds, deadline });
  } catch (error) {
    // redact() cannot recognise the device secret; make sure no server line that echoes it reaches stderr.
    if (error instanceof CliError) {
      error.message = scrub(error.message, deviceSecret);
      error.hints = error.hints.map((hint) => scrub(hint, deviceSecret));
    }
    throw error;
  }
}

function scrub(text, secret) {
  return secret === '' ? text : String(text).split(secret).join('[redacted]');
}

/** A poll failure the wait rides out: the server is unreachable, timed out, or answered 5xx. */
function isTransientPollError(error) {
  if (!(error instanceof CliError)) return false;
  return error.status === undefined ? error.message.startsWith('could not reach ') : error.status >= 500;
}

async function pollUntilDone(ctx, { deviceSecret, intervalSeconds: initialInterval, deadline }) {
  let intervalSeconds = initialInterval;
  let failures = 0;
  const api = await client(ctx, undefined);
  for (;;) {
    let result;
    try {
      result = await api.pollPair(deviceSecret);
      failures = 0;
    } catch (error) {
      // One dropped poll must not end a ten-minute wait; the pairing stays saved so a rerun resumes it.
      failures += 1;
      if (!isTransientPollError(error) || failures >= MAX_POLL_FAILURES) {
        if (error instanceof CliError && error.hints.length === 0) error.hints = [`to resume this sign-in, run: npx ${PACKAGE_NAME} login --wait`];
        throw error;
      }
      ctx.io.err(`${scrub(error.message, deviceSecret)}; retrying in ${intervalSeconds}s…`);
      result = { status: 'retry' };
    }

    if (result.status === 'ok') {
      await writeConfig(ctx.dir, { apiKey: result.apiKey });
      await clearPairing(ctx.dir);
      let me;
      try {
        me = await (await client(ctx, result.apiKey)).me();
      } catch (error) {
        throw withKeyHints(ctx, error);
      }
      ctx.io.err(`Logged in as @${me.github_login}`);
      ctx.io.err(`Dashboard: ${dashboardUrl(ctx.origin)}`);
      return 0;
    }
    if (result.status === 'gone') {
      await clearPairing(ctx.dir);
      throw new CliError(goneMessage(result.reason), { hints: [loginHint()] });
    }

    let delaySeconds = intervalSeconds;
    if (result.status === 'slow_down') {
      // Any 429 is a back-off, never a failure. A server-side slow_down raises the interval for good.
      const serverSlowDown = result.reason === 'slow_down';
      if (serverSlowDown) intervalSeconds = Math.min(MAX_INTERVAL_S, intervalSeconds + BACKOFF_S);
      delaySeconds = result.retryAfterSeconds ?? (serverSlowDown ? intervalSeconds : intervalSeconds + BACKOFF_S);
    }

    const remainingMs = deadline - ctx.now();
    if (remainingMs <= 0) {
      await clearPairing(ctx.dir);
      throw new CliError('timed out waiting for approval.', { hints: [loginHint()] });
    }
    await ctx.sleep(Math.min(delaySeconds * 1000, remainingMs));
  }
}

/** Today's paste flow (R17): hidden input on an interactive terminal. */
async function loginPaste(ctx) {
  const dashboard = dashboardUrl(ctx.origin);
  if (!ctx.stdin.isTTY) {
    throw new CliError('login needs an interactive terminal to paste the key (stdin is not a TTY).', {
      hints: keyInstructions(dashboard),
    });
  }

  ctx.io.err(`Get your key at ${dashboard}`);
  ctx.stderr.write('Paste your API key (input is hidden): ');
  const apiKey = (await ctx.readSecret(ctx.stdin, ctx.stderr)).trim();
  if (apiKey === '') throw new CliError('no key entered');

  let me;
  try {
    me = await (await client(ctx, apiKey)).me();
  } catch (error) {
    throw withKeyHints(ctx, error);
  }
  await writeConfig(ctx.dir, { apiKey });
  ctx.io.err(`Logged in as @${me.github_login}`);
  return 0;
}

/** Read one line from a TTY without echoing it. Exported for tests. */
export function readSecretFromTty(stdin, stderr) {
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const finish = (fn) => {
      stdin.off('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stderr.write('\n');
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(value));
        if (ch === '\u0003' || ch === '\u0004') return finish(() => reject(new CliError('login cancelled')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
      return undefined;
    };
    stdin.on('data', onData);
  });
}

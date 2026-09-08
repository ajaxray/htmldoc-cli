/**
 * Command layer: login, upload, list, delete (KTD15, KTD16).
 *
 * `main(argv, deps)` returns the exit code and never throws a CliError; the
 * bin maps anything else to one stderr line. `deps` exist so tests can inject
 * streams, env, cwd, the timeout, and the hidden-input reader.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ApiClient, MAX_HTML_BYTES, MAX_MARKDOWN_BYTES, TOO_LARGE, VERSION, dashboardUrl, resolveOrigin } from './api.js';
import { configDir, readConfig, resolveApiKey, writeConfig } from './config.js';
import { CliError, createIO, keyInstructions, PACKAGE_NAME } from './output.js';
import { forgetPage, lookupPage, readState, recordPage } from './state.js';

const RESERVED = new Set(['login', 'list', 'delete']);
const KINDS = { '.html': 'html', '.htm': 'html', '.md': 'markdown', '.markdown': 'markdown' };
const ID_PATTERN = /^[0-9A-Za-z]+$/;

export const USAGE = [
  'Usage:',
  '  htmldoc <file> [--update <id|url>] [--json]   share an .html, .htm, .md, or .markdown file',
  '  htmldoc login                                 paste and store your API key',
  '  htmldoc list [--json]                         list your live pages',
  '  htmldoc delete <id|url>                       delete a page',
  '',
  'Environment:',
  '  HTMLDOC_API_KEY   use this key instead of the stored one',
  '  HTMLDOC_API_URL   API origin (default https://htmldoc.space)',
].join('\n');

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
  const { positionals } = parse(args, {});
  if (positionals.length !== 0) throw new CliError('login takes no arguments; the key is pasted, never passed', { hints: USAGE.split('\n') });

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

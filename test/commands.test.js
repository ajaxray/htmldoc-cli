import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { readSecretFromTty } from '../src/commands.js';
import { run, runBin, tempDir, jsonResponse, PAGE } from './helpers.js';
import { writeConfig } from '../src/config.js';
import { readState } from '../src/state.js';

const KEY = 'hd_' + 'k'.repeat(40);
const DASHBOARD = 'https://htmldoc.space/dashboard';
const LOGIN_CMD = 'npx htmldoc-cli login';

let xdg;
let cfgDir;
let work;
let env;

beforeEach(async () => {
  xdg = await tempDir();
  work = await tempDir();
  cfgDir = path.join(xdg, 'htmldoc');
  env = { XDG_CONFIG_HOME: xdg, HTMLDOC_API_KEY: KEY };
  await writeFile(path.join(work, 'plan.md'), '# Plan\n\nhello\n');
  await writeFile(path.join(work, 'page.html'), '<h1>hi</h1>\n');
});

afterEach(async () => {
  mock.restoreAll();
  await rm(xdg, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

function mockFetch(handler) {
  mock.restoreAll(); // stacking mocks on a mocked fetch breaks restoreAll ordering
  return mock.method(globalThis, 'fetch', async (url, init) => handler(String(url), init));
}

function assertNoKey(result) {
  assert.ok(!result.stdout.includes('hd_'), 'stdout leaks key');
  assert.ok(!result.stderr.includes('hd_'), 'stderr leaks key');
}

describe('key resolution', () => {
  it('exits 1 with the dashboard URL and login command when no key is configured', async () => {
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['plan.md'], { env: { XDG_CONFIG_HOME: xdg }, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(DASHBOARD), r.stderr);
    assert.ok(r.stderr.includes(LOGIN_CMD), r.stderr);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('prefers HTMLDOC_API_KEY over config.json', async () => {
    await writeConfig(cfgDir, { apiKey: 'hd_' + 'f'.repeat(40) });
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 0);
    assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, `Bearer ${KEY}`);
  });

  it('falls back to the stored key', async () => {
    const stored = 'hd_' + 'f'.repeat(40);
    await writeConfig(cfgDir, { apiKey: stored });
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['plan.md'], { env: { XDG_CONFIG_HOME: xdg }, cwd: work });
    assert.equal(r.code, 0);
    assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, `Bearer ${stored}`);
  });
});

describe('upload', () => {
  it('prints exactly the URL on stdout and id plus expiry on stderr', async () => {
    mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${PAGE.url}\n`);
    assert.ok(r.stderr.includes(PAGE.id));
    assert.ok(r.stderr.includes(PAGE.expires_at));
    assertNoKey(r);
  });

  it('prints {id, url, expires_at} only with --json', async () => {
    mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['plan.md', '--json'], { env, cwd: work });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { id: PAGE.id, url: PAGE.url, expires_at: PAGE.expires_at });
    assert.equal(r.stdout.trim().split('\n').length, 1);
  });

  it('accepts an absolute path and sends the basename as the multipart filename', async () => {
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const r = await run([path.join(work, 'page.html')], { env, cwd: '/' });
    assert.equal(r.code, 0);
    const file = fetch.mock.calls[0].arguments[1].body.get('file');
    assert.equal(file.name, 'page.html');
    assert.equal(file.type, 'text/html');
  });

  it('records the absolute path in state.json without touching config.json', async () => {
    await writeConfig(cfgDir, { apiKey: 'hd_' + 'f'.repeat(40) });
    const before = await readFile(path.join(cfgDir, 'config.json'), 'utf8');
    mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 0);
    const state = await readState(cfgDir);
    assert.deepEqual(state.pages[path.join(work, 'plan.md')], { id: PAGE.id, url: PAGE.url });
    assert.equal(await readFile(path.join(cfgDir, 'config.json'), 'utf8'), before);
    assert.deepEqual((await readdir(cfgDir)).sort(), ['config.json', 'state.json']);
  });

  it('hints on stderr when the path was shared before, then creates a new page', async () => {
    const fetch = mockFetch(() => jsonResponse(201, { ...PAGE, id: 'new123456789', url: 'https://p.htmldoc.space/new123456789' }));
    let r = await run(['plan.md'], { env, cwd: work });
    r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'https://p.htmldoc.space/new123456789\n');
    assert.ok(r.stderr.includes('--update new123456789'), r.stderr);
    assert.ok(r.stderr.includes('https://p.htmldoc.space/new123456789'), r.stderr);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(String(fetch.mock.calls[1].arguments[0]), 'https://htmldoc.space/api/v1/pages');
    const files = await readdir(cfgDir);
    assert.deepEqual(files, ['state.json'], 'atomic rewrite leaves no temp file');
  });

  it('does not hint when --update is given', async () => {
    mockFetch(() => jsonResponse(201, PAGE));
    await run(['plan.md'], { env, cwd: work });
    const r = await run(['plan.md', '--update', PAGE.id], { env, cwd: work });
    assert.equal(r.code, 0);
    assert.ok(!r.stderr.includes('shared before'));
  });

  it('treats --update <id> and --update <url> identically and POSTs to /pages/<id>', async () => {
    const fetch = mockFetch(() => jsonResponse(200, PAGE));
    for (const ref of ['abc123def456', 'https://p.htmldoc.space/abc123def456', 'https://p.htmldoc.space/abc123def456/']) {
      const r = await run(['plan.md', '--update', ref], { env, cwd: work });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `${PAGE.url}\n`);
    }
    assert.equal(fetch.mock.callCount(), 3);
    for (const call of fetch.mock.calls) {
      assert.equal(String(call.arguments[0]), 'https://htmldoc.space/api/v1/pages/abc123def456');
      assert.equal(call.arguments[1].method, 'POST');
    }
  });

  it('rejects an --update reference that is not an id', async () => {
    const fetch = mockFetch(() => jsonResponse(200, PAGE));
    const r = await run(['plan.md', '--update', '../pages'], { env, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('relays a 410 on update as the server line', async () => {
    mockFetch(() => jsonResponse(410, { error: 'page abc123def456 was deleted' }));
    const r = await run(['plan.md', '--update', PAGE.id], { env, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.trim().split('\n').pop(), 'page abc123def456 was deleted');
  });

  it('warns but still succeeds when state.json cannot be written', async () => {
    // a directory at state.json makes the rename fail
    await mkdir(path.join(cfgDir, 'state.json'), { recursive: true });
    mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${PAGE.url}\n`);
    assert.ok(/state/.test(r.stderr));
  });
});

describe('upload pre-checks (no request is made)', () => {
  it('rejects a .txt file', async () => {
    await writeFile(path.join(work, 'notes.txt'), 'x');
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['notes.txt'], { env, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /\.txt/);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('rejects a 3 MB HTML file and a 600 KB Markdown file with the too-large line', async () => {
    await writeFile(path.join(work, 'big.html'), Buffer.alloc(3 * 1024 * 1024, 0x61));
    await writeFile(path.join(work, 'big.md'), Buffer.alloc(600 * 1024, 0x61));
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const a = await run(['big.html'], { env, cwd: work });
    const b = await run(['big.md'], { env, cwd: work });
    assert.equal(a.code, 1);
    assert.equal(b.code, 1);
    assert.equal(a.stderr, b.stderr);
    assert.match(a.stderr, /too large/);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('accepts files exactly at the caps', async () => {
    await writeFile(path.join(work, 'max.html'), Buffer.alloc(2 * 1024 * 1024, 0x61));
    await writeFile(path.join(work, 'max.md'), Buffer.alloc(512 * 1024, 0x61));
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    assert.equal((await run(['max.html'], { env, cwd: work })).code, 0);
    assert.equal((await run(['max.md'], { env, cwd: work })).code, 0);
    assert.equal(fetch.mock.callCount(), 2);
  });

  it('rejects invalid UTF-8 and a UTF-16 BOM', async () => {
    await writeFile(path.join(work, 'bad.html'), Buffer.from([0x3c, 0x68, 0xff, 0xfe, 0x3e]));
    await writeFile(path.join(work, 'u16.md'), Buffer.from([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00]));
    await writeFile(path.join(work, 'u16be.md'), Buffer.from([0xfe, 0xff, 0x00, 0x23]));
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const a = await run(['bad.html'], { env, cwd: work });
    const b = await run(['u16.md'], { env, cwd: work });
    const c = await run(['u16be.md'], { env, cwd: work });
    assert.equal(a.code, 1);
    assert.match(a.stderr, /UTF-8/);
    assert.equal(b.code, 1);
    assert.match(b.stderr, /UTF-16/);
    assert.equal(c.code, 1);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('accepts a UTF-8 BOM', async () => {
    await writeFile(path.join(work, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# ok')]));
    mockFetch(() => jsonResponse(201, PAGE));
    assert.equal((await run(['bom.md'], { env, cwd: work })).code, 0);
  });

  it('rejects an empty file, a missing file, and a directory', async () => {
    await writeFile(path.join(work, 'empty.md'), '');
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    assert.equal((await run(['empty.md'], { env, cwd: work })).code, 1);
    const missing = await run(['nope.md'], { env, cwd: work });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not found/);
    await mkdir(path.join(work, 'dir.md'));
    assert.equal((await run(['dir.md'], { env, cwd: work })).code, 1);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('requires exactly one positional', async () => {
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const none = await run([], { env, cwd: work });
    const two = await run(['plan.md', 'page.html'], { env, cwd: work });
    assert.equal(none.code, 1);
    assert.equal(two.code, 1);
    assert.equal(none.stdout, '');
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('exits 1 on an unknown flag such as --key and never echoes hd_', async () => {
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['--key', 'hd_x', 'plan.md'], { env, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /--key/);
    assertNoKey(r);
    assert.equal(fetch.mock.callCount(), 0);
    const list = await run(['list', '--bogus'], { env, cwd: work });
    assert.equal(list.code, 1);
    assert.equal(fetch.mock.callCount(), 0);
  });
});

describe('server errors', () => {
  it('401 prints the server line and where to get a key', async () => {
    mockFetch(() => jsonResponse(401, { error: 'invalid or revoked API key' }));
    const r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('invalid or revoked API key'));
    assert.ok(r.stderr.includes(DASHBOARD));
    assertNoKey(r);
  });

  it('429 prints the retry hint', async () => {
    mockFetch(() => jsonResponse(429, { error: 'Too Many Attempts.' }, { 'Retry-After': '30' }));
    const r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /retry after 30 seconds/);
  });

  it('413 and a size 422 print the same too-large line', async () => {
    mockFetch(() => new Response('<html><body>413 Request Entity Too Large</body></html>', { status: 413 }));
    const a = await run(['plan.md'], { env, cwd: work });
    mockFetch(() => jsonResponse(422, { error: 'The file must not be greater than 2048 kilobytes.' }));
    const b = await run(['plan.md'], { env, cwd: work });
    assert.equal(a.code, 1);
    assert.equal(b.code, 1);
    assert.equal(a.stderr, b.stderr);
    assert.match(a.stderr, /too large/);
  });

  it('HTML 502 body gives one line and no stack trace', async () => {
    mockFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'server returned HTTP 502\n');
  });

  it('a 2xx without a JSON body is an error, not a crash', async () => {
    mockFetch(() => new Response('ok', { status: 200 }));
    const r = await run(['plan.md'], { env, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.ok(!/\n\s+at /.test(r.stderr));
  });

  it('a server that never responds exits 1 within the timeout', async () => {
    const server = createServer(() => {});
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await run(['plan.md'], { env: { ...env, HTMLDOC_API_URL: origin }, cwd: work, timeoutMs: 300 });
      assert.equal(r.code, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`could not reach ${origin.replaceAll('.', '\\.')}: timed out`));
    } finally {
      server.closeAllConnections();
      await new Promise((res) => server.close(res));
    }
  });
});

describe('HTMLDOC_API_URL guard', () => {
  it('refuses http://evil.example before any request', async () => {
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    const r = await run(['plan.md'], { env: { ...env, HTMLDOC_API_URL: 'http://evil.example' }, cwd: work });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /insecure API URL/);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('proceeds for http://localhost:8000 and https://api.example, naming the origin on stderr', async () => {
    const fetch = mockFetch(() => jsonResponse(201, PAGE));
    for (const origin of ['http://localhost:8000', 'https://api.example']) {
      const r = await run(['plan.md'], { env: { ...env, HTMLDOC_API_URL: origin }, cwd: work });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stderr.includes(`using API at ${origin}`), r.stderr);
      assert.equal(r.stdout, `${PAGE.url}\n`);
    }
    assert.equal(String(fetch.mock.calls[0].arguments[0]), 'http://localhost:8000/api/v1/pages');
    assert.equal(String(fetch.mock.calls[1].arguments[0]), 'https://api.example/api/v1/pages');
  });

  it('derives the dashboard URL from the override when no key is set', async () => {
    const r = await run(['plan.md'], { env: { XDG_CONFIG_HOME: xdg, HTMLDOC_API_URL: 'http://localhost:8000' }, cwd: work });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('http://localhost:8000/dashboard'));
  });

  it('names the origin on every command, including list and delete', async () => {
    mockFetch((url, init) => (init.method === 'DELETE' ? jsonResponse(200, { id: PAGE.id, url: PAGE.url, state: 'deleted' }) : jsonResponse(200, { pages: [] })));
    const e = { ...env, HTMLDOC_API_URL: 'https://api.example' };
    assert.ok((await run(['list'], { env: e })).stderr.includes('using API at https://api.example'));
    assert.ok((await run(['delete', PAGE.id], { env: e })).stderr.includes('using API at https://api.example'));
  });
});

describe('login', () => {
  it('exits 1 with instructions when stdin is not a TTY and never blocks', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { github_login: 'octo' }));
    const r = await run(['login'], { env: { XDG_CONFIG_HOME: xdg }, stdin: { isTTY: false } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(DASHBOARD));
    assert.ok(r.stderr.includes(LOGIN_CMD));
    assert.equal(fetch.mock.callCount(), 0);
    await assert.rejects(stat(path.join(cfgDir, 'config.json')));
  });

  it('stores nothing and exits 1 on a bad key', async () => {
    mockFetch(() => jsonResponse(401, { error: 'invalid API key' }));
    const r = await run(['login'], { env: { XDG_CONFIG_HOME: xdg }, stdin: { isTTY: true }, readSecret: async () => 'hd_bad' });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('invalid API key'));
    assertNoKey(r);
    await assert.rejects(stat(path.join(cfgDir, 'config.json')));
  });

  it('rejects an empty paste without a request', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { github_login: 'octo' }));
    const r = await run(['login'], { env: { XDG_CONFIG_HOME: xdg }, stdin: { isTTY: true }, readSecret: async () => '   ' });
    assert.equal(r.code, 1);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('validates via GET /me, creates the 0700 dir and 0600 config.json, and greets by login', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { github_login: 'octo', live_pages: 0, max_live_pages: 100 }));
    const r = await run(['login'], { env: { XDG_CONFIG_HOME: xdg }, stdin: { isTTY: true }, readSecret: async () => ` ${KEY}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('Logged in as @octo'));
    assertNoKey(r);
    assert.equal(String(fetch.mock.calls[0].arguments[0]), 'https://htmldoc.space/api/v1/me');
    assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, `Bearer ${KEY}`);
    assert.equal((await stat(cfgDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(cfgDir, 'config.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path.join(cfgDir, 'config.json'), 'utf8')), { apiKey: KEY });
  });

  it('ignores HTMLDOC_API_KEY and stores the pasted key', async () => {
    const pasted = 'hd_' + 'p'.repeat(40);
    const fetch = mockFetch(() => jsonResponse(200, { github_login: 'octo' }));
    const r = await run(['login'], { env, stdin: { isTTY: true }, readSecret: async () => pasted });
    assert.equal(r.code, 0);
    assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, `Bearer ${pasted}`);
    assert.deepEqual(JSON.parse(await readFile(path.join(cfgDir, 'config.json'), 'utf8')), { apiKey: pasted });
  });
});

describe('list and delete', () => {
  const pages = [
    { ...PAGE, state: 'active' },
    { id: 'zzz987654321', url: 'https://p.htmldoc.space/zzz987654321', expires_at: '2026-09-01T00:00:00Z', filename: 'old.html', kind: 'html', state: 'expired' },
  ];

  it('list prints one row per page on stdout', async () => {
    mockFetch(() => jsonResponse(200, { pages }));
    const r = await run(['list'], { env });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 3, r.stdout);
    assert.match(lines[0], /ID/);
    assert.ok(lines[1].includes(PAGE.id) && lines[1].includes(PAGE.url) && lines[1].includes('plan.md') && lines[1].includes('active'));
    assert.ok(lines[2].includes('zzz987654321') && lines[2].includes('expired'));
    assertNoKey(r);
  });

  it('list --json prints the server payload', async () => {
    mockFetch(() => jsonResponse(200, { pages }));
    const r = await run(['list', '--json'], { env });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { pages });
  });

  it('list with no pages prints nothing on stdout and a note on stderr', async () => {
    mockFetch(() => jsonResponse(200, { pages: [] }));
    const r = await run(['list'], { env });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /no pages/);
  });

  it('list rejects positionals', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { pages }));
    assert.equal((await run(['list', 'extra'], { env })).code, 1);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('delete prints the removed URL on stderr, nothing on stdout, and forgets the state entry', async () => {
    const fetch = mockFetch((url, init) => (init.method === 'DELETE' ? jsonResponse(200, { id: PAGE.id, url: PAGE.url, state: 'deleted' }) : jsonResponse(201, PAGE)));
    await run(['plan.md'], { env, cwd: work });
    const r = await run(['delete', PAGE.id], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(PAGE.url), r.stderr);
    assert.equal(String(fetch.mock.calls[1].arguments[0]), 'https://htmldoc.space/api/v1/pages/abc123def456');
    assert.equal(fetch.mock.calls[1].arguments[1].method, 'DELETE');
    assert.deepEqual((await readState(cfgDir)).pages, {});
  });

  it('delete accepts a full URL and needs exactly one argument', async () => {
    const fetch = mockFetch(() => jsonResponse(200, { id: PAGE.id, url: PAGE.url, state: 'deleted' }));
    assert.equal((await run(['delete', PAGE.url], { env })).code, 0);
    assert.equal(String(fetch.mock.calls[0].arguments[0]), 'https://htmldoc.space/api/v1/pages/abc123def456');
    assert.equal((await run(['delete'], { env })).code, 1);
    assert.equal((await run(['delete', 'a', 'b'], { env })).code, 1);
    assert.equal(fetch.mock.callCount(), 1);
  });

  it('delete relays a 404 as the server line', async () => {
    mockFetch(() => jsonResponse(404, { error: 'page not found' }));
    const r = await run(['delete', PAGE.id], { env });
    assert.equal(r.code, 1);
    assert.equal(r.stderr.trim(), 'page not found');
  });
});

describe('bin/htmldoc.js end to end', () => {
  it('connection refused exits 1 with one stderr line and empty stdout', async () => {
    const server = createServer();
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    await new Promise((res) => server.close(res));
    const origin = `http://127.0.0.1:${port}`;
    const r = await runBin(['plan.md'], { cwd: work, env: { ...env, HTMLDOC_API_URL: origin } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    const lines = r.stderr.trimEnd().split('\n');
    assert.equal(lines[0], `using API at ${origin}`);
    assert.equal(lines.length, 2, r.stderr);
    assert.match(lines[1], /^could not reach http:\/\/127\.0\.0\.1:\d+: /);
    assert.ok(!r.stderr.includes('hd_'));
  });

  it('no key exits 1 with the instructions and empty stdout', async () => {
    const r = await runBin(['plan.md'], { cwd: work, env: { XDG_CONFIG_HOME: xdg } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(DASHBOARD) && r.stderr.includes(LOGIN_CMD), r.stderr);
  });

  it('login with piped stdin exits 1 quickly', async () => {
    const r = await runBin(['login'], { cwd: work, env: { XDG_CONFIG_HOME: xdg } });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(DASHBOARD));
  });

  it('insecure API URL exits 1 before any request', async () => {
    const r = await runBin(['plan.md'], { cwd: work, env: { ...env, HTMLDOC_API_URL: 'http://evil.example' } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /insecure API URL/);
  });

  it('--version prints the package version', async () => {
    const r = await runBin(['--version'], { cwd: work });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '0.1.0');
  });

  it('bin is executable and starts with a node shebang', async () => {
    const { BIN } = await import('./helpers.js');
    assert.ok((await stat(BIN)).mode & 0o111);
    assert.ok((await readFile(BIN, 'utf8')).startsWith('#!/usr/bin/env node\n'));
  });
});

describe('hidden key reader', () => {
  function fakeTty() {
    const tty = new EventEmitter();
    tty.isTTY = true;
    tty.isRaw = false;
    tty.calls = [];
    tty.setRawMode = (v) => tty.calls.push(['raw', v]);
    tty.setEncoding = () => {};
    tty.resume = () => tty.calls.push(['resume']);
    tty.pause = () => tty.calls.push(['pause']);
    return tty;
  }

  it('collects characters until Enter, honours backspace, and restores the terminal', async () => {
    const tty = fakeTty();
    const err = { data: '', write(c) { this.data += c; } };
    const p = readSecretFromTty(tty, err);
    tty.emit('data', 'hd_ab');
    tty.emit('data', '\u007f');
    tty.emit('data', 'c\r');
    tty.emit('data', 'ignored after enter');
    assert.equal(await p, 'hd_ac');
    assert.deepEqual(tty.calls, [['raw', true], ['resume'], ['raw', false], ['pause']]);
    assert.equal(err.data, '\n', 'nothing typed is echoed');
  });

  it('rejects on Ctrl-C without echoing anything', async () => {
    const tty = fakeTty();
    const err = { data: '', write(c) { this.data += c; } };
    const p = readSecretFromTty(tty, err);
    tty.emit('data', 'hd_secret\u0003');
    await assert.rejects(p, /cancelled/);
    assert.ok(!err.data.includes('hd_'));
  });
});

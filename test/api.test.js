import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mock } from 'node:test';

import { resolveOrigin, dashboardUrl, ApiClient, TOO_LARGE, VERSION } from '../src/api.js';
import { CliError } from '../src/output.js';
import { jsonResponse, PAGE } from './helpers.js';

const KEY = 'hd_' + 'k'.repeat(40);

describe('resolveOrigin', () => {
  it('defaults to production and reports no override', () => {
    assert.deepEqual(resolveOrigin({}), { origin: 'https://htmldoc.space', overridden: false });
    assert.deepEqual(resolveOrigin({ HTMLDOC_API_URL: '' }), { origin: 'https://htmldoc.space', overridden: false });
  });

  it('accepts https anywhere and http only on loopback hosts', () => {
    assert.deepEqual(resolveOrigin({ HTMLDOC_API_URL: 'https://api.example' }), { origin: 'https://api.example', overridden: true });
    for (const url of ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000', 'http://app.localhost:8000']) {
      assert.equal(resolveOrigin({ HTMLDOC_API_URL: url }).origin, url);
    }
    assert.equal(resolveOrigin({ HTMLDOC_API_URL: 'https://api.example/' }).origin, 'https://api.example');
  });

  it('rejects insecure or malformed URLs before any request', () => {
    for (const url of ['http://evil.example', 'http://evil.example:8000', 'ftp://localhost', 'http://localhost.evil.example', 'not a url', 'http://10.0.0.5']) {
      assert.throws(() => resolveOrigin({ HTMLDOC_API_URL: url }), (e) => e instanceof CliError && /insecure API URL|invalid API URL/.test(e.message));
    }
  });

  it('rejects an override that carries a path, query, or credentials', () => {
    for (const url of ['https://api.example/api/v1', 'https://api.example/?x=1', 'https://u:p@api.example']) {
      assert.throws(() => resolveOrigin({ HTMLDOC_API_URL: url }), CliError);
    }
  });

  it('derives the dashboard URL from the origin', () => {
    assert.equal(dashboardUrl('https://htmldoc.space'), 'https://htmldoc.space/dashboard');
    assert.equal(dashboardUrl('http://localhost:8000'), 'http://localhost:8000/dashboard');
  });
});

describe('ApiClient', () => {
  afterEach(() => mock.restoreAll());

  function mockFetch(handler) {
    mock.restoreAll();
    return mock.method(globalThis, 'fetch', handler);
  }

  function client(extra = {}) {
    return new ApiClient({ origin: 'https://htmldoc.space', apiKey: KEY, timeoutMs: 1000, ...extra });
  }

  it('sends bearer, accept, and user-agent headers under /api/v1', async () => {
    mockFetch(async () => jsonResponse(200, { github_login: 'octo', live_pages: 1, max_live_pages: 100 }));
    const me = await client().me();
    assert.equal(me.github_login, 'octo');
    const [url, init] = fetch.mock.calls[0].arguments;
    assert.equal(String(url), 'https://htmldoc.space/api/v1/me');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.headers['User-Agent'], `htmldoc-cli/${VERSION}`);
    assert.ok(init.signal instanceof AbortSignal);
  });

  it('uploads multipart with a `file` field and the basename', async () => {
    mockFetch(async () => jsonResponse(201, PAGE));
    const page = await client().createPage({ bytes: Buffer.from('# hi'), filename: 'plan.md', kind: 'markdown' });
    assert.equal(page.id, PAGE.id);
    const [url, init] = fetch.mock.calls[0].arguments;
    assert.equal(String(url), 'https://htmldoc.space/api/v1/pages');
    assert.equal(init.method, 'POST');
    assert.ok(init.body instanceof FormData);
    const file = init.body.get('file');
    assert.ok(file instanceof File);
    assert.equal(file.name, 'plan.md');
    assert.equal(await file.text(), '# hi');
  });

  it('updates via POST /pages/{id}', async () => {
    mockFetch(async () => jsonResponse(200, PAGE));
    await client().updatePage('abc123def456', { bytes: Buffer.from('x'), filename: 'a.html', kind: 'html' });
    assert.equal(String(fetch.mock.calls[0].arguments[0]), 'https://htmldoc.space/api/v1/pages/abc123def456');
    assert.equal(fetch.mock.calls[0].arguments[1].method, 'POST');
  });

  it('lists and deletes', async () => {
    mockFetch(async (url, init) => {
      if (init.method === 'DELETE') return jsonResponse(200, { id: PAGE.id, url: PAGE.url, state: 'deleted' });
      return jsonResponse(200, { pages: [{ ...PAGE, state: 'active' }] });
    });
    const list = await client().listPages();
    assert.equal(list.pages.length, 1);
    const del = await client().deletePage(PAGE.id);
    assert.equal(del.state, 'deleted');
    assert.equal(String(fetch.mock.calls[1].arguments[0]), 'https://htmldoc.space/api/v1/pages/abc123def456');
  });

  it('maps a JSON error body to the server line', async () => {
    mockFetch(async () => jsonResponse(401, { error: 'invalid API key' }));
    await assert.rejects(client().me(), (e) => e instanceof CliError && e.message === 'invalid API key' && e.status === 401);
  });

  it('maps a non-JSON body to `server returned HTTP <status>`', async () => {
    mockFetch(async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    await assert.rejects(client().me(), (e) => e instanceof CliError && e.message === 'server returned HTTP 502');
    mockFetch(async () => jsonResponse(500, { message: 'no error field' }));
    await assert.rejects(client().me(), (e) => e.message === 'server returned HTTP 500');
  });

  it('maps 413 and a size 422 to the same too-large line', async () => {
    mockFetch(async () => new Response('<html>413</html>', { status: 413 }));
    await assert.rejects(client().me(), (e) => e.message === TOO_LARGE);
    mockFetch(async () => jsonResponse(422, { error: 'The file must not be greater than 2048 kilobytes.' }));
    await assert.rejects(client().me(), (e) => e.message === TOO_LARGE);
    mockFetch(async () => jsonResponse(422, { error: 'The file must be valid UTF-8.' }));
    await assert.rejects(client().me(), (e) => e.message === 'The file must be valid UTF-8.');
  });

  it('adds the Retry-After hint on 429', async () => {
    mockFetch(async () => jsonResponse(429, { error: 'Too Many Attempts.' }, { 'Retry-After': '42' }));
    await assert.rejects(client().me(), (e) => e.message === 'Too Many Attempts. (retry after 42 seconds)');
    mockFetch(async () => jsonResponse(429, { error: 'Too Many Attempts.' }));
    await assert.rejects(client().me(), (e) => e.message === 'Too Many Attempts. (try again later)');
  });

  it('reports a thrown fetch error as could-not-reach with the cause', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    await assert.rejects(client().me(), (e) => e.message === 'could not reach https://htmldoc.space: ECONNREFUSED');
  });

  it('gives up within the timeout when the server never responds', async () => {
    const server = createServer(() => {
      /* never respond */
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const started = Date.now();
    try {
      await assert.rejects(
        new ApiClient({ origin, apiKey: KEY, timeoutMs: 300 }).me(),
        (e) => e instanceof CliError && e.message === `could not reach ${origin}: timed out after 0.3s`,
      );
      assert.ok(Date.now() - started < 5000);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

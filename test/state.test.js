import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readState, recordPage, forgetPage, lookupPage } from '../src/state.js';
import { tempDir } from './helpers.js';

describe('state', () => {
  let dir;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an empty pages map when state.json is missing or corrupt', async () => {
    assert.deepEqual(await readState(path.join(dir, 'missing')), { pages: {} });
    await writeFile(path.join(dir, 'state.json'), '{corrupt');
    assert.deepEqual(await readState(dir), { pages: {} });
    await writeFile(path.join(dir, 'state.json'), '{"pages":"nope"}');
    assert.deepEqual(await readState(dir), { pages: {} });
  });

  it('records a page keyed by absolute path and rewrites the file atomically', async () => {
    const target = path.join(dir, 'htmldoc');
    await recordPage(target, '/abs/plan.md', { id: 'abc123def456', url: 'https://p.example/abc123def456' });
    await recordPage(target, '/abs/other.html', { id: 'zzz123def456', url: 'https://p.example/zzz123def456' });
    const state = await readState(target);
    assert.deepEqual(state.pages, {
      '/abs/plan.md': { id: 'abc123def456', url: 'https://p.example/abc123def456' },
      '/abs/other.html': { id: 'zzz123def456', url: 'https://p.example/zzz123def456' },
    });
    assert.deepEqual(await readdir(target), ['state.json'], 'no temp files remain');
    assert.equal((await stat(target)).mode & 0o777, 0o700);
    assert.equal(lookupPage(state, '/abs/plan.md').id, 'abc123def456');
    assert.equal(lookupPage(state, '/abs/none.md'), undefined);
  });

  it('overwrites a path that is uploaded again', async () => {
    await recordPage(dir, '/abs/plan.md', { id: 'first1234567', url: 'u1' });
    await recordPage(dir, '/abs/plan.md', { id: 'second123456', url: 'u2' });
    assert.deepEqual((await readState(dir)).pages['/abs/plan.md'], { id: 'second123456', url: 'u2' });
  });

  it('forgets every path mapped to a deleted id', async () => {
    await recordPage(dir, '/abs/a.md', { id: 'same12345678', url: 'u' });
    await recordPage(dir, '/abs/b.md', { id: 'same12345678', url: 'u' });
    await recordPage(dir, '/abs/c.md', { id: 'other1234567', url: 'v' });
    await forgetPage(dir, 'same12345678');
    assert.deepEqual(Object.keys((await readState(dir)).pages), ['/abs/c.md']);
    assert.match(await readFile(path.join(dir, 'state.json'), 'utf8'), /"pages"/);
  });
});

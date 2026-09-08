import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { configDir, readConfig, writeConfig, resolveApiKey, writeAtomic } from '../src/config.js';
import { tempDir } from './helpers.js';

describe('config', () => {
  let dir;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses $XDG_CONFIG_HOME/htmldoc when set, else ~/.config/htmldoc', () => {
    assert.equal(configDir({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/h' }), path.join('/x/cfg', 'htmldoc'));
    assert.equal(configDir({ HOME: '/h' }), path.join('/h', '.config', 'htmldoc'));
    assert.equal(configDir({ XDG_CONFIG_HOME: '', HOME: '/h' }), path.join('/h', '.config', 'htmldoc'));
  });

  it('reads an empty config when the file is missing', async () => {
    assert.deepEqual(await readConfig(path.join(dir, 'missing')), {});
  });

  it('writes config.json with mode 0600 inside a 0700 directory, via a temp file', async () => {
    const target = path.join(dir, 'htmldoc');
    await writeConfig(target, { apiKey: 'hd_' + 'a'.repeat(40) });
    assert.equal((await stat(target)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(target, 'config.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readConfig(target), { apiKey: 'hd_' + 'a'.repeat(40) });
    const leftovers = (await readdir(target)).filter((f) => f !== 'config.json');
    assert.deepEqual(leftovers, [], 'no temp files remain after rename');
  });

  it('writeAtomic leaves no partial file when the target directory is missing', async () => {
    const target = path.join(dir, 'nope', 'file.json');
    await assert.rejects(writeAtomic(target, '{}', 0o600));
    assert.deepEqual(await readdir(dir), []);
  });

  it('writeAtomic replaces existing content in full', async () => {
    const target = path.join(dir, 'file.json');
    await writeAtomic(target, JSON.stringify({ a: 1 }), 0o600);
    await writeAtomic(target, JSON.stringify({ b: 2 }), 0o600);
    assert.equal(await readFile(target, 'utf8'), '{"b":2}');
    assert.deepEqual(await readdir(dir), ['file.json']);
  });

  it('prefers HTMLDOC_API_KEY over the stored key', () => {
    assert.equal(resolveApiKey({ HTMLDOC_API_KEY: 'hd_env' }, { apiKey: 'hd_file' }), 'hd_env');
    assert.equal(resolveApiKey({}, { apiKey: 'hd_file' }), 'hd_file');
    assert.equal(resolveApiKey({ HTMLDOC_API_KEY: '  ' }, {}), undefined);
    assert.equal(resolveApiKey({}, {}), undefined);
  });

  it('rejects a config.json that is not valid JSON with a one-line error', async () => {
    const target = path.join(dir, 'htmldoc');
    await writeConfig(target, { apiKey: 'x' });
    await writeAtomic(path.join(target, 'config.json'), '{not json', 0o600);
    await assert.rejects(readConfig(target), (e) => /config\.json/.test(e.message) && !/\n/.test(e.message));
  });
});

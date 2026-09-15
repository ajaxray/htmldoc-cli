import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { configDir, readConfig, writeConfig, resolveApiKey, writeAtomic, PAIRING_FILE, readPairing, writePairing, clearPairing } from '../src/config.js';
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

  describe('pairing.json', () => {
    const state = {
      deviceSecret: 'device-secret-' + 's'.repeat(30),
      userCode: 'AbCdEfGh1234',
      expiresAt: '2026-09-16T10:10:00.000Z',
      intervalSeconds: 5,
      origin: 'https://htmldoc.space',
    };

    it('readPairing returns null when the file is missing', async () => {
      assert.equal(await readPairing(path.join(dir, 'missing')), null);
    });

    it('writePairing creates the 0700 dir and a 0600 pairing.json via a temp file; readPairing returns it', async () => {
      const target = path.join(dir, 'htmldoc');
      await writePairing(target, state);
      assert.equal((await stat(target)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(target, PAIRING_FILE))).mode & 0o777, 0o600);
      assert.deepEqual(await readPairing(target), state);
      assert.deepEqual(await readdir(target), ['pairing.json']);
    });

    it('writePairing replaces an earlier pairing in full', async () => {
      const target = path.join(dir, 'htmldoc');
      await writePairing(target, state);
      await writePairing(target, { ...state, userCode: 'ZyXwVuTs9876', deviceSecret: 'second' });
      assert.deepEqual(await readPairing(target), { ...state, userCode: 'ZyXwVuTs9876', deviceSecret: 'second' });
    });

    it('clearPairing removes the file and is quiet when it is already gone', async () => {
      const target = path.join(dir, 'htmldoc');
      await writePairing(target, state);
      await clearPairing(target);
      assert.equal(await readPairing(target), null);
      await clearPairing(target);
      await clearPairing(path.join(dir, 'never-made'));
    });

    it('readPairing rejects malformed or non-object content with a one-line error that names the file, not the content', async () => {
      const target = path.join(dir, 'htmldoc');
      await writePairing(target, state);
      await writeAtomic(path.join(target, PAIRING_FILE), '{not json', 0o600);
      await assert.rejects(readPairing(target), (e) => /pairing\.json/.test(e.message) && !/\n/.test(e.message) && !/not json/.test(e.message));
      await writeAtomic(path.join(target, PAIRING_FILE), '[1,2]', 0o600);
      assert.equal(await readPairing(target), null);
    });

    it('config.json is untouched by pairing writes', async () => {
      const target = path.join(dir, 'htmldoc');
      await writeConfig(target, { apiKey: 'hd_' + 'a'.repeat(40) });
      await writePairing(target, state);
      await clearPairing(target);
      assert.deepEqual(await readConfig(target), { apiKey: 'hd_' + 'a'.repeat(40) });
    });
  });

  it('rejects a config.json that is not valid JSON with a one-line error', async () => {
    const target = path.join(dir, 'htmldoc');
    await writeConfig(target, { apiKey: 'x' });
    await writeAtomic(path.join(target, 'config.json'), '{not json', 0o600);
    await assert.rejects(readConfig(target), (e) => /config\.json/.test(e.message) && !/\n/.test(e.message));
  });
});

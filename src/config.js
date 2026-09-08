/**
 * Config directory and config.json (KTD15).
 *
 * Directory: $XDG_CONFIG_HOME/htmldoc, default ~/.config/htmldoc, mode 0700.
 * config.json (mode 0600) holds { apiKey } and is written only by `login`.
 * Writes go to a temp file in the same directory, then rename.
 */
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { CliError, PACKAGE_NAME } from './output.js';

export const CONFIG_FILE = 'config.json';

export function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : path.join(env.HOME || homedir(), '.config');
  return path.join(base, 'htmldoc');
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to umask and ignored for a pre-existing directory.
  await chmod(dir, 0o700).catch(() => {});
}

/** Write `data` to `target` via a same-directory temp file and rename. */
export async function writeAtomic(target, data, mode = 0o600) {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
  try {
    await chmod(tmp, mode).catch(() => {});
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Read a JSON file; `{}`-like `fallback` when it does not exist. Malformed JSON throws `onInvalid(path)`. */
export async function readJson(file, fallback, onInvalid) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return onInvalid(file);
  }
}

export async function readConfig(dir) {
  const config = await readJson(path.join(dir, CONFIG_FILE), {}, (file) => {
    throw new CliError(`${file} is not valid JSON; fix or delete it, then run: npx ${PACKAGE_NAME} login`);
  });
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

export async function writeConfig(dir, config) {
  await ensureDir(dir);
  await writeAtomic(path.join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

/** HTMLDOC_API_KEY wins over the stored key. */
export function resolveApiKey(env, config) {
  const fromEnv = typeof env.HTMLDOC_API_KEY === 'string' ? env.HTMLDOC_API_KEY.trim() : '';
  if (fromEnv !== '') return fromEnv;
  const stored = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  return stored !== '' ? stored : undefined;
}

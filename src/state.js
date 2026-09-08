/**
 * state.json (KTD15): { pages: { "<absolute path>": { id, url } } }.
 * Rewritten in full on every upload via temp file then rename. It is a
 * convenience cache, so a missing or corrupt file reads as empty.
 */
import path from 'node:path';

import { ensureDir, readJson, writeAtomic } from './config.js';

export const STATE_FILE = 'state.json';

const EMPTY = () => ({ pages: {} });

export async function readState(dir) {
  let state;
  try {
    state = await readJson(path.join(dir, STATE_FILE), EMPTY(), EMPTY);
  } catch {
    return EMPTY();
  }
  if (!state || typeof state !== 'object' || !state.pages || typeof state.pages !== 'object' || Array.isArray(state.pages)) {
    return EMPTY();
  }
  return { pages: { ...state.pages } };
}

export function lookupPage(state, absolutePath) {
  const entry = state.pages[absolutePath];
  return entry && typeof entry.id === 'string' && typeof entry.url === 'string' ? entry : undefined;
}

async function writeState(dir, state) {
  await ensureDir(dir);
  await writeAtomic(path.join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export async function recordPage(dir, absolutePath, { id, url }) {
  const state = await readState(dir);
  state.pages[absolutePath] = { id, url };
  await writeState(dir, state);
}

export async function forgetPage(dir, id) {
  const state = await readState(dir);
  for (const [file, entry] of Object.entries(state.pages)) {
    if (entry && entry.id === id) delete state.pages[file];
  }
  await writeState(dir, state);
}

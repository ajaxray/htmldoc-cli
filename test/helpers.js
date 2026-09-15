import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { main } from '../src/commands.js';

export const BIN = fileURLToPath(new URL('../bin/htmldoc.js', import.meta.url));

export async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'htmldoc-cli-'));
}

export function capture() {
  let data = '';
  return {
    write(chunk) {
      data += String(chunk);
      return true;
    },
    get data() {
      return data;
    },
  };
}

export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const PAGE = {
  id: 'abc123def456',
  url: 'https://p.htmldoc.space/abc123def456',
  expires_at: '2026-10-08T12:00:00Z',
  filename: 'plan.md',
  kind: 'markdown',
};

export const CODE = 'AbCdEfGh1234';
export const SECRET = 'device-secret-' + 's'.repeat(30);

export const PAIRING = { user_code: CODE, device_secret: SECRET, expires_in: 600, interval: 5 };

/**
 * Run the command layer in-process with injected streams and env.
 *
 * `openUrl` and `sleep` default to no-ops that never spawn or wait; `now` and
 * `platform` default to a fixed clock and darwin so the opener applies.
 */
export async function run(argv, { env = {}, stdin = { isTTY: false }, timeoutMs, readSecret, cwd, openUrl, sleep, now, platform = 'darwin' } = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, {
    env: { HOME: '/nonexistent', ...env },
    stdout,
    stderr,
    stdin,
    timeoutMs,
    readSecret,
    cwd,
    openUrl: openUrl ?? (() => true),
    sleep: sleep ?? (async () => {}),
    now,
    platform,
  });
  return { code, stdout: stdout.data, stderr: stderr.data };
}

/** A fake clock plus a sleep that advances it, so `--wait` deadlines are testable without waiting. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance(ms) {
      t += ms;
    },
  };
}

/** Spawn the real bin for end-to-end cases. */
export function runBin(argv, { env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      cwd,
      env: { PATH: process.env.PATH, HOME: '/nonexistent', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

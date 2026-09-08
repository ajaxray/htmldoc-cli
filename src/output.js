/**
 * Output contract (KTD16): stdout carries only the share URL, the --json
 * payload, or the list table. Everything else goes to stderr, and stderr is
 * scrubbed so an API key can never be echoed. Exit codes are 0 and 1.
 */

import pkg from '../package.json' with { type: 'json' };

/** The published npm package name, so user-facing hints follow a rename (R19). */
export const PACKAGE_NAME = pkg.name;

/** A user-facing failure: one line on stderr, exit 1, optional hint lines. */
export class CliError extends Error {
  constructor(message, { status, hints = [] } = {}) {
    super(message);
    this.name = 'CliError';
    this.status = status;
    this.hints = hints;
  }
}

const KEY_PATTERN = /hd_[A-Za-z0-9_-]+/g;

/** Replace anything shaped like an API key. Filenames containing `hd_` lose that token too; accepted. */
export function redact(text) {
  return String(text).replace(KEY_PATTERN, '[redacted]');
}

export function createIO({ stdout = process.stdout, stderr = process.stderr } = {}) {
  return {
    /** Data line on stdout: URL, JSON, or table. Never redacted, never a key. */
    out(text) {
      stdout.write(`${text}\n`);
    },
    /** Human line on stderr. Always redacted. */
    err(text) {
      stderr.write(`${redact(text)}\n`);
    },
  };
}

export function keyInstructions(dashboardUrl) {
  return [`Get your key at ${dashboardUrl}`, `then run: npx ${PACKAGE_NAME} login`];
}

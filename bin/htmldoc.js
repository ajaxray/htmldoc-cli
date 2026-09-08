#!/usr/bin/env node
import { main } from '../src/commands.js';
import { redact } from '../src/output.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Anything the command layer did not classify: one line, no stack trace.
  const line = redact(String(error && error.message ? error.message : error).split('\n')[0]);
  process.stderr.write(`htmldoc: ${line}\n`);
  process.exitCode = 1;
}

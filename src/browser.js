/**
 * Best-effort browser opener for the approval link (KTD5).
 *
 * No shell, no dependency: the platform's opener is spawned with an argument
 * array, detached, with stdio ignored, and unreferenced so the CLI can exit
 * at once. Anything that goes wrong means "not opened", never a failure.
 */
import { spawn as spawnProcess } from 'node:child_process';

function hasDisplay(env) {
  return Boolean((env.DISPLAY && env.DISPLAY !== '') || (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY !== ''));
}

/** The opener command (argv prefix) for this platform, or null when none applies. */
export function openerFor(platform, env) {
  switch (platform) {
    case 'darwin':
      return ['open'];
    case 'linux':
      return hasDisplay(env) ? ['xdg-open'] : null;
    case 'win32':
      return ['cmd', '/c', 'start', ''];
    default:
      return null;
  }
}

/** @returns {boolean} true when an opener command was started. */
export function openUrl(url, { platform = process.platform, env = process.env, spawn = spawnProcess } = {}) {
  const opener = openerFor(platform, env);
  if (!opener) return false;
  const [command, ...prefix] = opener;
  try {
    const child = spawn(command, [...prefix, url], { detached: true, stdio: 'ignore' });
    // A missing opener surfaces as an async 'error' event; swallow it so it cannot crash the CLI.
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

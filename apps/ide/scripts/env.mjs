/**
 * Launch environment for Electron (shared by scripts/launch.mjs and the Playwright harness).
 *
 * WSL2/WSLg workaround: this machine lacks libasound.so.2 (Electron links it) and there is no sudo, so
 * scripts/setup-linux-libs.sh extracts the Ubuntu .deb into <repo>/.local-libs/root (gitignored); when that
 * directory exists it is prepended to LD_LIBRARY_PATH. The Electron binary is downloaded on demand when npm skipped
 * electron's postinstall.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const repoDir = dirname(dirname(appDir));
const require = createRequire(import.meta.url);

export const localLibDir = join(repoDir, '.local-libs', 'root', 'usr', 'lib', 'x86_64-linux-gnu');

/** Path of the Electron executable (downloads it if missing). */
export function electronPath() {
  const pkgDir = dirname(require.resolve('electron/package.json'));
  const read = () => {
    try {
      return require('electron');
    } catch {
      return null;
    }
  };
  let p = read();
  if (!p || !existsSync(p)) {
    execFileSync(process.execPath, [join(pkgDir, 'install.js')], { stdio: 'inherit' });
    p = read();
  }
  return p;
}

/** process.env plus the library path and Electron flags needed here. */
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (process.platform === 'linux' && existsSync(localLibDir)) env.LD_LIBRARY_PATH = [localLibDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  // WSLg: Chromium's GPU process is flaky under WSL; software rendering is reliable and fast enough for this UI.
  if (isWsl()) env.S12_WSL = '1';
  return env;
}

export function isWsl() {
  return process.platform === 'linux' && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(safeRead('/proc/version')));
}

function safeRead(p) {
  try {
    return require('node:fs').readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Extra Chromium switches for this platform. */
export function electronArgs() {
  return isWsl() ? ['--disable-gpu'] : [];
}

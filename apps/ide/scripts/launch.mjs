#!/usr/bin/env node
/**
 * node scripts/launch.mjs dev|start|preview [app args...]
 *   dev      electron-vite dev server with HMR
 *   start    run the built app (out/) with Electron
 *   preview  electron-vite preview (build + run)
 * Sets LD_LIBRARY_PATH / GPU flags for WSL (see env.mjs).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { appDir, electronArgs, electronEnv, electronPath } from './env.mjs';

const require = createRequire(import.meta.url);
const [mode = 'start', ...rest] = process.argv.slice(2);
const exe = electronPath();
const env = electronEnv({ ELECTRON_EXEC_PATH: exe });
const flags = electronArgs();

let cmd;
let args;
if (mode === 'start') {
  cmd = exe;
  args = [...flags, appDir, ...rest];
} else if (mode === 'dev' || mode === 'preview') {
  const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
  cmd = process.execPath;
  args = [cli, mode, ...(rest.length || flags.length ? ['--', ...flags, ...rest] : [])];
} else {
  console.error(`unknown mode ${mode} (dev|start|preview)`);
  process.exit(2);
}

const child = spawn(cmd, args, { cwd: appDir, env, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));

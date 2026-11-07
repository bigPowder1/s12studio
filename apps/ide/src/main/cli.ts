/**
 * Command line: `s12studio [options] [file.mcp|file.asm|...]`.
 *   <file>            open it (a .mcp/.s12studio.json as the project, anything else in the editor)
 *   --open <file>     same, explicit
 *   --debug           after opening the project, start the debugger (Project > Debug)
 *   --devtools        open DevTools in each window
 * Electron/Chromium switches (--no-sandbox, --inspect, --user-data-dir...) and the app path are ignored.
 */
export interface CliOptions {
  open: string[];
  debug: boolean;
  devtools: boolean;
}

/** Chromium/Electron switches that take a separate value argument. */
const SWITCHES_WITH_VALUE = new Set(['--inspect-port', '--remote-debugging-port', '--user-data-dir', '--lang', '--log-file']);

/**
 * Parse process.argv. A packaged app has argv = [exe, ...args]; `electron [switches] <app> ...args` (dev, E2E:
 * Playwright inserts --inspect=0 --remote-debugging-port=0) also has the app path, which is skipped.
 */
export function parseCli(argv: readonly string[], packaged: boolean): CliOptions {
  const out: CliOptions = { open: [], debug: false, devtools: false };
  let args = argv.slice(1);
  if (!packaged) {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += SWITCHES_WITH_VALUE.has(args[i]) ? 2 : 1;
    args = args.slice(i + 1);
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--open') {
      const f = args[++i];
      if (f) out.open.push(f);
    } else if (a.startsWith('--open=')) out.open.push(a.slice(7));
    else if (a === '--debug') out.debug = true;
    else if (a === '--devtools') out.devtools = true;
    else if (a.startsWith('-')) {
      if (SWITCHES_WITH_VALUE.has(a)) i++;
    } else if (a !== '.') out.open.push(a);
  }
  return out;
}

export const isProjectFile = (p: string): boolean => /\.(mcp|s12studio\.json)$/i.test(p);

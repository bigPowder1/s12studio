/**
 * Playwright `_electron` harness: launch the BUILT app (run `npm run build -w @s12/ide` first; `npm run e2e` does)
 * with command-line args, find the IDE and debugger windows, copy fixtures to temp dirs, save screenshots.
 *
 *   const s = await launchApp({ args: ['--open', mcp] });
 *   const ide = await s.ideWindow();
 *   const dbg = await s.debuggerWindow();       // waits until Project > Debug opened it
 *   await s.screenshot(ide, 'ide-lab3');        // -> $S12_SCREENS_DIR/ide-lab3.png
 *   await s.close();
 *
 * Environment: S12_SCREENS_DIR (default <os tmp>/s12studio-screens), S12_E2E_TMP (default <os tmp>),
 * S12_FIXTURES (the private fixtures, default <repo>/fixtures). Specs that need the private fixtures start with
 * `test.skip(!hasFixtures, NO_FIXTURES)`; the public specs use copyExample('blinky').
 */
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { locateFixtures } from '../../../packages/formats/test/fixtures-locate';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDir, electronArgs, electronEnv, electronPath, repoDir } from '../scripts/env.mjs';

export const SCREENS_DIR = process.env.S12_SCREENS_DIR ?? join(tmpdir(), 's12studio-screens');
const TMP = process.env.S12_E2E_TMP ?? tmpdir();

export interface LaunchedApp {
  app: ElectronApplication;
  /** userData dir of this run (deleted by close()). */
  userData: string;
  ideWindow(): Promise<Page>;
  debuggerWindow(): Promise<Page>;
  /** The ME3305 board window (opens with a debug session that has the board, or Component > Open > ME3305 Board). */
  boardWindow(): Promise<Page>;
  screenshot(page: Page, name: string): Promise<string>;
  close(): Promise<void>;
}

export type WindowKindName = 'ide' | 'debugger' | 'board';

const kindOf = (p: Page): WindowKindName | null =>
  /\/debugger\/index\.html#board$/.test(p.url()) ? 'board' : /\/debugger\/index\.html/.test(p.url()) ? 'debugger' : /\/ide\/index\.html/.test(p.url()) ? 'ide' : null;

const fx = locateFixtures(repoDir);
/** The private fixtures directory: $S12_FIXTURES (relative to the repo root when relative), else <repo>/fixtures. */
export const FIXTURES = fx.dir;
/** True when the private fixtures (Lab3 and blank_project) are present. */
export const hasFixtures = fx.present;
/** Skip reason for specs that need the private fixtures. */
export const NO_FIXTURES = `needs the ${fx.reason}`;

/** `label: DC.B '...'` strings of the private Lab3 main.asm (label -> text): lab texts are read, not repeated here. */
export function lab3Strings(): Record<string, string> {
  const src = readFileSync(join(FIXTURES, 'Lab3', 'Sources', 'main.asm'), 'latin1');
  return Object.fromEntries([...src.matchAll(/^(\w+):?\s+DC\.B\s+'([^']*)'/gim)].map((m) => [m[1], m[2]]));
}

/** The first `DC.B` string of the private Lab3 main.asm: the text its LCD line-1 prompt starts with. */
export const lab3FirstString = (): string => Object.values(lab3Strings())[0];

/** RegExp matching text that starts with `prefix` (literal), for `expect.poll(...).toMatch(...)`. */
export const startsWithRe = (prefix: string): RegExp => new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** Temp copies made by copyFixture/copyExample, deleted when the test worker exits (they may hold private fixtures). */
const copies: string[] = [];
process.once('exit', () => {
  for (const d of copies) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp dir (under $S12_E2E_TMP or the OS temp dir), deleted when the test worker exits. */
export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(TMP, prefix));
  copies.push(d);
  return d;
}

/** Copy a fixture project (read-only) to a fresh temp dir; returns the copy's directory. */
export function copyFixture(name: 'Lab3' | 'blank_project'): string {
  const base = mkdtempSync(join(TMP, `s12e2e-${name}-`));
  copies.push(base);
  const dest = join(base, name);
  cpSync(join(FIXTURES, name), dest, { recursive: true, preserveTimestamps: true });
  return dest;
}

/** Copy a public example project (examples/<name>) to a fresh temp dir; returns the copy's directory. */
export function copyExample(name: string): string {
  const base = mkdtempSync(join(TMP, `s12e2e-${name}-`));
  copies.push(base);
  const dest = join(base, name);
  cpSync(join(repoDir, 'examples', name), dest, { recursive: true, preserveTimestamps: true });
  return dest;
}

export async function launchApp(opts: { args?: string[]; env?: Record<string, string> } = {}): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(TMP, 's12e2e-userdata-'));
  const app = await _electron.launch({
    executablePath: electronPath(),
    args: [...electronArgs(), appDir, ...(opts.args ?? [])],
    cwd: appDir,
    env: electronEnv({ S12_E2E: '1', S12_USER_DATA: userData, ...opts.env }) as Record<string, string>,
    timeout: 60_000,
  });
  const proc = app.process();
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[app] ${d}`));
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[app] ${d}`));

  const windowOf = async (kind: WindowKindName): Promise<Page> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      for (const w of app.windows()) if (kindOf(w) === kind) return w;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${kind} window (have: ${app.windows().map((w) => w.url()).join(', ')})`);
      await app.waitForEvent('window', { timeout: Math.min(left, 2000) }).catch(() => undefined);
    }
  };
  const logged = new WeakSet<Page>();
  const ready = async (kind: WindowKindName) => {
    const p = await windowOf(kind);
    if (!logged.has(p)) {
      logged.add(p);
      p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && process.stdout.write(`[${kind} ${m.type()}] ${m.text()}\n`));
      p.on("pageerror", (e) => process.stdout.write(`[${kind} pageerror] ${e.stack ?? e.message}\n`));
    }
    await p.waitForLoadState('domcontentloaded');
    await p.locator('#root > *').first().waitFor();
    return p;
  };

  return {
    app,
    userData,
    ideWindow: () => ready('ide'),
    debuggerWindow: () => ready('debugger'),
    boardWindow: () => ready('board'),
    async screenshot(page, name) {
      mkdirSync(SCREENS_DIR, { recursive: true });
      const path = join(SCREENS_DIR, `${name}.png`);
      await page.screenshot({ path });
      return path;
    },
    async close() {
      await app.close().catch(() => undefined);
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

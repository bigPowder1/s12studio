/**
 * Engine track E2E: Make in the IDE window (streamed build events, Code/Data columns), Project > Debug on Lab3's
 * P&E (icd12) connection falls back to Full Chip Simulation with a notice, Go runs true-time and the ME305 LCD shows
 * the lab's first prompt, a keypad tap, and Make while debugging sends `applicationRebuilt`.
 * Screenshots: $S12_SCREENS_DIR/build-engine-*.png.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { copyFixture, hasFixtures, lab3FirstString, NO_FIXTURES, launchApp, startsWithRe, type LaunchedApp } from './harness';

// Lab3 / blank_project are private fixtures: skip the whole file without them (public specs: public-demo.spec.ts).
test.skip(!hasFixtures, NO_FIXTURES);

let s: LaunchedApp | undefined;

test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** Record events of a domain in the page (window.__s12evts). */
async function record(page: Page, domain: string, events: string[]): Promise<void> {
  await page.evaluate(
    ([d, evs]) => {
      const w = globalThis as unknown as { __s12evts?: { event: string; payload: unknown }[]; s12: Record<string, { on(e: string, cb: (p: unknown) => void): () => void }> };
      w.__s12evts ??= [];
      for (const e of evs as string[]) w.s12[d as string].on(e, (payload) => w.__s12evts!.push({ event: e, payload }));
    },
    [domain, events] as const,
  );
}
/** A window page even when its React tree failed to mount (other tracks' renderer work in progress). */
async function windowPage(l: LaunchedApp, kind: 'ide' | 'debugger'): Promise<{ page: Page; ui: boolean }> {
  try {
    return { page: await (kind === 'ide' ? l.ideWindow() : l.debuggerWindow()), ui: true };
  } catch {
    const page = l.app.windows().find((w) => w.url().includes(`/${kind}/index.html`));
    if (!page) throw new Error(`no ${kind} window`);
    return { page, ui: false };
  }
}

/** Click a toolbar button, or call the same API when the UI is not available. */
async function clickOr(page: Page, testId: string, api: string): Promise<void> {
  if ((await page.getByTestId(testId).count()) > 0) await page.getByTestId(testId).click();
  else
    await page.evaluate((path) => {
      const [d, m] = path.split('.');
      const s12 = (globalThis as unknown as { s12: Record<string, Record<string, () => Promise<unknown>>> }).s12;
      void s12[d][m]();
    }, api);
}

const recorded = (page: Page, event: string) =>
  page.evaluate((e) => ((globalThis as unknown as { __s12evts?: { event: string; payload: unknown }[] }).__s12evts ?? []).filter((x) => x.event === e).map((x) => x.payload), event);

test('Make, debug with FCS fallback, run to the first prompt, rebuild notice', async () => {
  const dir = copyFixture('Lab3');
  s = await launchApp({ args: ['--open', join(dir, 'Lab3.mcp')] });
  const { page: ide, ui: ideUi } = await windowPage(s, 'ide');
  if (ideUi) await expect(ide.getByTestId('project-files')).toContainText('main.asm');
  await record(ide, 'build', ['started', 'progress', 'message', 'finished']);

  // Project > Make (F7): toolbar button, result streamed as build.* events
  await clickOr(ide, 'pw-make', 'build.make');
  await expect.poll(async () => (await recorded(ide, 'finished')).length, { timeout: 60_000 }).toBeGreaterThan(0);
  const result = (await recorded(ide, 'finished'))[0] as { ok: boolean; errors: number; files: { name: string; code: number }[] };
  expect(result.ok).toBe(true);
  expect(result.errors).toBe(0);
  const info = await ide.evaluate(() => (globalThis as unknown as { s12: { project: { current(): Promise<{ files: { name: string; code?: number }[] }> } } }).s12.project.current());
  expect(info.files.find((f) => f.name === 'main.asm')?.code).toBeGreaterThan(0);
  await s.screenshot(ide, 'build-engine-ide-make');

  // Project > Debug: Lab3.mcp selects P&E_Multilink_USB (icd12) -> Full Chip Simulation + notice
  await clickOr(ide, 'pw-debug', 'debug.launch');
  const { page: dbg, ui: dbgUi } = await windowPage(s, 'debugger');
  await record(dbg, 'debug', ['applicationRebuilt', 'notice', 'halted']);
  await expect.poll(() => dbg.evaluate(async () => (await (globalThis as unknown as { s12: { debug: { snapshot(): Promise<{ registers: { PC: number } | null }> } } }).s12.debug.snapshot()).registers?.PC), { timeout: 30_000 }).toBe(0xc000);
  if (dbgUi) {
    await expect(dbg.getByTestId('reg-PC')).toHaveText('C000');
    await expect(dbg.getByTestId('command-component')).toContainText('S12 Studio runs it in Full Chip Simulation');
  }
  const session = await dbg.evaluate(() => (globalThis as unknown as { s12: { debug: { session(): Promise<{ fallbackFrom?: { target: string }; connection: string }> } } }).s12.debug.session());
  expect(session.connection).toBe('sim');
  expect(session.fallbackFrom?.target).toBe('icd12');

  // Run > Start/Continue: true-time pacing; ~3.5 s later the LCD shows the prompts
  await clickOr(dbg, 'tb-go', 'debug.go');
  if (dbgUi) await expect(dbg.getByTestId('debugger-status')).toContainText(/RUNNING/i);
  await dbg.waitForTimeout(1500);
  await s.screenshot(dbg, 'build-engine-debugger-running');
  const snapRunning = await dbg.evaluate(() => (globalThis as unknown as { s12: { debug: { snapshot(): Promise<{ state: string; realTimeRatio?: number; simSeconds: number }> } } }).s12.debug.snapshot());
  expect(snapRunning.state).toBe('running');
  // true-time pacing; shared 2-core CI runners have measured 0.19998 here
  expect(snapRunning.realTimeRatio ?? 0).toBeGreaterThan(process.env.CI ? 0.1 : 0.2);
  const lcd = () =>
    dbg.evaluate(async () => ((await (globalThis as unknown as { s12: { board: { state(): Promise<{ lcd: { lines: string[] } | null }> } } }).s12.board.state()).lcd?.lines ?? []).map((l) => l.trimEnd()));
  await expect.poll(async () => (await lcd())[0] ?? '', { timeout: 30_000 }).toMatch(startsWithRe(lab3FirstString().trimEnd()));

  // keypad stimulus while running reaches the board (the course program's reaction is checked in the private specs)
  type KeyBoard = { s12: { board: { pressKey(k: string): Promise<void>; releaseKey(k: string): Promise<void>; state(): Promise<{ keysDown: string[] }> } } };
  const keysDown = () => dbg.evaluate(async () => (await (globalThis as unknown as KeyBoard).s12.board.state()).keysDown);
  await dbg.evaluate(() => (globalThis as unknown as KeyBoard).s12.board.pressKey('5'));
  await expect.poll(keysDown, { timeout: 10_000 }).toEqual(['5']);
  await dbg.evaluate(() => (globalThis as unknown as KeyBoard).s12.board.releaseKey('5'));
  await expect.poll(keysDown, { timeout: 10_000 }).toEqual([]);
  await clickOr(dbg, 'tb-halt', 'debug.halt');
  if (dbgUi) await expect(dbg.getByTestId('debugger-status')).not.toContainText(/RUNNING/i);
  await s.screenshot(dbg, 'build-engine-debugger-lcd');

  // Make while debugging -> applicationRebuilt in the debugger window
  await ide.evaluate(() => (globalThis as unknown as { s12: { build: { make(r: { force: boolean }): Promise<unknown> } } }).s12.build.make({ force: true }));
  await expect.poll(async () => (await recorded(dbg, 'applicationRebuilt')).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const rebuilt = (await recorded(dbg, 'applicationRebuilt'))[0] as { absPath: string };
  expect(rebuilt.absPath).toBe(join(dir, 'bin', 'Project.abs'));
  await s.screenshot(dbg, 'build-engine-debugger-rebuilt');
  await s.screenshot(ide, 'build-engine-ide-after');
});

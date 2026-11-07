/**
 * Smoke test of a PACKAGED build (electron-builder output), not the dev out/ tree:
 *
 *   npm run dist:dir                                   # or dist:linux
 *   S12_PACKAGED_APP=$PWD/apps/ide/dist/linux-unpacked/s12studio npm run e2e:packaged -w @s12/ide
 *   (Windows: dist\win-unpacked\S12Studio.exe; macOS: dist/mac-arm64/S12 Studio.app/Contents/MacOS/S12 Studio;
 *    an AppImage path works too)
 *
 * Skipped unless S12_PACKAGED_APP is set. Proves: the installer carries the demo project (<resources>/examples/blinky,
 * without build outputs) and NO course content (no <resources>/templates); the app starts from app.asar, the demo
 * project builds (Make 0 errors), the debugger opens and the ESM debug-engine worker thread
 * (out/main/debug-worker.js inside app.asar) simulates: state RUNNING and the cycle counter advances; File > New offers
 * the ME 305 blank_project only from the user's templates folder (none here: it points to File > Open) and the
 * generic project builds.
 */
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electronArgs, electronEnv } from '../scripts/env.mjs';

const exe = process.env.S12_PACKAGED_APP;
test.skip(!exe, 'set S12_PACKAGED_APP=<packaged executable> to test a packaged build');

let app: ElectronApplication | null = null;
const temps: string[] = [];
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = null;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

async function ideWindow(a: ElectronApplication): Promise<Page> {
  const isIde = (p: Page) => /\/ide\/index\.html/.test(p.url());
  for (;;) {
    const w = a.windows().find(isIde);
    if (w) {
      await w.locator('#root > *').first().waitFor();
      return w;
    }
    await a.waitForEvent('window', { timeout: 60_000 });
  }
}

async function debuggerWindow(a: ElectronApplication): Promise<Page> {
  const isDbg = (p: Page) => /\/debugger\/index\.html/.test(p.url());
  for (;;) {
    const w = a.windows().find(isDbg);
    if (w) {
      await w.locator('#root > *').first().waitFor();
      return w;
    }
    await a.waitForEvent('window', { timeout: 60_000 });
  }
}

/** The packaged demo (<resources>/examples/blinky) copied to a temp dir (Make writes next to it): its project file. */
function copyDemo(resources: string): string {
  const dest = join(tmp('s12pkg-example-'), 'blinky');
  cpSync(join(resources, 'examples', 'blinky'), dest, { recursive: true });
  return join(dest, 'blinky.s12studio.json');
}

async function launchPackaged(args: string[]): Promise<{ a: ElectronApplication; ide: Page }> {
  const a = await _electron.launch({
    executablePath: exe!,
    args: [...electronArgs(), ...args],
    env: electronEnv({ S12_E2E: '1', S12_USER_DATA: tmp('s12pkg-userdata-'), S12_NO_UPDATE: '1' }) as Record<string, string>,
    timeout: 90_000,
  });
  app = a;
  a.process().stderr?.on('data', (d: Buffer) => process.stderr.write(`[app] ${d}`));
  expect(await a.evaluate(({ app: x }) => x.isPackaged)).toBe(true);
  return { a, ide: await ideWindow(a) };
}

/** File > New...: no blank_project in the (fresh) templates folder, so the generic project; checks the ME 305 note. */
async function newGenericProject(ide: Page): Promise<void> {
  await ide.keyboard.press('Control+Shift+N');
  const np = ide.getByTestId('new-project-dialog');
  await expect(np.getByTestId('np-page-device')).toContainText('MC9S12XDP512');
  await np.getByTestId('np-next').click();
  const hint = np.getByTestId('np-template-hint');
  // data-course is set once app.info() has answered (courseTemplate)
  await expect(hint).toHaveAttribute('data-course', 'false', { timeout: 15_000 });
  await expect(np.getByTestId('np-no-course')).toContainText('use File > Open... on a copy of the blank_project folder from your course');
  await np.getByTestId('np-templates').getByText('MC9S12XDP512 assembly (generic)').click();
  await np.getByTestId('np-name').fill('PkgTest');
  await np.getByTestId('np-dir').fill(tmp('s12pkg-new-'));
  await np.getByTestId('np-finish').click();
}

/** Make (F7) on the open project: 0 errors. */
async function make(ide: Page): Promise<void> {
  await expect(ide).toHaveTitle(/^S12 Studio - \[.+\]$/, { timeout: 30_000 });
  const mainRow = ide.locator('tr[data-key="f:main.asm"]');
  await expect(mainRow).toBeVisible();
  await mainRow.click();
  await ide.keyboard.press('F7');
  await expect(ide.getByTestId('ide-status')).toContainText(/Build done: 0 error\(s\)/, { timeout: 60_000 });
}

test('packaged app: ships the demo project and no course content; the demo -> Make 0 errors -> Debug -> worker simulates', async () => {
  test.setTimeout(300_000);
  const first = await launchPackaged([]);
  const resources = await first.a.evaluate(() => process.resourcesPath);
  const demo = join(resources, 'examples', 'blinky');
  for (const f of ['blinky.s12studio.json', 'Sources/main.asm', 'Sources/derivative.inc', 'prm/Project.prm', 'prm/burner.bbl', 'Full_Chip_Simulation.ini']) {
    expect(existsSync(join(demo, f)), `resources/examples/blinky/${f}`).toBe(true);
  }
  expect(readdirSync(demo).filter((n) => n === 'bin' || /_Data$/i.test(n)), 'no build outputs in the packaged demo').toEqual([]);
  expect(existsSync(join(resources, 'templates')), 'no resources/templates (no course content)').toBe(false);
  await first.a.close();
  app = null;

  const { a, ide } = await launchPackaged([copyDemo(resources)]);
  await make(ide);

  await ide.keyboard.press('F5');
  const dbg = await debuggerWindow(a);
  const status = dbg.getByTestId('debugger-status');
  await expect(dbg.getByTestId('reg-PC')).toHaveText(/^[0-9A-F]{4}$/, { timeout: 60_000 });
  await dbg.keyboard.press('F5');
  await expect(status.locator('[data-pane="state"]')).toContainText('RUNNING', { timeout: 20_000 });
  const cycles = async () => Number(((await status.locator('[data-pane="cycles"]').textContent()) ?? '').replace(/\D/g, '') || 0);
  const c0 = await cycles();
  await expect.poll(cycles, { timeout: 20_000 }).toBeGreaterThan(c0);
  await dbg.keyboard.press('F6');
  await expect(status.locator('[data-pane="state"]')).not.toContainText('RUNNING');
});

test('packaged app: New Project without a course blank_project points to File > Open; the generic project builds', async () => {
  test.setTimeout(180_000);
  const { ide } = await launchPackaged([]);
  await newGenericProject(ide);
  await make(ide);
});

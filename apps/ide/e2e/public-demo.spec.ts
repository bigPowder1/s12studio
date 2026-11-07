/**
 * Public E2E (no private fixtures needed): the own-authored demo project examples/blinky and a new generic project.
 *   1. File > Open a temp copy of examples/blinky/blinky.s12studio.json -> F7 Make (0 errors) -> F5 Project > Debug ->
 *      Component > Open > ME305 Board -> F5 run -> the LCD shows the program's message, the LEDs toggle, a click on
 *      keypad '2' changes the rate digit -> F6 halts.
 *   2. File > New > "MC9S12XDP512 assembly (generic)" -> Make -> Debug -> run -> halt.
 * Runs in both modes (`S12_FIXTURES=/nonexistent npm run app:e2e` and normally).
 * Screenshots: $S12_SCREENS_DIR/public-*.png.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyExample, launchApp, tempDir, type LaunchedApp } from './harness';

let s: LaunchedApp | undefined;

test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** Answer the next native File > Open dialog(s) with `paths` (Playwright cannot drive native dialogs). */
async function answerOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as unknown as typeof dialog.showOpenDialog;
  }, paths);
}

async function menu(page: Page, top: string, id: string): Promise<void> {
  await page.locator(`[role=menubar] > [data-menu="${top}"]`).click();
  await page.locator(`[data-menu-id="${id}"]`).click();
}

/** The demo's own LCD texts (DC.B strings of its main.asm). */
function asmStrings(dir: string): Record<string, string> {
  const src = readFileSync(join(dir, 'Sources', 'main.asm'), 'latin1');
  return Object.fromEntries([...src.matchAll(/^(\w+):\s+DC\.B\s+'([^']*)'/gm)].map((m) => [m[1], m[2]]));
}

test('public demo: open examples/blinky, Make, debug on the ME305 board, LEDs + LCD + keypad, halt', async () => {
  test.setTimeout(180_000);
  const dir = copyExample('blinky');
  const project = join(dir, 'blinky.s12studio.json');
  const msgs = asmStrings(dir);
  s = await launchApp();
  const ide = await s.ideWindow();

  // File > Open...
  await answerOpenDialog(s.app, [project]);
  await menu(ide, 'File', 'file.open');
  await expect(ide).toHaveTitle(/blinky/, { timeout: 30_000 });
  const files = ide.getByTestId('project-files');
  for (const t of ['Sources', 'main.asm', 'Project.prm']) await expect(files).toContainText(t);

  // F7 Make
  const mainRow = ide.locator('tr[data-key="f:main.asm"]');
  await expect(mainRow).toBeVisible();
  await mainRow.click();
  await ide.keyboard.press('F7');
  await expect(ide.getByTestId('ide-status')).toContainText(/Build done: 0 error\(s\)/, { timeout: 60_000 });
  expect(existsSync(join(dir, 'bin', 'Project.abs'))).toBe(true);
  await s.screenshot(ide, 'public-blinky-make');

  // F5 Project > Debug
  await ide.keyboard.press('F5');
  const dbg = await s.debuggerWindow();
  await expect(dbg).toHaveTitle(/S12 Studio Debugger/);
  const pc = dbg.getByTestId('reg-PC');
  await expect(pc).toHaveText(/^[0-9A-F]{4}$/, { timeout: 60_000 });

  // Component > Open > ME305 Board
  await dbg.locator('[data-menu="Component"]').click();
  await dbg.locator('[data-menu-id="component.open"]').click();
  await dbg.getByTestId('component-option-ME305 Board').click();
  await dbg.getByTestId('component-open-ok').click();
  const board = dbg.getByTestId('me305-board');
  await expect(board).toBeVisible();

  // F5 run: the LCD shows the message, the LEDs toggle
  await dbg.keyboard.press('F5');
  await expect(dbg.getByTestId('debugger-status')).toContainText('RUNNING');
  await expect(dbg.getByTestId('lcd-row-0')).toContainText(msgs.msg1, { timeout: 30_000 });
  await expect(dbg.getByTestId('lcd-row-1')).toContainText(msgs.msg2);
  const pp4 = dbg.getByTestId('led-PP4');
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        seen.add((await pp4.getAttribute('data-on')) ?? '?');
        return seen.has('0') && seen.has('1');
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
  // PP4/PP6 and PP5/PP7 are opposite pairs
  const on = async (pin: string) => (await dbg.getByTestId(`led-${pin}`).getAttribute('data-on')) === '1';
  await expect.poll(async () => (await on('PP4')) !== (await on('PP5')), { timeout: 5_000 }).toBe(true);
  await s.screenshot(dbg, 'public-blinky-running');

  // keypad '2' (mouse): the rate digit on line 2 changes
  const key2 = dbg.getByTestId('key-2');
  await key2.hover();
  await dbg.mouse.down();
  await dbg.waitForTimeout(150);
  await dbg.mouse.up();
  await expect(dbg.getByTestId('lcd-row-1')).toContainText(msgs.msg2.replace('500', '200'), { timeout: 10_000 });
  await s.screenshot(dbg, 'public-blinky-rate');

  // F6 halt
  await dbg.keyboard.press('F6');
  await expect(dbg.getByTestId('debugger-status')).toContainText(/halted/i);
  await expect(pc).toHaveText(/^[0-9A-F]{4}$/);
});

test('public demo: File > New generic MC9S12XDP512 project -> Make -> Debug -> run -> halt', async () => {
  test.setTimeout(180_000);
  const base = tempDir('s12e2e-new-');
  s = await launchApp();
  const ide = await s.ideWindow();
  await menu(ide, 'File', 'file.new');
  const np = ide.getByTestId('new-project-dialog');
  await expect(np.getByTestId('np-page-device')).toContainText('MC9S12XDP512');
  await np.getByTestId('np-next').click();
  await np.getByTestId('np-templates').getByText('MC9S12XDP512 assembly (generic)').click();
  await np.getByTestId('np-name').fill('Demo');
  await np.getByTestId('np-dir').fill(base);
  await np.getByTestId('np-finish').click();
  await expect(ide).toHaveTitle(/Demo/, { timeout: 30_000 });
  const mainRow = ide.locator('tr[data-key="f:main.asm"]');
  await expect(mainRow).toBeVisible();
  await mainRow.click();
  await ide.keyboard.press('F7');
  await expect(ide.getByTestId('ide-status')).toContainText(/Build done: 0 error\(s\)/, { timeout: 60_000 });
  expect(existsSync(join(base, 'Demo', 'bin', 'Project.abs'))).toBe(true);
  await s.screenshot(ide, 'public-new-make');

  await menu(ide, 'Project', 'project.debug');
  const dbg = await s.debuggerWindow();
  const pc = dbg.getByTestId('reg-PC');
  await expect(pc).toHaveText(/^[0-9A-F]{4}$/, { timeout: 60_000 });
  await dbg.keyboard.press('F5');
  await expect(dbg.getByTestId('debugger-status')).toContainText('RUNNING');
  await dbg.waitForTimeout(500);
  await dbg.keyboard.press('F6');
  await expect(dbg.getByTestId('debugger-status')).toContainText(/halted/i);
  await s.screenshot(dbg, 'public-new-halted');
});

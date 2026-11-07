/**
 * m6c fix step: regressions from the m6c verify walk, through the UI on a Lab3 copy.
 *   - Text-entry dialogs (Assembly Address, Memory Address) take keys typed right after they open, halted and running:
 *     the default text is there and selected in the first frame, and is not reset afterwards.
 *   - Procedure window after a CPU reset shows only the reset entry (no leftover return addresses).
 *   - Make while debugging relinks the loaded .abs: the Command window and the status bar say so.
 *   - IDE File > Exit with a modified document and the debugger open: Cancel keeps both windows and the session;
 *     Don't Save then quits the app without writing the file.
 * Screenshots: $S12_SCREENS_DIR/m6c-fix-*.png.
 */
import { expect, test, type Page } from '@playwright/test';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyFixture, hasFixtures, NO_FIXTURES, launchApp, type LaunchedApp } from './harness';

// Lab3 / blank_project are private fixtures: skip the whole file without them (public specs: public-demo.spec.ts).
test.skip(!hasFixtures, NO_FIXTURES);

let s: LaunchedApp | undefined;

test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

function mapSymbol(map: string, name: string): number {
  const m = new RegExp(`^\\s+${name}\\s+([0-9A-F]+)\\s`, 'm').exec(map);
  if (!m) throw new Error(`${name} not in map`);
  return parseInt(m[1], 16);
}

async function menu(page: Page, top: string, id: string): Promise<void> {
  await page.locator(`[role=menubar] > [data-menu="${top}"]`).click();
  await page.locator(`[data-menu-id="${id}"]`).click();
}

async function command(dbg: Page, line: string): Promise<void> {
  const input = dbg.getByTestId('command-component').getByLabel('Command');
  await input.fill(line);
  await input.press('Enter');
}

test('m6c fixes: fast typing in dialogs, Procedure after reset, rebuild notice, Exit/Cancel keeps the debugger', async () => {
  const dir = copyFixture('Lab3');
  const mainPath = join(dir, 'Sources', 'main.asm');
  const map = readFileSync(join(dir, 'bin', 'Project.map'), 'latin1');
  const top = mapSymbol(map, 'top');
  s = await launchApp({ args: ['--open', join(dir, 'Lab3.mcp')] });
  const ide = await s.ideWindow();
  await expect(ide.getByTestId('project-files')).toContainText('main.asm');
  await ide.getByTestId('pw-debug').click();
  const dbg = await s.debuggerWindow();
  const pc = dbg.getByTestId('reg-PC');
  const status = dbg.getByTestId('debugger-status');
  await expect(pc).toHaveText('C000', { timeout: 60_000 });

  // ---- Assembly > Address...: type at once (no pause), three times, halted
  await dbg.getByTestId('mdi-caption-Assembly').click();
  for (let k = 0; k < 3; k++) {
    await menu(dbg, 'Assembly', 'assembly.address');
    await expect(dbg.getByTestId('assembly-address-dialog')).toBeVisible();
    await dbg.keyboard.type(k === 1 ? 'Entry' : 'top');
    await expect(dbg.getByTestId('assembly-address-dialog-input')).toHaveValue(k === 1 ? 'Entry' : 'top');
    await dbg.keyboard.press('Enter');
    await expect(dbg.getByTestId('assembly-address-dialog')).toBeHidden();
    await expect(dbg.getByTestId(`asm-row-${hex4(k === 1 ? 0xc000 : top)}`)).toBeVisible();
  }

  // ---- Memory > Address... while running: the default (current address) is replaced, not appended to or reset
  await dbg.getByTestId('mdi-caption-Assembly').click();
  await dbg.keyboard.press('F5');
  await expect(status).toContainText('RUNNING');
  await dbg.getByTestId('mdi-caption-Memory').click();
  const memory = dbg.getByTestId('memory-component');
  for (const a of [0x2400, 0x1000, 0x2410]) {
    await menu(dbg, 'Memory', 'memory.address');
    const field = dbg.getByTestId('address-dialog').getByLabel('Address');
    await expect(field).toBeVisible();
    await dbg.keyboard.type(`0x${hex4(a)}`);
    await dbg.waitForTimeout(150); // a few snapshots arrive while the dialog is open
    await expect(field).toHaveValue(`0x${hex4(a)}`);
    await dbg.keyboard.press('Enter');
    await expect(memory.locator(`[data-addr="${a}"]`)).toBeVisible();
  }
  await s.screenshot(dbg, 'm6c-fix-01-address-while-running');

  // ---- halt, reset: Procedure shows the reset entry only
  await dbg.keyboard.press('F6');
  await expect(status.locator('[data-pane="state"]')).not.toHaveText('RUNNING');
  await dbg.getByTestId('mdi-caption-Assembly').click();
  await dbg.keyboard.press('Control+r');
  await expect(pc).toHaveText('C000');
  await expect(dbg.getByTestId('proc-frame-0')).toContainText('_Startup');
  await expect(dbg.getByTestId('proc-frame-1')).toHaveCount(0);
  await s.screenshot(dbg, 'm6c-fix-02-procedure-after-reset');
  // one step later the program's own frames come back as it calls (not asserted: depends on where it is)
  await dbg.keyboard.press('F11');
  await expect(pc).not.toHaveText('C000');

  // ---- Make while debugging relinks Project.abs: Command window + status bar notice
  appendFileSync(mainPath, '; m6c fix: rebuilt while debugging\r\n', 'latin1');
  await ide.getByTestId('project-files').getByText('main.asm', { exact: true }).click();
  await ide.keyboard.press('F7');
  await expect(ide.getByTestId('ide-status')).toContainText('Build done: 0 error(s)', { timeout: 60_000 });
  await expect(dbg.getByTestId('command-component')).toContainText('Project.abs was rebuilt. Project > Debug (F5) in the IDE or File > Load Application... loads the new code.');
  await expect(status.locator('[data-pane="help"]')).toContainText('Project.abs was rebuilt.');
  await s.screenshot(dbg, 'm6c-fix-03-rebuilt-notice');
  const onDisk = readFileSync(mainPath, 'latin1');

  // ---- File > Exit with a modified document: Cancel keeps the IDE, the debugger and its session
  await ide.getByTestId('project-files').getByText('main.asm', { exact: true }).dblclick();
  const lines = ide.locator('[data-testid="editor-monaco"] .view-lines');
  await expect(lines).toContainText('Lab 3');
  await lines.click();
  await ide.keyboard.press('Control+End');
  await ide.keyboard.type('; not saved');
  await expect(ide.getByTestId('editor-tab-main.asm')).toContainText('main.asm *');
  // the window-close guard on as in normal use (the E2E harness turns it off): it must not ask a second time
  await ide.evaluate(() => ((globalThis as unknown as { __s12UnloadGuard: boolean }).__s12UnloadGuard = true));
  await menu(ide, 'File', 'file.exit');
  const prompt = ide.getByTestId('editor-save-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('main.asm');
  // the debugger is still there while the IDE asks
  expect(dbg.isClosed()).toBe(false);
  await s.screenshot(ide, 'm6c-fix-04-exit-prompt');
  await ide.getByTestId('save-prompt-cancel').click();
  await expect(prompt).toBeHidden();
  await expect(ide.getByTestId('editor-tab-main.asm')).toContainText('main.asm *');
  expect(ide.isClosed()).toBe(false);
  expect(dbg.isClosed()).toBe(false);
  // ... and its session still answers
  await command(dbg, 'rd');
  await expect(dbg.getByTestId('command-component')).toContainText(/PC=[0-9A-F]{4}/);
  const before = (await pc.textContent())!;
  await dbg.getByTestId('mdi-caption-Assembly').click();
  await dbg.keyboard.press('F11');
  await expect(pc).not.toHaveText(before);
  await s.screenshot(dbg, 'm6c-fix-05-debugger-after-cancel');

  // ---- File > Exit again, Don't Save: the app quits (IDE first, then the debugger), the file is not written
  const exited = s.app.waitForEvent('close', { timeout: 30_000 });
  await menu(ide, 'File', 'file.exit');
  await expect(prompt).toBeVisible();
  await ide.getByTestId('save-prompt-discard').click();
  await exited;
  expect(readFileSync(mainPath, 'latin1')).toBe(onDisk);
});

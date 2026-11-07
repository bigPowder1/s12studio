/**
 * Editor track review fixes, against the built app and the real engine (Lab3 copy):
 *   - Ctrl+D typed in the editor reaches File > Find and Open File (Monaco's multicursor binding removed)
 *   - F4 with the Errors & Warnings window closed opens it AND jumps to the error in one press
 *   - after a rebuild the Errors window's source pane shows the new file text, not the cached old one
 *   - Edit > Paste from the menu pastes (system clipboard denied by main -> the editor's last copy)
 *   - closing the IDE window with unsaved changes is cancelled and asks "save changes?" first
 * Screenshots: fix-editor-*.png.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyFixture, hasFixtures, NO_FIXTURES, launchApp, type LaunchedApp } from './harness';

// Lab3 / blank_project are private fixtures: skip the whole file without them (public specs: public-demo.spec.ts).
test.skip(!hasFixtures, NO_FIXTURES);

let s: LaunchedApp | undefined;

test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

const lineCol = (ide: Page) => ide.getByTestId('editor-linecol');

async function gotoLine(ide: Page, n: number) {
  await ide.keyboard.press('Control+g');
  const gl = ide.getByTestId('goto-line-dialog');
  await gl.getByRole('textbox').fill(String(n));
  await gl.getByRole('textbox').press('Enter');
  await expect(lineCol(ide)).toContainText(`Line ${n} `);
}

test('editor fixes: Ctrl+D, F4 when closed, errors pane after rebuild, menu paste, close guard', async () => {
  const dir = copyFixture('Lab3');
  const mainPath = join(dir, 'Sources', 'main.asm');
  const originalText = readFileSync(mainPath, 'latin1');
  const original = originalText.split(/\r?\n/);
  const topLine = original.findIndex((l) => l.startsWith('top:')) + 1;
  s = await launchApp({ args: ['--open', join(dir, 'Lab3.mcp')] });
  const ide = await s.ideWindow();
  await ide.getByTestId('project-files').getByText('main.asm', { exact: true }).dblclick();
  const lines = ide.locator('[data-testid="editor-monaco"] .view-lines');
  await expect(lines).toContainText('Lab 3');

  // --- Ctrl+D inside Monaco -> Find and Open File dialog
  await lines.click();
  await ide.keyboard.press('Control+d');
  const findOpen = ide.getByTestId('find-open-dialog');
  await expect(findOpen).toBeVisible();
  await s.screenshot(ide, 'fix-editor-ctrlD');
  await ide.keyboard.press('Escape');
  await expect(findOpen).toBeHidden();

  // --- error, save, make
  await gotoLine(ide, topLine);
  await ide.keyboard.press('End');
  await ide.keyboard.press('Enter');
  await ide.keyboard.type('        ldaa  FIRST_BAD');
  await ide.keyboard.press('Control+s');
  await expect(ide.getByTestId('editor-tab-main.asm')).not.toContainText('*');
  await ide.keyboard.press('F7');
  const errors = ide.getByTestId('errors-window');
  await expect(errors.getByTestId('errors-row').first()).toContainText('FIRST_BAD');

  // --- F4 with the window closed: opens it and jumps in one press
  await errors.getByLabel('Close').click();
  await expect(ide.getByTestId('errors-window')).toHaveCount(0);
  await gotoLine(ide, 3);
  await ide.keyboard.press('F4');
  await expect(errors).toBeVisible();
  await expect(lineCol(ide)).toContainText(`Line ${topLine + 1} `);
  await expect(errors.getByTestId('errors-row').first()).toHaveAttribute('aria-selected', 'true');
  await expect(errors.getByTestId('errors-source')).toContainText('ldaa  FIRST_BAD');
  await s.screenshot(ide, 'fix-editor-f4');

  // --- rebuild with the error moved: the source pane re-reads the file
  await ide.keyboard.press('Home');
  await ide.keyboard.press('Shift+End');
  await ide.keyboard.press('Delete'); // the line is now empty
  await gotoLine(ide, topLine + 3);
  await ide.keyboard.press('End');
  await ide.keyboard.press('Enter');
  await ide.keyboard.type('        ldab  SECOND_BAD');
  await ide.keyboard.press('Control+s');
  await expect(ide.getByTestId('editor-tab-main.asm')).not.toContainText('*');
  await ide.keyboard.press('F7');
  const row = errors.getByTestId('errors-row').first();
  await expect(row).toContainText('SECOND_BAD');
  // final fidelity F14: the first message of the new build is selected, its source shows without a click
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(errors.getByTestId('errors-source')).toContainText('ldab  SECOND_BAD');
  await row.click();
  await expect(errors.getByTestId('errors-source')).toContainText('ldab  SECOND_BAD');
  await expect(errors.getByTestId('errors-source')).not.toContainText('FIRST_BAD');
  await s.screenshot(ide, 'fix-editor-errors-rebuild');

  // --- Edit > Paste from the menu: copy "SECOND_BAD" with Ctrl+C, paste it via the menu on a new line
  await row.dblclick();
  await expect(lineCol(ide)).toContainText(`Line ${topLine + 4} `);
  await lines.click(); // focus the text
  await gotoLine(ide, topLine + 4);
  await ide.keyboard.press('End');
  for (let i = 0; i < 'SECOND_BAD'.length; i++) await ide.keyboard.press('Shift+ArrowLeft');
  await ide.keyboard.press('Control+c');
  await ide.keyboard.press('End');
  await ide.keyboard.press('Enter');
  await ide.keyboard.type('        ldaa  ');
  await ide.locator('[role=menubar] > [data-menu="Edit"]').click();
  await ide.locator('[data-menu-id="edit.paste"]').click();
  await expect(lines).toContainText('ldaa  SECOND_BAD');
  await expect(ide.getByTestId('editor-tab-main.asm')).toContainText('main.asm *');
  await s.screenshot(ide, 'fix-editor-menu-paste');

  // --- closing the window with unsaved changes asks first (guard enabled for this E2E run)
  await ide.evaluate(() => ((globalThis as unknown as { __s12UnloadGuard: boolean }).__s12UnloadGuard = true));
  await s.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('/renderer/ide/')) w.close();
  });
  const prompt = ide.getByTestId('editor-save-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('main.asm');
  await s.screenshot(ide, 'fix-editor-close-guard');
  // Cancel: the window stays with the document still modified
  await ide.getByTestId('save-prompt-cancel').click();
  await expect(prompt).toBeHidden();
  expect(ide.isClosed()).toBe(false);
  await expect(ide.getByTestId('editor-tab-main.asm')).toContainText('main.asm *');
  // close again and Save: the file is written, then the window closes
  const closed = ide.waitForEvent('close');
  await s.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('/renderer/ide/')) w.close();
  });
  await ide.getByTestId('save-prompt-save').click();
  await closed;
  const saved = readFileSync(mainPath, 'latin1');
  const eol = originalText.includes('\r\n') ? '\r\n' : '\n'; // the file's own line ending is kept
  expect(saved).toContain(`        ldaa  SECOND_BAD${eol}`);
  expect(saved.split(/\r?\n/)).toHaveLength(original.length + 3);
  expect(saved.includes('\r\n')).toBe(eol === '\r\n');
});

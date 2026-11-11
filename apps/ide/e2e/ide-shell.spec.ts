/**
 * IDE shell E2E (IDE shell track): a Lab3 copy opened from the command line; title, project window, menus, Target
 * Settings (+ assembler Options...), Link Order, Make (F7) filling Code/Data, About, New Project. Screenshots go to
 * $S12_SCREENS_DIR as build-ide-shell-*.png.
 */
import { expect, test } from '@playwright/test';
import { dirname, join } from 'node:path';
import { copyFixture, hasFixtures, NO_FIXTURES, launchApp, type LaunchedApp } from './harness';

// Lab3 / blank_project are private fixtures: skip the whole file without them (public specs: public-demo.spec.ts).
test.skip(!hasFixtures, NO_FIXTURES);

let s: LaunchedApp | undefined;

test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

test('IDE shell: project window, menus, target settings, make', async () => {
  test.setTimeout(180_000);
  const dir = copyFixture('Lab3');
  s = await launchApp({ args: ['--open', join(dir, 'Lab3.mcp')] });
  const ide = await s.ideWindow();
  await ide.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

  const files = ide.getByTestId('project-files');
  await expect(files).toContainText('main.asm');
  await expect(files).toContainText('Linker Files');
  await expect(ide).toHaveTitle('S12 Studio - [Lab3.mcp]');
  await s.screenshot(ide, 'build-ide-shell-project');

  // Project menu
  await ide.locator('[role=menubar] > [data-menu="Project"]').click();
  await expect(ide.getByTestId('menu-Project')).toContainText('Bring Up To Date');
  await s.screenshot(ide, 'build-ide-shell-menu-project');
  await ide.keyboard.press('Escape');

  // Make (F7): Code/Data columns fill in, status bar reports the result
  await ide.locator('body').click({ position: { x: 900, y: 400 } });
  await ide.keyboard.press('F7');
  await expect(ide.getByTestId('ide-status')).toContainText(/Build done|up to date/, { timeout: 60_000 });
  await expect(ide.locator('tr[data-key="f:main.asm"]')).not.toContainText('n/a');
  await s.screenshot(ide, 'build-ide-shell-after-make');

  // Link Order tab
  await ide.getByRole('tab', { name: 'Link Order' }).dispatchEvent('mousedown');
  await expect(ide.getByTestId('project-link-order')).toContainText('ME305LibV4.0.lib');
  await s.screenshot(ide, 'build-ide-shell-link-order');
  await ide.getByRole('tab', { name: 'Files' }).dispatchEvent('mousedown');

  // Target Settings (Alt+F7) > Assembler for HC12 > Options...
  await ide.keyboard.press('Alt+F7');
  const ts = ide.getByTestId('target-settings');
  await expect(ts).toBeVisible();
  await ts.getByTestId('ts-panels').getByText('Access Paths').dispatchEvent('mousedown');
  await expect(ts.getByTestId('ts-path-list')).toContainText('{Project}Sources');
  await s.screenshot(ide, 'build-ide-shell-settings-access-paths');
  await ts.getByTestId('ts-panels').getByText('Assembler for HC12').dispatchEvent('mousedown');
  await expect(ts.getByTestId('ts-opt-assembler')).toHaveValue('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li');
  await ts.getByTestId('ts-asm-options').click();
  await expect(ide.getByTestId('asm-options-dialog')).toBeVisible();
  await s.screenshot(ide, 'build-ide-shell-asm-options');
  await ide.getByTestId('asm-options-dialog').getByText('Cancel').click();
  await ts.getByTestId('ts-cancel').click();

  // Help > About
  await ide.locator('[role=menubar] > [data-menu="Help"]').click();
  await ide.locator('[data-menu-id="help.about"]').click();
  await expect(ide.getByTestId('about-not-affiliated')).toContainText('not affiliated');
  await s.screenshot(ide, 'build-ide-shell-about');
  await ide.keyboard.press('Escape');

  // File > New... (New Project)
  await ide.keyboard.press('Control+Shift+N');
  await expect(ide.getByTestId('new-project-dialog')).toBeVisible();
  await s.screenshot(ide, 'build-ide-shell-new-project');
  await ide.keyboard.press('Escape');
  await expect(ide.getByTestId('new-project-dialog')).toHaveCount(0);

  // double-click a file: it opens in the editor area (editor track); the window list follows
  await ide.locator('tr[data-key="f:main.asm"]').dblclick();
  await expect(ide.getByTestId('editor-area')).toContainText(/main\.asm/, { timeout: 30_000 });
  await s.screenshot(ide, 'build-ide-shell-editor');

  // Project > Debug (F5): brings the target up to date, then opens the debugger on bin/Project.abs
  await ide.locator('tr[data-key="f:main.asm"]').click();
  await ide.keyboard.press('F5');
  const dbg = await s.debuggerWindow();
  await expect(dbg.getByTestId('reg-PC')).toHaveText('C000', { timeout: 60_000 });
  await s.screenshot(ide, 'build-ide-shell-after-debug');

  // File > New...: create a blank ME3305 project next to the Lab3 copy and open it
  await ide.bringToFront();
  await ide.keyboard.press('Control+Shift+N');
  const np = ide.getByTestId('new-project-dialog');
  await expect(np.getByTestId('np-page-device')).toContainText('MC9S12XDP512');
  await np.getByTestId('np-next').click();
  await np.getByTestId('np-name').fill('Lab4');
  await np.getByTestId('np-dir').fill(dirname(dir));
  await np.getByTestId('np-finish').click();
  await expect(ide).toHaveTitle('S12 Studio - [Lab4.mcp]', { timeout: 30_000 });
  await expect(ide.getByTestId('project-files')).toContainText('main.asm');
  await s.screenshot(ide, 'build-ide-shell-new-project-created');
});

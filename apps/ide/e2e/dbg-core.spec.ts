/**
 * Debugger core E2E (dbg-core track): the hiwave window on a Lab3 copy - MDI layout from ASM_layout.hwl, Source on
 * main.dbg with the PC line, toolbar from the .ini, breakpoint from the Assembly margin, F5 to the breakpoint,
 * changed registers in red, Component > Open, Window > Tile/Cascade. Screenshots: build-dbg-core-*.png.
 */
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { copyFixture, hasFixtures, NO_FIXTURES, launchApp, type LaunchedApp } from './harness';

// Lab3 / blank_project are private fixtures: skip the whole file without them (public specs: public-demo.spec.ts).
test.skip(!hasFixtures, NO_FIXTURES);

let s: LaunchedApp | undefined;

test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

test('hiwave window: layout, source, breakpoint, run, registers', async () => {
  const dir = copyFixture('Lab3');
  // (not `--debug` on the command line: Electron's Node takes it as the removed `node --debug` flag and exits)
  s = await launchApp({ args: ['--open', join(dir, 'Lab3.mcp')] });
  const ide = await s.ideWindow();
  await expect(ide.getByTestId('project-files')).toContainText('main.asm');
  await ide.getByTestId('pw-debug').click();
  const dbg = await s.debuggerWindow();
  await expect(dbg).toHaveTitle(/S12 Studio Debugger/);
  await expect(dbg.getByTestId('reg-PC')).toHaveText('C000');

  // MDI windows from ASM_layout.hwl, Data active (last in ACTIVATE)
  for (const t of ['Source', 'Assembly', 'Register', 'Procedure', 'Memory', 'Data', 'Command']) await expect(dbg.getByTestId(`mdi-window-${t}`)).toBeVisible();
  await expect(dbg.getByTestId('mdi-caption-Data')).toHaveClass(/active/);
  // toolbar from the ini TOOLBAR= key
  await expect(dbg.getByTestId('tb-cut')).toBeVisible();
  await expect(dbg.getByTestId('tb-reset')).toBeEnabled();

  // PC = Entry ($C000) is library start-up code without a .dbg: Source says so, Assembly shows it
  await expect(dbg.getByTestId('source-empty')).toHaveAttribute('title', /No source for PC 0xC000/);
  await expect(dbg.getByTestId('asm-row-C000')).toHaveAttribute('data-pc', 'true');
  await expect(dbg.getByTestId('debugger-status')).toContainText('MC9S12XDP512');
  await s.screenshot(dbg, 'build-dbg-core-open');

  // Assembly > Address... main, breakpoint from the margin, F5 runs to it
  await dbg.getByTestId('mdi-caption-Assembly').click();
  await dbg.locator('[data-menu="Assembly"]').click();
  await dbg.locator('[data-menu-id="assembly.address"]').click();
  await dbg.getByTestId('assembly-address-dialog-input').fill('main');
  await dbg.getByTestId('assembly-address-dialog-ok').click();
  await dbg.getByTestId('asm-gutter-4000').click();
  await expect(dbg.getByTestId('asm-row-4000')).toHaveAttribute('data-bp', 'enabled');
  await dbg.keyboard.press('F5');
  await expect(dbg.getByTestId('reg-PC')).toHaveText('4000', { timeout: 30_000 });
  await expect(dbg.getByTestId('debugger-status')).toContainText('Breakpoint');
  await expect(dbg.getByTestId('asm-row-4000')).toHaveAttribute('data-pc', 'true');
  await expect(dbg.getByTestId('reg-PC')).toHaveClass(/changed/);
  // Source now shows main.dbg with the PC line and the breakpoint mark
  const src = dbg.getByTestId('source-component');
  await expect(src).toHaveAttribute('data-pc-line', /^\d+$/);
  const pcLine = await src.getAttribute('data-pc-line');
  await expect(src).toHaveAttribute('data-bp-lines', new RegExp(`(^| )${pcLine}( |$)`));
  // the Monaco view paints the PC bar and the breakpoint glyph
  await expect(src.locator('.monaco-editor .s12-pc-line')).toHaveCount(1);
  await expect(src.locator('.monaco-editor .s12-bp')).toHaveCount(1);
  await expect(dbg.getByTestId('headline-Source')).toContainText('main.dbg');
  await s.screenshot(dbg, 'build-dbg-core-breakpoint');

  // assembly step (Ctrl+F11): the PC changes, procedure list follows
  await dbg.keyboard.press('Control+F11');
  await expect(dbg.getByTestId('reg-PC')).not.toHaveText('4000');
  await expect(dbg.getByTestId('proc-frame-0')).toBeVisible();

  // Register: in-place edit of IX
  await dbg.getByTestId('reg-X').dblclick();
  await dbg.getByTestId('reg-edit-X').fill('1234');
  await dbg.getByTestId('reg-edit-X').press('Enter');
  await expect(dbg.getByTestId('reg-X')).toHaveText('1234');

  // Component > Open lists every component
  await dbg.locator('[data-menu="Component"]').click();
  await dbg.locator('[data-menu-id="component.open"]').click();
  await expect(dbg.getByTestId('component-open-dialog')).toBeVisible();
  await s.screenshot(dbg, 'build-dbg-core-component-open');
  await dbg.getByTestId('component-option-Terminal').click();
  await dbg.getByTestId('component-open-ok').click();
  await expect(dbg.getByTestId('mdi-window-Terminal')).toBeVisible();

  // Window > Tile
  await dbg.locator('[data-menu="Window"]').click();
  await dbg.locator('[data-menu-id="window.tile"]').click();
  await s.screenshot(dbg, 'build-dbg-core-tile');
});

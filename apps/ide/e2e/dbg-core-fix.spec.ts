/**
 * Debugger core fixes E2E (dbg-core review): register edit of a hex value that looks binary (0B10), Source PC line
 * after Set Program Counter (no halt), Monaco Source view (PC bar, breakpoint glyph, conditional glyph), Register Bin
 * columns at a large font without overlap, `OPEN comp x y w h;I`, Assembly PgDn/PgUp symmetry.
 * Screenshots: fix-dbg-core-*.png.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { copyFixture, hasFixtures, NO_FIXTURES, launchApp, type LaunchedApp } from './harness';

// Lab3 / blank_project are private fixtures: skip the whole file without them (public specs: public-demo.spec.ts).
test.skip(!hasFixtures, NO_FIXTURES);

let s: LaunchedApp | undefined;

test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

async function command(dbg: Page, line: string) {
  const input = dbg.getByTestId('command-component').getByLabel('Command');
  await input.fill(line);
  await input.press('Enter');
}

test('dbg-core fixes on Lab3', async () => {
  const dir = copyFixture('Lab3');
  s = await launchApp({ args: ['--open', join(dir, 'Lab3.mcp')] });
  const ide = await s.ideWindow();
  await expect(ide.getByTestId('project-files')).toContainText('main.asm');
  await ide.getByTestId('pw-debug').click();
  const dbg = await s.debuggerWindow();
  await expect(dbg.getByTestId('reg-PC')).toHaveText('C000');

  // run to main through a breakpoint set by command
  await command(dbg, 'bs main');
  await dbg.keyboard.press('F5');
  await expect(dbg.getByTestId('reg-PC')).toHaveText('4000', { timeout: 30_000 });
  const src = dbg.getByTestId('source-component');
  await expect(src).toHaveAttribute('data-pc-line', /^\d+$/);
  const haltLine = Number(await src.getAttribute('data-pc-line'));
  await expect(src.locator('.monaco-editor .s12-pc-line')).toHaveCount(1);
  await s.screenshot(dbg, 'fix-dbg-core-source-monaco');

  // finding 1: X = 0x0B10, double-click + Enter keeps 0B10
  await command(dbg, 'RS X=0x0B10');
  await expect(dbg.getByTestId('reg-X')).toHaveText('0B10');
  await dbg.getByTestId('reg-X').dblclick();
  await expect(dbg.getByTestId('reg-edit-X')).toHaveValue('0B10');
  await dbg.getByTestId('reg-edit-X').press('Enter');
  await expect(dbg.getByTestId('reg-X')).toHaveText('0B10');

  // finding 2: Set Program Counter (PC edit in the Register window, no halt) moves the Source PC line
  await dbg.getByTestId('reg-PC').dblclick();
  await dbg.getByTestId('reg-edit-PC').fill('4003');
  await dbg.getByTestId('reg-edit-PC').press('Enter');
  await expect(dbg.getByTestId('reg-PC')).toHaveText('4003');
  await expect(src).not.toHaveAttribute('data-pc-line', String(haltLine));
  const newLine = Number(await src.getAttribute('data-pc-line'));
  expect(newLine).toBeGreaterThan(haltLine);
  await expect(dbg.getByTestId('asm-row-4003')).toHaveAttribute('data-pc', 'true');
  await s.screenshot(dbg, 'fix-dbg-core-set-pc');

  // conditional breakpoint glyph (finding 3: per-kind margin icons) by command on the PC line address
  await command(dbg, 'BS 0x4003 P ;cond="A==0x55" E');
  await expect(src).toHaveAttribute('data-bp-lines', new RegExp(`(^| )${newLine}( |$)`));
  await expect(src.locator('.monaco-editor .s12-bp-conditional')).toHaveCount(1);

  // finding 4: Register in Bin at font 14: value cells do not overlap
  await command(dbg, 'Register < attributes FORMAT bin');
  await command(dbg, 'FONT "Courier New" 14');
  await expect(dbg.getByTestId('reg-D')).toHaveText(/^[01]{8} [01]{8}$/);
  const cells = dbg.locator('[data-testid="register-component"] .s12-reg-grid').first().locator('.s12-reg');
  const n = await cells.count();
  expect(n).toBeGreaterThan(4);
  for (let i = 0; i < n; i++) {
    const cell = (await cells.nth(i).boundingBox())!;
    const value = (await cells.nth(i).locator('.s12-reg-value').boundingBox())!;
    // the value ends inside its grid cell (+ the 8px column gap): no overlap with the next register
    expect(value.x + value.width).toBeLessThanOrEqual(cell.x + cell.width + 8.5);
  }
  await s.screenshot(dbg, 'fix-dbg-core-register-bin-font14');
  await command(dbg, 'Register < attributes FORMAT hex');
  await command(dbg, 'FONT "Courier New" 9');

  // finding 6: OPEN with ;I opens iconic at the given rectangle
  await command(dbg, 'OPEN terminal 5 5 30 30;I');
  await expect(dbg.getByTestId('mdi-window-Terminal')).toHaveClass(/minimized/);

  // finding 10: Assembly PgDn then PgUp returns to the same top (also in erased code before Entry)
  await command(dbg, 'Assembly < SPC 0xBFF7');
  const asm = dbg.getByTestId('assembly-component');
  const firstRow = () => asm.locator('[data-testid^="asm-row-"]').first().getAttribute('data-testid');
  await expect(asm.getByTestId('asm-row-BFF7')).toBeVisible();
  const top0 = await firstRow();
  console.log('assembly top before PgDn', top0);
  await asm.focus();
  await dbg.keyboard.press('PageDown');
  await expect.poll(firstRow).not.toBe(top0);
  console.log('assembly top after PgDn', await firstRow());
  await dbg.keyboard.press('PageUp');
  await expect.poll(firstRow).toBe(top0);
  await s.screenshot(dbg, 'fix-dbg-core-final');
});

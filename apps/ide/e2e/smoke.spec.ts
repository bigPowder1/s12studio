/**
 * Smoke E2E: open a temp copy of fixtures/Lab3/Lab3.mcp from the command line, see main.asm in the project window,
 * Project > Debug opens the debugger window and loads bin/Project.abs (halted at Entry $C000), one assembly step
 * changes PC. Screenshots of both windows go to $S12_SCREENS_DIR.
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

test('open Lab3, debug, step once', async () => {
  const dir = copyFixture('Lab3');
  s = await launchApp({ args: ['--open', join(dir, 'Lab3.mcp')] });

  const ide = await s.ideWindow();
  const files = ide.getByTestId('project-files');
  await expect(files).toContainText('main.asm');
  await expect(files).toContainText('ME305LibV4.0.lib');
  await expect(ide).toHaveTitle(/Lab3/);
  await s.screenshot(ide, 'ide-lab3');

  await ide.getByTestId('pw-debug').click();
  const dbg = await s.debuggerWindow();
  await s.screenshot(dbg, 'debugger-lab3-open');
  await expect(dbg).toHaveTitle(/S12 Studio Debugger/);
  const pc = dbg.getByTestId('reg-PC');
  await expect(pc).toHaveText('C000');
  await expect(dbg.getByTestId('debugger-status')).toContainText('MHz');

  await dbg.getByTestId('tb-asm-step').click();
  await expect(pc).not.toHaveText('C000');
  await expect(dbg.getByTestId('debugger-status')).toContainText('TRACED');
  await expect(dbg.getByTestId('command-component')).toContainText('Postload command file correctly executed.');
  await s.screenshot(dbg, 'debugger-lab3-step');
  await s.screenshot(ide, 'ide-lab3-after-debug');
});

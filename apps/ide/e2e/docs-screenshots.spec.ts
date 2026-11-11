/**
 * Screenshots for README.md and the download site (docs-site/img/*.png), taken from the PUBLIC demo examples/blinky
 * only (never a lab solution or course content). Skipped unless S12_DOCS_SCREENSHOTS is set:
 *
 *   npm run build -w @s12/ide
 *   S12_DOCS_SCREENSHOTS=$PWD/docs-site/img npm run e2e:nobuild -w @s12/ide -- docs-screenshots.spec.ts
 *
 * Writes ide.png (blinky open after Make), debugger.png (running, ME3305 Board panel with the demo's LCD text and lit
 * LEDs) and new-project.png (File > New, Project Parameters page), each 1280x800 (the size docs-site/index.html
 * declares). The demo is copied to <os tmp>/demo/blinky and new projects are placed in <os tmp>/demo, so no personal
 * path shows in the pictures. Look at every picture before committing it.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoDir } from '../scripts/env.mjs';
import { launchApp, type LaunchedApp } from './harness';

const OUT = process.env.S12_DOCS_SCREENSHOTS;
test.skip(!OUT, 'set S12_DOCS_SCREENSHOTS=<dir> to (re)generate the README/docs-site screenshots');

const W = 1280;
const H = 800;
const DEMO_BASE = join(tmpdir(), 'demo');

let s: LaunchedApp | undefined;
test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** Copy examples/blinky to <tmp>/demo/blinky (fresh); returns the project file. */
function demoCopy(): string {
  const dest = join(DEMO_BASE, 'blinky');
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(DEMO_BASE, { recursive: true });
  cpSync(join(repoDir, 'examples', 'blinky'), dest, { recursive: true });
  for (const out of ['bin', 'blinky_Data']) rmSync(join(dest, out), { recursive: true, force: true });
  return join(dest, 'blinky.s12studio.json');
}

/** Resize the window showing `page` to a W x H content area (un-maximized). */
async function resize(app: ElectronApplication, page: Page): Promise<void> {
  const title = await page.title();
  await app.evaluate(
    ({ BrowserWindow }, a) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === a.title) ?? BrowserWindow.getFocusedWindow();
      if (!w) return;
      if (w.isMaximized()) w.unmaximize();
      w.setContentSize(a.w, a.h);
    },
    { title, w: W, h: H },
  );
  // the e2e tsconfig has no DOM lib: globalThis is the page's window here
  await expect.poll(() => page.evaluate(() => { const g = globalThis as unknown as { innerWidth: number; innerHeight: number }; return `${g.innerWidth}x${g.innerHeight}`; }), { timeout: 10_000 }).toBe(`${W}x${H}`);
  await page.waitForTimeout(400); // layout settles (child windows, Monaco)
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT!, { recursive: true });
  await page.screenshot({ path: join(OUT!, `${name}.png`) });
}

async function menu(page: Page, top: string, id: string): Promise<void> {
  await page.locator(`[role=menubar] > [data-menu="${top}"]`).click();
  await page.locator(`[data-menu-id="${id}"]`).click();
}

test('docs screenshots: ide.png + debugger.png (examples/blinky)', async () => {
  test.setTimeout(180_000);
  const project = demoCopy();
  const src = readFileSync(join(DEMO_BASE, 'blinky', 'Sources', 'main.asm'), 'latin1');
  const msg1 = /^msg1:\s+DC\.B\s+'([^']*)'/m.exec(src)![1]!;
  s = await launchApp({ args: ['--open', project] });
  const ide = await s.ideWindow();
  await expect(ide).toHaveTitle(/blinky/, { timeout: 30_000 });
  await resize(s.app, ide);

  // open main.asm in the editor, Make
  const mainRow = ide.locator('tr[data-key="f:main.asm"]');
  await expect(mainRow).toBeVisible();
  await mainRow.dblclick();
  await expect(ide.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 });
  await mainRow.click();
  await ide.keyboard.press('F7');
  await expect(ide.getByTestId('ide-status')).toContainText(/Build done: 0 error\(s\)/, { timeout: 60_000 });
  await ide.waitForTimeout(500);
  await shot(ide, 'ide');

  // debugger + ME3305 board window, run
  await ide.keyboard.press('F5');
  const dbg = await s.debuggerWindow();
  await expect(dbg.getByTestId('reg-PC')).toHaveText(/^[0-9A-F]{4}$/, { timeout: 60_000 });
  await resize(s.app, dbg);
  // the ME3305 board has its own window, opened with the session
  const bw = await s.boardWindow();
  await expect(bw.getByTestId('me3305-board')).toBeVisible();
  await dbg.keyboard.press('F5');
  await expect(dbg.getByTestId('debugger-status')).toContainText('RUNNING');
  await expect(bw.getByTestId('lcd-row-0')).toContainText(msg1, { timeout: 30_000 });
  // a moment when PP4 is lit (PP4+PP6 or PP5+PP7 are always on)
  await expect.poll(async () => bw.getByTestId('led-PP4').getAttribute('data-on'), { timeout: 15_000, intervals: [50] }).toBe('1');
  // debugger.png shows the board window floating over the debugger: its picture is laid over the debugger page for
  // the shot (a page screenshot has only its own window)
  const boardPng = (await bw.screenshot()).toString('base64');
  await dbg.evaluate((b64) => {
    // page-side code (the spec is typed for Node: no DOM lib)
    type El = { id: string; style: Record<string, string>; textContent: string; src: string; append(...n: El[]): void };
    const document = (globalThis as unknown as { document: { createElement(t: string): El; body: El } }).document;
    const d = document.createElement('div');
    d.id = 'docs-board-overlay';
    Object.assign(d.style, { position: 'fixed', right: '18px', top: '64px', border: '1px solid #404040', boxShadow: '4px 4px 14px rgba(0,0,0,.45)', background: '#d4d0c8', zIndex: '99999' });
    const cap = document.createElement('div');
    cap.textContent = 'ME3305 Board';
    Object.assign(cap.style, { background: 'linear-gradient(90deg,#0a246a,#a6caf0)', color: '#fff', font: 'bold 11px Tahoma, sans-serif', padding: '3px 6px' });
    const img = document.createElement('img');
    img.src = `data:image/png;base64,${b64}`;
    img.style.display = 'block';
    d.append(cap, img);
    document.body.append(d);
  }, boardPng);
  await dbg.waitForTimeout(200);
  await shot(dbg, 'debugger');
  await dbg.evaluate(() => (globalThis as unknown as { document: { getElementById(id: string): { remove(): void } | null } }).document.getElementById('docs-board-overlay')?.remove());
  await dbg.keyboard.press('F6');
});

test('docs screenshots: new-project.png (File > New, Project Parameters)', async () => {
  test.setTimeout(120_000);
  s = await launchApp();
  const ide = await s.ideWindow();
  await resize(s.app, ide);
  await menu(ide, 'File', 'file.new');
  const np = ide.getByTestId('new-project-dialog');
  await expect(np.getByTestId('np-page-device')).toContainText('MC9S12XDP512');
  await np.getByTestId('np-next').click();
  await expect(np.getByTestId('np-template-hint')).toHaveAttribute('data-course', /^(true|false)$/, { timeout: 15_000 });
  await np.getByTestId('np-templates').getByText('MC9S12XDP512 assembly (generic)').click();
  await np.getByTestId('np-name').fill('MyProject');
  await np.getByTestId('np-dir').fill(DEMO_BASE);
  await ide.mouse.move(0, 0);
  await ide.waitForTimeout(300);
  await shot(ide, 'new-project');
});

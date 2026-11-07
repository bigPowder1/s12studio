/** Demo project (examples/blinky): source lookup and the writable copy under Documents. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiError } from '../../shared/api/common';
import { DEMO_PROJECT_FILE, demoProjectCopy, demoProjectSource, prepareDemoProject } from './examples-dir';

const root = mkdtempSync(join(tmpdir(), 's12-examples-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fake bundled demo with build outputs next to it (a checkout's examples/blinky after a Make). */
function bundled(dir: string): string {
  const b = join(dir, 'blinky');
  mkdirSync(join(b, 'Sources'), { recursive: true });
  mkdirSync(join(b, 'bin'), { recursive: true });
  mkdirSync(join(b, 'blinky_Data', 'Standard'), { recursive: true });
  writeFileSync(join(b, DEMO_PROJECT_FILE), '{}');
  writeFileSync(join(b, 'Sources', 'main.asm'), '; demo\n');
  writeFileSync(join(b, 'bin', 'Project.abs'), 'x');
  return join(b, DEMO_PROJECT_FILE);
}

describe('demoProjectSource', () => {
  const base = { appDir: '/repo/apps/ide', resourcesPath: '/opt/s12/resources' };
  it('env override, then <resources>/examples (packaged) or <repo>/examples (checkout)', () => {
    expect(demoProjectSource({ ...base, env: { S12_EXAMPLES_DIR: '/ex' }, packaged: true })).toBe(join(resolve('/ex'), 'blinky', DEMO_PROJECT_FILE));
    expect(demoProjectSource({ ...base, env: {}, packaged: true })).toBe(join('/opt/s12/resources', 'examples', 'blinky', DEMO_PROJECT_FILE));
    expect(demoProjectSource({ ...base, env: {}, packaged: false })).toBe(join('/repo/apps/ide', '../../examples', 'blinky', DEMO_PROJECT_FILE));
  });

  it('the checkout default points at the real examples/blinky', () => {
    const appDir = fileURLToPath(new URL('../../..', import.meta.url));
    expect(existsSync(demoProjectSource({ env: {}, appDir, packaged: false, resourcesPath: '' }))).toBe(true);
  });
});

describe('prepareDemoProject', () => {
  it('copies the demo (without build outputs) to Documents/S12 Studio/Demo (blinky), then reuses the copy', async () => {
    const src = bundled(join(root, 'res1'));
    const docs = join(root, 'docs1');
    const p = await prepareDemoProject(src, docs);
    expect(p).toBe(demoProjectCopy(docs));
    expect(p).toBe(join(docs, 'S12 Studio', 'Demo (blinky)', DEMO_PROJECT_FILE));
    expect(readFileSync(join(docs, 'S12 Studio', 'Demo (blinky)', 'Sources', 'main.asm'), 'utf8')).toBe('; demo\n');
    expect(existsSync(join(docs, 'S12 Studio', 'Demo (blinky)', 'bin'))).toBe(false);
    expect(existsSync(join(docs, 'S12 Studio', 'Demo (blinky)', 'blinky_Data'))).toBe(false);

    // the student's edits survive the next open; the bundled source is never written
    writeFileSync(join(docs, 'S12 Studio', 'Demo (blinky)', 'Sources', 'main.asm'), '; edited\n');
    expect(await prepareDemoProject(src, docs)).toBe(p);
    expect(readFileSync(join(docs, 'S12 Studio', 'Demo (blinky)', 'Sources', 'main.asm'), 'utf8')).toBe('; edited\n');
    expect(readFileSync(join(root, 'res1', 'blinky', 'Sources', 'main.asm'), 'utf8')).toBe('; demo\n');
  });

  it('a leftover folder without the project file is kept aside, not merged into', async () => {
    const src = bundled(join(root, 'res2'));
    const docs = join(root, 'docs2');
    mkdirSync(join(docs, 'S12 Studio', 'Demo (blinky)'), { recursive: true });
    writeFileSync(join(docs, 'S12 Studio', 'Demo (blinky)', 'notes.txt'), 'mine');
    const p = await prepareDemoProject(src, docs);
    expect(existsSync(p)).toBe(true);
    expect(existsSync(join(docs, 'S12 Studio', 'Demo (blinky)', 'notes.txt'))).toBe(false);
    const aside = readdirSync(join(docs, 'S12 Studio')).find((n) => n.startsWith('Demo (blinky) (old '));
    expect(readFileSync(join(docs, 'S12 Studio', aside!, 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('reports a missing demo as not-found', async () => {
    const e = await prepareDemoProject(join(root, 'nothing', 'blinky', DEMO_PROJECT_FILE), join(root, 'docs3')).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('not-found');
    expect(existsSync(join(root, 'docs3', 'S12 Studio', 'Demo (blinky)'))).toBe(false);
  });
});

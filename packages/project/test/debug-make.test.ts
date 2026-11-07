/**
 * Project > Debug runs Make (not Bring Up To Date) so the debugger never loads a stale .abs. On the public
 * examples/blinky: an edit assembled by Bring Up To Date alone is still linked by the next Make; an up-to-date
 * project makes nothing (Debug launches at once); a source error stops the Make with the error reported.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryFs, bringUpToDate, installCompilerRoot, make, openProject, type Project } from '../src/index';
import { REPO } from '../../formats/test/fixtures';

const EXAMPLE = join(REPO, 'examples', 'blinky');
const DEST = '/work/blinky';
const MAIN = `${DEST}/Sources/main.asm`;
const ABS = `${DEST}/bin/Project.abs`;

describe('Make before Debug (B2)', () => {
  const fs = new MemoryFs();
  let proj: Project;
  let source: string;

  beforeAll(async () => {
    const rec = (rel: string) => {
      for (const n of readdirSync(join(EXAMPLE, rel))) {
        const r = rel ? `${rel}/${n}` : n;
        if (statSync(join(EXAMPLE, r)).isDirectory()) rec(r);
        else fs.writeSync(`${DEST}/${r}`, new Uint8Array(readFileSync(join(EXAMPLE, r))));
      }
    };
    rec('');
    await installCompilerRoot(fs, '/cw');
    proj = await openProject(fs, `${DEST}/blinky.s12studio.json`, { compilerDir: '/cw' });
    source = Buffer.from(fs.readSync(MAIN)!).toString('latin1');
    expect((await make(proj, { user: 'student' })).ok).toBe(true);
  });

  it('an up-to-date project: Make assembles and links nothing and reports the existing .abs', async () => {
    const r = await make(proj, { user: 'student' });
    expect(r).toMatchObject({ ok: true, upToDate: true, compiled: [], linked: false, absPath: ABS });
  });

  it('Bring Up To Date alone leaves the .abs stale; the following Make links it', async () => {
    const before = fs.readSync(ABS)!;
    // a changed program: one more NOP at the end of the source
    fs.writeSync(MAIN, Buffer.from(source.replace(/\s*$/, '') + '\r\n            NOP\r\n', 'latin1'));
    const btd = await bringUpToDate(proj, { user: 'student' });
    expect(btd).toMatchObject({ ok: true, compiled: ['main.asm'], linked: false });
    expect(fs.readSync(ABS)).toEqual(before);

    const r = await make(proj, { user: 'student' });
    expect(r).toMatchObject({ ok: true, compiled: [], linked: true, absPath: ABS });
    expect(fs.readSync(ABS)).not.toEqual(before);
  });

  it('a source error: Make fails with the error and no .abs is reported to debug', async () => {
    fs.writeSync(MAIN, Buffer.from(source + '\r\n            BOGUS   #1\r\n', 'latin1'));
    const r = await make(proj, { user: 'student' });
    expect(r.ok).toBe(false);
    expect(r.errors).toBeGreaterThan(0);
    expect(r.linked).toBe(false);
    expect(r.absPath).toBeUndefined();
    expect(r.messages.find((m) => m.severity === 'error')?.file).toBe(MAIN);
  });
});

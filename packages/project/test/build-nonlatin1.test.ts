/**
 * A project folder (or user name) with characters above U+00FF ("Lab 4 – 학생": en dash + Hangul) must still build.
 * CodeWarrior's tools are 8-bit: such characters become '?' in every path or name the build records (object/.abs
 * .note command line and user, DWARF comp_dir, listing/.dbg/.map text, the S19 S0 header). Uses the public
 * examples/blinky only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiwareNoteType, noteDescString, parseHiwareNotes, readElf } from '@s12/formats';
import { createNodeFs, installCompilerRoot, make, openProject } from '../src/index';
import { REPO } from '../../formats/test/fixtures';

const EXAMPLE = join(REPO, 'examples', 'blinky');
const FOLDER = 'Lab 4 – 학생';

const noteText = (elf: Uint8Array, type: number): string => {
  const note = readElf(elf).sections.find((s) => s.name === '.note')!;
  return noteDescString(parseHiwareNotes(note.data).notes.find((n) => n.type === type)!.desc);
};

describe('build in a folder with non-Latin-1 characters', () => {
  const tmp = mkdtempSync(join(tmpdir(), 's12-nonlatin1-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it(`Make of examples/blinky in "${FOLDER}": 0 errors, outputs written, '?' in recorded paths`, async () => {
    const dir = join(tmp, FOLDER);
    const fs = createNodeFs();
    // the app's own copy (fs/promises cp, as for the Documents demo copy); Node's native cpSync is not used for this
    await fs.copyDir!(EXAMPLE, dir);
    expect(readdirSync(tmp)).toContain(FOLDER);
    const cw = join(tmp, 'cw');
    await installCompilerRoot(fs, cw);
    const proj = await openProject(fs, join(dir, 'blinky.s12studio.json'), { compilerDir: cw });
    const r = await make(proj, { user: 'Nguyễn Văn 학생', stamp: () => 'Thu Nov 05 12:00:00 2026' });
    expect(r.messages.map((m) => m.display)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.linked).toBe(true);
    for (const out of ['bin/Project.abs', 'bin/Project.abs.s19', 'bin/Project.map', 'bin/main.dbg']) expect(existsSync(join(dir, out)), out).toBe(true);

    const abs = new Uint8Array(readFileSync(join(dir, 'bin', 'Project.abs')));
    expect(noteText(abs, HiwareNoteType.User)).toBe('Nguy?n V?n ??');
    expect(noteText(abs, HiwareNoteType.CommandLine)).toContain('Lab 4 ? ??');
    // the S0 record carries the .abs path: the en dash and Hangul are single '?' bytes (0x3F), Latin-1 is kept
    const s0 = readFileSync(join(dir, 'bin', 'Project.abs.s19'), 'latin1').split('\r\n')[0];
    const s0Text = Buffer.from(s0.slice(8, -2), 'hex').toString('latin1');
    expect(s0Text).toContain('Lab 4 ? ??');
    expect(s0Text).not.toMatch(/[\x00-\x1f\x80-\xff]/);
    // text outputs: no stray control bytes from truncated code units
    const map = readFileSync(join(dir, 'bin', 'Project.map'), 'latin1');
    expect(map).toContain('Lab 4 ? ??');
    expect(map).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  });

  it('a second Make is up to date (the build cache handles the folder name)', async () => {
    const fs = createNodeFs();
    const cw = join(tmp, 'cw');
    const proj = await openProject(fs, join(tmp, FOLDER, 'blinky.s12studio.json'), { compilerDir: cw });
    const r = await make(proj, { user: 'Nguyễn Văn 학생' });
    expect(r.ok).toBe(true);
    expect(r.upToDate).toBe(true);
    expect(r.compiled).toEqual([]);
  });
});

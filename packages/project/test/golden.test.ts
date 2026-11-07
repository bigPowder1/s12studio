// Golden: a Make of the fixture projects (outputs deleted) regenerates CodeWarrior's files byte for byte when the
// lab PC's paths, user name and time stamps are injected; with our own metadata only those fields differ.
import { describe, expect, it } from 'vitest';
import { PT_LOAD, readElf, readSRecords } from '@s12/formats';
import { make } from '../src/index';
import { DATA_DIR, freshProject, goldenBuildOptions, goldenBytes, latin1, OUTPUTS, describeFx } from './helpers';

const PATH_DEPENDENT_SECTIONS = new Set(['.note', '.debug_info', '.debug_line']);

for (const project of ['Lab3', 'blank_project']) {
  describeFx(`golden Make ${project}`, async () => {
    const { fs, proj, dir } = await freshProject(project);
    const mcpBefore = fs.readSync(`${dir}/${proj.name}.mcp`)!.slice();
    const progress: string[] = [];
    const r = await make(proj, { ...goldenBuildOptions(project), onProgress: (p) => progress.push(p.step) });

    it('builds without messages', () => {
      expect(r.messages).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.compiled).toEqual(['main.asm']);
      expect(r.linked).toBe(true);
      expect(r.burned).toBe(true);
      expect(progress[0]).toBe('check');
      expect(progress).toContain('link');
      expect(progress.at(-1)).toBe('done');
    });

    for (const o of OUTPUTS(project)) {
      it(`${o} is byte-identical`, () => {
        const got = fs.readSync(`${dir}/${o}`);
        expect(got, o).toBeDefined();
        const gold = goldenBytes(project, o);
        if (!Buffer.from(got!).equals(Buffer.from(gold))) expect(latin1(got)).toBe(latin1(gold));
      });
    }

    it('also writes the full-image S19 and the build cache, never TargetDataWindows.tdt or the .mcp', () => {
      expect(fs.readSync(`${dir}/bin/Project.abs.full.s19`)).toBeDefined();
      expect(fs.readSync(`${dir}/${DATA_DIR[project]}/Standard/s12studio-build.json`)).toBeDefined();
      expect(fs.writes.some((w) => w.endsWith('.tdt'))).toBe(false);
      expect(Buffer.from(fs.readSync(`${dir}/${proj.name}.mcp`)!).equals(Buffer.from(mcpBefore))).toBe(true);
      expect(r.files[0]).toMatchObject({ name: 'main.asm', ok: true, compiled: true });
      expect(r.files[0].code).toBeGreaterThan(0);
    });
  });

  describeFx(`normal Make ${project} (our own metadata)`, async () => {
    const { fs, proj, dir } = await freshProject(project);
    const r = await make(proj, { user: 'student', stamp: () => 'Thu Oct 29 12:00:00 2026' });
    const out = (o: string) => fs.readSync(`${dir}/${o}`)!;

    it('builds', () => expect(r.ok).toBe(true));

    it('listing and .dbg are identical (no paths inside)', () => {
      expect(latin1(out('bin/main.lst'))).toBe(latin1(goldenBytes(project, 'bin/main.lst')));
      expect(latin1(out('bin/main.dbg'))).toBe(latin1(goldenBytes(project, 'bin/main.dbg')));
    });

    it('map differs only in the PROGRAM line', () => {
      const a = latin1(out('bin/Project.map')).split('\r\n');
      const b = latin1(goldenBytes(project, 'bin/Project.map')).split('\r\n');
      const i = b.findIndex((l) => l.startsWith('PROGRAM '));
      expect(a[i]).toBe(`PROGRAM "${dir}/bin/Project.abs"`);
      expect([...a.slice(0, i), ...a.slice(i + 1)]).toEqual([...b.slice(0, i), ...b.slice(i + 1)]);
    });

    it('S-records differ only in the S0 header', () => {
      for (const f of ['bin/Project.abs.s19', 'bin/Project.abs.glo']) {
        const a = latin1(out(f)).split('\r\n');
        const b = latin1(goldenBytes(project, f)).split('\r\n');
        expect(readSRecords(a.join('\r\n')).header).toBe(`${dir}/bin/Project.abs`);
        expect(a.slice(1)).toEqual(b.slice(1));
      }
    });

    it('.abs and object differ only in the .note and the path-bearing DWARF sections', () => {
      const pairs: [Uint8Array, Uint8Array][] = [
        [out('bin/Project.abs'), goldenBytes(project, 'bin/Project.abs')],
        [out(`${DATA_DIR[project]}/Standard/ObjectCode/main.asm.o`), goldenBytes(project, `${DATA_DIR[project]}/Standard/ObjectCode/main.asm.o`)],
      ];
      for (const [mine, gold] of pairs) {
        const a = readElf(mine), b = readElf(gold);
        expect(a.sections.map((s) => s.name)).toEqual(b.sections.map((s) => s.name));
        const differing = a.sections.filter((s, i) => !Buffer.from(s.data).equals(Buffer.from(b.sections[i].data))).map((s) => s.name);
        for (const d of differing) expect(PATH_DEPENDENT_SECTIONS.has(d) || d.startsWith('.rela.debug') || d === '.shstrtab', d).toBe(true);
        expect(differing).toContain('.note');
        const load = (e: typeof a) => e.programHeaders.filter((p) => p.type === PT_LOAD).map((p) => [p.vaddr, p.filesz]);
        expect(load(a)).toEqual(load(b));
      }
    });

    it('records our metadata in the .note', () => {
      const note = latin1(readElf(out('bin/Project.abs')).sections.find((s) => s.name === '.note')!.data);
      expect(note).toContain('student');
      expect(note).toContain('Thu Oct 29 12:00:00 2026');
      expect(note).toContain(`-o"${dir}/bin/Project.abs"`);
    });
  });
}

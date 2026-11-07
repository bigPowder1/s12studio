/**
 * Golden tests: assembling the fixture sources must reproduce CodeWarrior's outputs byte for byte.
 *  - bin/main.lst (listing), bin/main.dbg (debug source),
 *  - <proj>_Data/Standard/ObjectCode/main.asm.o (ELF object, with the .note user/time/command line and the
 *    DWARF comp_dir/.dbg path taken from the golden object: they depend on the build machine).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixture, describeFx, hasFixtures } from '../../formats/test/fixtures';
import { readElf, readRelocationSections, readSymbols } from '@s12/formats';
import { assemble } from '../src/index.js';
import { goldenMeta, LAB_OPTIONS, projectReader } from './helpers.js';

const CASES = !hasFixtures ? [] : [
  { project: 'Lab3', obj: 'Lab3_Data/Standard/ObjectCode/main.asm.o' },
  { project: 'blank_project', obj: 'blank_project_Data/Standard/ObjectCode/main.asm.o' },
];

// without the private fixtures: one skipped placeholder with the reason (the cases above are empty)
if (!hasFixtures) describeFx('golden main.asm', () => {});

describe.each(CASES)('$project main.asm', ({ project, obj }) => {
  const goldObj = new Uint8Array(readFileSync(fixture(project, obj)));
  const meta = goldenMeta(goldObj);
  const r = assemble({
    sourcePath: 'Sources\\main.asm',
    readFile: projectReader(project),
    options: LAB_OPTIONS,
    env: { TEXTPATH: meta.compDir, OBJPATH: meta.compDir },
    noteMeta: { user: meta.user, time: meta.time, commandLine: meta.commandLine },
  });

  it('assembles without messages', () => {
    expect(r.messages).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('listing is byte-identical to bin/main.lst', () => {
    const gold = readFileSync(fixture(project, 'bin/main.lst'), 'latin1');
    expect(r.listing).toBeDefined();
    expect(r.listing!.path).toBe(meta.compDir + '\\main.lst');
    expect(r.listing!.text).toBe(gold);
  });

  it('.dbg is byte-identical to bin/main.dbg', () => {
    const gold = readFileSync(fixture(project, 'bin/main.dbg'), 'latin1');
    expect(r.dbg.text).toBe(gold);
    expect(r.dbg.path).toBe(meta.dbgPath);
  });

  it('object is byte-identical to main.asm.o', () => {
    expect(Buffer.from(r.objectBytes!).equals(Buffer.from(goldObj))).toBe(true);
  });

  it('object structure matches section by section (diagnostic)', () => {
    const a = readElf(r.objectBytes!);
    const b = readElf(goldObj);
    expect(a.sections.map((s) => s.name)).toEqual(b.sections.map((s) => s.name));
    for (let i = 0; i < a.sections.length; i++) {
      expect(Buffer.from(a.sections[i].data).equals(Buffer.from(b.sections[i].data)), a.sections[i].name).toBe(true);
    }
    expect(readSymbols(a)).toEqual(readSymbols(b));
    expect(readRelocationSections(a).map((x) => x.relocs)).toEqual(readRelocationSections(b).map((x) => x.relocs));
  });

  it('object is reproducible without golden paths (structure only)', () => {
    const r2 = assemble({ sourcePath: 'Sources\\main.asm', readFile: projectReader(project), options: LAB_OPTIONS });
    expect(r2.ok).toBe(true);
    const a = readElf(r2.objectBytes!);
    const b = readElf(goldObj);
    expect(readSymbols(a)).toEqual(readSymbols(b));
    for (const name of a.sections.map((s) => s.name).filter((n) => !n.startsWith('.debug_info') && !n.startsWith('.debug_line') && n !== '.note')) {
      const sa = a.sections.find((s) => s.name === name)!;
      const sb = b.sections.find((s) => s.name === name)!;
      if (name === '.shstrtab' || name.startsWith('.rela.debug')) continue;
      expect(Buffer.from(sa.data).equals(Buffer.from(sb.data)), name).toBe(true);
    }
  });
});

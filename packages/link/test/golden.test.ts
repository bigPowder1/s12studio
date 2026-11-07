// Golden tests: relinking the CodeWarrior objects reproduces Project.abs / Project.map / .s19 / .glo byte for byte.
import { describe, expect, it } from 'vitest';
import { readElf, readSRecords, decodeCwCompileUnits, parseAranges } from '@s12/formats';
import { burn, burnFull, link, readNoteMeta, type LinkResult } from '@s12/link';
import { LIB, fixtureText, readFixture, describeFx } from './helpers';

const PROJECTS = [
  { proj: 'Lab3', data: 'Lab3_Data' },
  { proj: 'blank_project', data: 'blank_project_Data' },
] as const;

function relink(proj: string, data: string): { r: LinkResult; absPath: string; goldAbs: Uint8Array; goldMap: string } {
  const goldAbs = readFixture(proj, 'bin', 'Project.abs');
  const goldMap = fixtureText(proj, 'bin', 'Project.map');
  const absPath = /PROGRAM "([^"]*)"/.exec(goldMap)![1];
  const r = link({
    objects: [{ name: 'main.asm.o', bytes: readFixture(proj, data, 'Standard', 'ObjectCode', 'main.asm.o') }],
    libraries: [{ name: 'ME305LibV4.0.lib', bytes: LIB() }],
    prmText: fixtureText(proj, 'prm', 'Project.prm'),
    outputPath: absPath,
    noteMeta: readNoteMeta(goldAbs),
  });
  return { r, absPath, goldAbs, goldMap };
}

for (const { proj, data } of PROJECTS) {
  describeFx(`golden ${proj}`, () => {
    const { r, absPath, goldAbs, goldMap } = relink(proj, data);

    it('links without messages', () => {
      expect(r.messages).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it('Project.abs is byte-identical', () => {
      expect(r.absBytes!.length).toBe(goldAbs.length);
      expect(Buffer.from(r.absBytes!).equals(Buffer.from(goldAbs))).toBe(true);
    });

    it('Project.map is byte-identical', () => {
      expect(r.mapText).toBe(goldMap);
    });

    it('the .abs path in the map equals the S0 header of the golden S19', () => {
      expect(readSRecords(fixtureText(proj, 'bin', 'Project.abs.s19')).header).toBe(absPath);
    });

    it('burner.bbl reproduces Project.abs.s19 and Project.abs.glo byte for byte', () => {
      const b = burn({ absBytes: r.absBytes!, bblText: fixtureText(proj, 'prm', 'burner.bbl'), absPath });
      expect(b.ok).toBe(true);
      expect(b.warnings).toEqual([]);
      expect(b.outputs.map((o) => o.path)).toEqual([`${absPath}.glo`, `${absPath}.s19`]);
      const [glo, s19] = b.outputs;
      expect(Buffer.from(s19.bytes).equals(Buffer.from(readFixture(proj, 'bin', 'Project.abs.s19')))).toBe(true);
      expect(Buffer.from(glo.bytes).equals(Buffer.from(readFixture(proj, 'bin', 'Project.abs.glo')))).toBe(true);
    });

    it('burner also works from the golden .abs and from the parsed ElfFile', () => {
      const bbl = fixtureText(proj, 'prm', 'burner.bbl');
      const a = burn({ absBytes: goldAbs, bblText: bbl, absPath });
      const b = burn({ abs: r.abs!, bblText: bbl, env: { ABS_FILE: absPath } });
      expect(a.outputs.map((o) => o.text)).toEqual(b.outputs.map((o) => o.text));
    });

    it('burnFull adds the EEPROM library code that CodeWarrior leaves out of the S19', () => {
      const full = readSRecords(burnFull(r.absBytes!, { absPath }).text);
      const s19 = readSRecords(fixtureText(proj, 'bin', 'Project.abs.s19'));
      expect(full.header).toBe(absPath);
      expect(full.blocks.some((b) => b.address === 0x800)).toBe(true);
      expect(s19.blocks.some((b) => b.address < 0x4000)).toBe(false);
      const bytes = (f: typeof full) => f.blocks.reduce((n, b) => n + b.data.length, 0);
      const eeprom = r.layout.sections.filter((s) => s.segment === 'EEPROM').reduce((n, s) => n + s.size, 0);
      expect(bytes(full)).toBe(bytes(s19) + eeprom);
    });

    it('debug information of the relinked file decodes (one CU per linked module)', () => {
      const elf = readElf(r.absBytes!);
      const get = (n: string) => elf.sections.find((s) => s.name === n)!.data;
      const cus = decodeCwCompileUnits({ info: get('.debug_info'), abbrev: get('.debug_abbrev'), line: get('.debug_line') });
      expect(cus.map((c) => c.name)).toEqual(r.layout.modules.map((m) => m.name.replace('.asm.o', '.dbg')));
      expect(parseAranges(get('.debug_aranges'))).toHaveLength(r.layout.modules.length);
    });
  });
}

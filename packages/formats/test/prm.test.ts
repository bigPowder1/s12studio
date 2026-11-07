import { describe, it, expect } from 'vitest';
import { readFixture, describeFx } from './fixtures';
import { parsePrm, parsePrmStrict, prmSegment, prmPlacementOf, PrmSyntaxError, parsePrmNumber } from '../src/text/prm';

const lab3 = () => readFixture('Lab3', 'prm', 'Project.prm').toString('latin1');

describeFx('PRM parser: fixtures/Lab3/prm/Project.prm', () => {
  const ast = parsePrm(lab3());

  it('parses without errors', () => {
    expect(ast.errors).toEqual([]);
    expect(ast.commands.map((c) => c.keyword)).toEqual(['NAMES', 'SEGMENTS', 'PLACEMENT', 'ENTRIES', 'STACKSIZE', 'INIT']);
    expect(ast.names).toEqual([]);
    expect(ast.entries).toEqual([]);
    expect(ast.vectors).toEqual([]);
    expect(ast.oldSectionsSyntax).toBe(false);
  });

  it('segments', () => {
    expect(ast.segments).toHaveLength(5 + 3 + 6 + 30);
    expect(ast.segments.slice(0, 5).map((s) => s.name)).toEqual(['EEPROM', 'LIBRAM', 'RAM', 'ROM_4000', 'ROM_C000']);
    expect(prmSegment(ast, 'ROM_4000')).toMatchObject({
      qualifier: 'READ_ONLY', dataModel: 'DATA_NEAR', ibcc: 'IBCC_NEAR', start: 0x4000, end: 0x7fff, size: 0x4000, rangeForm: 'TO', line: 26,
    });
    expect(prmSegment(ast, 'EEPROM')).toMatchObject({ qualifier: 'READ_ONLY', start: 0x0800, end: 0x0ffb, line: 19 });
    expect(prmSegment(ast, 'LIBRAM')).toMatchObject({ qualifier: 'READ_WRITE', dataModel: 'DATA_NEAR', ibcc: undefined, start: 0x1000, end: 0x1fff });
    expect(prmSegment(ast, 'RAM')).toMatchObject({ start: 0x2000, end: 0x3fff });
    expect(prmSegment(ast, 'ROM_C000')).toMatchObject({ start: 0xc000, end: 0xfeff });
    expect(prmSegment(ast, 'EEPROM_FC')).toMatchObject({ dataModel: 'DATA_FAR', ibcc: 'IBCC_FAR', start: 0xfc0800, end: 0xfc0bff });
    expect(prmSegment(ast, 'RAM_F8')).toMatchObject({ qualifier: 'READ_WRITE', dataModel: 'DATA_FAR', start: 0xf81000, end: 0xf81fff });
    expect(prmSegment(ast, 'PAGE_E0')).toMatchObject({ start: 0xe08000, end: 0xe0bfff });
    expect(prmSegment(ast, 'PAGE_FE')).toMatchObject({ start: 0xfe8000, end: 0xfebfff });
    // commented-out definitions must not appear
    for (const n of ['IO_SEG', 'VECTORS', 'OSVECTORS', 'EEPROM_FF', 'RAM_FE', 'PAGE_FD', 'PAGE_FF']) expect(prmSegment(ast, n)).toBeUndefined();
  });

  it('placements', () => {
    expect(ast.placements[0]).toMatchObject({
      sections: ['_PRESTART', 'STARTUP', 'ROM_VAR', 'STRINGS', 'VIRTUAL_TABLE_SEGMENT', 'NON_BANKED', 'COPY'],
      segments: ['ROM_C000'],
      distribute: false,
    });
    expect(prmPlacementOf(ast, 'DEFAULT_ROM')!.segments).toHaveLength(30);
    expect(prmPlacementOf(ast, 'DEFAULT_ROM')!.segments[0]).toBe('PAGE_FE');
    expect(prmPlacementOf(ast, 'SSTACK')).toMatchObject({ sections: ['SSTACK', 'DEFAULT_RAM'], segments: ['RAM'] });
    expect(prmPlacementOf(ast, 'LIBRARY_RAM')!.segments).toEqual(['LIBRAM']);
    expect(prmPlacementOf(ast, 'PAGED_RAM')!.segments).toEqual(['RAM_F8', 'RAM_F9', 'RAM_FA', 'RAM_FB', 'RAM_FC', 'RAM_FD']);
    expect(prmPlacementOf(ast, 'DISTRIBUTE')).toMatchObject({ distribute: true });
    expect(prmPlacementOf(ast, 'DISTRIBUTE')!.segments[0]).toBe('ROM_4000');
    expect(prmPlacementOf(ast, 'DATA_DISTRIBUTE')!.segments).toEqual(['RAM', 'RAM_FD', 'RAM_FC', 'RAM_FB', 'RAM_FA', 'RAM_F9', 'RAM_F8']);
    expect(prmPlacementOf(ast, 'MyCode')).toMatchObject({ segments: ['ROM_4000'], distribute: false });
    for (const lib of ['Lib_Startup', 'Lib_Motor', 'Lib_DAC', 'Lib_Keypad', 'Lib_Encoder', 'Lib_LCD', 'Lib_Delay']) {
      expect(prmPlacementOf(ast, lib)!.segments).toEqual(['EEPROM']);
    }
    expect(prmPlacementOf(ast, '.ostext')).toBeUndefined();
    expect(prmPlacementOf(ast, '.vectors')).toBeUndefined();
    expect(ast.placements).toHaveLength(16);
  });

  it('stack and init', () => {
    expect(ast.stackSize).toBe(0x400);
    expect(ast.stackTop).toBeUndefined();
    expect(ast.init).toBe('Entry');
    expect(ast.main).toBeUndefined();
  });

  it('blank_project PRM is identical in content', () => {
    const b = parsePrm(readFixture('blank_project', 'prm', 'Project.prm').toString('latin1'));
    expect(b.errors).toEqual([]);
    expect(b.segments.length).toBe(ast.segments.length);
    expect(b.init).toBe('Entry');
  });
});

describe('PRM parser: syntax coverage', () => {
  it('numbers', () => {
    expect(parsePrmNumber('0x4000')).toBe(0x4000);
    expect(parsePrmNumber('0400')).toBe(0o400);
    expect(parsePrmNumber('0')).toBe(0);
    expect(parsePrmNumber('1024')).toBe(1024);
    expect(parsePrmNumber('-2')).toBe(-2);
    expect(parsePrmNumber('ROM')).toBeUndefined();
    expect(parsePrmNumber('08')).toBeUndefined();
  });

  it('wizard-style PRM with LINK, VECTOR, SIZE, options, MAPFILE, ENTRIES and comments', () => {
    const src = `LINK out.abs
NAMES main.o +start12.o ansi.lib END
(* Modula comment *)
SEGMENTS
  RAM = READ_WRITE 0x1000 SIZE 0x3000 ALIGN 2 [1:1] FILL 0xFF 0x00;
  ROM = READ_ONLY 0xC000 TO 0xFEFF RELOCATE_TO 0x8000 DO_NOT_OVERLAP_CONSTS CODE;
  NV  = NO_INIT 0x2000 TO 0x20FF;
  IO  = PAGED 0x0000 TO 0x03FF
END
PLACEMENT
  .text, DEFAULT_ROM INTO ROM;
  SSTACK, DEFAULT_RAM INTO RAM; // comment
  .data INTO READ_WRITE 0x3800 TO 0x38FF;
END
ENTRIES * main.o:* lib.o:foo, bar END
STACKTOP 0x3FFF
MAIN main
VECTOR 0 _Startup
VECTOR 8 isr OFFSET 2
VECTOR ADDRESS 0xFFCE 0x4000
HEXFILE out.s19 OFFSET 0x10
MAPFILE SEC_ALLOC, OBJ_ALLOC STATISTIC
DEPENDENCY ROOT main END foo USES bar baz END END
OVERLAP_GROUP a b END
`;
    const a = parsePrm(src);
    expect(a.errors).toEqual([]);
    expect(a.link).toBe('out.abs');
    expect(a.names).toEqual(['main.o', '+start12.o', 'ansi.lib']);
    expect(a.segments[0]).toMatchObject({ name: 'RAM', start: 0x1000, size: 0x3000, end: 0x3fff, rangeForm: 'SIZE', align: { defaultAlignment: 2, rules: ['[1:1]'] }, fill: [0xff, 0] });
    expect(a.segments[1]).toMatchObject({ name: 'ROM', relocateTo: 0x8000, overlapConsts: { mode: 'DO_NOT_OVERLAP_CONSTS', target: 'CODE' } });
    expect(a.segments[2].qualifier).toBe('NO_INIT');
    expect(a.segments[3]).toMatchObject({ qualifier: 'PAGED', start: 0, end: 0x3ff });
    expect(a.placements[0]).toMatchObject({ sections: ['.text', 'DEFAULT_ROM'], segments: ['ROM'] });
    expect(a.placements[2].inlineSegment).toMatchObject({ qualifier: 'READ_WRITE', start: 0x3800, end: 0x38ff });
    expect(a.entries).toEqual(['*', 'main.o:*', 'lib.o:foo', 'bar']);
    expect(a.stackTop).toBe(0x3fff);
    expect(a.main).toBe('main');
    expect(a.vectors).toEqual([
      { form: 'number', number: 0, address: 0xfffe, target: '_Startup', line: 18, col: 1 },
      { form: 'number', number: 8, address: 0xffee, target: 'isr', offset: 2, line: 19, col: 1 },
      { form: 'address', address: 0xffce, target: 0x4000, line: 20, col: 1 },
    ]);
    expect(a.hexFile).toEqual({ file: 'out.s19', offset: 0x10 });
    expect(a.mapFile).toEqual(['SEC_ALLOC', 'OBJ_ALLOC', 'STATISTIC']);
    expect(a.dependencies).toEqual([
      { kind: 'ROOT', names: ['main'], line: 23, col: 12 },
      { kind: 'USES', object: 'foo', names: ['bar', 'baz'], line: 23, col: 26 },
    ]);
    expect(a.overlapGroups).toEqual([['a', 'b']]);
  });

  it('old SECTIONS syntax without END', () => {
    const a = parsePrm('SECTIONS\n MY_RAM = READ_WRITE 0x800 TO 0xFFF;\nPLACEMENT DEFAULT_RAM INTO MY_RAM; END\nSTACKSIZE 0x100');
    expect(a.errors).toEqual([]);
    expect(a.oldSectionsSyntax).toBe(true);
    expect(a.segments[0].name).toBe('MY_RAM');
    expect(a.placements[0].segments).toEqual(['MY_RAM']);
  });

  it('INCLUDE via resolver', () => {
    const a = parsePrm('INCLUDE "segs.prm"\nINIT Entry', { include: (f) => (f === 'segs.prm' ? 'SEGMENTS R = READ_ONLY 0x4000 TO 0x7FFF; END' : undefined) });
    expect(a.errors).toEqual([]);
    expect(a.includes).toEqual(['segs.prm']);
    expect(a.segments.map((s) => s.name)).toEqual(['R']);
    expect(a.init).toBe('Entry');
  });

  it('reports errors with line numbers and recovers', () => {
    const src = `SEGMENTS
  A = READ_ONLY 0x4000 0x7FFF;
  B = SOMETHING 0x0 TO 0x1;
  C = READ_WRITE 0x2000 TO 0x2FFF;
END
PLACEMENT
  X INTO ;
  Y C;
  Z INTO C;
END
BOGUS 1 2 3
STACKSIZE zz
/* unterminated`;
    const a = parsePrm(src);
    expect(a.segments.map((s) => s.name)).toEqual(['C']);
    expect(a.placements.map((p) => p.sections)).toEqual([['X'], ['Z']]);
    const lines = a.errors.map((e) => e.line);
    expect(lines).toEqual([2, 3, 7, 8, 11, 12, 13]);
    expect(a.errors[0].message).toMatch(/expected TO or SIZE/);
    expect(a.errors[4].message).toMatch(/unknown command "BOGUS"/);
    expect(a.errors[6].message).toMatch(/unterminated comment/);
    expect(() => parsePrmStrict(src)).toThrow(PrmSyntaxError);
  });

  it('flags STACKSIZE together with STACKTOP and missing END', () => {
    const a = parsePrm('STACKSIZE 0x100\nSTACKTOP 0x3FFF\nNAMES a.o');
    expect(a.errors.map((e) => e.message)).toEqual(['STACKSIZE and STACKTOP must not both be specified', 'missing END for NAMES']);
  });
});

describe('PRM parser: review regressions', () => {
  it('placement INTO a segment named like a qualifier is a segment list, not an inline segment (finding 2)', () => {
    for (const name of ['CODE', 'PAGED', 'READ_ONLY', 'read_write', 'No_Init']) {
      const ast = parsePrm(`SEGMENTS ${name} = READ_ONLY 0x4000 TO 0x7FFF; END PLACEMENT .text, DEFAULT_ROM INTO ${name}, ROM2; END`);
      expect(ast.errors).toEqual([]);
      expect(ast.segments.map((s) => s.name)).toEqual([name]);
      expect(ast.placements[0].segments).toEqual([name, 'ROM2']);
      expect(ast.placements[0].inlineSegment).toBeUndefined();
    }
  });

  it('inline segment definitions after INTO still parse', () => {
    const ast = parsePrm('PLACEMENT .text INTO READ_ONLY 0x4000 TO 0x7FFF; .data INTO NO_INIT DATA_FAR 0x2000 SIZE 0x100; END');
    expect(ast.errors).toEqual([]);
    expect(ast.placements[0].inlineSegment).toMatchObject({ qualifier: 'READ_ONLY', start: 0x4000, end: 0x7fff });
    expect(ast.placements[1].inlineSegment).toMatchObject({ qualifier: 'NO_INIT', dataModel: 'DATA_FAR', start: 0x2000, size: 0x100 });
  });

  it('errors inside an INCLUDEd file are tagged with that file (finding 12)', () => {
    const files: Record<string, string> = { 'inc.prm': 'SEGMENTS\n  BAD = READ_ONLY;\nEND\n' };
    const ast = parsePrm('NAMES END\nINCLUDE inc.prm\nSTACKSIZE oops\n', { include: (f) => files[f] });
    expect(ast.includes).toEqual(['inc.prm']);
    const inc = ast.errors.filter((e) => e.file === 'inc.prm');
    const main = ast.errors.filter((e) => e.file === undefined);
    expect(inc.length).toBeGreaterThan(0);
    expect(inc[0].line).toBe(2);
    expect(main.map((e) => e.line)).toEqual([3]);
    // main-file errors sort first
    expect(ast.errors[0].file).toBeUndefined();
    expect(() => parsePrmStrict('INCLUDE inc.prm', { include: (f) => files[f] })).toThrow(/inc\.prm:2:/);
  });

  it('recursive INCLUDE stops with an error instead of looping', () => {
    const ast = parsePrm('INCLUDE self.prm\n', { include: () => 'INCLUDE self.prm\n' });
    expect(ast.errors.some((e) => /too many INCLUDEs/.test(e.message))).toBe(true);
  });
});

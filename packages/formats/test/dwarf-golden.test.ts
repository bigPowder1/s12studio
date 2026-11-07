import { describe, it, expect } from 'vitest';
import { readFixture, describeFx, hasFixtures } from './fixtures';
import {
  readElf,
  readHiwareLib,
  readSymbols,
  readRelocationSections,
  bytesEqual,
  parseAbbrevTable,
  encodeAbbrevTable,
  parseDebugInfo,
  parseDebugLine,
  parseAranges,
  encodeAranges,
  dieAttr,
  walkDies,
  decodeCwCompileUnit,
  decodeCwCompileUnits,
  encodeCwCompileUnit,
  encodeCwDwarfUnits,
  newCwCompileUnit,
  CW_DEBUG_FRAME,
  CW_BASE_TYPES,
  DW_AT,
  DW_TAG,
  DW_LANG_CW_ASM,
  type ElfFile,
  type ElfRela,
  type CwVariable,
  type CwSubprogram,
} from '../src/index';

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
// Private fixtures: read only when present (suites below are skipped otherwise; their bodies still run to collect).
const fx = <T>(f: () => T): T => (hasFixtures ? f() : (undefined as T));
const MAIN_O = fx(() => readElf(u8(readFixture('Lab3', 'Lab3_Data', 'Standard', 'ObjectCode', 'main.asm.o'))));
const LIB = fx(() => readHiwareLib(u8(readFixture('Lab3', 'Sources', 'Libraries', 'ME305LibV4.0.lib'))));
const LAB3_ABS = fx(() => readElf(u8(readFixture('Lab3', 'bin', 'Project.abs'))));
const BLANK_ABS = fx(() => readElf(u8(readFixture('blank_project', 'bin', 'Project.abs'))));
const MAIN_LST = fx(() => readFixture('Lab3', 'bin', 'main.lst').toString('latin1'));

const sec = (elf: ElfFile, name: string) => {
  const s = elf.sections.find((x) => x.name === name);
  if (!s) throw new Error(`no section ${name}`);
  return s.data;
};
const relocsFor = (elf: ElfFile, name: string): ElfRela[] => {
  const idx = elf.sections.findIndex((s) => s.name === name);
  return readRelocationSections(elf).find((r) => r.target === idx)?.relocs ?? [];
};
const debugInput = (elf: ElfFile) => ({
  info: sec(elf, '.debug_info'),
  abbrev: sec(elf, '.debug_abbrev'),
  line: sec(elf, '.debug_line'),
  infoRelocs: relocsFor(elf, '.debug_info'),
  lineRelocs: relocsFor(elf, '.debug_line'),
});

const objects: [string, ElfFile][] = hasFixtures ? [['main.asm.o', MAIN_O], ...LIB.members.map((m) => [m.name, m.elf!] as [string, ElfFile])] : [];

(hasFixtures ? describe : describe.skip).each(objects)('CW DWARF decode → encode (object): %s', (_name, elf) => {
  const input = debugInput(elf);
  const cu = decodeCwCompileUnit(input);
  const enc = encodeCwCompileUnit(cu);

  it('.debug_info identical', () => expect(bytesEqual(enc.info, input.info)).toBe(true));
  it('.debug_abbrev identical', () => expect(bytesEqual(enc.abbrev, input.abbrev)).toBe(true));
  it('.debug_line identical', () => expect(bytesEqual(enc.line, input.line)).toBe(true));
  it('.debug_frame identical (constant CIE)', () => expect(bytesEqual(enc.frame, sec(elf, '.debug_frame'))).toBe(true));
  it('relocation lists identical (order included)', () => {
    expect(enc.infoRelocs).toEqual(input.infoRelocs);
    expect(enc.lineRelocs).toEqual(input.lineRelocs);
  });
  it('abbrev table re-encodes generically', () => {
    expect(bytesEqual(encodeAbbrevTable(parseAbbrevTable(input.abbrev).list), input.abbrev)).toBe(true);
  });
  it('DIE order = defined GLOBAL FUNC/OBJECT symbols, then LOCAL ones, each in symtab order', () => {
    const syms = readSymbols(elf).filter((s) => (s.type === 1 || s.type === 2) && s.shndx !== 0);
    const expected = [...syms.filter((s) => s.bind === 1), ...syms.filter((s) => s.bind === 0)].map((s) => s.name);
    expect(cu.entries.map((e) => e.name)).toEqual(expected);
    // FUNC ↔ subprogram, OBJECT ↔ variable
    const kinds = new Map(syms.map((s) => [s.name, s.type === 2 ? 'subprogram' : 'variable']));
    for (const e of cu.entries) expect(e.kind).toBe(kinds.get(e.name));
  });

  it('CU conventions', () => {
    expect(cu.producer).toBe('Freescale');
    expect(cu.language).toBe(DW_LANG_CW_ASM);
    expect(cu.baseTypes).toEqual(CW_BASE_TYPES);
    expect(cu.lineFile.endsWith(`\\bin\\${cu.name}`)).toBe(true);
    expect(cu.lineFile.startsWith(cu.compDir)).toBe(true);
    expect(cu.sequences.length).toBe(1);
    const syms = readSymbols(elf);
    expect(syms[cu.abbrevOffset.sym!].type).toBe(3); // SECTION symbol
    expect(elf.sections[syms[cu.abbrevOffset.sym!].shndx].name).toBe('.debug_abbrev');
    expect(elf.sections[syms[cu.stmtList.sym!].shndx].name).toBe('.debug_line');
  });
});

(hasFixtures ? describe : describe.skip).each(!hasFixtures ? [] : [
  ['Lab3', LAB3_ABS],
  ['blank_project', BLANK_ABS],
] as const)('CW DWARF decode → encode (linked %s/bin/Project.abs)', (_n, elf) => {
  const input = debugInput(elf);
  const cus = decodeCwCompileUnits(input);

  it('has one CU per linked module in link order (archive members, then main)', () => {
    const names = cus.map((c) => c.name);
    expect(names.at(-1)).toBe('main.dbg');
    expect(names.slice(0, -1).every((n) => /^Lib_\w+\.dbg$/.test(n))).toBe(true);
    expect(names.slice(0, -1)).toEqual(names.slice(0, -1).sort());
    expect(input.infoRelocs.length).toBe(0);
  });

  it('re-encoding the concatenated units is byte-identical in all four sections', () => {
    const enc = encodeCwDwarfUnits(cus);
    expect(bytesEqual(enc.info, input.info)).toBe(true);
    expect(bytesEqual(enc.abbrev, input.abbrev)).toBe(true);
    expect(bytesEqual(enc.line, input.line)).toBe(true);
    expect(bytesEqual(enc.frame, sec(elf, '.debug_frame'))).toBe(true);
    expect(enc.infoRelocs).toEqual([]);
    expect(enc.lineRelocs).toEqual([]);
  });

  it('assignOffsets reproduces the linker-computed abbrev_offset / stmt_list values', () => {
    const stripped = cus.map((c) => ({ ...c, abbrevOffset: { value: 0 }, stmtList: { value: 0 } }));
    const enc = encodeCwDwarfUnits(stripped, { assignOffsets: true });
    expect(bytesEqual(enc.info, input.info)).toBe(true);
  });

  it('.debug_aranges parse → encode identical, one set per CU', () => {
    const ar = sec(elf, '.debug_aranges');
    const sets = parseAranges(ar);
    expect(sets.length).toBe(cus.length);
    expect(bytesEqual(encodeAranges(sets), ar)).toBe(true);
  });
});

describe('CW DWARF encoder from scratch', () => {
  it('builds a small CU with CW abbrev numbering and relocation order', () => {
    const cu = newCwCompileUnit('t.dbg', 'C:\\p\\bin', 'C:\\p\\bin\\t.dbg');
    cu.abbrevOffset = { value: 0, sym: 2 };
    cu.stmtList = { value: 0, sym: 4 };
    cu.entries.push({ kind: 'variable', name: 'BUF', location: { value: 0, sym: 12 }, type: 0, external: true, array: { length: 3, bitStride: 8 } });
    cu.entries.push({ kind: 'subprogram', name: 'f', low: { value: 0, sym: 13 }, high: { value: 2, sym: 13 }, external: false });
    cu.sequences.push({ start: { value: 0, sym: 8 }, rows: [{ address: 0, line: 10 }, { address: 2, line: 11 }], end: 2 });
    const enc = encodeCwCompileUnit(cu);
    const abbrevs = parseAbbrevTable(enc.abbrev).list;
    // first use: cu 128, base 129, array 130, subrange 131, variable 132, subprogram 133; table in fixed tag order
    expect(abbrevs.map((a) => [a.code, a.tag])).toEqual([
      [129, DW_TAG.base_type],
      [128, DW_TAG.compile_unit],
      [131, DW_TAG.subrange_type],
      [132, DW_TAG.variable],
      [130, DW_TAG.array_type],
      [133, DW_TAG.subprogram],
    ]);
    const offs = enc.infoRelocs.map((r) => r.offset);
    expect(offs).toEqual([...offs].sort((a, b) => b - a));
    expect(enc.infoRelocs.length).toBe(2 + 2 * 3);
    expect(enc.lineRelocs.map((r) => r.type)).toEqual([1, 5]);
    expect(bytesEqual(enc.frame, CW_DEBUG_FRAME)).toBe(true);
    // decode back
    const back = decodeCwCompileUnit({ ...enc });
    expect(back).toEqual(cu);
    const [p] = parseDebugLine(enc.line);
    expect(p.rows.map((r) => [r.address, r.line, r.endSequence])).toEqual([
      [0, 10, false],
      [2, 11, false],
      [2, 11, true],
    ]);
  });
});

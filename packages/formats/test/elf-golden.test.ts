import { describe, it, expect } from 'vitest';
import { readFixture, describeFx, hasFixtures } from './fixtures';
import {
  readElf,
  writeElf,
  layoutElf,
  rebuildSectionNames,
  readSymbols,
  buildSymbolTables,
  findSymtab,
  readRelocationSections,
  encodeRelocations,
  findUnknownRelocations,
  relocKind,
  relocWidthBits,
  inPlaceAddend,
  resolveAlias,
  isAliasSymbol,
  parseHiwareNotes,
  buildHiwareNotes,
  noteDescString,
  noteDescU32,
  HiwareNoteType,
  readHiwareLib,
  bytesEqual,
  ET_REL,
  ET_EXEC,
  EM_68HC12,
  SHT_NOBITS,
  SHT_NOTE,
  PT_LOAD,
  PT_NOTE,
  STT_HIWARE_ALIAS,
  type ElfFile,
} from '../src/index';

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
// Private fixtures: read only when present (suites below are skipped otherwise; their bodies still run to collect).
const fx = <T>(f: () => T, none: T): T => (hasFixtures ? f() : none);
const MAIN_O = fx(() => u8(readFixture('Lab3', 'Lab3_Data', 'Standard', 'ObjectCode', 'main.asm.o')), new Uint8Array(0));
const LIB = fx(() => u8(readFixture('Lab3', 'Sources', 'Libraries', 'ME305LibV4.0.lib')), new Uint8Array(0));
const LAB3_ABS = fx(() => u8(readFixture('Lab3', 'bin', 'Project.abs')), new Uint8Array(0));
const BLANK_ABS = fx(() => u8(readFixture('blank_project', 'bin', 'Project.abs')), new Uint8Array(0));
const MAIN_LST = fx(() => readFixture('Lab3', 'bin', 'main.lst').toString('latin1'), '');

const members = hasFixtures ? readHiwareLib(LIB).members : [];
const samples: [string, Uint8Array][] = !hasFixtures ? [] : [
  ['main.asm.o', MAIN_O],
  ...members.map((m) => [m.name, m.bytes] as [string, Uint8Array]),
  ['Lab3/bin/Project.abs', LAB3_ABS],
  ['blank_project/bin/Project.abs', BLANK_ABS],
];

/** Deep-ish copy so that mutations in a test never leak. */
const cloneElf = (e: ElfFile): ElfFile => ({
  header: { ...e.header, ident: e.header.ident.slice() },
  sections: e.sections.map((s) => ({ ...s, data: s.data.slice() })),
  programHeaders: e.programHeaders.map((p) => ({ ...p })),
});

(hasFixtures ? describe : describe.skip).each(samples)('ELF golden round trip: %s', (_name, bytes) => {
  const elf = readElf(bytes);

  it('readElf → writeElf is byte-identical', () => {
    const out = writeElf(elf);
    expect(out.length).toBe(bytes.length);
    expect(bytesEqual(out, bytes)).toBe(true);
  });

  it('CW layout reproduces every offset as read', () => {
    const lay = layoutElf(elf);
    expect(lay.sectionOffsets).toEqual(elf.sections.map((s) => s.offset));
    expect(lay.shoff).toBe(elf.header.shoff);
    expect(lay.phoff).toBe(elf.header.phoff);
    expect(lay.size).toBe(bytes.length);
  });

  it('rebuilding .shstrtab from names is identical', () => {
    const e2 = rebuildSectionNames(cloneElf(elf));
    expect(bytesEqual(writeElf(e2), bytes)).toBe(true);
  });

  it('rebuilding .symtab/.strtab from symbols is identical', () => {
    const syms = readSymbols(elf);
    const st = findSymtab(elf)!;
    const { symtab, strtab } = buildSymbolTables(syms.map((s) => ({ ...s, nameOffset: -1 })));
    expect(bytesEqual(symtab, st.data)).toBe(true);
    expect(bytesEqual(strtab, elf.sections[st.link].data)).toBe(true);
  });

  it('relocation sections re-encode identically and contain only known kinds', () => {
    for (const rs of readRelocationSections(elf)) {
      expect(bytesEqual(encodeRelocations(rs.relocs), rs.section.data)).toBe(true);
      expect(findUnknownRelocations(rs.relocs)).toEqual([]);
    }
  });

  it('.note parses as packed HIWARE AG records and rebuilds identically', () => {
    const note = elf.sections.find((s) => s.type === SHT_NOTE)!;
    const { notes, tail } = parseHiwareNotes(note.data);
    expect(tail.length).toBe(0);
    expect(notes.map((n) => n.type)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(notes.every((n) => n.name === 'HIWARE AG')).toBe(true);
    expect(bytesEqual(buildHiwareNotes(notes), note.data)).toBe(true);
    expect(noteDescU32(notes[HiwareNoteType.Unknown10 - 1].desc)).toBe(0x42);
    expect(Array.from(notes[HiwareNoteType.Machine - 1].desc)).toEqual([0, 0x35, 0, 0x73]);
  });

  it('header is CW HC12 ELF32 big-endian', () => {
    expect(elf.header.machine).toBe(EM_68HC12);
    expect(elf.header.ident[5]).toBe(2);
    expect(elf.header.phoff).toBe(elf.header.shoff + elf.sections.length * 40);
  });
});

describeFx('linked executables (Project.abs)', () => {
  it('Lab3 Project.abs: EXEC, entry 0xC000, phdrs at end of file', () => {
    const elf = readElf(LAB3_ABS);
    expect(elf.header.type).toBe(ET_EXEC);
    expect(elf.header.entry).toBe(0xc000);
    expect(elf.header.phoff + elf.header.phnum * 32).toBe(LAB3_ABS.length);
    expect(elf.programHeaders.length).toBe(11);
    expect(elf.programHeaders.filter((p) => p.type === PT_LOAD && p.filesz > 0).length).toBe(8);
    expect(elf.programHeaders.filter((p) => p.type === PT_NOTE).length).toBe(1);
    expect(elf.programHeaders.every((p) => p.sectionIndex !== undefined)).toBe(true);
    const { notes } = parseHiwareNotes(elf.sections.find((s) => s.name === '.note')!.data);
    expect(noteDescU32(notes[1].desc)).toBe(0x13b0);
  });

  it('writer relocates phdr offsets when section bodies move', () => {
    const elf = cloneElf(readElf(BLANK_ABS));
    const i = elf.sections.findIndex((s) => s.name === 'Lib_Keypad');
    const grown = new Uint8Array(elf.sections[i].data.length + 8);
    grown.set(elf.sections[i].data);
    elf.sections[i].data = grown;
    const re = readElf(writeElf(elf));
    for (const p of re.programHeaders) {
      const s = re.sections[p.sectionIndex!];
      expect(p.offset).toBe(s.offset);
    }
    expect(re.sections[i].size).toBe(grown.length);
  });
});

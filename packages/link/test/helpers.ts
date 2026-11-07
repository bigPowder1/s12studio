// Test helpers: fixtures and a tiny builder for CodeWarrior-dialect relocatable ELF objects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSymbolTables,
  encodeRelocations,
  relocFromKind,
  rebuildSectionNames,
  symInfo,
  writeElf,
  CW_ELF_IDENT,
  EM_68HC12,
  ET_REL,
  SHF_ALLOC,
  SHF_EXECINSTR,
  SHF_WRITE,
  SHN_ABS,
  SHN_UNDEF,
  SHT_NOBITS,
  SHT_PROGBITS,
  SHT_RELA,
  SHT_STRTAB,
  SHT_SYMTAB,
  STB_GLOBAL,
  STB_LOCAL,
  STT_FILE,
  STT_FUNC,
  STT_NOTYPE,
  STT_OBJECT,
  STT_SECTION,
  type ElfFile,
  type ElfRela,
  type ElfSection,
  type ElfSymbol,
  type RelocKind,
} from '@s12/formats';

import { FIXTURES } from '../../formats/test/fixtures';
export { FIXTURES, hasFixtures, describeFx, itFx } from '../../formats/test/fixtures';
export const readFixture = (...p: string[]): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, ...p)));
export const fixtureText = (...p: string[]): string => Buffer.from(readFixture(...p)).toString('latin1');
export const LIB = () => readFixture('Lab3', 'Sources', 'Libraries', 'ME305LibV4.0.lib');

export interface TSection {
  name: string;
  kind: 'code' | 'data' | 'org';
  /** PROGBITS contents (code / org) */
  bytes?: number[];
  /** NOBITS size (data) */
  size?: number;
  /** ORG address */
  addr?: number;
}
export interface TSymbol {
  name: string;
  /** section name, 'ABS' or 'UND' */
  section: string;
  value?: number;
  size?: number;
  global?: boolean;
  type?: 'func' | 'object' | 'notype';
}
export interface TReloc {
  section: string;
  offset: number;
  sym: string;
  kind?: RelocKind;
  /** raw (type, rawAddend) override for unknown-relocation tests */
  raw?: { type: number; rawAddend: number };
}

/** Build a CW-dialect relocatable object (symbols: null, SECTION syms, FILE, locals, globals; .rela.<sec>). */
export function makeObject(name: string, spec: { sections: TSection[]; symbols: TSymbol[]; relocs?: TReloc[] }): Uint8Array {
  const sec = (n: string, type: number, flags: number, data: Uint8Array, extra: Partial<ElfSection> = {}): ElfSection => ({
    name: n, nameOffset: 0, type, flags, addr: 0, offset: 0, size: data.length, link: 0, info: 0, addralign: 1, entsize: 0, data, ...extra,
  });
  const sections: ElfSection[] = [sec('', 0, 0, new Uint8Array(0), { addralign: 0 }), sec('.symtab', SHT_SYMTAB, 0, new Uint8Array(0), { link: 2, addralign: 4, entsize: 16 }), sec('.strtab', SHT_STRTAB, 0, new Uint8Array(0))];
  const index = new Map<string, number>();
  for (const s of spec.sections) {
    index.set(s.name, sections.length);
    if (s.kind === 'data') sections.push(sec(s.name, SHT_NOBITS, SHF_ALLOC | SHF_WRITE, new Uint8Array(0), { size: s.size ?? 0 }));
    else sections.push(sec(s.name, SHT_PROGBITS, s.kind === 'code' ? SHF_ALLOC | SHF_EXECINSTR : SHF_ALLOC, Uint8Array.from(s.bytes ?? []), { addr: s.addr ?? 0 }));
  }
  const mk = (n: string, value: number, size: number, bind: number, type: number, shndx: number): ElfSymbol => ({
    name: n, nameOffset: 0, value, size, info: symInfo(bind, type), bind, type, other: 0, shndx,
  });
  const syms: ElfSymbol[] = [mk('', 0, 0, 0, 0, 0)];
  for (const s of spec.sections) syms.push(mk('', 0, 0, STB_LOCAL, STT_SECTION, index.get(s.name)!));
  syms.push(mk(`${name.replace(/\.asm\.o$/, '')}.dbg`, 0, 0, STB_LOCAL, STT_FILE, SHN_ABS));
  const ty = (t: TSymbol) => (t.type === 'object' ? STT_OBJECT : t.type === 'notype' || t.section === 'UND' ? STT_NOTYPE : STT_FUNC);
  const shndx = (t: TSymbol) => (t.section === 'ABS' ? SHN_ABS : t.section === 'UND' ? SHN_UNDEF : index.get(t.section)!);
  const ordered = [...spec.symbols.filter((s) => !s.global && s.section !== 'UND'), ...spec.symbols.filter((s) => s.global || s.section === 'UND')];
  const firstGlobal = syms.length + spec.symbols.filter((s) => !s.global && s.section !== 'UND').length;
  for (const t of ordered) syms.push(mk(t.name, t.value ?? 0, t.size ?? 0, t.global || t.section === 'UND' ? STB_GLOBAL : STB_LOCAL, ty(t), shndx(t)));
  const { symtab, strtab } = buildSymbolTables(syms);
  sections[1].data = symtab;
  sections[1].size = symtab.length;
  sections[1].info = firstGlobal;
  sections[2].data = strtab;
  sections[2].size = strtab.length;
  const byTarget = new Map<string, ElfRela[]>();
  for (const r of spec.relocs ?? []) {
    const symIdx = syms.findIndex((s, i) => i > 0 && s.name === r.sym);
    if (symIdx < 0) throw new Error(`no symbol ${r.sym}`);
    const rel = r.raw ? { offset: r.offset, sym: symIdx, ...r.raw } : relocFromKind(r.kind ?? 'ABS16', r.offset, symIdx);
    byTarget.set(r.section, [...(byTarget.get(r.section) ?? []), rel]);
  }
  for (const [target, list] of byTarget) {
    const data = encodeRelocations(list);
    sections.push(sec(`.rela.${target}`, SHT_RELA, 0, data, { link: 1, info: index.get(target)!, addralign: 4, entsize: 12 }));
  }
  sections.push(sec('.shstrtab', SHT_STRTAB, 0, new Uint8Array(0)));
  const elf: ElfFile = {
    header: {
      ident: CW_ELF_IDENT, type: ET_REL, machine: EM_68HC12, version: 1, entry: 0, phoff: 0, shoff: 0, flags: 0,
      ehsize: 52, phentsize: 0, phnum: 0, shentsize: 40, shnum: sections.length, shstrndx: sections.length - 1,
    },
    sections,
    programHeaders: [],
  };
  rebuildSectionNames(elf);
  return writeElf(elf);
}

/** A minimal PRM for synthetic tests. */
export function prm(body: { segments: string; placement: string; extra?: string }): string {
  return `NAMES END\nSEGMENTS\n${body.segments}\nEND\nPLACEMENT\n${body.placement}\nEND\n${body.extra ?? ''}\n`;
}

/** A typical relocatable student object: Entry in MyCode, a variable in DEFAULT_RAM, reset vector via ORG. */
export function studentObject(extra: { code?: number[]; symbols?: TSymbol[]; relocs?: TReloc[]; sections?: TSection[] } = {}): Uint8Array {
  return makeObject('main.asm.o', {
    sections: [
      { name: 'DEFAULT_RAM', kind: 'data', size: 2 },
      { name: 'MyCode', kind: 'code', bytes: extra.code ?? [0x79, 0x00, 0x00, 0x20, 0xfb] },
      { name: '_ORG00001', kind: 'org', addr: 0xfffe, bytes: [0, 0] },
      ...(extra.sections ?? []),
    ],
    symbols: [
      { name: 'counter', section: 'DEFAULT_RAM', size: 2, type: 'object' },
      { name: 'VAR00001', section: 'ABS', value: 0xfffe, size: 2, type: 'object' },
      { name: 'Entry', section: 'MyCode', size: 5, global: true },
      ...(extra.symbols ?? []),
    ],
    relocs: [
      { section: 'MyCode', offset: 1, sym: 'counter' },
      { section: '_ORG00001', offset: 0, sym: 'Entry' },
      ...(extra.relocs ?? []),
    ],
  });
}

export const SIMPLE_PRM = prm({
  segments: `RAM = READ_WRITE 0x2000 TO 0x3FFF;\nROM_4000 = READ_ONLY 0x4000 TO 0x7FFF;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;`,
  placement: `_PRESTART, STARTUP INTO ROM_C000;\nDEFAULT_ROM INTO ROM_4000;\nSSTACK, DEFAULT_RAM INTO RAM;\nMyCode INTO ROM_4000;`,
  extra: 'STACKSIZE 0x100\nINIT Entry\n',
});

// Linked `.abs` writer (ELF32-BE EXEC + DWARF 2), CodeWarrior SmartLinker layout (elf-lib-formats.md §4):
//   NULL, allocated sections sorted by address, .symtab, .strtab, .debug_line, .debug_abbrev, .debug_loc,
//   .debug_info, .debug_frame, .debug_pubnames (empty), .debug_aranges (generated), .note, .shstrtab;
//   bodies 4-aligned, shdrs after the last body, phdrs at the end of the file.
import {
  buildHiwareNotes,
  buildSymbolTables,
  encodeAranges,
  hiwareNote,
  rebuildSectionNames,
  stringDesc,
  symInfo,
  u32Desc,
  writeElf,
  CW_ELF_IDENT,
  EM_68HC12,
  ET_EXEC,
  HiwareNoteType,
  PF_R,
  PF_W,
  PF_X,
  PT_LOAD,
  PT_NOTE,
  SHF_EXECINSTR,
  SHF_WRITE,
  SHN_ABS,
  SHT_NOBITS,
  SHT_NOTE,
  SHT_PROGBITS,
  SHT_STRTAB,
  SHT_SYMTAB,
  STB_GLOBAL,
  STB_LOCAL,
  STT_FILE,
  STT_SECTION,
  type ArangeSet,
  type ElfFile,
  type ElfProgramHeader,
  type ElfSection,
  type ElfSymbol,
} from '@s12/formats';
import type { Module, OutSection } from './model';
import { byAddress, type LinkObject } from './objects';
import type { NoteMeta } from './types';

/** Order of the debug sections in the linked file. */
export const DEBUG_SECTION_ORDER = ['.debug_line', '.debug_abbrev', '.debug_loc', '.debug_info', '.debug_frame'] as const;

export const SMARTLINKER_PRODUCER = 'SmartLinker V-5.0.40 Build 10203, Jul 23 2010';
export const SMARTLINKER_VERSION = 0x13b0;
export const SMARTLINKER_BUILD_DATE = 'Jul 23 2010';
/** CodeWarrior truncates the command-line note to this many bytes (+ NUL). */
export const NOTE_COMMAND_LINE_MAX = 1024;

export interface LoadSegment {
  /** first output section of the segment */
  first: OutSection;
  vaddr: number;
  filesz: number;
  memsz: number;
  flags: number;
}

/**
 * PT_LOAD segments: one per allocated section (address order), except that an uninitialised (NOBITS) section
 * directly following another NOBITS segment with the same flags is merged into it (golden Lab3: `.stack` 0x2000
 * + `.data` 0x2400 -> one segment; LIBRARY_RAM at 0x1000 is not contiguous and stays separate; adjacent PROGBITS
 * sections such as two library code sections are never merged).
 * UNCERTAIN: the exact merge condition (contiguous + NOBITS + same flags reproduces both goldens).
 */
export function loadSegments(outs: readonly OutSection[]): LoadSegment[] {
  const segs: LoadSegment[] = [];
  for (const o of outs) {
    const nobits = o.type === SHT_NOBITS;
    const prev = segs[segs.length - 1];
    if (nobits && prev && prev.filesz === 0 && prev.first.flags === o.flags && prev.vaddr + prev.memsz === o.address) {
      prev.memsz += o.size;
      continue;
    }
    const flags = PF_R | (o.flags & SHF_WRITE ? PF_W : 0) | (o.flags & SHF_EXECINSTR ? PF_X : 0);
    segs.push({ first: o, vaddr: o.address, filesz: nobits ? 0 : o.size, memsz: o.size, flags });
  }
  return segs;
}

/** The linker's `.note` records (types 1..10 in CodeWarrior order). */
export function linkerNotes(meta: NoteMeta): Uint8Array {
  const cmd = meta.commandLine.slice(0, NOTE_COMMAND_LINE_MAX);
  return buildHiwareNotes([
    hiwareNote(HiwareNoteType.Producer, stringDesc(SMARTLINKER_PRODUCER)),
    hiwareNote(HiwareNoteType.Version, u32Desc(SMARTLINKER_VERSION)),
    hiwareNote(HiwareNoteType.BuildDate, stringDesc(SMARTLINKER_BUILD_DATE)),
    hiwareNote(HiwareNoteType.Machine, Uint8Array.of(0x00, 0x35, 0x00, 0x73)),
    hiwareNote(HiwareNoteType.User, stringDesc(meta.user)),
    hiwareNote(HiwareNoteType.Unknown6, Uint8Array.of(0)),
    hiwareNote(HiwareNoteType.Created, stringDesc(meta.created)),
    // UNCERTAIN: the linker writes 'A' (same as the assembler) without a NUL, as in both golden .abs files.
    hiwareNote(HiwareNoteType.Tool, Uint8Array.of(0x41)),
    hiwareNote(HiwareNoteType.CommandLine, stringDesc(cmd)),
    hiwareNote(HiwareNoteType.Unknown10, u32Desc(0x42)),
  ]);
}

export interface AbsBuildInput {
  entry: number;
  /** allocated output sections with size > 0, sorted by address */
  outs: OutSection[];
  sectionData: Map<OutSection, Uint8Array>;
  objects: LinkObject[];
  debug: { sections: Map<string, Uint8Array> };
  aranges: ArangeSet[];
  note: NoteMeta;
}

const sym = (name: string, value: number, size: number, bind: number, type: number, shndx: number): ElfSymbol => ({
  name, nameOffset: 0, value, size, info: symInfo(bind, type), bind, type, other: 0, shndx,
});

/**
 * Symbol table grouping (verified on both golden .abs files):
 *   for each allocated section in file order: SECTION symbol, then its LOCAL objects sorted by address, a FILE
 *   symbol "<module>.dbg" emitted whenever the module differs from the last FILE emitted. ORG sections are
 *   preceded by a group for their absolute objects: SECTION symbol with st_shndx 0, FILE, the ABS locals.
 *   Then every GLOBAL object, section by section, sorted by address. Linker-defined labels are not written.
 */
export function buildAbsSymbols(outs: readonly OutSection[], objects: readonly LinkObject[]): { syms: ElfSymbol[]; firstGlobal: number } {
  const syms: ElfSymbol[] = [sym('', 0, 0, STB_LOCAL, 0, 0)];
  let lastFile: Module | undefined;
  const emitLocals = (list: LinkObject[], shndx: number, symShndx: number) => {
    for (const o of byAddress(list)) {
      if (o.mod !== lastFile) {
        syms.push(sym(o.mod.fileSym, 0, 0, STB_LOCAL, STT_FILE, shndx));
        lastFile = o.mod;
      }
      syms.push(sym(o.name, o.address, o.size, STB_LOCAL, o.elfType, symShndx));
    }
  };
  const of = (o: OutSection) => objects.filter((x) => x.out === o && x.binding !== 'linker');
  outs.forEach((o, i) => {
    const shndx = i + 1;
    const mine = of(o);
    if (o.kind === 'org') {
      const absLocals = mine.filter((x) => x.isOrgAbs && x.binding === 'local');
      // UNCERTAIN: the (shndx 0) group is only written when the ORG section has absolute locals.
      if (absLocals.length) {
        syms.push(sym('', 0, 0, STB_LOCAL, STT_SECTION, 0));
        emitLocals(absLocals, 0, SHN_ABS);
      }
      syms.push(sym('', 0, 0, STB_LOCAL, STT_SECTION, shndx));
      emitLocals(mine.filter((x) => !x.isOrgAbs && x.binding === 'local'), shndx, shndx);
    } else {
      syms.push(sym('', 0, 0, STB_LOCAL, STT_SECTION, shndx));
      emitLocals(mine.filter((x) => x.binding === 'local'), shndx, shndx);
    }
  });
  const firstGlobal = syms.length;
  outs.forEach((o, i) => {
    for (const x of byAddress(of(o).filter((y) => y.binding === 'global'))) {
      syms.push(sym(x.name, x.address, x.size, STB_GLOBAL, x.elfType, x.isOrgAbs ? SHN_ABS : i + 1));
    }
  });
  return { syms, firstGlobal };
}

const section = (name: string, type: number, flags: number, addr: number, data: Uint8Array, extra: Partial<ElfSection> = {}): ElfSection => ({
  name, nameOffset: 0, type, flags, addr, offset: 0, size: data.length, link: 0, info: 0, addralign: 1, entsize: 0, data, ...extra,
});

export function buildAbs(input: AbsBuildInput): { elf: ElfFile; bytes: Uint8Array } {
  const sections: ElfSection[] = [section('', 0, 0, 0, new Uint8Array(0), { addralign: 0 })];
  for (const o of input.outs) {
    const nobits = o.type === SHT_NOBITS;
    const data = nobits ? new Uint8Array(0) : input.sectionData.get(o) ?? new Uint8Array(o.size);
    sections.push(section(o.name, nobits ? SHT_NOBITS : SHT_PROGBITS, o.flags, o.address, data, { size: o.size, addralign: 0 }));
  }
  const { syms, firstGlobal } = buildAbsSymbols(input.outs, input.objects);
  const { symtab, strtab } = buildSymbolTables(syms);
  const symtabIdx = sections.length;
  sections.push(section('.symtab', SHT_SYMTAB, 0, 0, symtab, { link: symtabIdx + 1, info: firstGlobal, addralign: 4, entsize: 16 }));
  sections.push(section('.strtab', SHT_STRTAB, 0, 0, strtab));
  for (const name of DEBUG_SECTION_ORDER) sections.push(section(name, SHT_PROGBITS, 0, 0, input.debug.sections.get(name) ?? new Uint8Array(0)));
  sections.push(section('.debug_pubnames', SHT_PROGBITS, 0, 0, new Uint8Array(0)));
  sections.push(section('.debug_aranges', SHT_PROGBITS, 0, 0, encodeAranges(input.aranges)));
  const noteIdx = sections.length;
  const note = linkerNotes(input.note);
  sections.push(section('.note', SHT_NOTE, 0, 0, note, { addralign: 4 }));
  const shstrndx = sections.length;
  sections.push(section('.shstrtab', SHT_STRTAB, 0, 0, new Uint8Array(0)));

  const phdrs: ElfProgramHeader[] = loadSegments(input.outs).map((s) => ({
    type: PT_LOAD,
    offset: 0,
    vaddr: s.vaddr,
    paddr: 0,
    filesz: s.filesz,
    memsz: s.memsz,
    flags: s.flags,
    align: 0,
    sectionIndex: input.outs.indexOf(s.first) + 1,
  }));
  phdrs.push({ type: PT_NOTE, offset: 0, vaddr: 0, paddr: 0, filesz: note.length, memsz: note.length, flags: 0, align: 0, sectionIndex: noteIdx });

  const elf: ElfFile = {
    header: {
      ident: CW_ELF_IDENT,
      type: ET_EXEC,
      machine: EM_68HC12,
      version: 1,
      entry: input.entry,
      phoff: 0,
      shoff: 0,
      flags: 0,
      ehsize: 52,
      phentsize: 32,
      phnum: phdrs.length,
      shentsize: 40,
      shnum: sections.length,
      shstrndx,
    },
    sections,
    programHeaders: phdrs,
  };
  rebuildSectionNames(elf);
  const bytes = writeElf(elf);
  return { elf, bytes };
}

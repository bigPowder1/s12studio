/**
 * CodeWarrior (HIWARE) ELF relocatable object writer for the assembler clone.
 * Layout and rules: docs/research/r2/elf-lib-formats.md §2-3, verified byte-for-byte on the Lab3 and
 * blank_project `main.asm.o` fixtures.
 *
 * Sections: NULL, .symtab, .strtab, .debug_info, .debug_abbrev, .debug_loc, .debug_line, .debug_frame,
 * _SEC000000, the user SECTIONs and ORG sections (_ORGnnnnn) in creation order, .rela.<sec> for every section with
 * relocations (debug_info, debug_line, then the code/data sections in section order), .note, .shstrtab.
 *
 * Symbol table: NULL; one STT_SECTION per section from .debug_info through the last code/data section; a FILE
 * symbol "<module>.dbg" (ABS); the local symbols, then the global ones, each group in *allocation order*:
 *   - XDEF / XREF names are allocated when declared,
 *   - labels of data directives (DS/DC/DCB/...) and VARnnnnn are allocated when defined (pass 1),
 *   - every other label is allocated by its first reference in pass 2 (operands, branches, DC values),
 *   - labels never referenced come last, in definition order (UNCERTAIN: never observed).
 * This reproduces every symbol table of the fixtures (the main.asm.o objects and the ME3305 library members).
 * Sizes: distance to the next label address in the same section (or the section end); several labels at one
 * address: the earliest-allocated one gets the size, the others 0 (UNCERTAIN: two samples, main/spin and
 * _Startup/Entry).
 * Types: labels in a section containing instructions are STT_FUNC, others STT_OBJECT.
 * DWARF (debug_info entries): defined globals then locals, both in symbol-table order; FUNC → subprogram,
 * OBJECT → variable typed from its data directive (.B unsigned char, .W int, .L long; arrays when count > 1).
 */
import {
  CW_ELF_IDENT,
  EM_68HC12,
  ET_REL,
  HiwareNoteType,
  SHF_ALLOC,
  SHF_EXECINSTR,
  SHF_WRITE,
  SHN_ABS,
  SHN_UNDEF,
  SHT_NOBITS,
  SHT_NOTE,
  SHT_NULL,
  SHT_PROGBITS,
  SHT_RELA,
  SHT_STRTAB,
  SHT_SYMTAB,
  STB_GLOBAL,
  STB_LOCAL,
  STT_FILE,
  STT_FUNC,
  STT_HIWARE_ALIAS,
  STT_NOTYPE,
  STT_OBJECT,
  STT_SECTION,
  buildCwStringTable,
  buildHiwareNotes,
  buildSymbolTables,
  encodeCwCompileUnit,
  encodeRelocations,
  hiwareNote,
  latin1BestFit,
  newCwCompileUnit,
  relocFromKind,
  stringDesc,
  u32Desc,
  writeElf,
  type CwCompileUnit,
  type CwEntry,
  type CwLineSequence,
  type ElfFile,
  type ElfRela,
  type ElfSection,
  type ElfSymbol,
  type HiwareNote,
  type RelocKind,
} from '@s12/formats';
import type { Section, Stmt, Sym } from './types.js';

/** Metadata of the `.note` section (what CodeWarrior records about the build). */
export interface NoteMeta {
  /** Note 1. Default "Assembler for HC12 V-5.0.30 Build 10203, Jul 23 2010". */
  producer?: string;
  /** Note 2. Default 5030. */
  version?: number;
  /** Note 3. Default "Jul 23 2010". */
  buildDate?: string;
  /** Note 4 raw bytes. Default 00 35 00 73. */
  machine?: Uint8Array;
  /** Note 5: user name. Default "user". */
  user?: string;
  /** Note 7: creation time, ctime() format without the trailing "\n" (e.g. "Mon Oct 19 10:30:46 2026"), or a Date. */
  time?: string | Date;
  /** Note 9: tool command line (truncated to 1024 characters like CodeWarrior). Default: the option string. */
  commandLine?: string;
  /** Note 10. Default 0x42. */
  unknown10?: number;
}

export const ASSEMBLER_PRODUCER = 'Assembler for HC12 V-5.0.30 Build 10203, Jul 23 2010';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** C `ctime()` text (without the newline), local time of `d`. */
export function ctime(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}

/** Build the 10 HIWARE notes of an assembler object. */
export function buildAssemblerNotes(meta: NoteMeta, defaultCommandLine: string): HiwareNote[] {
  // Deterministic default (the caller passes the real build time).
  const time = meta.time instanceof Date ? ctime(meta.time) : (meta.time ?? 'Thu Jan  1 00:00:00 1970');
  // 8-bit first ('?' for characters above U+00FF), so the 1024 limit counts bytes as CodeWarrior's does
  const cmd = latin1BestFit(meta.commandLine ?? defaultCommandLine).slice(0, 1024);
  return [
    hiwareNote(HiwareNoteType.Producer, stringDesc(meta.producer ?? ASSEMBLER_PRODUCER)),
    hiwareNote(HiwareNoteType.Version, u32Desc(meta.version ?? 5030)),
    hiwareNote(HiwareNoteType.BuildDate, stringDesc(meta.buildDate ?? 'Jul 23 2010')),
    hiwareNote(HiwareNoteType.Machine, meta.machine ?? Uint8Array.of(0x00, 0x35, 0x00, 0x73)),
    hiwareNote(HiwareNoteType.User, stringDesc(meta.user ?? 'user')),
    hiwareNote(HiwareNoteType.Unknown6, Uint8Array.of(0)),
    hiwareNote(HiwareNoteType.Created, stringDesc(time.endsWith('\n') ? time : time + '\n')),
    hiwareNote(HiwareNoteType.Tool, Uint8Array.of(0x41)),
    hiwareNote(HiwareNoteType.CommandLine, stringDesc(cmd)),
    hiwareNote(HiwareNoteType.Unknown10, u32Desc(meta.unknown10 ?? 0x42)),
  ];
}

export interface ObjectInput {
  sections: Section[];
  symbols: Sym[];
  stmts: Stmt[];
  /** Absolute path of the .dbg file (DWARF line-table file entry). */
  dbgPath: string;
  /** DW_AT_comp_dir. */
  compDir: string;
  notes: HiwareNote[];
}

export interface ObjectOutput {
  elf: ElfFile;
  bytes: Uint8Array;
  /** Final symbol table (index = ELF symbol index). */
  elfSymbols: ElfSymbol[];
}

const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);

function sectionHeader(name: string, type: number, flags: number, data: Uint8Array, extra: Partial<ElfSection> = {}): ElfSection {
  return { name, nameOffset: 0, type, flags, addr: 0, offset: 0, size: data.length, link: 0, info: 0, addralign: 1, entsize: 0, data, ...extra };
}

/** Section type/flags from its contents (manual: code section / constant section / data section). */
function sectionShape(s: Section): { type: number; flags: number } {
  if (s.hasCode) return { type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR };
  if (s.hasConst) return { type: SHT_PROGBITS, flags: SHF_ALLOC };
  return { type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE };
}

/** True for symbols that appear in the object symbol table. */
export function isObjectSymbol(s: Sym): boolean {
  if (s.kind === 'label') return !!s.section && s.section.kind !== 'offset' && s.defined && !s.aliasOf;
  if (s.kind === 'xref') return true;
  if (s.kind === 'equ') {
    if (s.xdef && !s.equValue && s.defined) return true; // exported absolute constant
    return !!s.equValue && s.equValue.kind === 'ext' && s.equValue.v === 0 && !s.equValue.fn;
  }
  return false;
}

/** Compute label sizes (see module comment). */
export function computeSizes(symbols: Sym[]): void {
  const bySec = new Map<Section, Sym[]>();
  for (const s of symbols) {
    if (s.kind !== 'label' || !s.section || s.section.kind === 'offset' || !s.defined || s.aliasOf) continue;
    let a = bySec.get(s.section);
    if (!a) bySec.set(s.section, (a = []));
    a.push(s);
  }
  for (const [sec, list] of bySec) {
    const addrs = [...new Set(list.map((s) => s.value))].sort((a, b) => a - b);
    const end = sec.base + sec.size;
    for (let i = 0; i < addrs.length; i++) {
      const at = addrs[i];
      const next = i + 1 < addrs.length ? addrs[i + 1] : end;
      const group = list.filter((s) => s.value === at).sort((a, b) => (a.alloc ?? 0) - (b.alloc ?? 0));
      group.forEach((s, k) => (s.size = k === 0 ? Math.max(0, next - at) : 0));
    }
  }
}

export function buildObject(inp: ObjectInput): ObjectOutput {
  const userSecs = inp.sections.filter((s) => s.kind !== 'offset');
  computeSizes(inp.symbols);

  // ----- section list (indices) -----
  const FIRST_USER = 8;
  userSecs.forEach((s, i) => (s.elfIndex = FIRST_USER + i));
  const lastContent = FIRST_USER + userSecs.length - 1;

  // ----- symbols -----
  const syms: ElfSymbol[] = [{ name: '', nameOffset: 0, value: 0, size: 0, info: 0, bind: 0, type: 0, other: 0, shndx: 0 }];
  const mk = (name: string, value: number, size: number, bind: number, type: number, shndx: number): ElfSymbol => ({
    name,
    nameOffset: 0,
    value: value >>> 0,
    size,
    info: (bind << 4) | type,
    bind,
    type,
    other: 0,
    shndx,
  });
  const secSymIndex = new Map<number, number>();
  for (let shndx = 3; shndx <= lastContent; shndx++) {
    secSymIndex.set(shndx, syms.length);
    syms.push(mk('', 0, 0, STB_LOCAL, STT_SECTION, shndx));
  }
  for (const s of userSecs) s.secSym = secSymIndex.get(s.elfIndex!);
  syms.push(mk(baseName(inp.dbgPath), 0, 0, STB_LOCAL, STT_FILE, SHN_ABS));

  const objSyms = inp.symbols.filter(isObjectSymbol).sort((a, b) => (a.alloc ?? 1e9) - (b.alloc ?? 1e9));
  const isGlobal = (s: Sym) => s.kind === 'xref' || s.xdef;
  const locals = objSyms.filter((s) => !isGlobal(s));
  const globals = objSyms.filter(isGlobal);
  const ordered = [...locals, ...globals];
  ordered.forEach((s, i) => (s.elfIndex = syms.length + i));
  const firstGlobal = syms.length + locals.length;
  for (const s of ordered) {
    const bind = isGlobal(s) ? STB_GLOBAL : STB_LOCAL;
    if (s.kind === 'xref') {
      syms.push(mk(s.name, 0, 0, bind, STT_NOTYPE, SHN_UNDEF));
    } else if (s.kind === 'equ' && !s.equValue) {
      // UNCERTAIN: an XDEF'd EQU constant is exported as an absolute NOTYPE symbol (never observed).
      syms.push(mk(s.name, s.value, 0, bind, STT_NOTYPE, SHN_ABS));
    } else if (s.kind === 'equ') {
      // Alias of an external symbol: HIWARE type 13, st_shndx = index of the aliased symbol.
      const target = s.equValue!.sym as Sym;
      syms.push(mk(s.name, 0, 0, bind, STT_HIWARE_ALIAS, target.elfIndex ?? 0));
    } else {
      const sec = s.section!;
      const type = sec.hasCode ? STT_FUNC : STT_OBJECT;
      const shndx = sec.kind === 'org' ? SHN_ABS : sec.elfIndex!;
      syms.push(mk(s.name, s.value, s.size ?? 0, bind, type, shndx));
    }
  }
  // Aliases may precede their target in the table: fix up now that every index is known.
  for (const s of ordered) {
    if (s.kind === 'equ' && s.equValue) syms[s.elfIndex!].shndx = ((s.equValue!.sym as Sym).elfIndex ?? 0) & 0xffff;
  }

  // ----- relocations of code/data sections -----
  const relocsBySec = new Map<Section, ElfRela[]>();
  for (const sec of userSecs) {
    const list: ElfRela[] = [];
    for (const fx of sec.fixups) {
      const kind = fx.kind as RelocKind;
      if (!['ABS16', 'ABS32', 'PCREL16', 'PAGE8'].includes(kind)) continue; // reported by the assembler
      const v = fx.value;
      let symIndex: number;
      let addend: number;
      const base = v.sym as Sym | undefined;
      if (v.kind === 'ext') {
        symIndex = base!.elfIndex!;
        addend = v.v;
      } else if (base && base.elfIndex !== undefined) {
        symIndex = base.elfIndex;
        addend = v.v - base.value;
      } else if (v.kind === 'rel' && v.sec) {
        const s = v.sec as Section;
        symIndex = s.secSym!;
        addend = v.v;
      } else continue;
      if (kind === 'PCREL16') addend -= fx.pcAdjust ?? 0;
      if (kind === 'PAGE8') addend = 0; // UNCERTAIN: page byte in-place value
      const w = fx.width;
      for (let k = 0; k < w; k++) sec.data[fx.at + k] = (addend >>> (8 * (w - 1 - k))) & 0xff;
      list.push(relocFromKind(kind, fx.at, symIndex));
    }
    if (list.length) relocsBySec.set(sec, list);
  }

  // ----- DWARF -----
  const cu = buildCompileUnit(inp, ordered, firstGlobal, secSymIndex, userSecs);
  const dw = encodeCwCompileUnit(cu);

  // ----- assemble the section table -----
  const { symtab, strtab } = buildSymbolTables(syms);
  const sections: ElfSection[] = [
    { name: '', nameOffset: 0, type: SHT_NULL, flags: 0, addr: 0, offset: 0, size: 0, link: 0, info: 0, addralign: 0, entsize: 0, data: new Uint8Array(0) },
    sectionHeader('.symtab', SHT_SYMTAB, 0, symtab, { link: 2, info: firstGlobal, addralign: 4, entsize: 16 }),
    sectionHeader('.strtab', SHT_STRTAB, 0, strtab),
    sectionHeader('.debug_info', SHT_PROGBITS, 0, dw.info),
    sectionHeader('.debug_abbrev', SHT_PROGBITS, 0, dw.abbrev),
    sectionHeader('.debug_loc', SHT_PROGBITS, 0, new Uint8Array(0)),
    sectionHeader('.debug_line', SHT_PROGBITS, 0, dw.line),
    sectionHeader('.debug_frame', SHT_PROGBITS, 0, dw.frame),
  ];
  for (const s of userSecs) {
    const { type, flags } = sectionShape(s);
    const data = type === SHT_NOBITS ? new Uint8Array(0) : Uint8Array.from(s.data.slice(0, s.size));
    sections.push({
      name: s.name,
      nameOffset: 0,
      type,
      flags,
      addr: s.kind === 'org' ? s.base : 0,
      offset: 0,
      size: s.size,
      link: 0,
      info: 0,
      addralign: 1,
      entsize: 0,
      data,
    });
  }
  const rela = (name: string, target: number, relocs: ElfRela[]) =>
    sectionHeader(name, SHT_RELA, 0, encodeRelocations(relocs), { link: 1, info: target, addralign: 4, entsize: 12 });
  if (dw.infoRelocs.length) sections.push(rela('.rela.debug_info', 3, dw.infoRelocs));
  if (dw.lineRelocs.length) sections.push(rela('.rela.debug_line', 6, dw.lineRelocs));
  for (const s of userSecs) {
    const r = relocsBySec.get(s);
    if (r) sections.push(rela(`.rela.${s.name}`, s.elfIndex!, r));
  }
  sections.push(sectionHeader('.note', SHT_NOTE, 0, buildHiwareNotes(inp.notes), { addralign: 4 }));
  const shstrNames = [...sections.slice(1).map((s) => s.name), '.shstrtab'];
  const { data: shstr, offsets } = buildCwStringTable(shstrNames);
  sections.push(sectionHeader('.shstrtab', SHT_STRTAB, 0, shstr));
  sections.forEach((s, i) => (s.nameOffset = i === 0 ? 0 : offsets[i - 1]));

  const elf: ElfFile = {
    header: {
      ident: CW_ELF_IDENT.slice(),
      type: ET_REL,
      machine: EM_68HC12,
      version: 1,
      entry: 0,
      phoff: 0,
      shoff: 0,
      flags: 0,
      ehsize: 52,
      phentsize: 0,
      phnum: 0,
      shentsize: 40,
      shnum: sections.length,
      shstrndx: sections.length - 1,
    },
    sections,
    programHeaders: [],
  };
  return { elf, bytes: writeElf(elf), elfSymbols: syms };
}

function buildCompileUnit(
  inp: ObjectInput,
  ordered: Sym[],
  firstGlobal: number,
  secSymIndex: Map<number, number>,
  userSecs: Section[],
): CwCompileUnit {
  const cu = newCwCompileUnit(baseName(inp.dbgPath), inp.compDir, inp.dbgPath);
  cu.abbrevOffset = { value: 0, sym: secSymIndex.get(4) };
  cu.stmtList = { value: 0, sym: secSymIndex.get(6) };
  const labels = ordered.filter((s) => s.kind === 'label');
  const defGlobals = labels.filter((s) => s.elfIndex! >= firstGlobal);
  const defLocals = labels.filter((s) => s.elfIndex! < firstGlobal);
  const entries: CwEntry[] = [];
  for (const s of [...defGlobals, ...defLocals]) {
    const sym = s.elfIndex!;
    if (s.section!.hasCode) {
      entries.push({ kind: 'subprogram', name: s.name, low: { value: 0, sym }, high: { value: s.size ?? 0, sym }, external: s.xdef });
    } else {
      const elem = s.dataElem ?? 1;
      const count = s.dataCount ?? 1;
      const v: CwEntry = { kind: 'variable', name: s.name, location: { value: 0, sym }, type: elem === 1 ? 0 : elem === 2 ? 1 : 2, external: s.xdef };
      // UNCERTAIN: bit stride of non-byte arrays (only DS.B n arrays observed, stride 8).
      if (count > 1) v.array = { length: count, bitStride: 8 * elem };
      entries.push(v);
    }
  }
  cu.entries = entries;
  // Line table: one sequence per code section; a row per statement emitting code or data (the .dbg line), the
  // first row duplicated (observed in every CW object); ORG/data sections have no rows (UNCERTAIN for ORG code).
  const seqs: CwLineSequence[] = [];
  for (const sec of userSecs) {
    if (!sec.hasCode || sec.kind === 'org') continue;
    const rows = inp.stmts
      .filter((st) => st.section === sec && (st.type === 'instr' || st.type === 'dc') && st.size > 0 && st.absLine > 0 && !st.skipped)
      .map((st) => ({ address: st.loc - sec.base, line: st.absLine }));
    if (!rows.length) continue;
    rows.unshift({ ...rows[0] });
    seqs.push({ start: { value: 0, sym: sec.secSym }, rows, end: rows[rows.length - 1].address });
  }
  cu.sequences = seqs;
  return cu;
}

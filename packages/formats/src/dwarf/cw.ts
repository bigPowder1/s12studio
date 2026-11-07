// CodeWarrior HC12 assembler-flavoured DWARF 2: semantic compile-unit model, exact encoder and decoder.
// Spec: docs/research/r2/elf-lib-formats.md §3. Verified byte-identical (decode → encode) on main.asm.o, all eight
// ME305LibV4.0.lib members and the linked bin/Project.abs of Lab3 and blank_project.
import { ByteWriter, readBE } from '../util/bytes';
import { relocFromKind, relocKind } from '../elf/reloc';
import type { ElfRela } from '../elf/types';
import { encodeAbbrevTable, type Abbrev } from './abbrev';
import { DW_AT, DW_ATE, DW_FORM, DW_LANG_CW_ASM, DW_LNE, DW_LNS, DW_OP_addr, DW_TAG } from './constants';
import { DwarfError, parseCompileUnit, type Die } from './info';
import { parseLineProgram } from './line';

/**
 * A 4-byte DWARF address field, laid out as [00][page][addr16]. In an object file `value` is the in-place addend
 * and `sym` is the symbol the linker relocates against (PAGE8 at +1, ABS16 at +2). In a linked file `sym` is absent
 * and `value` is the final address.
 */
export interface CwAddr {
  value: number;
  sym?: number;
}

/** A 4-byte section offset (abbrev_offset, stmt_list). `sym` = SECTION symbol → one ABS32 relocation. */
export interface CwOffsetRef {
  value: number;
  sym?: number;
}

export interface CwBaseType {
  name: string;
  /** DW_ATE_* (sdata). */
  encoding: number;
  /** udata. */
  byteSize: number;
}

export interface CwSubprogram {
  kind: 'subprogram';
  name: string;
  /** Object file: in-place 0 + label symbol. */
  low: CwAddr;
  /** Object file: in-place = label size, same label symbol. */
  high: CwAddr;
  external: boolean;
}

export interface CwVariable {
  kind: 'variable';
  name: string;
  /** DW_OP_addr operand. */
  location: CwAddr;
  /** Index into CwCompileUnit.baseTypes (element type for arrays). */
  type: number;
  external: boolean;
  /**
   * DS.B n with n > 1: an array_type DIE (bit_stride) with one subrange (lower 0, upper length−1), emitted
   * immediately before the variable. CW never shares array DIEs between variables.
   */
  array?: { length: number; bitStride: number };
}

export type CwEntry = CwSubprogram | CwVariable;

export interface CwLineRow {
  /** Address (object file: section offset added to start.value; linked: absolute). */
  address: number;
  /** Line in the .dbg file (the listing's "Abs." column). */
  line: number;
}

export interface CwLineSequence {
  /** DW_LNE_set_address operand. Object file: section symbol + in-place 0. */
  start: CwAddr;
  rows: CwLineRow[];
  /** Address of the end_sequence row (CW: the address of the last row — no trailing advance). */
  end: number;
}

export interface CwCompileUnit {
  /** "<module>.dbg" */
  name: string;
  /** "Freescale" */
  producer: string;
  /** Project bin directory (Windows path). */
  compDir: string;
  /** 0x41 (vendor value for assembly). */
  language: number;
  abbrevOffset: CwOffsetRef;
  stmtList: CwOffsetRef;
  /** unsigned char / int / long in every sample. */
  baseTypes: CwBaseType[];
  /** Subprograms and variables in DIE order. */
  entries: CwEntry[];
  /** The single line-table file entry: absolute path of bin\<module>.dbg. */
  lineFile: string;
  sequences: CwLineSequence[];
}

export interface CwDwarfSections {
  info: Uint8Array;
  abbrev: Uint8Array;
  line: Uint8Array;
  frame: Uint8Array;
  /** Relocations for .rela.debug_info, in CW order (descending offset). */
  infoRelocs: ElfRela[];
  /** Relocations for .rela.debug_line, in CW order (descending offset). */
  lineRelocs: ElfRela[];
}

/** The three base types CW emits for DS.B / DS.W / DS.L. */
export const CW_BASE_TYPES: readonly CwBaseType[] = [
  { name: 'unsigned char', encoding: DW_ATE.unsigned_char, byteSize: 1 },
  { name: 'int', encoding: DW_ATE.signed, byteSize: 2 },
  { name: 'long', encoding: DW_ATE.signed, byteSize: 4 },
];

export const CW_PRODUCER = 'Freescale';

/** .debug_frame contents (one CIE, RA column 32, CFA = r15), identical in every CW module. */
export const CW_DEBUG_FRAME: Uint8Array = Uint8Array.from(
  (
    '0000004fffffffff01000101200d0f0e00a00008000701070207030704070507' +
    '06070708080809080a080b080c080d080e080f08100811081208130814081508' +
    '16081708180819081a081b081c081d081e081f'
  )
    .match(/../g)!
    .map((h) => parseInt(h, 16)),
);

// Line program parameters (header).
export const CW_LINE = {
  version: 2,
  minInstLength: 1,
  defaultIsStmt: true,
  lineBase: 0,
  lineRange: 4,
  opcodeBase: 10,
  standardOpcodeLengths: [0, 1, 1, 1, 1, 0, 0, 0, 1],
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Abbreviations

type AbbrevKind = 'cu' | 'base' | 'subprogram' | 'variable' | 'array' | 'subrange';

const ABBREV_SHAPES: Record<AbbrevKind, Omit<Abbrev, 'code'>> = {
  cu: {
    tag: DW_TAG.compile_unit,
    hasChildren: true,
    attrs: [
      { at: DW_AT.name, form: DW_FORM.string },
      { at: DW_AT.producer, form: DW_FORM.string },
      { at: DW_AT.comp_dir, form: DW_FORM.string },
      { at: DW_AT.language, form: DW_FORM.udata },
      { at: DW_AT.stmt_list, form: DW_FORM.data4 },
    ],
  },
  base: {
    tag: DW_TAG.base_type,
    hasChildren: false,
    attrs: [
      { at: DW_AT.name, form: DW_FORM.string },
      { at: DW_AT.encoding, form: DW_FORM.sdata },
      { at: DW_AT.byte_size, form: DW_FORM.udata },
    ],
  },
  subprogram: {
    tag: DW_TAG.subprogram,
    hasChildren: false,
    attrs: [
      { at: DW_AT.low_pc, form: DW_FORM.addr },
      { at: DW_AT.high_pc, form: DW_FORM.addr },
      { at: DW_AT.external, form: DW_FORM.flag },
      { at: DW_AT.name, form: DW_FORM.string },
    ],
  },
  variable: {
    tag: DW_TAG.variable,
    hasChildren: false,
    attrs: [
      { at: DW_AT.location, form: DW_FORM.block2 },
      { at: DW_AT.name, form: DW_FORM.string },
      { at: DW_AT.type, form: DW_FORM.ref4 },
      { at: DW_AT.external, form: DW_FORM.flag },
    ],
  },
  array: {
    tag: DW_TAG.array_type,
    hasChildren: true,
    attrs: [
      { at: DW_AT.type, form: DW_FORM.ref4 },
      { at: DW_AT.bit_stride, form: DW_FORM.udata },
    ],
  },
  subrange: {
    tag: DW_TAG.subrange_type,
    hasChildren: false,
    attrs: [
      { at: DW_AT.type, form: DW_FORM.ref4 },
      { at: DW_AT.lower_bound, form: DW_FORM.sdata },
      { at: DW_AT.upper_bound, form: DW_FORM.sdata },
    ],
  },
};

/**
 * Order of entries in the emitted abbrev table, by kind. Codes are assigned 128, 129, … in order of FIRST USE in
 * the DIE stream, but the table is written in this fixed tag order (consistent across every object of the
 * fixtures). UNCERTAIN: probably a hash-table iteration order inside the assembler.
 */
const ABBREV_TABLE_ORDER: readonly AbbrevKind[] = ['base', 'cu', 'subrange', 'variable', 'array', 'subprogram'];

// ---------------------------------------------------------------------------------------------------------------
// Encoder

/** Encode one compile unit into .debug_info/.debug_abbrev/.debug_line/.debug_frame bytes plus CW's relocations. */
export function encodeCwCompileUnit(cu: CwCompileUnit): CwDwarfSections {
  const infoRelocs: ElfRela[] = [];
  const lineRelocs: ElfRela[] = [];

  // Abbrev code assignment by first use.
  const codes = new Map<AbbrevKind, number>();
  const code = (k: AbbrevKind): number => {
    let c = codes.get(k);
    if (c === undefined) {
      c = 128 + codes.size;
      codes.set(k, c);
    }
    return c;
  };

  const w = new ByteWriter(4096);
  const addr = (a: CwAddr, relocs: ElfRela[]) => {
    const off = w.length;
    w.u32(a.value);
    if (a.sym !== undefined) {
      relocs.push(relocFromKind('PAGE8', off + 1, a.sym));
      relocs.push(relocFromKind('ABS16', off + 2, a.sym));
    }
  };
  const offRef = (a: CwOffsetRef, relocs: ElfRela[]) => {
    const off = w.length;
    w.u32(a.value);
    if (a.sym !== undefined) relocs.push(relocFromKind('ABS32', off, a.sym));
  };

  // CU header
  w.u32(0); // unit_length, patched
  w.u16(2);
  offRef(cu.abbrevOffset, infoRelocs);
  w.u8(4);
  // CU DIE
  w.uleb128(code('cu')).cstr(cu.name).cstr(cu.producer).cstr(cu.compDir).uleb128(cu.language);
  offRef(cu.stmtList, infoRelocs);
  const baseOffsets: number[] = [];
  for (const b of cu.baseTypes) {
    baseOffsets.push(w.length);
    w.uleb128(code('base')).cstr(b.name).sleb128(b.encoding).uleb128(b.byteSize);
  }
  const typeRef = (i: number): number => {
    const o = baseOffsets[i];
    if (o === undefined) throw new DwarfError(`base type index ${i} out of range`);
    return o;
  };
  for (const e of cu.entries) {
    if (e.kind === 'subprogram') {
      w.uleb128(code('subprogram'));
      addr(e.low, infoRelocs);
      addr(e.high, infoRelocs);
      w.u8(e.external ? 1 : 0).cstr(e.name);
    } else {
      let tref = typeRef(e.type);
      if (e.array) {
        const arrOff = w.length;
        w.uleb128(code('array')).u32(tref).uleb128(e.array.bitStride);
        w.uleb128(code('subrange')).u32(tref).sleb128(0).sleb128(e.array.length - 1);
        w.u8(0); // end of array children
        tref = arrOff;
      }
      w.uleb128(code('variable')).u16(5).u8(DW_OP_addr);
      addr(e.location, infoRelocs);
      w.cstr(e.name).u32(tref).u8(e.external ? 1 : 0);
    }
  }
  w.u8(0); // end of CU children
  w.setU32(0, w.length - 4);
  const info = w.finish();

  const abbrevList: Abbrev[] = ABBREV_TABLE_ORDER.filter((k) => codes.has(k)).map((k) => ({
    code: codes.get(k)!,
    ...ABBREV_SHAPES[k],
  }));
  const abbrev = encodeAbbrevTable(abbrevList);

  const line = encodeCwLineProgram(cu, lineRelocs);

  const desc = (a: ElfRela, b: ElfRela) => b.offset - a.offset;
  infoRelocs.sort(desc);
  lineRelocs.sort(desc);
  return { info, abbrev, line, frame: CW_DEBUG_FRAME.slice(), infoRelocs, lineRelocs };
}

function encodeCwLineProgram(cu: CwCompileUnit, relocs: ElfRela[]): Uint8Array {
  const w = new ByteWriter(1024);
  w.u32(0); // unit_length
  w.u16(CW_LINE.version);
  w.u32(0); // header_length
  const hdrStart = w.length;
  w.u8(CW_LINE.minInstLength).u8(CW_LINE.defaultIsStmt ? 1 : 0).i8(CW_LINE.lineBase).u8(CW_LINE.lineRange).u8(CW_LINE.opcodeBase);
  for (const n of CW_LINE.standardOpcodeLengths) w.u8(n);
  w.u8(0); // no include directories
  w.cstr(cu.lineFile).uleb128(0).uleb128(0).uleb128(0);
  w.u8(0); // end of file table
  w.setU32(6, w.length - hdrStart);

  for (const seq of cu.sequences) {
    w.u8(0).uleb128(5).u8(DW_LNE.set_address);
    const off = w.length;
    w.u32(seq.start.value);
    if (seq.start.sym !== undefined) {
      relocs.push(relocFromKind('PAGE8', off + 1, seq.start.sym));
      relocs.push(relocFromKind('ABS16', off + 2, seq.start.sym));
    }
    let address = seq.start.value;
    let line = 1;
    for (const row of seq.rows) {
      const dAddr = row.address - address;
      const dLine = row.line - line;
      if (dAddr < 0) throw new DwarfError(`line rows not in address order at line ${row.line}`);
      const special = dLine - CW_LINE.lineBase + CW_LINE.lineRange * dAddr + CW_LINE.opcodeBase;
      if (dLine >= CW_LINE.lineBase && dLine < CW_LINE.lineBase + CW_LINE.lineRange && special <= 255) {
        w.u8(special);
      } else {
        // UNCERTAIN: every observed fallback (289 across 21 files) has a line step > 3 and an address step of
        // 0..6, encoded `advance_line [advance_pc] copy` (zero advance_pc omitted). Two paths here are UNSEEN in
        // any fixture and follow plain DWARF 2 rather than evidence: (a) line step 0..3 with an address step too
        // large for a special opcode (> 61) → `[advance_line] advance_pc copy` (advance_line omitted only for a
        // line step of 0); (b) a negative line step (line_base is 0, so it always falls back) →
        // `advance_line <negative sleb> [advance_pc] copy`.
        // CW might instead e.g. split into a special opcode after advance_pc, or use const_add_pc.
        if (dLine !== 0) w.u8(DW_LNS.advance_line).sleb128(dLine);
        if (dAddr !== 0) w.u8(DW_LNS.advance_pc).uleb128(dAddr);
        w.u8(DW_LNS.copy);
      }
      address = row.address;
      line = row.line;
    }
    // UNCERTAIN: CW ends the sequence at the last row's address; a trailing advance is never observed.
    if (seq.end !== address) {
      if (seq.end < address) throw new DwarfError('end_sequence before last row');
      w.u8(DW_LNS.advance_pc).uleb128(seq.end - address);
    }
    w.u8(0).uleb128(1).u8(DW_LNE.end_sequence);
  }
  w.setU32(0, w.length - 4);
  return w.finish();
}

/**
 * Encode several compile units into concatenated sections (linked-.abs style: each module's sections back to back,
 * in link order). With `assignOffsets`, abbrevOffset/stmtList values of units without a `sym` are set to the unit's
 * offset in the concatenated .debug_abbrev/.debug_line (what the linker's relocation would have produced).
 * Relocation offsets are shifted to the concatenated section.
 */
export function encodeCwDwarfUnits(cus: readonly CwCompileUnit[], opts: { assignOffsets?: boolean } = {}): CwDwarfSections {
  const parts: CwDwarfSections[] = [];
  let infoOff = 0;
  let abbrevOff = 0;
  let lineOff = 0;
  const infoRelocs: ElfRela[] = [];
  const lineRelocs: ElfRela[] = [];
  for (const cu0 of cus) {
    const cu = { ...cu0 };
    if (opts.assignOffsets) {
      if (cu.abbrevOffset.sym === undefined) cu.abbrevOffset = { value: abbrevOff };
      if (cu.stmtList.sym === undefined) cu.stmtList = { value: lineOff };
    }
    const p = encodeCwCompileUnit(cu);
    parts.push(p);
    infoRelocs.push(...p.infoRelocs.map((r) => ({ ...r, offset: r.offset + infoOff })));
    lineRelocs.push(...p.lineRelocs.map((r) => ({ ...r, offset: r.offset + lineOff })));
    infoOff += p.info.length;
    abbrevOff += p.abbrev.length;
    lineOff += p.line.length;
  }
  const cat = (k: 'info' | 'abbrev' | 'line' | 'frame') => {
    const w = new ByteWriter(4096);
    for (const p of parts) w.bytes(p[k]);
    return w.finish();
  };
  const desc = (a: ElfRela, b: ElfRela) => b.offset - a.offset;
  return { info: cat('info'), abbrev: cat('abbrev'), line: cat('line'), frame: cat('frame'), infoRelocs: infoRelocs.sort(desc), lineRelocs: lineRelocs.sort(desc) };
}

// ---------------------------------------------------------------------------------------------------------------
// Decoder

export interface CwDecodeInput {
  info: Uint8Array;
  abbrev: Uint8Array;
  line: Uint8Array;
  /** Relocations of .debug_info / .debug_line (object files). Every one must be consumed. */
  infoRelocs?: readonly ElfRela[];
  lineRelocs?: readonly ElfRela[];
}

class RelocIndex {
  private map = new Map<string, ElfRela>();
  private used = new Set<ElfRela>();
  constructor(
    private readonly relocs: readonly ElfRela[],
    private readonly what: string,
  ) {
    for (const r of relocs) {
      const k = relocKind(r);
      if (!k) throw new DwarfError(`${what}: unknown relocation type ${r.type} width ${r.rawAddend + 1} at 0x${r.offset.toString(16)}`);
      this.map.set(`${r.offset}:${k}`, r);
    }
  }
  take(offset: number, kind: string): ElfRela | undefined {
    const r = this.map.get(`${offset}:${kind}`);
    if (r) this.used.add(r);
    return r;
  }
  /** Relocations in [lo, hi) that were not consumed. */
  unusedIn(lo: number, hi: number): ElfRela[] {
    return this.relocs.filter((r) => !this.used.has(r) && r.offset >= lo && r.offset < hi);
  }
}

function readAddr(bytes: Uint8Array, off: number, rx: RelocIndex, what: string): CwAddr {
  const value = readBE(bytes, off, 4);
  const page = rx.take(off + 1, 'PAGE8');
  const lo = rx.take(off + 2, 'ABS16');
  if (!page && !lo) return { value };
  if (!page || !lo || page.sym !== lo.sym)
    throw new DwarfError(`${what}: address field at 0x${off.toString(16)} lacks the PAGE8+ABS16 relocation pair`);
  return { value, sym: lo.sym };
}

function readOffRef(bytes: Uint8Array, off: number, rx: RelocIndex): CwOffsetRef {
  const value = readBE(bytes, off, 4);
  const r = rx.take(off, 'ABS32');
  return r ? { value, sym: r.sym } : { value };
}

function shapeMatches(die: Die, kind: AbbrevKind): boolean {
  const s = ABBREV_SHAPES[kind];
  return die.tag === s.tag && die.attrs.length === s.attrs.length && die.attrs.every((a, i) => a.at === s.attrs[i].at && a.form === s.attrs[i].form);
}

/**
 * Decode the CW compile unit whose header is at `infoOffset` in .debug_info. Throws DwarfError if the unit uses
 * anything outside CodeWarrior's asm-flavoured DWARF (so that a decode→encode round trip is exact by construction).
 */
export function decodeCwCompileUnit(input: CwDecodeInput, infoOffset = 0): CwCompileUnit {
  const irx = new RelocIndex(input.infoRelocs ?? [], '.debug_info');
  const lrx = new RelocIndex(input.lineRelocs ?? [], '.debug_line');
  const info = input.info;

  const abbrevOffset = readOffRef(info, infoOffset + 6, irx);
  const unit = parseCompileUnit(info, input.abbrev, infoOffset);
  if (unit.version !== 2 || unit.addressSize !== 4) throw new DwarfError('CW DWARF must be version 2, address_size 4');
  const root = unit.die;
  if (!shapeMatches(root, 'cu')) throw new DwarfError('unexpected compile_unit abbreviation shape');
  const str = (d: Die, i: number) => d.attrs[i].value as string;
  const num = (d: Die, i: number) => d.attrs[i].value as number;
  const stmtList = readOffRef(info, root.attrs[4].offset, irx);

  const baseTypes: CwBaseType[] = [];
  const baseByOffset = new Map<number, number>();
  const entries: CwEntry[] = [];
  const kids = root.children;
  let i = 0;
  for (; i < kids.length && shapeMatches(kids[i], 'base'); i++) {
    const d = kids[i];
    baseByOffset.set(d.offset - infoOffset, baseTypes.length);
    baseTypes.push({ name: str(d, 0), encoding: num(d, 1), byteSize: num(d, 2) });
  }
  const baseIndex = (ref: number, where: string): number => {
    const idx = baseByOffset.get(ref);
    if (idx === undefined) throw new DwarfError(`${where}: type ref 0x${ref.toString(16)} is not a base type`);
    return idx;
  };
  for (; i < kids.length; i++) {
    const d = kids[i];
    if (shapeMatches(d, 'subprogram')) {
      entries.push({
        kind: 'subprogram',
        name: str(d, 3),
        low: readAddr(info, d.attrs[0].offset, irx, 'subprogram'),
        high: readAddr(info, d.attrs[1].offset, irx, 'subprogram'),
        external: d.attrs[2].value as boolean,
      });
      if (d.children.length) throw new DwarfError('subprogram with children');
      continue;
    }
    let array: CwVariable['array'];
    let arrayElem = -1;
    let arrayOffset = -1;
    let v = d;
    if (shapeMatches(d, 'array')) {
      const sub = d.children;
      if (sub.length !== 1 || !shapeMatches(sub[0], 'subrange')) throw new DwarfError('array_type must have exactly one subrange');
      arrayElem = baseIndex(num(d, 0), 'array_type');
      if (baseIndex(num(sub[0], 0), 'subrange') !== arrayElem || num(sub[0], 1) !== 0)
        throw new DwarfError('subrange type/lower bound differs from CW convention');
      array = { length: num(sub[0], 2) + 1, bitStride: num(d, 1) };
      arrayOffset = d.offset - infoOffset;
      v = kids[++i];
      if (!v || !shapeMatches(v, 'variable') || num(v, 2) !== arrayOffset)
        throw new DwarfError('array_type not immediately followed by its variable');
    }
    if (!shapeMatches(v, 'variable')) throw new DwarfError(`unexpected DIE tag 0x${v.tag.toString(16)} at 0x${v.offset.toString(16)}`);
    const loc = v.attrs[0].value as Uint8Array;
    if (loc.length !== 5 || loc[0] !== DW_OP_addr) throw new DwarfError('variable location is not DW_OP_addr <4>');
    const variable: CwVariable = {
      kind: 'variable',
      name: str(v, 1),
      location: readAddr(info, v.attrs[0].offset + 3, irx, 'variable'),
      type: array ? arrayElem : baseIndex(num(v, 2), 'variable'),
      external: v.attrs[3].value as boolean,
    };
    if (array) variable.array = array;
    entries.push(variable);
  }

  const leftover = irx.unusedIn(infoOffset, unit.end);
  if (leftover.length) throw new DwarfError(`${leftover.length} unconsumed .debug_info relocations (first at 0x${leftover[0].offset.toString(16)})`);

  // Line program
  const lp = parseLineProgram(input.line, stmtList.value, 4);
  const h = lp.header;
  if (
    h.version !== CW_LINE.version ||
    h.minInstLength !== CW_LINE.minInstLength ||
    h.defaultIsStmt !== CW_LINE.defaultIsStmt ||
    h.lineBase !== CW_LINE.lineBase ||
    h.lineRange !== CW_LINE.lineRange ||
    h.opcodeBase !== CW_LINE.opcodeBase ||
    h.standardOpcodeLengths.join() !== CW_LINE.standardOpcodeLengths.join() ||
    h.includeDirs.length !== 0 ||
    h.files.length !== 1 ||
    h.files[0].dir || h.files[0].mtime || h.files[0].length
  )
    throw new DwarfError('line program header differs from CW convention');
  const sequences: CwLineSequence[] = [];
  const starts = lp.ops
    .filter((o) => o.opcode === 0 && o.ext === DW_LNE.set_address)
    .map((o) => readAddr(input.line, o.operandOffset!, lrx, 'line'));
  let cur: CwLineSequence | undefined;
  let si = 0;
  for (const row of lp.rows) {
    if (!cur) {
      const start = starts[si++];
      if (!start) throw new DwarfError('line rows before set_address');
      cur = { start, rows: [], end: 0 };
    }
    if (row.file !== 1 || row.column !== 0 || !row.isStmt) throw new DwarfError('line row uses file/column/is_stmt');
    if (row.endSequence) {
      cur.end = row.address;
      sequences.push(cur);
      cur = undefined;
    } else cur.rows.push({ address: row.address, line: row.line });
  }
  if (cur) throw new DwarfError('line program without end_sequence');
  const lineLeft = lrx.unusedIn(stmtList.value, h.end);
  if (lineLeft.length) throw new DwarfError(`${lineLeft.length} unconsumed .debug_line relocations`);

  return {
    name: str(root, 0),
    producer: str(root, 1),
    compDir: str(root, 2),
    language: num(root, 3),
    abbrevOffset,
    stmtList,
    baseTypes,
    entries,
    lineFile: h.files[0].name,
    sequences,
  };
}

/** Decode every compile unit of a (possibly linked, concatenated) set of debug sections. */
export function decodeCwCompileUnits(input: CwDecodeInput): CwCompileUnit[] {
  const out: CwCompileUnit[] = [];
  let off = 0;
  while (off + 11 <= input.info.length) {
    out.push(decodeCwCompileUnit(input, off));
    off += 4 + readBE(input.info, off, 4);
  }
  return out;
}

/** A fresh CU description with CW defaults (language 0x41, producer "Freescale", the three base types). */
export function newCwCompileUnit(name: string, compDir: string, lineFile: string): CwCompileUnit {
  return {
    name,
    producer: CW_PRODUCER,
    compDir,
    language: DW_LANG_CW_ASM,
    abbrevOffset: { value: 0 },
    stmtList: { value: 0 },
    baseTypes: CW_BASE_TYPES.map((b) => ({ ...b })),
    entries: [],
    lineFile,
    sequences: [],
  };
}

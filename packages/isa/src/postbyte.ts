/**
 * Postbyte encode/decode: indexed addressing (`xb`), TFR/EXG/SEX (`eb`) and loop primitives (`lb`).
 *
 * Indexed postbyte (CPU12RM Table A-3/A-4):
 *   rr0nnnnn  5-bit signed offset            (IDX,   0 extension bytes)
 *   rr1pnnnn  auto pre/post inc/dec 1..8     (IDX,   X/Y/SP only; rr=11 is the 111xxxxx group)
 *   111rr0zs  z=0: 9-bit offset, s = sign    (IDX1,  1 byte)
 *   111rr010  16-bit offset                  (IDX2,  2 bytes)
 *   111rr011  [n16,r]                        ([IDX2], 2 bytes)
 *   111rr1aa  aa=00 A,r / 01 B,r / 10 D,r    (IDX,   0 bytes)
 *   111rr111  [D,r]                          ([D,IDX], 0 bytes)
 * All 256 postbyte values are legal.
 */
import type { Cpu } from './table.js';

export type IndexReg = 'X' | 'Y' | 'SP' | 'PC';
export const INDEX_REGS: readonly IndexReg[] = ['X', 'Y', 'SP', 'PC'];

/** Cycle class of an indexed operand (the columns of the CPU12RM access-detail tables). */
export type IdxClass = 'IDX' | 'IDX1' | 'IDX2' | '[D,IDX]' | '[IDX2]';
export const IDX_CLASSES: readonly IdxClass[] = ['IDX', 'IDX1', 'IDX2', '[D,IDX]', '[IDX2]'];

export type IdxKind =
  | 'n5' // 5-bit constant offset
  | 'pre' // n,+r / n,-r
  | 'post' // n,r+ / n,r-
  | 'n9' // 9-bit constant offset
  | 'n16' // 16-bit constant offset
  | 'ind16' // [n16,r]
  | 'acc' // A,r / B,r / D,r
  | 'indD'; // [D,r]

export interface IndexedOperand {
  kind: IdxKind;
  reg: IndexReg;
  /**
   * n5/n9: signed offset. n16/ind16: raw 16-bit offset 0..$FFFF (wraps, sign irrelevant).
   * pre/post: signed adjustment (+1..+8 or -1..-8). acc/indD: 0.
   */
  offset: number;
  /** Accumulator for 'acc' (A, B or D); 'D' for 'indD'. */
  acc?: 'A' | 'B' | 'D';
  indirect: boolean;
  postbyte: number;
  /** Extension bytes following the postbyte (0, 1 or 2). */
  extBytes: 0 | 1 | 2;
  cls: IdxClass;
}

/** Number of extension bytes that follow indexed postbyte `xb`. */
export function indexedExtBytes(xb: number): 0 | 1 | 2 {
  if ((xb & 0xe0) !== 0xe0) return 0;
  const m = xb & 7;
  if (m <= 1) return 1;
  if (m <= 3) return 2;
  return 0;
}

/** Cycle class for postbyte `xb`. */
export function indexedClass(xb: number): IdxClass {
  if ((xb & 0xe0) !== 0xe0) return 'IDX';
  switch (xb & 7) {
    case 0:
    case 1:
      return 'IDX1';
    case 2:
      return 'IDX2';
    case 3:
      return '[IDX2]';
    case 7:
      return '[D,IDX]';
    default:
      return 'IDX';
  }
}

const sx = (v: number, bits: number): number => {
  const m = 1 << (bits - 1);
  return ((v & (m * 2 - 1)) ^ m) - m;
};

/**
 * Decode an indexed postbyte plus its extension bytes (`ext[0]`, `ext[1]`; extra entries ignored).
 * Missing extension bytes read as 0.
 */
export function decodeIndexed(xb: number, ext: readonly number[] = []): IndexedOperand {
  xb &= 0xff;
  const e0 = (ext[0] ?? 0) & 0xff;
  const e1 = (ext[1] ?? 0) & 0xff;
  const base = { postbyte: xb, extBytes: indexedExtBytes(xb), cls: indexedClass(xb) };
  if ((xb & 0xe0) !== 0xe0) {
    const reg = INDEX_REGS[xb >> 6];
    if ((xb & 0x20) === 0) return { ...base, kind: 'n5', reg, offset: sx(xb, 5), indirect: false };
    const n = xb & 0x0f;
    const offset = n < 8 ? n + 1 : n - 16;
    return { ...base, kind: xb & 0x10 ? 'post' : 'pre', reg, offset, indirect: false };
  }
  const reg = INDEX_REGS[(xb >> 3) & 3];
  switch (xb & 7) {
    case 0:
    case 1:
      return { ...base, kind: 'n9', reg, offset: xb & 1 ? e0 - 256 : e0, indirect: false };
    case 2:
      return { ...base, kind: 'n16', reg, offset: (e0 << 8) | e1, indirect: false };
    case 3:
      return { ...base, kind: 'ind16', reg, offset: (e0 << 8) | e1, indirect: true };
    case 4:
      return { ...base, kind: 'acc', reg, offset: 0, acc: 'A', indirect: false };
    case 5:
      return { ...base, kind: 'acc', reg, offset: 0, acc: 'B', indirect: false };
    case 6:
      return { ...base, kind: 'acc', reg, offset: 0, acc: 'D', indirect: false };
    default:
      return { ...base, kind: 'indD', reg, offset: 0, acc: 'D', indirect: true };
  }
}

export interface IndexedSpec {
  kind: IdxKind;
  reg: IndexReg;
  offset?: number;
  acc?: 'A' | 'B' | 'D';
}

/**
 * Encode an indexed operand to postbyte + extension bytes. Throws RangeError for unencodable specs
 * (offset out of range, auto inc/dec on PC, accumulator missing).
 */
export function encodeIndexed(spec: IndexedSpec): number[] {
  const rr = INDEX_REGS.indexOf(spec.reg);
  if (rr < 0) throw new RangeError(`bad index register ${spec.reg}`);
  const off = spec.offset ?? 0;
  switch (spec.kind) {
    case 'n5':
      if (off < -16 || off > 15) throw new RangeError(`5-bit offset out of range: ${off}`);
      return [(rr << 6) | (off & 0x1f)];
    case 'pre':
    case 'post': {
      if (spec.reg === 'PC') throw new RangeError('auto increment/decrement not allowed on PC');
      if (off === 0 || off < -8 || off > 8) throw new RangeError(`auto inc/dec out of range: ${off}`);
      const n = off > 0 ? off - 1 : off & 0x0f;
      return [(rr << 6) | 0x20 | (spec.kind === 'post' ? 0x10 : 0) | n];
    }
    case 'n9':
      if (off < -256 || off > 255) throw new RangeError(`9-bit offset out of range: ${off}`);
      return [0xe0 | (rr << 3) | (off < 0 ? 1 : 0), off & 0xff];
    case 'n16':
    case 'ind16': {
      if (off < -0x8000 || off > 0xffff) throw new RangeError(`16-bit offset out of range: ${off}`);
      const v = off & 0xffff;
      return [0xe0 | (rr << 3) | (spec.kind === 'n16' ? 2 : 3), v >> 8, v & 0xff];
    }
    case 'acc': {
      const a = spec.acc === 'A' ? 4 : spec.acc === 'B' ? 5 : spec.acc === 'D' ? 6 : -1;
      if (a < 0) throw new RangeError('accumulator offset needs acc A, B or D');
      return [0xe0 | (rr << 3) | a];
    }
    case 'indD':
      return [0xe0 | (rr << 3) | 7];
  }
}

/** Re-encode a decoded operand (exact form preserved). */
export function reencodeIndexed(op: IndexedOperand): number[] {
  return encodeIndexed({ kind: op.kind, reg: op.reg, offset: op.offset, acc: op.acc });
}

/**
 * Smallest constant-offset form for `offset` (5-bit, then 9-bit, then 16-bit), as an assembler
 * would choose for a known value. For PC-relative operands the caller must iterate (the offset
 * depends on the instruction length).
 */
export function smallestOffsetKind(offset: number): 'n5' | 'n9' | 'n16' {
  if (offset >= -16 && offset <= 15) return 'n5';
  if (offset >= -256 && offset <= 255) return 'n9';
  return 'n16';
}

export interface IdxFormatOptions {
  /** Hex prefix for 9/16-bit offsets: '0x' (hiwave) or '$' (assembler syntax). */
  hex?: '0x' | '$';
}

const hexStr = (v: number, digits: number, prefix: string): string =>
  prefix + v.toString(16).toUpperCase().padStart(digits, '0');

/**
 * Text of an indexed operand, e.g. `0,X`, `2,SP+`, `-0x14,Y`, `0x1234,X`, `[D,X]`, `[0x10,SP]`.
 * 5-bit offsets and auto inc/dec amounts are decimal.
 * UNCERTAIN: hiwave's exact rendering of 9/16-bit offsets (hex vs decimal) is unverified.
 */
export function formatIndexed(op: IndexedOperand, opts: IdxFormatOptions = {}): string {
  const p = opts.hex ?? '0x';
  const r = op.reg;
  switch (op.kind) {
    case 'n5':
      return `${op.offset},${r}`;
    case 'pre':
      return `${Math.abs(op.offset)},${op.offset > 0 ? '+' : '-'}${r}`;
    case 'post':
      return `${Math.abs(op.offset)},${r}${op.offset > 0 ? '+' : '-'}`;
    case 'n9':
      return `${op.offset < 0 ? '-' : ''}${hexStr(Math.abs(op.offset), 2, p)},${r}`;
    case 'n16':
      return `${hexStr(op.offset, 4, p)},${r}`;
    case 'ind16':
      return `[${hexStr(op.offset, 4, p)},${r}]`;
    case 'acc':
      return `${op.acc},${r}`;
    case 'indD':
      return `[D,${r}]`;
  }
}

export interface IndexRegs {
  X: number;
  Y: number;
  SP: number;
  A: number;
  B: number;
}

export interface IndexedEA {
  /** Address formed from base + offset (for indirect forms: the pointer's address). */
  address: number;
  indirect: boolean;
  /** Register write-back for auto inc/dec forms. */
  writeback?: { reg: Exclude<IndexReg, 'PC'>; value: number };
}

/**
 * Effective address of an indexed operand. `pcBase` is the PC value used for PC-relative forms
 * (normally the address of the next instruction; see `movePcBase` in disasm for MOVB/MOVW).
 * Pre-modify forms use the modified register; post-modify forms use the old value.
 * A,r and B,r use the accumulator zero-extended; D,r is 16-bit.
 */
export function indexedEA(op: IndexedOperand, regs: IndexRegs, pcBase: number): IndexedEA {
  const base = op.reg === 'PC' ? pcBase : regs[op.reg];
  const w = (v: number) => v & 0xffff;
  switch (op.kind) {
    case 'pre': {
      const v = w(base + op.offset);
      return { address: v, indirect: false, writeback: { reg: op.reg as 'X', value: v } };
    }
    case 'post':
      return { address: w(base), indirect: false, writeback: { reg: op.reg as 'X', value: w(base + op.offset) } };
    case 'acc': {
      const a = op.acc === 'A' ? regs.A : op.acc === 'B' ? regs.B : (regs.A << 8) | regs.B;
      return { address: w(base + a), indirect: false };
    }
    case 'indD':
      return { address: w(base + ((regs.A << 8) | regs.B)), indirect: true };
    default:
      return { address: w(base + op.offset), indirect: op.indirect };
  }
}

// ---------------------------------------------------------------------------------------------
// TFR / EXG / SEX postbyte (B7 eb)

export type XferOp = 'TFR' | 'EXG' | 'SEX';

/** Register names used by TFR/EXG/SEX. CCR = CCRL. TMP3 (source) / TMP2 (destination) are reserved. */
export type XferReg =
  | 'A' | 'B' | 'CCR' | 'TMP3' | 'TMP2' | 'D' | 'X' | 'Y' | 'SP'
  | 'CCRH' | 'CCRW' | 'XH' | 'XL' | 'YH' | 'YL' | 'SPH' | 'SPL';

export interface XferDecoded {
  op: XferOp;
  src: XferReg;
  dst: XferReg;
  postbyte: number;
  /** Uses a CPU12X-only encoding (LS nibble 8..F with a special meaning). */
  s12x: boolean;
  /** Involves the reserved TMP2/TMP3 registers. */
  reserved: boolean;
}

const SRC_NAMES: XferReg[] = ['A', 'B', 'CCR', 'TMP3', 'D', 'X', 'Y', 'SP'];
const DST_NAMES: XferReg[] = ['A', 'B', 'CCR', 'TMP2', 'D', 'X', 'Y', 'SP'];
const IS8 = (r: number): boolean => r <= 2;

/**
 * CPU12X-only TFR/EXG/SEX encodings with bit 3 set (libasm table_mc68hc12.cpp TFR_PAIRS /
 * SEX_PAIRS / EXG_PAIRS, cross-checked with Ghidra HCS_HC12.sinc per docs/research/r2/s12x-isa.md).
 * Any other postbyte with bit 3 set behaves as if bit 3 were clear (CPU12 "don't care").
 */
const S12X_XFER: ReadonlyArray<[number, XferOp, XferReg, XferReg]> = [
  [0x28, 'TFR', 'CCRH', 'A'],
  [0x58, 'TFR', 'XH', 'A'],
  [0x68, 'TFR', 'YH', 'A'],
  [0x78, 'TFR', 'SPH', 'A'],
  [0x0a, 'TFR', 'A', 'CCRH'],
  [0x2a, 'TFR', 'CCRW', 'CCRW'],
  [0x4a, 'TFR', 'D', 'CCRW'],
  [0x5a, 'TFR', 'X', 'CCRW'],
  [0x6a, 'TFR', 'Y', 'CCRW'],
  [0x7a, 'TFR', 'SP', 'CCRW'],
  [0x2c, 'TFR', 'CCRW', 'D'],
  [0x0d, 'TFR', 'A', 'XH'],
  [0x1d, 'TFR', 'B', 'XL'],
  [0x2d, 'TFR', 'CCRW', 'X'],
  [0x0e, 'TFR', 'A', 'YH'],
  [0x1e, 'TFR', 'B', 'YL'],
  [0x2e, 'TFR', 'CCRW', 'Y'],
  [0x0f, 'TFR', 'A', 'SPH'],
  [0x1f, 'TFR', 'B', 'SPL'],
  [0x2f, 'TFR', 'CCRW', 'SP'],
  [0x4d, 'SEX', 'D', 'X'],
  [0x4e, 'SEX', 'D', 'Y'],
  [0x4f, 'SEX', 'D', 'SP'],
  [0xa8, 'EXG', 'CCRH', 'A'],
  [0xd8, 'EXG', 'XH', 'A'],
  [0xe8, 'EXG', 'YH', 'A'],
  [0xf8, 'EXG', 'SPH', 'A'],
  [0xd9, 'EXG', 'XL', 'B'],
  [0xe9, 'EXG', 'YL', 'B'],
  [0xf9, 'EXG', 'SPL', 'B'],
  [0x8a, 'EXG', 'A', 'CCRH'],
  [0xaa, 'EXG', 'CCRW', 'CCRW'],
  [0xca, 'EXG', 'D', 'CCRW'],
  [0xda, 'EXG', 'X', 'CCRW'],
  [0xea, 'EXG', 'Y', 'CCRW'],
  [0xfa, 'EXG', 'SP', 'CCRW'],
  [0xac, 'EXG', 'CCRW', 'D'],
  [0x8d, 'EXG', 'A', 'XH'],
  [0x9d, 'EXG', 'B', 'XL'],
  [0xad, 'EXG', 'CCRW', 'X'],
  [0x8e, 'EXG', 'A', 'YH'],
  [0x9e, 'EXG', 'B', 'YL'],
  [0xae, 'EXG', 'CCRW', 'Y'],
  [0x8f, 'EXG', 'A', 'SPH'],
  [0x9f, 'EXG', 'B', 'SPL'],
  [0xaf, 'EXG', 'CCRW', 'SP'],
];
const S12X_XFER_MAP = new Map(S12X_XFER.map((e) => [e[0], e]));

function decodeBasic(eb: number): XferDecoded {
  const r1 = (eb >> 4) & 7;
  const r2 = eb & 7;
  const exg = (eb & 0x80) !== 0;
  const op: XferOp = exg ? 'EXG' : IS8(r1) && !IS8(r2) ? 'SEX' : 'TFR';
  return {
    op,
    src: SRC_NAMES[r1],
    dst: DST_NAMES[r2],
    postbyte: eb,
    s12x: false,
    reserved: r1 === 3 || r2 === 3,
  };
}

/**
 * Decode a TFR/EXG/SEX postbyte. Bit 3 is "don't care" on CPU12; on CPU12X it selects the
 * extended register set for the combinations in S12X_XFER and is don't-care otherwise.
 * UNCERTAIN: CPU12X behaviour of bit-3 encodings that are not in the libasm table.
 */
export function decodeTfrExg(eb: number, cpu: Cpu = 's12x'): XferDecoded {
  eb &= 0xff;
  if (cpu === 's12x' && eb & 0x08) {
    const e = S12X_XFER_MAP.get(eb);
    if (e) return { op: e[1], src: e[2], dst: e[3], postbyte: eb, s12x: true, reserved: false };
  }
  return { ...decodeBasic(eb & ~0x08), postbyte: eb };
}

/** CCR (SXHINZVC) effect string written by a CCR write (X can only be cleared). */
const CCR_WRITTEN = 'WvWWWWWW';
const CCR_UNCHANGED = '--------';

/**
 * CCR effect of a TFR/EXG/SEX postbyte, in the OpForm.ccr notation (S X H I N Z V C):
 * 'WvWWWWWW' when CCR (CCRL) or CCRW is written - TFR/SEX with that destination, EXG with it on
 * either side - otherwise unchanged. A CCRH-only write (CPU12X: TFR/EXG with CCRH) changes only the
 * IPL bits, so the flag string is unchanged; see `xferWritesIpl`.
 */
export function xferCcr(eb: number, cpu: Cpu = 's12x'): string {
  const x = decodeTfrExg(eb, cpu);
  const writes = (r: XferReg): boolean => r === 'CCR' || r === 'CCRW';
  return writes(x.dst) || (x.op === 'EXG' && writes(x.src)) ? CCR_WRITTEN : CCR_UNCHANGED;
}

/** True when the TFR/EXG postbyte writes CCRH (the IPL) on the CPU12X (CCRH or CCRW destination). */
export function xferWritesIpl(eb: number, cpu: Cpu = 's12x'): boolean {
  if (cpu !== 's12x') return false;
  const x = decodeTfrExg(eb, cpu);
  const writes = (r: XferReg): boolean => r === 'CCRH' || r === 'CCRW';
  return writes(x.dst) || (x.op === 'EXG' && writes(x.src));
}

const REG_ALIASES: Record<string, XferReg> = { CCRL: 'CCR', TMP2: 'TMP2', TMP3: 'TMP3' };
const normReg = (r: string): string => {
  const u = r.trim().toUpperCase();
  return REG_ALIASES[u] ?? u;
};

/**
 * Encode TFR/EXG/SEX. `TFR r8,r16` is accepted and encodes like SEX. Returns undefined when the
 * combination does not exist on `cpu`. Prefers the CPU12 encoding (bit 3 clear).
 */
export function encodeTfrExg(op: XferOp | string, src: string, dst: string, cpu: Cpu = 's12x'): number | undefined {
  const o = op.toUpperCase();
  let s = normReg(src);
  let d = normReg(dst);
  // TMP2 is the destination spelling of register 3, TMP3 the source spelling.
  if (s === 'TMP2') s = 'TMP3';
  if (d === 'TMP3') d = 'TMP2';
  for (let eb = 0; eb < 0x100; eb++) {
    if (eb & 0x08) continue;
    const x = decodeBasic(eb);
    if (x.src !== s || x.dst !== d) continue;
    if (x.op === o || (o === 'TFR' && x.op === 'SEX') || (o === 'SEX' && x.op === 'SEX')) return eb;
  }
  if (cpu === 's12x') {
    for (const [eb, xo, xs, xd] of S12X_XFER) if (xo === o && xs === s && xd === d) return eb;
  }
  return undefined;
}

/** Bit width of a TFR/EXG register. */
export function xferRegWidth(r: XferReg): 8 | 16 {
  return r === 'A' || r === 'B' || r === 'CCR' || r === 'CCRH' || r.endsWith('H') || r.endsWith('L') ? 8 : 16;
}

// ---------------------------------------------------------------------------------------------
// Loop primitives (04 lb rr)

export type LoopOp = 'DBEQ' | 'DBNE' | 'TBEQ' | 'TBNE' | 'IBEQ' | 'IBNE';
export const LOOP_OPS: readonly LoopOp[] = ['DBEQ', 'DBNE', 'TBEQ', 'TBNE', 'IBEQ', 'IBNE'];
export type LoopReg = 'A' | 'B' | 'D' | 'X' | 'Y' | 'SP';
const LOOP_REGS: Array<LoopReg | undefined> = ['A', 'B', undefined, undefined, 'D', 'X', 'Y', 'SP'];

export interface LoopDecoded {
  /** Undefined for the unused operation codes 110/111. */
  op?: LoopOp;
  /** Undefined for the unused register codes 010/011. */
  reg?: LoopReg;
  /** Bit 4: sign (bit 8) of the 9-bit offset. */
  negative: boolean;
  valid: boolean;
  /** Bit 3 (marked 'x' in CPU12RM Table A-6) is set: decodes, but no assembler emits it. */
  dontCare: boolean;
}

// UNCERTAIN: bit 3 of lb is treated as don't-care (CPU12RM Table A-6 marks it 'x'); libasm rejects it.
// It is reported through `dontCare` (and DecodedInstruction.nonCanonical) so a UI can flag it.
export function decodeLoop(lb: number): LoopDecoded {
  const op = LOOP_OPS[(lb >> 5) & 7] as LoopOp | undefined;
  const reg = LOOP_REGS[lb & 7];
  const d: LoopDecoded = {
    negative: (lb & 0x10) !== 0,
    valid: op !== undefined && reg !== undefined,
    dontCare: (lb & 0x08) !== 0,
  };
  if (op) d.op = op;
  if (reg) d.reg = reg;
  return d;
}

/** Signed 9-bit loop offset from `lb` and `rr`. */
export function loopOffset(lb: number, rr: number): number {
  return lb & 0x10 ? (rr & 0xff) - 256 : rr & 0xff;
}

/** Encode `op reg,offset` (offset relative to the end of the 3-byte instruction) as [lb, rr]. */
export function encodeLoop(op: LoopOp | string, reg: LoopReg | string, offset: number): [number, number] {
  const o = LOOP_OPS.indexOf(op.toUpperCase() as LoopOp);
  const r = LOOP_REGS.indexOf(reg.toUpperCase() as LoopReg);
  if (o < 0 || r < 0) throw new RangeError(`bad loop primitive ${op} ${reg}`);
  if (offset < -256 || offset > 255) throw new RangeError(`loop offset out of range: ${offset}`);
  return [(o << 5) | (offset < 0 ? 0x10 : 0) | r, offset & 0xff];
}

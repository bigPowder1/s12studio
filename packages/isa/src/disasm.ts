/**
 * CPU12 / CPU12X disassembler, formatted like hiwave's Assembly window
 * (`4000 B63000   LDAA 0x3000`: uppercase mnemonics, 0x-prefixed uppercase hex).
 *
 * UNCERTAIN (hiwave rendering details, configurable through DecodeOptions):
 *  - branch operands render as `*+n` / `*-n` (offset from the instruction address, decimal) with a
 *    `abs = 0xXXXX` comment, as the Freescale debuggers do; `branchStyle: 'absolute'` prints the target;
 *  - 5-bit indexed offsets decimal, 9/16-bit offsets hex;
 *  - direct addresses as 2 hex digits, extended as 4;
 *  - fixed-operand aliases (CLI, SEI, TSX, INS, ...) print in their canonical form unless
 *    `aliases: true`.
 */
import { formCycles, type CycleContext } from './cycles.js';
import {
  decodeIndexed,
  decodeLoop,
  decodeTfrExg,
  formatIndexed,
  indexedExtBytes,
  loopOffset,
  xferCcr,
  type IdxClass,
  type IndexedOperand,
  type XferReg,
} from './postbyte.js';
import { accessFor, aliasForBytes, formsAt, idxAllowed, idxSetFor, type AddrMode, type Cpu, type OpForm } from './table.js';

export type ReadByte = (address: number) => number;

export interface DecodeOptions {
  /** Default 's12x' (MC9S12XDP512). */
  cpu?: Cpu;
  /** Hex prefix: '0x' (hiwave, default) or '$' (assembler syntax). */
  hex?: '0x' | '$';
  /** Symbol lookup for direct/extended addresses and branch targets ("Display Symbolic"). */
  symbols?: (address: number) => string | undefined;
  /** Print fixed-encoding aliases (CLI, SEI, TSX, INS, ABX, ...) instead of the canonical form. */
  aliases?: boolean;
  /** Branch operand style: '*+n' relative (default) or the absolute target address. */
  branchStyle?: 'relative' | 'absolute';
}

export type Operand =
  | { kind: 'imm'; value: number; size: 8 | 16 }
  | { kind: 'dir'; address: number }
  | { kind: 'ext'; address: number }
  | {
      kind: 'idx';
      idx: IndexedOperand;
      /** For PC-relative operands: the PC base used for the offset. */
      pcBase?: number;
      /** Constant effective address (PC-relative constant offsets: target, or pointer address if indirect). */
      address?: number;
    }
  | { kind: 'rel'; target: number; offset: number }
  | { kind: 'mask'; value: number }
  | { kind: 'page'; value: number }
  | { kind: 'reg'; name: XferReg | string }
  | { kind: 'trap'; value: number };

export interface DecodedInstruction {
  address: number;
  length: number;
  bytes: number[];
  /** Uppercase mnemonic ('???' for an undecodable loop-primitive postbyte). */
  mnemonic: string;
  operandsText: string;
  /** Trailing comment, e.g. `abs = 0x4018` for branches. */
  comment?: string;
  mode: AddrMode | 'ILLEGAL';
  form?: OpForm;
  operands: Operand[];
  /** Branch / jump / call target when statically known. */
  targetAddress?: number;
  /** Cycle count (branches: taken). Loop instructions (REV/REVW/WAV) count the fixed part only. */
  cycles: number;
  /** Cycle count when a conditional branch / loop primitive is not taken. */
  cyclesNotTaken?: number;
  /** Indexed class of the (source) indexed operand, for cycle accounting. */
  idxClass?: IdxClass;
  /** Indexed class of the destination operand of MOVB/MOVW idx->idx. */
  idxDstClass?: IdxClass;
  /**
   * CCR effect of this instruction (OpForm.ccr notation, S X H I N Z V C). Equals `form.ccr` except
   * for TFR/EXG that write CCR/CCRW ('WvWWWWWW', see `xferCcr`).
   */
  ccr: string;
  /** Undefined encoding (bad loop primitive postbyte). */
  illegal?: boolean;
  /**
   * The operand is not allowed: an indexed variant this instruction does not accept on the selected
   * CPU, or a TFR/EXG/SEX postbyte naming the reserved TMP2/TMP3 registers (libasm: ILLEGAL_REGISTER).
   */
  invalidOperand?: boolean;
  /**
   * A postbyte bit documented as "don't care" is set (loop primitive lb bit 3; TFR/EXG eb bit 3 outside
   * the CPU12X extended-register combinations). The CPU ignores it; no assembler emits it.
   */
  nonCanonical?: boolean;
}

const hex = (v: number, digits: number, p: string): string => p + (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');
const s8 = (v: number): number => ((v & 0xff) ^ 0x80) - 0x80;
const s16 = (v: number): number => ((v & 0xffff) ^ 0x8000) - 0x8000;

/** Decode one instruction at `pc` (16-bit CPU address; reads wrap at $FFFF). */
export function decode(read: ReadByte, pc: number, opts: DecodeOptions = {}): DecodedInstruction {
  const cpu = opts.cpu ?? 's12x';
  const p = opts.hex ?? '0x';
  const start = pc & 0xffff;
  const bytes: number[] = [];
  const at = (): number => (start + bytes.length) & 0xffff;
  const next = (): number => {
    const b = read(at()) & 0xff;
    bytes.push(b);
    return b;
  };
  const word = (): number => (next() << 8) | next();

  let prefix: 0 | 0x18 = 0;
  let opcode = next();
  if (opcode === 0x18) {
    prefix = 0x18;
    opcode = next();
  }
  const candidates = formsAt(cpu, prefix, opcode);
  let form: OpForm | undefined = candidates[0];
  if (candidates.length > 1) {
    const post = read(at()) & 0xff;
    const name =
      form.mode === 'LOOP' ? decodeLoop(post).op : form.mode === 'TFR_EXG' ? decodeTfrExg(post, cpu).op : undefined;
    form = candidates.find((f) => f.mnemonic === name);
  }
  if (!form) {
    // Only reachable for an unused loop-primitive operation code (04 lb with lb bits 7:5 = 110/111).
    next();
    next();
    return {
      address: start,
      length: bytes.length,
      bytes,
      mnemonic: '???',
      operandsText: '',
      mode: 'ILLEGAL',
      operands: [],
      ccr: '--------',
      cycles: 3,
      illegal: true,
    };
  }

  const operands: Operand[] = [];
  const idxOps: Array<Extract<Operand, { kind: 'idx' }>> = [];
  let invalidOperand = false;
  let illegal = false;
  let nonCanonical = false;
  let ccr = form.ccr;
  let srcEnd = -1; // byte count after the source operand of MOV_IDX_IDX
  const idxSet = idxSetFor(form, cpu);

  const readIdx = (): Extract<Operand, { kind: 'idx' }> => {
    const xb = next();
    const ext: number[] = [];
    for (let i = indexedExtBytes(xb); i > 0; i--) ext.push(next());
    const idx = decodeIndexed(xb, ext);
    if (!idxAllowed(idxSet, idx.cls)) invalidOperand = true;
    const o: Extract<Operand, { kind: 'idx' }> = { kind: 'idx', idx };
    idxOps.push(o);
    return o;
  };
  const imm = (size: 8 | 16): Operand => ({ kind: 'imm', value: size === 16 ? word() : next(), size });
  const ext = (): Operand => ({ kind: 'ext', address: word() });
  const dir = (): Operand => ({ kind: 'dir', address: next() });
  const size: 8 | 16 = form.size === 16 ? 16 : 8;

  switch (form.mode) {
    case 'INH':
      break;
    case 'IMM8':
      operands.push(imm(8));
      break;
    case 'IMM16':
      operands.push(imm(16));
      break;
    case 'DIR':
      operands.push(dir());
      break;
    case 'EXT':
      operands.push(ext());
      break;
    case 'IDX':
      operands.push(readIdx());
      break;
    case 'REL8': {
      const off = s8(next());
      operands.push({ kind: 'rel', offset: off, target: (at() + off) & 0xffff });
      break;
    }
    case 'REL16': {
      const off = s16(word());
      operands.push({ kind: 'rel', offset: off, target: (at() + off) & 0xffff });
      break;
    }
    case 'LOOP': {
      const lb = next();
      const lp = decodeLoop(lb);
      const off = loopOffset(lb, next());
      if (!lp.reg) illegal = true;
      if (lp.dontCare) nonCanonical = true;
      operands.push({ kind: 'reg', name: lp.reg ?? '?' });
      operands.push({ kind: 'rel', offset: off, target: (at() + off) & 0xffff });
      break;
    }
    case 'BIT_DIR':
    case 'BRBIT_DIR':
    case 'BIT_EXT':
    case 'BRBIT_EXT':
    case 'BIT_IDX':
    case 'BRBIT_IDX': {
      operands.push(form.mode.endsWith('DIR') ? dir() : form.mode.endsWith('EXT') ? ext() : readIdx());
      operands.push({ kind: 'mask', value: next() });
      if (form.mode.startsWith('BRBIT')) {
        const off = s8(next());
        operands.push({ kind: 'rel', offset: off, target: (at() + off) & 0xffff });
      }
      break;
    }
    case 'MOV_IMM_IDX': {
      const d = readIdx(); // destination postbyte precedes the immediate
      operands.push(imm(size), d);
      break;
    }
    case 'MOV_EXT_IDX': {
      const d = readIdx();
      operands.push(ext(), d);
      break;
    }
    case 'MOV_IDX_IDX': {
      const s = readIdx();
      srcEnd = bytes.length;
      operands.push(s, readIdx());
      break;
    }
    case 'MOV_IMM_EXT':
      operands.push(imm(size), ext());
      break;
    case 'MOV_EXT_EXT':
      operands.push(ext(), ext());
      break;
    case 'MOV_IDX_EXT':
      operands.push(readIdx(), ext());
      break;
    case 'TFR_EXG': {
      const eb = next();
      const x = decodeTfrExg(eb, cpu);
      if (x.reserved) invalidOperand = true;
      if (eb & 0x08 && !x.s12x) nonCanonical = true;
      ccr = xferCcr(eb, cpu);
      operands.push({ kind: 'reg', name: x.src }, { kind: 'reg', name: x.dst });
      break;
    }
    case 'TRAP':
      operands.push({ kind: 'trap', value: opcode });
      break;
    case 'CALL_EXT':
      operands.push(ext(), { kind: 'page', value: next() });
      break;
    case 'CALL_IDX': {
      const o = readIdx();
      operands.push(o);
      if (!o.idx.indirect) operands.push({ kind: 'page', value: next() });
      break;
    }
  }

  const end = at();
  // PC-relative indexed operands: the base is the address of the next instruction, except for the
  // source of MOVB/MOVW idx->idx, whose base excludes the destination's extension bytes
  // (UNCERTAIN; follows libasm's CPU12X model; identical to "end of instruction" on CPU12).
  for (const o of idxOps) {
    if (o.idx.reg !== 'PC') continue;
    const isMoveSrc = form.mode === 'MOV_IDX_IDX' && o === idxOps[0];
    o.pcBase = isMoveSrc ? (start + srcEnd + 1) & 0xffff : end;
    if (o.idx.kind === 'n5' || o.idx.kind === 'n9' || o.idx.kind === 'n16' || o.idx.kind === 'ind16') {
      o.address = (o.pcBase + o.idx.offset) & 0xffff;
    }
  }

  // Text
  const sym = opts.symbols;
  const relText = (o: Extract<Operand, { kind: 'rel' }>): string => {
    const s = sym?.(o.target);
    if (s) return s;
    if (opts.branchStyle === 'absolute') return hex(o.target, 4, p);
    const d = (o.target - start) | 0;
    const dist = ((d + 0x8000) & 0xffff) - 0x8000;
    return `*${dist < 0 ? '-' : '+'}${Math.abs(dist)}`;
  };
  const opText = (o: Operand): string => {
    switch (o.kind) {
      case 'imm':
        return '#' + hex(o.value, o.size === 16 ? 4 : 2, p);
      case 'dir':
        return sym?.(o.address) ?? hex(o.address, 2, p);
      case 'ext':
        return sym?.(o.address) ?? hex(o.address, 4, p);
      case 'idx':
        return formatIndexed(o.idx, { hex: p });
      case 'rel':
        return relText(o);
      case 'mask':
        return '#' + hex(o.value, 2, p);
      case 'page':
        return hex(o.value, 2, p);
      case 'reg':
        return o.name;
      case 'trap':
        return hex(o.value, 2, p);
    }
  };

  let mnemonic = form.mnemonic;
  let operandsText = operands.map(opText).join(',');
  if (opts.aliases) {
    const a = aliasForBytes(bytes);
    if (a && a.operands !== undefined) {
      mnemonic = a.alias;
      operandsText = '';
    }
  }

  const out: DecodedInstruction = {
    address: start,
    length: bytes.length,
    bytes,
    mnemonic,
    operandsText,
    mode: form.mode,
    form,
    operands,
    cycles: 0,
    ccr,
  };

  const rel = operands.find((o): o is Extract<Operand, { kind: 'rel' }> => o.kind === 'rel');
  if (rel) {
    out.targetAddress = rel.target;
    if (opts.branchStyle !== 'absolute' && !sym?.(rel.target)) out.comment = `abs = ${hex(rel.target, 4, p)}`;
  } else if (/^(JMP|JSR|CALL)$/.test(form.mnemonic)) {
    const t = operands[0];
    if (t?.kind === 'ext' || t?.kind === 'dir') out.targetAddress = t.address;
    else if (t?.kind === 'idx' && t.address !== undefined && !t.idx.indirect) out.targetAddress = t.address;
  }

  const ctx: CycleContext = { cpu };
  if (idxOps[0]) {
    ctx.idx = idxOps[0].idx.cls;
    out.idxClass = ctx.idx;
  }
  if (form.mode === 'MOV_IDX_IDX' && idxOps[1]) {
    ctx.idxDst = idxOps[1].idx.cls;
    out.idxDstClass = ctx.idxDst;
  }
  out.cycles = formCycles(form, { ...ctx, taken: true });
  if (accessFor(form, cpu).notTaken !== undefined) out.cyclesNotTaken = formCycles(form, { ...ctx, taken: false });
  if (illegal) out.illegal = true;
  if (invalidOperand) out.invalidOperand = true;
  if (nonCanonical) out.nonCanonical = true;
  return out;
}

/** Byte reader over a buffer mapped at `base`; addresses outside read as `fill` (default $FF, erased flash). */
export function bufferReader(data: Uint8Array, base: number, fill = 0xff): ReadByte {
  return (a) => {
    const i = a - base;
    return i >= 0 && i < data.length ? data[i] : fill;
  };
}

/** Linear disassembly of [start, end). The last instruction may extend past `end`. */
export function disassembleRange(read: ReadByte, start: number, end: number, opts: DecodeOptions = {}): DecodedInstruction[] {
  const out: DecodedInstruction[] = [];
  let pc = start;
  while (pc < end) {
    const insn = decode(read, pc, opts);
    out.push(insn);
    pc += insn.length;
  }
  return out;
}

export interface LineFormatOptions {
  showAddress?: boolean;
  showCode?: boolean;
  /** Minimum width of the code column (hex characters). Default 0. */
  codeWidth?: number;
  showComment?: boolean;
}

/** One Assembly-window line, e.g. `4000 B63000   LDAA 0x3000`. */
export function formatLine(insn: DecodedInstruction, opts: LineFormatOptions = {}): string {
  const parts: string[] = [];
  if (opts.showAddress !== false) parts.push(insn.address.toString(16).toUpperCase().padStart(4, '0') + ' ');
  if (opts.showCode !== false) {
    const code = insn.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    parts.push(code.padEnd(opts.codeWidth ?? 0) + '   ');
  }
  let text = insn.mnemonic + (insn.operandsText ? ' ' + insn.operandsText : '');
  if (opts.showComment !== false && insn.comment) text += ' ;' + insn.comment;
  parts.push(text);
  return parts.join('');
}

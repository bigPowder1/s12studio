/**
 * CPU12 / CPU12X instruction encoder for the CodeWarrior assembler clone, driven by the @s12/isa form table.
 *
 * Addressing-mode selection policy (docs/research/r2/critique.md G2, manual "Addressing modes"):
 *  - XREF symbols and labels of relocatable sections → extended (16-bit fixup); XREF.B / SHORT sections → direct.
 *  - Absolute values known in pass 1 and inside the direct page (`-CpDirect`, default $0000-$00FF) → direct.
 *  - `<expr` / `expr.B` force direct / 8-bit; `>expr` / `expr.W` force extended / 16-bit.
 *  - UNCERTAIN: a value that is still undefined in pass 1 (forward reference) is assembled extended (and as a
 *    16-bit indexed offset), and pass 2 keeps that size (two-pass assembler without relaxation).
 *  - Indexed constant offsets use the smallest of 5/9/16 bits; `n,PC` inserts n literally, `expr,PCR` computes
 *    the offset to the address after the instruction (smallest form that fits, iterated because the offset
 *    depends on the length).
 *  - Branches are never relaxed: short branch out of range → A1401; cross-section/external short branch →
 *    A12008; loop primitives → A12403 / A12411. Long branches to other sections → PCREL16 fixup.
 * Every decision taken in pass 1 is recorded (`choices`) and replayed in pass 2 so that sizes never change.
 */
import {
  encodeIndexed,
  encodeLoop,
  encodeTfrExg,
  formsByMnemonic,
  idxAllowed,
  idxSetFor,
  resolveAlias,
  type AddrMode,
  type Cpu,
  type IdxClass,
  type IdxSet,
  type IndexedSpec,
  type OpForm,
} from '@s12/isa';
import type { Value } from './expr.js';
import { splitOperands } from './line.js';

/** Relocation kinds the encoder can request. Only ABS16/ABS32/PCREL16/PAGE8 are writable to a CW object. */
export type FixupKind = 'ABS16' | 'ABS32' | 'PCREL16' | 'PAGE8' | 'ABS8' | 'PCREL8';

export interface Fixup {
  /** Byte offset of the field within the encoded bytes. */
  at: number;
  /** Field width in bytes. */
  width: 1 | 2 | 4;
  kind: FixupKind;
  value: Value;
  /** PC-relative fixups: (PC base) − (field address). Field = target − base = S + (addend − pcAdjust) − P. */
  pcAdjust?: number;
  /** 0-based column for messages. */
  col: number;
}

export interface EncodeContext {
  cpu: Cpu;
  /** -Cpu option (CPU12 adapts PCR offsets of MOVB/MOVW per CPU12RM Table 3-3). */
  cpuName: 'CPU12' | 'HCS12' | 'HCS12X';
  pass: 1 | 2;
  /** Location of the statement start (section offset, or absolute address in an absolute section). */
  pc: number;
  /** The current section is absolute (ORG / OFFSET). */
  absSection: boolean;
  /** Handle of the current section (compared with Value.sec). */
  section: unknown;
  /** Direct page window start (-CpDirect). */
  cpDirect: number;
  /** Evaluate an expression; `col` is the 0-based column of `text` in the line. Returns undefined on error. */
  evaluate(text: string, col: number): Value | undefined;
  /** Whether a relocatable section is SHORT (direct-page accessible). */
  isShortSection(sec: unknown): boolean;
  /** XREF size (B = direct page) of an external symbol. */
  xrefSize(sym: unknown): string | undefined;
  report(code: string, col: number, ...args: Array<string | number>): void;
  /** Pass-1 decisions to replay (pass 2). */
  replay?: string[];
}

export interface EncodeResult {
  bytes: number[];
  fixups: Fixup[];
  /** Decisions taken (pass 1) to replay in pass 2. */
  choices: string[];
  /** False when an error was reported (bytes still describe the best-effort size). */
  ok: boolean;
}

class Fail extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Operand model

type IdxReg = 'X' | 'Y' | 'SP' | 'PC';
type Item = { text: string; col: number };

type IdxOp =
  | {
      k: 'idx';
      off: string;
      col: number;
      reg: IdxReg;
      pcr: boolean;
      auto?: 'pre' | 'post';
      autoSign?: 1 | -1;
      acc?: 'A' | 'B' | 'D';
    }
  | { k: 'ind'; off: string; col: number; reg: IdxReg; pcr: boolean; accD: boolean };

type MemOp = { k: 'imm'; text: string; col: number } | { k: 'addr'; text: string; col: number } | IdxOp;

const IDX_REG_RE = /^([+-]?)(X|Y|SP|PCR|PC)([+-]?)$/i;

function isIndexSpec(t: string): boolean {
  const m = t.match(IDX_REG_RE);
  return !!m && !(m[1] && m[3]);
}

const ACCS = new Set(['A', 'B', 'D']);

// ---------------------------------------------------------------------------------------------------------------
// Instruction layout: an ordered list of byte runs and indexed operands. Indexed operands are laid out at the
// end because their size can depend on the instruction length (PC-relative offsets).

interface BytesPart {
  t: 'bytes';
  bytes: number[];
  fixups: Fixup[];
}
interface IdxPart {
  t: 'idx';
  op: IdxOp;
  /** CPU12 PCR move adaptation (CPU12RM Table 3-3). */
  adj: number;
  /** PC base rule: end of instruction, or (S12X MOVB/MOVW idx,idx source) one past the source operand. */
  base: 'end' | 'afterThisPlus1';
  spec?: IndexedSpec;
  fixup?: Omit<Fixup, 'at'>;
  pcrTarget?: Value;
}
/** Trailing 8-bit branch offset (Bcc, BRSET/BRCLR): resolved once the instruction length is known. */
interface Rel8Part {
  t: 'rel8';
  v: Value;
  col: number;
}
type Part = BytesPart | IdxPart | Rel8Part;

const EXT_LEN: Record<IndexedSpec['kind'], number> = { n5: 0, n9: 1, n16: 2, ind16: 2, pre: 0, post: 0, acc: 0, indD: 0 };
const fits8 = (v: number): boolean => v >= -128 && v <= 255;
const fits16 = (v: number): boolean => v >= -32768 && v <= 65535;

function classOfKind(k: IndexedSpec['kind']): IdxClass {
  switch (k) {
    case 'n9':
      return 'IDX1';
    case 'n16':
      return 'IDX2';
    case 'ind16':
      return '[IDX2]';
    case 'indD':
      return '[D,IDX]';
    default:
      return 'IDX';
  }
}

export class InstructionEncoder {
  private parts: Part[] = [];
  private choices: string[] = [];
  private replayIdx = 0;
  private ok = true;
  private set: IdxSet | undefined;

  constructor(private readonly ctx: EncodeContext) {}

  // ----- helpers ---------------------------------------------------------------------------------------------

  private fail(code: string, col: number, ...args: Array<string | number>): never {
    this.ctx.report(code, col, ...args);
    this.ok = false;
    throw new Fail();
  }
  private warn(code: string, col: number, ...args: Array<string | number>): void {
    this.ctx.report(code, col, ...args);
  }

  /** Decide (pass 1) or replay (pass 2) a choice. */
  private choose(compute: () => string): string {
    const r = this.ctx.replay;
    let c: string;
    if (r && this.replayIdx < r.length) c = r[this.replayIdx++];
    else c = compute();
    this.choices.push(c);
    return c;
  }

  private value(text: string, col: number): Value {
    if (text.trim() === '') this.fail('A1055', col);
    const v = this.ctx.evaluate(text, col);
    if (!v) {
      this.ok = false;
      throw new Fail();
    }
    if (v.kind === 'undef' && this.ctx.pass === 2) this.ok = false;
    return v;
  }

  /** True when a branch / PCR target can be resolved by the assembler (same section or both absolute). */
  private resolvable(v: Value): boolean {
    if (v.kind === 'rel') return !this.ctx.absSection && v.sec === this.ctx.section;
    if (v.kind === 'abs') return this.ctx.absSection;
    return false;
  }

  private cur(): BytesPart {
    const last = this.parts[this.parts.length - 1];
    if (last && last.t === 'bytes') return last;
    const p: BytesPart = { t: 'bytes', bytes: [], fixups: [] };
    this.parts.push(p);
    return p;
  }
  private emit8(v: number): void {
    this.cur().bytes.push(v & 0xff);
  }
  private emit16(v: number): void {
    this.cur().bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  private emitOp(f: OpForm): void {
    if (f.prefix) this.emit8(f.prefix);
    this.emit8(f.opcode);
  }
  private fix(width: 1 | 2 | 4, kind: FixupKind, value: Value, col: number, pcAdjust?: number): void {
    const p = this.cur();
    const fx: Fixup = { at: p.bytes.length, width, kind, value, col };
    if (pcAdjust !== undefined) fx.pcAdjust = pcAdjust;
    p.fixups.push(fx);
    for (let i = 0; i < width; i++) p.bytes.push(0);
  }
  /** Current length (only valid before indexed parts are laid out, or for bytes-only layouts). */
  private lenSoFar(): number {
    let n = 0;
    for (const p of this.parts) n += p.t === 'bytes' ? p.bytes.length : p.t === 'rel8' ? 1 : 1 + EXT_LEN[p.spec?.kind ?? 'n5'];
    return n;
  }

  /** 8-bit field (immediate byte, direct address, mask, page). */
  private field8(v: Value, col: number, what: 'imm' | 'dir' | 'page' | 'mask'): void {
    if (v.kind === 'abs') {
      if (what !== 'dir' && !fits8(v.v)) this.warn('A12003', col);
      this.emit8(v.v);
      return;
    }
    if (v.kind === 'undef') return this.emit8(0);
    this.fix(1, v.fn === 'PAGE' ? 'PAGE8' : 'ABS8', v, col);
  }

  /** 16-bit field (address or immediate). */
  private field16(v: Value, col: number): void {
    if (v.kind === 'abs') {
      if (!fits16(v.v)) this.warn('A12004', col);
      return this.emit16(v.v);
    }
    if (v.kind === 'undef') return this.emit16(0);
    // HIGH/LOW/PAGE of a relocatable value into a 16-bit field: no CW relocation known for this.
    this.fix(2, v.fn ? 'ABS8' : 'ABS16', v, col);
  }

  /** Short branch offset; the field is the last byte of the instruction (resolved in finish()). */
  private rel8(target: Item): void {
    const v = this.value(target.text, target.col);
    if (!this.resolvable(v) && v.kind !== 'undef') this.fail('A12008', target.col);
    this.parts.push({ t: 'rel8', v, col: target.col });
  }

  // ----- entry point -----------------------------------------------------------------------------------------

  /**
   * Encode `mnemonic[.size] operands`. `operandCol` is the 0-based column of the operand field (for messages).
   * Returns undefined when the mnemonic is not an instruction on this CPU.
   */
  encode(mnemonic: string, size: string | undefined, operands: string, operandCol: number, opCol: number): EncodeResult | undefined {
    const up = mnemonic.toUpperCase();
    let forms = formsByMnemonic(up, this.ctx.cpu);
    const alias = resolveAlias(up);
    if (!forms.length && alias && (alias.cpu === 'cpu12' || this.ctx.cpu === 's12x')) {
      if (alias.bytes) {
        if (size) this.ctx.report('A12107', opCol);
        if (operands.trim()) this.ctx.report('A2400', operandCol);
        return { bytes: [...alias.bytes], fixups: [], choices: [], ok: !size };
      }
      forms = formsByMnemonic(alias.canonical, this.ctx.cpu);
    }
    if (!forms.length) return undefined;
    try {
      if (size) this.fail('A12107', opCol);
      const items: Item[] = splitOperands(operands).map((x) => ({ text: x.text, col: x.col + operandCol }));
      const modes = new Set(forms.map((f) => f.mode));
      const has = (pre: string) => [...modes].some((m) => m.startsWith(pre));
      if (modes.has('TFR_EXG')) this.encTransfer(forms[0].mnemonic, items, operandCol);
      else if (modes.has('LOOP')) this.encLoop(forms[0], items, operandCol);
      else if (modes.has('REL8') || modes.has('REL16')) this.encBranch(forms[0], items, operandCol);
      else if (modes.has('TRAP')) this.encTrap(forms, items, operandCol);
      else if (has('MOV_')) this.encMove(forms, items, operandCol);
      else if (has('BIT_') || has('BRBIT_')) this.encBit(forms, items, operandCol);
      else if (modes.has('CALL_EXT')) this.encCall(forms, items, operandCol);
      else if (modes.size === 1 && modes.has('INH')) {
        this.emitOp(forms[0]);
        if (items.length) this.warn('A2400', operandCol);
      } else this.encGeneral(forms, items, operandCol);
      return this.finish();
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      this.ok = false;
      try {
        const r = this.finish();
        if (!r.bytes.length) r.bytes = [0];
        return r;
      } catch (e2) {
        if (!(e2 instanceof Fail)) throw e2;
        return { bytes: [0], fixups: [], choices: this.choices, ok: false };
      }
    }
  }

  // ----- layout ----------------------------------------------------------------------------------------------

  /** Resolve indexed parts (PCR fixpoint) and concatenate the layout. */
  private finish(): EncodeResult {
    const idxParts = this.parts.filter((p): p is IdxPart => p.t === 'idx');
    for (const p of idxParts) if (!p.spec) this.prepIndexed(p);
    const lenOf = (p: Part): number => (p.t === 'bytes' ? p.bytes.length : p.t === 'rel8' ? 1 : 1 + EXT_LEN[p.spec!.kind]);
    const total = () => this.parts.reduce((a, p) => a + lenOf(p), 0);
    const baseOf = (p: IdxPart): number => {
      if (p.base === 'end') return this.ctx.pc + total();
      let n = 0;
      for (const q of this.parts) {
        n += lenOf(q);
        if (q === p) break;
      }
      return this.ctx.pc + n + 1;
    };
    const pcrParts = idxParts.filter((p) => p.pcrTarget);
    // PC-relative sizes: each operand takes the first of 5/9/16 bits whose offset (computed with that length)
    // fits; repeated until stable because MOVB/MOVW can have two PC-relative operands.
    const fitsKind = (k: string, off: number): boolean =>
      k === 'n5' ? off >= -16 && off <= 15 : k === 'n9' ? off >= -256 && off <= 255 : true;
    for (const p of pcrParts) {
      const t = p.pcrTarget!;
      // Unknown in pass 1: 16-bit, except where only 5-bit offsets exist (CPU12 MOVB/MOVW).
      if (p.spec!.kind !== 'ind16' && (t.force === 16 || !this.resolvable(t))) p.spec!.kind = idxAllowed(this.set, 'IDX2') ? 'n16' : 'n5';
      else if (p.spec!.kind !== 'ind16' && t.force === 8) p.spec!.kind = 'n9';
    }
    for (let iter = 0; iter < 8 && pcrParts.length; iter++) {
      let changed = false;
      for (const p of pcrParts) {
        const t = p.pcrTarget!;
        if (p.spec!.kind === 'ind16' || t.force || !this.resolvable(t)) continue;
        const before = p.spec!.kind;
        for (const k of ['n5', 'n9', 'n16'] as const) {
          if (!idxAllowed(this.set, classOfKind(k)) && k !== 'n16') continue;
          p.spec!.kind = k;
          if (fitsKind(k, t.v - baseOf(p) - p.adj)) break;
        }
        if (p.spec!.kind !== before) changed = true;
      }
      if (!changed) break;
    }
    // Record (pass 1) / replay (pass 2) every size first: offsets depend on the final total length.
    for (const p of pcrParts) {
      if (p.spec!.kind !== 'ind16') p.spec!.kind = this.choose(() => p.spec!.kind) as IndexedSpec['kind'];
    }
    for (const p of pcrParts) {
      const t = p.pcrTarget!;
      if (!idxAllowed(this.set, classOfKind(p.spec!.kind))) this.fail(this.set === 'short' ? 'A12404' : 'A12001', p.op.col);
      if (this.resolvable(t)) {
        const off = t.v - baseOf(p) - p.adj;
        if (p.spec!.kind === 'n5' && (off < -16 || off > 15)) this.fail('A12404', p.op.col);
        if (p.spec!.kind === 'n9' && (off < -256 || off > 255)) this.fail('A12403', p.op.col);
        if ((p.spec!.kind === 'n16' || p.spec!.kind === 'ind16') && (off < -32768 || off > 32767)) this.fail('A1402', p.op.col);
        p.spec!.offset = p.spec!.kind === 'n16' || p.spec!.kind === 'ind16' ? off & 0xffff : off;
      } else if (t.kind === 'undef') p.spec!.offset = 0;
      else if (t.kind === 'abs') this.fail(t.equ ? 'A1410' : 'A1411', p.op.col);
      else {
        if (p.spec!.kind !== 'n16' && p.spec!.kind !== 'ind16') this.fail('A12409', p.op.col);
        p.spec!.offset = 0;
        p.fixup = { width: 2, kind: 'PCREL16', value: t, col: p.op.col, pcAdjust: 0 };
      }
    }
    // Concatenate.
    const bytes: number[] = [];
    const fixups: Fixup[] = [];
    const totalLen = total();
    for (const p of this.parts) {
      if (p.t === 'bytes') {
        for (const f of p.fixups) fixups.push({ ...f, at: f.at + bytes.length });
        bytes.push(...p.bytes);
        continue;
      }
      if (p.t === 'rel8') {
        let off = 0;
        if (this.resolvable(p.v)) {
          off = p.v.v - (this.ctx.pc + totalLen);
          if (off < -128 || off > 127) this.fail('A1401', p.col);
        }
        bytes.push(off & 0xff);
        continue;
      }
      let enc: number[];
      try {
        enc = encodeIndexed(p.spec!);
      } catch {
        this.fail('A12001', p.op.col);
      }
      if (p.fixup && enc.length === 3) {
        const fx: Fixup = { ...p.fixup, at: bytes.length + 1 };
        if (fx.kind === 'PCREL16') fx.pcAdjust = baseOf(p) - (this.ctx.pc + bytes.length + 1);
        fixups.push(fx);
      }
      bytes.push(...enc);
    }
    return { bytes, fixups, choices: this.choices, ok: this.ok };
  }

  /** Resolve the non-PCR part of an indexed operand into an IndexedSpec. */
  private prepIndexed(p: IdxPart): void {
    const op = p.op;
    const set = this.set;
    if (op.k === 'ind') {
      if (op.accD) {
        if (op.pcr) this.warn('A12412', op.col);
        if (!idxAllowed(set, '[D,IDX]')) this.fail('A12001', op.col);
        p.spec = { kind: 'indD', reg: op.reg };
        return;
      }
      if (!idxAllowed(set, '[IDX2]')) this.fail('A12001', op.col);
      const v = this.value(op.off || '0', op.col);
      if (op.pcr) {
        p.spec = { kind: 'ind16', reg: 'PC', offset: 0 };
        p.pcrTarget = v;
        return;
      }
      p.spec = { kind: 'ind16', reg: op.reg, offset: 0 };
      if (v.kind === 'abs') {
        if (!fits16(v.v)) this.warn('A12004', op.col);
        p.spec.offset = v.v & 0xffff;
      } else if (v.kind !== 'undef') p.fixup = { width: 2, kind: v.fn ? 'ABS8' : 'ABS16', value: v, col: op.col };
      return;
    }
    if (op.acc) {
      if (op.pcr) this.warn('A12412', op.col);
      if (!idxAllowed(set, 'IDX')) this.fail('A12001', op.col);
      p.spec = { kind: 'acc', reg: op.reg, acc: op.acc };
      return;
    }
    if (op.auto) {
      const v = this.value(op.off || '0', op.col);
      if (v.kind !== 'abs' && v.kind !== 'undef') this.fail('A2314', op.col);
      const n = v.kind === 'abs' ? v.v : 1;
      if (n < 1 || n > 8) this.fail('A12005', op.col);
      p.spec = { kind: op.auto, reg: op.reg, offset: n * (op.autoSign ?? 1) };
      return;
    }
    const v: Value = op.off.trim() === '' ? { kind: 'abs', v: 0 } : this.value(op.off, op.col);
    if (op.pcr) {
      p.spec = { kind: 'n5', reg: 'PC', offset: 0 };
      p.pcrTarget = v;
      return;
    }
    const kind = this.choose(() => {
      if (v.force === 16) return 'n16';
      if (v.kind === 'abs') {
        if (v.force === 8) return 'n9';
        if (v.v >= -16 && v.v <= 15) return 'n5';
        if (v.v >= -256 && v.v <= 255) return 'n9';
        return 'n16';
      }
      // UNCERTAIN: forward-referenced offsets assumed 16-bit (5-bit for CPU12 moves, the only legal size).
      return set === 'short' ? 'n5' : 'n16';
    }) as 'n5' | 'n9' | 'n16';
    if (!idxAllowed(set, classOfKind(kind))) this.fail(set === 'short' && v.kind === 'abs' ? 'A12404' : 'A12001', op.col);
    p.spec = { kind, reg: op.reg, offset: 0 };
    if (v.kind === 'abs') {
      if (kind === 'n5' && (v.v < -16 || v.v > 15)) this.fail('A12404', op.col);
      if (kind === 'n9' && (v.v < -256 || v.v > 255)) this.fail('A12403', op.col);
      if (kind === 'n16' && !fits16(v.v)) this.warn('A12004', op.col);
      p.spec.offset = kind === 'n16' ? v.v & 0xffff : v.v;
    } else if (v.kind !== 'undef') {
      if (kind !== 'n16') this.fail('A12001', op.col);
      p.fixup = { width: 2, kind: v.fn ? 'ABS8' : 'ABS16', value: v, col: op.col };
    }
  }

  private idx(form: OpForm, op: IdxOp, adj = 0, base: IdxPart['base'] = 'end'): void {
    this.set = idxSetFor(form, this.ctx.cpu);
    const p: IdxPart = { t: 'idx', op, adj, base };
    this.parts.push(p);
  }

  /** Read one memory operand starting at items[i]; returns the operand and the next item index. */
  private readMem(items: Item[], i: number, col0: number): [MemOp, number] {
    const it = items[i];
    if (!it) this.fail('A12001', col0);
    const t = it.text;
    if (t.startsWith('#')) return [{ k: 'imm', text: t.slice(1), col: it.col + 1 }, i + 1];
    if (t.startsWith('[')) {
      if (!t.endsWith(']')) this.fail('A12001', it.col);
      const parts = splitOperands(t.slice(1, -1));
      if (parts.length !== 2) this.fail('A12001', it.col);
      const m = parts[1].text.match(/^(X|Y|SP|PCR|PC)$/i);
      if (!m) this.fail('A12010', it.col + 1 + parts[1].col);
      const r = m[1].toUpperCase();
      const reg = (r === 'PCR' ? 'PC' : r) as IdxReg;
      const accD = parts[0].text.toUpperCase() === 'D';
      return [{ k: 'ind', off: parts[0].text, col: it.col + 1 + parts[0].col, reg, pcr: r === 'PCR', accD }, i + 1];
    }
    const nx = items[i + 1];
    if (nx && isIndexSpec(nx.text)) {
      const m = nx.text.match(IDX_REG_RE)!;
      const r = m[2].toUpperCase();
      const reg = (r === 'PCR' ? 'PC' : r) as IdxReg;
      const op: IdxOp = { k: 'idx', off: t, col: t ? it.col : nx.col, reg, pcr: r === 'PCR' };
      if (m[1] || m[3]) {
        if (reg === 'PC') this.fail('A12010', nx.col);
        op.auto = m[1] ? 'pre' : 'post';
        op.autoSign = (m[1] || m[3]) === '+' ? 1 : -1;
      } else if (ACCS.has(t.toUpperCase())) op.acc = t.toUpperCase() as 'A' | 'B' | 'D';
      return [op, i + 2];
    }
    return [{ k: 'addr', text: t, col: it.col }, i + 1];
  }

  private dirOrExt(v: Value, hasDir: boolean, hasExt: boolean): 'DIR' | 'EXT' {
    if (!hasDir) return 'EXT';
    if (!hasExt) return 'DIR';
    if (v.force === 8) return 'DIR';
    if (v.force === 16) return 'EXT';
    if (v.kind === 'abs') {
      const lo = this.ctx.cpu === 's12x' ? this.ctx.cpDirect : 0;
      return v.v >= lo && v.v <= lo + 0xff ? 'DIR' : 'EXT';
    }
    if (v.kind === 'rel' && this.ctx.isShortSection(v.sec)) return 'DIR';
    if (v.kind === 'ext' && this.ctx.xrefSize(v.sym) === 'B') return 'DIR';
    return 'EXT';
  }

  /** DIR or EXT address field (after the opcode chosen here). */
  private dirExtOperand(fd: OpForm | undefined, fe: OpForm | undefined, op: Item): void {
    const v = this.value(op.text, op.col);
    const mode = this.choose(() => this.dirOrExt(v, !!fd, !!fe));
    if (mode === 'DIR') {
      this.emitOp(fd!);
      this.field8(v, op.col, 'dir');
    } else {
      this.emitOp(fe!);
      this.field16(v, op.col);
    }
  }

  // ----- general IMM / DIR / EXT / IDX -------------------------------------------------------------------------

  private encGeneral(forms: OpForm[], items: Item[], col0: number): void {
    const by = (m: AddrMode) => forms.find((f) => f.mode === m);
    if (!items.length) {
      const inh = by('INH');
      if (inh) return this.emitOp(inh);
      this.fail('A12001', col0);
    }
    const [op, next] = this.readMem(items, 0, col0);
    if (next < items.length) {
      // `LDAB 0,Z`: an identifier where an index register is expected.
      if (/^[A-Za-z_.][A-Za-z0-9_.]*$/.test(items[next].text)) this.fail('A12010', items[next].col);
      this.fail('A12001', items[next].col);
    }
    if (op.k === 'imm') {
      const f = by('IMM8') ?? by('IMM16');
      if (!f) this.fail('A12105', op.col - 1);
      const v = this.value(op.text, op.col);
      this.emitOp(f);
      if (f.mode === 'IMM8') this.field8(v, op.col, 'imm');
      else this.field16(v, op.col);
      return;
    }
    if (op.k === 'addr') {
      const fd = by('DIR');
      const fe = by('EXT');
      if (!fd && !fe) this.fail('A12001', op.col);
      return this.dirExtOperand(fd, fe, op);
    }
    const f = by('IDX');
    if (!f) this.fail('A12001', op.col);
    this.emitOp(f);
    this.idx(f, op);
  }

  // ----- bit manipulation ----------------------------------------------------------------------------------------

  private encBit(forms: OpForm[], items: Item[], col0: number): void {
    const isBr = forms.some((f) => f.mode.startsWith('BRBIT'));
    const prefix = isBr ? 'BRBIT_' : 'BIT_';
    const [op, next] = this.readMem(items, 0, col0);
    if (op.k === 'imm') this.fail('A12105', op.col - 1);
    const maskItem = items[next];
    if (!maskItem) this.fail('A2402', col0);
    // CW requires '#' before the mask: the manual's A12104 "Immediate value expected" entry gives exactly this case for
    // BRCLR/BRSET (`BRCLR var, maskValue, endCode`). UNCERTAIN only for BSET/BCLR, which follow the same rule here.
    if (!maskItem.text.startsWith('#')) this.fail('A12104', maskItem.col);
    const mask = this.value(maskItem.text.slice(1), maskItem.col + 1);
    let target: Item | undefined;
    if (isBr) {
      target = items[next + 1];
      if (!target) this.fail('A2402', col0);
      if (next + 2 < items.length) this.warn('A2400', items[next + 2].col);
    } else if (next + 1 < items.length) this.warn('A2400', items[next + 1].col);
    const by = (m: string) => forms.find((f) => f.mode === prefix + m);
    if (op.k === 'addr') {
      this.dirExtOperand(by('DIR'), by('EXT'), op);
      this.field8(mask, maskItem.col + 1, 'mask');
      if (target) this.rel8(target);
      return;
    }
    const f = by('IDX');
    if (!f) this.fail('A12001', op.col);
    this.emitOp(f);
    this.idx(f, op);
    // xb [ff|ee ff] mm [rr]: the mask and branch offset follow the indexed bytes.
    this.field8(mask, maskItem.col + 1, 'mask');
    if (target) this.rel8(target);
  }

  // ----- branches ------------------------------------------------------------------------------------------------

  private encBranch(form: OpForm, items: Item[], col0: number): void {
    if (items.length !== 1) this.fail(items.length ? 'A2400' : 'A12008', items[1]?.col ?? col0);
    const t = items[0];
    this.emitOp(form);
    if (form.mode === 'REL8') return this.rel8(t);
    const v = this.value(t.text, t.col);
    const end = this.ctx.pc + this.lenSoFar() + 2;
    if (this.resolvable(v)) {
      const off = v.v - end;
      if (off < -32768 || off > 32767) this.fail('A1402', t.col);
      this.emit16(off);
    } else if (v.kind === 'undef') this.emit16(0);
    else if (v.kind === 'abs' && !v.sym) this.fail('A1414', t.col);
    else this.fix(2, 'PCREL16', v, t.col, 2);
  }

  private encLoop(form: OpForm, items: Item[], col0: number): void {
    if (items.length < 2) this.fail('A2402', col0);
    const reg = items[0].text.toUpperCase();
    if (!['A', 'B', 'D', 'X', 'Y', 'SP'].includes(reg)) this.fail('A12010', items[0].col);
    const v = this.value(items[1].text, items[1].col);
    if (items.length > 2) this.warn('A2400', items[2].col);
    let off = 0;
    if (this.resolvable(v)) {
      off = v.v - (this.ctx.pc + 3);
      if (off < -256 || off > 255) this.fail('A12403', items[1].col);
    } else if (v.kind !== 'undef') this.fail('A12411', items[1].col);
    this.emitOp(form);
    const [lb, rr] = encodeLoop(form.mnemonic, reg, off);
    this.emit8(lb);
    this.emit8(rr);
  }

  private encTransfer(mn: string, items: Item[], col0: number): void {
    if (items.length !== 2) this.fail(items.length < 2 ? 'A2402' : 'A2400', items[2]?.col ?? col0);
    let eb = encodeTfrExg(mn, items[0].text, items[1].text, this.ctx.cpu);
    if (eb === undefined) {
      // UNCERTAIN: accept XL/YL/SPL (and CCRL) as the low byte of a 16-bit register in 16→8 transfers, as the
      // S12XCPU RM notation does (TFR XL,A = TFR X,A).
      const low = (r: string) => r.trim().toUpperCase().replace(/^(X|Y|SP)L$/, '$1');
      eb = encodeTfrExg(mn, low(items[0].text), items[1].text, this.ctx.cpu);
    }
    if (eb === undefined) this.fail('A12001', col0);
    this.emit8(0xb7);
    this.emit8(eb);
  }

  private encTrap(forms: OpForm[], items: Item[], col0: number): void {
    if (items.length !== 1) this.fail('A12001', col0);
    const hash = items[0].text.startsWith('#');
    const t = hash ? items[0].text.slice(1) : items[0].text;
    const col = hash ? items[0].col + 1 : items[0].col;
    const v = this.value(t, col);
    let n = 0x30;
    if (v.kind === 'abs') n = v.v & 0xff;
    else if (v.kind !== 'undef') this.fail('A2314', col);
    // UNCERTAIN: CW (manual A12111) checks the CPU12 trap ranges $30..$39 / $40..$FF; on the CPU12X the codes
    // that became instructions are rejected here as well.
    if (v.kind === 'abs' && (v.v < 0 || v.v > 0xff || !forms.some((f) => f.opcode === n))) this.warn('A12111', col);
    this.emit8(0x18);
    this.emit8(n);
  }

  // ----- CALL ----------------------------------------------------------------------------------------------------

  private encCall(forms: OpForm[], items: Item[], col0: number): void {
    const [op, next] = this.readMem(items, 0, col0);
    const fe = forms.find((f) => f.mode === 'CALL_EXT')!;
    const fi = forms.find((f) => f.mode === 'CALL_IDX')!;
    const pageItem = items[next];
    if (op.k === 'imm') this.fail('A12105', op.col - 1);
    if (op.k === 'ind') {
      if (pageItem) this.warn('A2400', pageItem.col);
      this.emitOp(fi);
      return this.idx(fi, op);
    }
    if (!pageItem) this.fail('A12102', col0);
    const ptext = pageItem.text.startsWith('#') ? pageItem.text.slice(1) : pageItem.text;
    const pcol = pageItem.text.startsWith('#') ? pageItem.col + 1 : pageItem.col;
    const page = this.value(ptext, pcol);
    if (next + 1 < items.length) this.warn('A2400', items[next + 1].col);
    if (op.k === 'addr') {
      const v = this.value(op.text, op.col);
      this.emitOp(fe);
      this.field16(v, op.col);
      this.field8(page, pcol, 'page');
      return;
    }
    this.emitOp(fi);
    this.idx(fi, op);
    this.field8(page, pcol, 'page');
  }

  // ----- MOVB / MOVW ---------------------------------------------------------------------------------------------

  private encMove(forms: OpForm[], items: Item[], col0: number): void {
    const [src, n1] = this.readMem(items, 0, col0);
    if (n1 >= items.length) this.fail('A2402', col0);
    const [dst, n2] = this.readMem(items, n1, col0);
    if (n2 < items.length) this.warn('A2400', items[n2].col);
    if (dst.k === 'imm') this.fail('A12105', dst.col - 1);
    const sk = src.k === 'imm' ? 'IMM' : src.k === 'addr' ? 'EXT' : 'IDX';
    const dk = dst.k === 'addr' ? 'EXT' : 'IDX';
    const mode = `MOV_${sk}_${dk}` as AddrMode;
    const f = forms.find((x) => x.mode === mode);
    if (!f) this.fail('A12001', col0);
    const word = f.mnemonic === 'MOVW';
    // CPU12RM Table 3-3 (M68HC12 only): PC offsets for PCR moves, applied in -CpuCPU12 mode (manual "-Cpu").
    const adj = (op: MemOp, which: 'src' | 'dst'): number => {
      if (this.ctx.cpuName !== 'CPU12' || !((op.k === 'idx' || op.k === 'ind') && op.pcr)) return 0;
      if (mode === 'MOV_IMM_IDX') return word ? 2 : 1;
      if (mode === 'MOV_EXT_IDX') return 2;
      if (mode === 'MOV_IDX_EXT') return -2;
      return which === 'src' ? -1 : 1;
    };
    const imm = (v: Value, col: number) => (word ? this.field16(v, col) : this.field8(v, col, 'imm'));
    this.emitOp(f);
    switch (mode) {
      case 'MOV_IMM_EXT':
      case 'MOV_EXT_EXT': {
        const sv = this.value((src as Item).text, src.col);
        const dv = this.value((dst as Item).text, dst.col);
        if (mode === 'MOV_IMM_EXT') imm(sv, src.col);
        else this.field16(sv, src.col);
        this.field16(dv, dst.col);
        return;
      }
      case 'MOV_IMM_IDX':
      case 'MOV_EXT_IDX': {
        // Destination postbyte (+extension) first, then the immediate / extended source (manual -Cpu example).
        const sv = this.value((src as Item).text, src.col);
        this.idx(f, dst as IdxOp, adj(dst, 'dst'));
        if (mode === 'MOV_IMM_IDX') imm(sv, src.col);
        else this.field16(sv, src.col);
        return;
      }
      case 'MOV_IDX_EXT': {
        const dv = this.value((dst as Item).text, dst.col);
        this.idx(f, src as IdxOp, adj(src, 'src'));
        this.field16(dv, dst.col);
        return;
      }
      case 'MOV_IDX_IDX':
        // UNCERTAIN (CPU12X): the source's PC base excludes the destination's extension bytes (as @s12/isa).
        this.idx(f, src as IdxOp, adj(src, 'src'), 'afterThisPlus1');
        this.idx(f, dst as IdxOp, adj(dst, 'dst'));
        return;
      default:
        this.fail('A12001', col0);
    }
  }
}

/** True when `mnemonic` (or an alias of it) is an instruction on `cpu`. */
export function isInstruction(mnemonic: string, cpu: Cpu): boolean {
  const up = mnemonic.toUpperCase();
  if (formsByMnemonic(up, cpu).length) return true;
  const a = resolveAlias(up);
  return !!a && (a.cpu === 'cpu12' || cpu === 's12x');
}

/** True when the mnemonic exists on some CPU (used to report S12X instructions in CPU12 mode). */
export function isAnyInstruction(mnemonic: string): boolean {
  return isInstruction(mnemonic, 's12x');
}

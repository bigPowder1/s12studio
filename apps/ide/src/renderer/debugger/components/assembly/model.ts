/**
 * Assembly component model (pure): DisasmLine[] from `debug.disassemble` -> display rows with hiwave's columns
 * (address | code bytes | instruction | absolute target), label rows, PC and breakpoint marks; layout attributes.
 * Ryerson lab listing format: `4000 B63000   LDAA 0x3000`.
 */
import type { BreakpointInfo, DisasmLine, HwlAttributeInfo } from '../../../../shared/api';
import { hex } from '../../../common/format';

export interface AsmOptions {
  /** Display Address (ADR). */
  address: boolean;
  /** Display Code: machine code bytes (CODE). */
  code: boolean;
  /** Display Symbolic: labels instead of addresses in operands (SYMB). */
  symbolic: boolean;
  /** Display Absolute Address: `;abs = 0x...` for relative branches (ABSADR). */
  absAddress: boolean;
}

export const DEFAULT_ASM_OPTIONS: AsmOptions = { address: true, code: false, symbolic: false, absAddress: true };

export interface AsmRow {
  key: string;
  kind: 'label' | 'insn';
  address: number;
  /** label rows: "Entry:" */
  text?: string;
  addrText: string;
  codeText: string;
  mnemonic: string;
  operands: string;
  absText: string;
  isPc: boolean;
  bp?: BreakpointInfo;
  illegal: boolean;
}

/** Code column width in characters: 5 bytes (the longest S12X instruction is 6; MOVW rarely). */
const CODE_W = 12;
const MNEMONIC_W = 6;

export function asmRows(lines: readonly DisasmLine[], opts: AsmOptions, pc: number | undefined, bps: readonly BreakpointInfo[]): AsmRow[] {
  const bpAt = new Map<number, BreakpointInfo>();
  for (const b of bps) if (!bpAt.has(b.address)) bpAt.set(b.address, b);
  const out: AsmRow[] = [];
  for (const l of lines) {
    if (l.label) out.push({ key: `L${l.address}`, kind: 'label', address: l.address, text: `${l.label}:`, addrText: '', codeText: '', mnemonic: '', operands: '', absText: '', isPc: false, illegal: false });
    out.push({
      key: `I${l.address}`,
      kind: 'insn',
      address: l.address,
      addrText: opts.address ? hex(l.address, l.address > 0xffff ? 6 : 4) : '',
      codeText: opts.code ? l.bytes.map((b) => hex(b, 2)).join('').padEnd(CODE_W) : '',
      mnemonic: l.mnemonic.padEnd(MNEMONIC_W),
      operands: l.operands,
      absText: opts.absAddress && l.comment ? `;${l.comment}` : '',
      isPc: pc !== undefined && l.address === pc,
      bp: bpAt.get(l.address),
      illegal: !!l.illegal,
    });
  }
  return out;
}

/** Plain-text form of a row (Copy; tests): `C000 CF2400      LDS   #0x2400`. */
export function rowText(r: AsmRow): string {
  if (r.kind === 'label') return r.text ?? '';
  return [r.addrText, r.codeText, `${r.mnemonic} ${r.operands}`.trimEnd(), r.absText].filter(Boolean).join(' ').trimEnd();
}

const onOff = (v: boolean) => (v ? 'on' : 'off');
const isOn = (v: string | undefined, def: boolean) => (v === undefined ? def : !/^(off|0|false)$/i.test(v.trim()));

/** Options and TOPPC from `Assembly < attributes ADR on,CODE off,ABSADR on,SYMB off,...,TOPPC 0x4000`. */
export function optionsFromAttributes(attrs: readonly HwlAttributeInfo[], base: AsmOptions = DEFAULT_ASM_OPTIONS): { options: AsmOptions; topPc?: number } {
  const get = (n: string) => attrs.find((a) => a.name.toUpperCase() === n)?.value;
  const top = get('TOPPC');
  const topPc = top !== undefined ? parseInt(top.replace(/^0x/i, '').replace(/^\$/, ''), 16) : undefined;
  return {
    options: { address: isOn(get('ADR'), base.address), code: isOn(get('CODE'), base.code), absAddress: isOn(get('ABSADR'), base.absAddress), symbolic: isOn(get('SYMB'), base.symbolic) },
    topPc: Number.isFinite(topPc) ? topPc : undefined,
  };
}

/** Attributes to write back, keeping unknown ones (FORMAT, FREEZE...) in their original order. */
export function attributesFromOptions(orig: readonly HwlAttributeInfo[], o: AsmOptions, topPc?: number): HwlAttributeInfo[] {
  const vals: Record<string, string> = { ADR: onOff(o.address), CODE: onOff(o.code), ABSADR: onOff(o.absAddress), SYMB: onOff(o.symbolic) };
  if (topPc !== undefined) vals.TOPPC = '0x' + hex(topPc, 4);
  const out = orig.map((a) => (a.name.toUpperCase() in vals ? { name: a.name, value: vals[a.name.toUpperCase()] } : { ...a }));
  for (const k of Object.keys(vals)) if (!out.some((a) => a.name.toUpperCase() === k)) out.push({ name: k, value: vals[k] });
  return out;
}

/** Nearest symbol at or below an address (info bar procedure name). */
export function procedureAt(symbols: readonly { name: string; address: number }[], address: number): string {
  let best: { name: string; address: number } | undefined;
  for (const s of symbols) if (s.address <= address && (!best || s.address > best.address)) best = s;
  return best && address - best.address < 0x1000 ? best.name : '';
}

/** One forward scroll: the view top moved from `from` to `to`, `n` instructions further on. */
export interface ScrollStep {
  from: number;
  to: number;
  n: number;
}

/**
 * Scroll back `n` instructions by undoing recorded forward scrolls, so PgUp after PgDn shows exactly the rows it
 * showed before even when the page size changed in between (window resized, font changed): disassembling backwards
 * resyncs differently, e.g. in erased $FF code. Pops the steps it consumes from `history`.
 * - `rest` > 0: the history ran out (or no longer matches `top`); scroll back `rest` more from `top` the hard way.
 * - `partial`: the target lies inside the step from `partial.from`: it is instruction `partial.index` disassembled
 *   forward from there (the caller decodes it and re-records the shortened step).
 */
export function unwindScroll(history: ScrollStep[], top: number, n: number): { top: number; rest: number; partial?: { from: number; index: number } } {
  let t = top;
  let rest = n;
  while (rest > 0) {
    const last = history.at(-1);
    if (!last || last.to !== t) break;
    history.pop();
    if (last.n <= rest) {
      t = last.from;
      rest -= last.n;
      continue;
    }
    return { top: t, rest: 0, partial: { from: last.from, index: last.n - rest } };
  }
  if (rest > 0) history.length = 0;
  return { top: t, rest };
}

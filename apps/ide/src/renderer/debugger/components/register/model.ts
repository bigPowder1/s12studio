/** Register component model: which registers, their widths, display formats and edit parsing (pure). */
import type { RegisterName, RegisterSetInfo } from '../../../../shared/api';
import { bitReverse, formatNumber, parseNumber, type NumberFormat } from '../../../common/format';

/** Register > Format menu. 'auto' shows hex (hiwave "Auto" picks the natural format: hex for CPU registers). */
export type RegFormat = 'auto' | 'hex' | 'bin' | 'oct' | 'dec' | 'udec' | 'bitrev';

export const REG_FORMATS: readonly { id: RegFormat; label: string; attr: string }[] = [
  { id: 'hex', label: '&Hex', attr: 'HEX' },
  { id: 'bin', label: '&Bin', attr: 'BIN' },
  { id: 'oct', label: '&Oct', attr: 'OCT' },
  { id: 'dec', label: '&Dec', attr: 'DEC' },
  { id: 'udec', label: '&UDec', attr: 'UDEC' },
  { id: 'auto', label: '&Auto', attr: 'AUTO' },
  { id: 'bitrev', label: 'Bit &Reverse', attr: 'BITREV' },
];

export function formatFromAttr(v: string | undefined): RegFormat {
  const u = (v ?? '').trim().toUpperCase();
  return REG_FORMATS.find((f) => f.attr === u || (u === 'BITREVERSE' && f.id === 'bitrev'))?.id ?? 'auto';
}

export interface RegDef {
  name: RegisterName;
  /** Label as hiwave prints it (IX, IY for X, Y). */
  label: string;
  bits: 8 | 16;
}

/** Display order (rows of the grid). UNCERTAIN: exact S12X arrangement; HCS12 shows D A B IX IY IP PC SP CCR PPAGE. */
export const REGISTERS: readonly RegDef[] = [
  { name: 'A', label: 'A', bits: 8 },
  { name: 'B', label: 'B', bits: 8 },
  { name: 'D', label: 'D', bits: 16 },
  { name: 'X', label: 'IX', bits: 16 },
  { name: 'Y', label: 'IY', bits: 16 },
  { name: 'PC', label: 'PC', bits: 16 },
  { name: 'SP', label: 'SP', bits: 16 },
  { name: 'CCRW', label: 'CCRW', bits: 16 },
  { name: 'IPL', label: 'IPL', bits: 8 },
  { name: 'PPAGE', label: 'PPAGE', bits: 8 },
  { name: 'GPAGE', label: 'GPAGE', bits: 8 },
  { name: 'RPAGE', label: 'RPAGE', bits: 8 },
  { name: 'EPAGE', label: 'EPAGE', bits: 8 },
];

/** CCR bits S X H I N Z V C (bit 7..0). */
export const CCR_BITS = ['S', 'X', 'H', 'I', 'N', 'Z', 'V', 'C'] as const;

export function formatReg(v: number, fmt: RegFormat, bits: 8 | 16): string {
  const f: NumberFormat = fmt === 'auto' ? 'hex' : fmt;
  if (f === 'bin' && bits === 16) {
    const s = formatNumber(v, 'bin', 16);
    return `${s.slice(0, 8)} ${s.slice(8)}`;
  }
  return formatNumber(v, f, bits);
}

/** Widest 16-bit value text in a format, in characters (sizes the grid columns so values never overlap). */
export function valueWidthCh(fmt: RegFormat): number {
  let w = 0;
  for (const v of [0, 0x7fff, 0x8000, 0xffff]) w = Math.max(w, formatReg(v, fmt, 16).length);
  return w;
}

/**
 * Parse an edited value in the register's display format (prefixes $, 0x, %, @ and an h suffix always work). In the
 * hex formats bare hex digits are always hex, so the editor's own text "0B10" is 0x0B10 (not binary 0b10). Null if
 * invalid.
 */
export function parseReg(text: string, fmt: RegFormat, bits: 8 | 16): number | null {
  const t = text.trim().replace(/\s+/g, '');
  if (!t) return null;
  const hexLike = fmt === 'auto' || fmt === 'hex' || fmt === 'bitrev';
  let v: number | null;
  if (hexLike && /^[0-9a-f]+$/i.test(t)) v = parseInt(t, 16);
  else if (/^-?[$%@]|^-?0x/i.test(t) || /^-?[0-9a-f]+h$/i.test(t)) v = parseNumber(t, 16);
  else if (!hexLike && /^-?0[bo]/i.test(t)) v = parseNumber(t, 16);
  else if (fmt === 'bin' || fmt === 'oct') {
    const radix = fmt === 'bin' ? 2 : 8;
    const ok = fmt === 'bin' ? /^[01]+$/.test(t) : /^[0-7]+$/.test(t);
    v = ok ? parseInt(t, radix) : null;
  } else if (fmt === 'dec' || fmt === 'udec') v = parseNumber(t, 10);
  else v = parseNumber(t, 16);
  if (v === null) return null;
  const mask = bits === 8 ? 0xff : 0xffff;
  if (v < -(2 ** (bits - 1)) || v > mask) return null;
  const u = v & mask;
  return fmt === 'bitrev' ? bitReverse(u, bits) : u;
}

/** Registers whose value differs from the previous halt (CCR bits are never painted red). */
export function changedRegisters(cur: RegisterSetInfo | null, prev: RegisterSetInfo | null | undefined): Set<RegisterName> {
  const out = new Set<RegisterName>();
  if (!cur || !prev) return out;
  for (const r of REGISTERS) if (cur[r.name] !== prev[r.name]) out.add(r.name);
  return out;
}

/**
 * Data component model: rows (variables / user expressions), value formats, attributes.
 * Spec: docs/research/r1/ide.md §6 Data (Scope Global/Local/User, Format Symbolic/Hex/Bin/Oct/Dec/UDec/Bit Reverse,
 * Mode Automatic/Periodical/Locked/Frozen, NAMEWIDTH, UPDATERATE).
 */
import type { ExpressionItem, VariableEntry } from '../../../../shared/api';
import { bitReverse, hex } from '../../../common/format';
import { parseAttrNumber, splitAttributes } from '../memory/model';
import { parseMode, type RefreshMode } from '../memory/refresh';

export type DataScope = 'global' | 'local' | 'user';
export type DataFormat = 'symb' | 'hex' | 'bin' | 'oct' | 'dec' | 'udec' | 'bitrev' | 'char';

export const SCOPE_LABELS: Record<DataScope, string> = { global: 'Global', local: 'Local', user: 'User' };
export const DATA_FORMAT_LABELS: Record<DataFormat, string> = {
  symb: '&Symbolic',
  hex: '&Hex',
  bin: '&Bin',
  oct: '&Oct',
  dec: '&Dec',
  udec: '&UDec',
  bitrev: 'Bit &Reverse',
  char: '&Char',
};
export const DATA_FORMAT_SHORT: Record<DataFormat, string> = { symb: 'Symb', hex: 'Hex', bin: 'Bin', oct: 'Oct', dec: 'Dec', udec: 'UDec', bitrev: 'BitRev', char: 'Char' };

/** One displayed row. `kind: 'var'` rows read their bytes from memory; `expr` rows are evaluated by the engine. */
export interface DataRow {
  key: string;
  name: string;
  kind: 'var' | 'expr';
  /** User expression (.xpr) this row comes from. */
  expression?: string;
  address?: number;
  /** Element size in bytes (1, 2, 4). */
  size: number;
  /** Array length (1 = scalar). */
  count: number;
  signed: boolean;
  typeName: string;
  module?: string;
  /** Element index for expanded array rows. */
  index?: number;
}

/** Type text: the DWARF type, or a C-like name from size/sign (assembly DS labels). */
export function typeText(v: Pick<DataRow, 'typeName' | 'size' | 'signed' | 'count'>): string {
  const base = v.typeName || (v.size === 1 ? (v.signed ? 'signed char' : 'unsigned char') : v.size === 2 ? (v.signed ? 'int' : 'unsigned int') : v.signed ? 'long' : 'unsigned long');
  return v.count > 1 ? `${base}[${v.count}]` : base;
}

export function varRow(v: VariableEntry): DataRow {
  const size = v.byteSize === 1 || v.byteSize === 2 || v.byteSize === 4 ? v.byteSize : 1;
  return { key: `var:${v.name}`, name: v.name, kind: 'var', address: v.address, size, count: Math.max(1, v.arrayLength ?? 1), signed: v.signed, typeName: v.typeName, module: v.module };
}

export function exprRow(e: ExpressionItem, globals: readonly VariableEntry[]): DataRow {
  // a user expression naming a variable is shown (and edited) as that variable
  const g = globals.find((v) => v.name === e.expression.trim()) ?? globals.find((v) => v.name.toLowerCase() === e.expression.trim().toLowerCase());
  if (g) return { ...varRow(g), key: `xpr:${e.expression}`, expression: e.expression };
  return { key: `xpr:${e.expression}`, name: e.expression, kind: 'expr', expression: e.expression, size: 2, count: 1, signed: false, typeName: '' };
}

/** Elements of an expanded array row. */
export function elementRows(r: DataRow): DataRow[] {
  const out: DataRow[] = [];
  for (let i = 0; i < Math.min(r.count, 1024); i++) out.push({ ...r, key: `${r.key}[${i}]`, name: `[${i}]`, count: 1, index: i, address: (r.address ?? 0) + i * r.size });
  return out;
}

/** Whether a user expression belongs to this Data window (`Data < ADDXPR` targets the first one). */
export function expressionBelongs(e: ExpressionItem, title: string, instance: number): boolean {
  const c = e.component.trim().toLowerCase();
  const t = title.toLowerCase();
  if (c === t) return true;
  // UNCERTAIN: "Data" (as written by .xpr files) is taken to mean the first Data window
  if (c === 'data') return instance <= 1 || t === 'data';
  if (t === 'data' && c === 'data:1') return true;
  return false;
}

/** Format a value of `size` bytes. Symbolic = decimal by signedness (UNCERTAIN: hiwave "Symb" for asm data). */
export function formatDataValue(value: number, size: number, signed: boolean, fmt: DataFormat): string {
  const bits = size * 8;
  const u = bits >= 32 ? value >>> 0 : value & ((1 << bits) - 1);
  const s = u >= 2 ** (bits - 1) ? u - 2 ** bits : u;
  switch (fmt) {
    case 'symb':
      return String(signed ? s : u);
    case 'hex':
      return '0x' + hex(u, size * 2);
    case 'bin':
      return '%' + u.toString(2).padStart(bits, '0');
    case 'oct':
      return 'o' + u.toString(8);
    case 'dec':
      return String(s);
    case 'udec':
      return String(u);
    case 'bitrev':
      return '0x' + hex(bitReverse(u, bits), size * 2);
    case 'char':
      return u >= 0x20 && u < 0x7f ? `'${String.fromCharCode(u)}'` : `0x${hex(u, size * 2)}`;
  }
}

/**
 * Display size of an evaluated (non-variable) expression: hiwave shows expression results as int (16 bits) unless
 * the value needs more. UNCERTAIN: EvalResult carries no type, so the size follows the value.
 */
export function exprValueSize(value: number): 2 | 4 {
  return value > 0xffff || value < -0x8000 ? 4 : 2;
}

/** Element size of a pointer's target type ("unsigned char *" -> 1, "int *" -> 2, "long *" -> 4; default 1). */
export function pointeeSize(typeName: string): 1 | 2 | 4 {
  const base = typeName.replace(/\*\s*$/, '').trim().toLowerCase();
  if (/\blong\b|\bfloat\b/.test(base)) return 4;
  if (/\bint\b|\bshort\b/.test(base) || /\*/.test(base)) return 2;
  return 1;
}

export const isPointerType = (typeName: string): boolean => /\*\s*$/.test(typeName);

/**
 * Parse an edited value: prefixes ($, 0x, %, @), 'c' chars, decimal; bare digits in hex when the format is hex.
 * In Bit Reverse format the entry is taken as shown (bit-reversed over `size` bytes) and reversed back.
 */
export function parseDataInput(text: string, fmt: DataFormat, size = 1): number | null {
  const v = parseDataPlain(text, fmt);
  if (v === null || fmt !== 'bitrev') return v;
  const bits = size * 8;
  if (v < 0 || v >= 2 ** bits) return null;
  return bitReverse(v, bits);
}

function parseDataPlain(text: string, fmt: DataFormat): number | null {
  let t = text.trim();
  if (!t) return null;
  const ch = /^'(.)'$/.exec(t);
  if (ch) return ch[1].charCodeAt(0);
  let neg = false;
  if (t.startsWith('-')) (neg = true), (t = t.slice(1));
  let radix = fmt === 'hex' || fmt === 'bitrev' ? 16 : fmt === 'bin' ? 2 : fmt === 'oct' ? 8 : 10;
  if (/^\$/.test(t)) (radix = 16), (t = t.slice(1));
  else if (/^0x/i.test(t)) (radix = 16), (t = t.slice(2));
  else if (/^%/.test(t)) (radix = 2), (t = t.slice(1));
  else if (/^[@o]/i.test(t) && radix !== 16) (radix = 8), (t = t.slice(1));
  const digits = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : radix === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!digits.test(t)) return null;
  const v = parseInt(t, radix);
  return neg ? -v : v;
}

/** Bytes (big-endian) of a value for `size` bytes; null when out of range. */
export function valueBytes(v: number, size: number): number[] | null {
  const bits = size * 8;
  if (v < -(2 ** (bits - 1)) || v >= 2 ** bits) return null;
  const u = v < 0 ? 2 ** bits + v : v;
  const out: number[] = [];
  for (let i = size - 1; i >= 0; i--) out.push(Math.floor(u / 2 ** (8 * i)) & 0xff);
  return out;
}

export interface DataAttrs {
  scope?: DataScope;
  format?: DataFormat;
  mode?: RefreshMode;
  updateRate?: number;
  nameWidth?: number;
  sort?: boolean;
}

export function parseDataFormat(v: string): DataFormat | undefined {
  const s = v.trim().toLowerCase();
  if (s.startsWith('symb')) return 'symb';
  if (s === 'hex' || s === 'bin' || s === 'oct' || s === 'dec' || s === 'udec' || s === 'char') return s;
  if (s.startsWith('bitrev') || s === 'reverse') return 'bitrev';
  return undefined;
}

export function parseDataAttributes(attrs: readonly { name: string; value: string }[] | string): DataAttrs {
  const list = typeof attrs === 'string' ? splitAttributes(attrs) : attrs;
  const out: DataAttrs = {};
  for (const { name, value } of list) {
    const v = value.trim();
    switch (name.toUpperCase()) {
      case 'SCOPE': {
        const s = v.toLowerCase();
        if (s.startsWith('glob')) out.scope = 'global';
        else if (s.startsWith('loc')) out.scope = 'local';
        else if (s.startsWith('user')) out.scope = 'user';
        break;
      }
      case 'FORMAT':
        out.format = parseDataFormat(v) ?? out.format;
        break;
      case 'MODE':
        out.mode = parseMode(v) ?? out.mode;
        break;
      case 'UPDATERATE': {
        const n = parseAttrNumber(v);
        if (n && n > 0) out.updateRate = n;
        break;
      }
      case 'NAMEWIDTH': {
        const n = parseAttrNumber(v);
        if (n && n > 0) out.nameWidth = n;
        break;
      }
      case 'SORT':
        out.sort = !/^notsort$/i.test(v);
        break;
    }
  }
  return out;
}

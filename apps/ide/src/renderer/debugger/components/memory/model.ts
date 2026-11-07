/**
 * Memory component data model: display units, formats, "uu"/"--" markers, edit parsing, watchpoint colours,
 * layout attributes. Pure functions (unit-tested without React).
 */
import { MEM_UNINITIALIZED, MEM_UNMAPPED, type AddressSpace, type MemoryBlockInfo, type WatchKind, type WatchpointInfo } from '../../../../shared/api';
import { bitReverse, hex } from '../../../common/format';
import { V_UNINIT, V_UNMAPPED, parseMode, type RefreshMode } from './refresh';

/** Word size menu: Byte, Word, Lword. */
export type MemUnit = 1 | 2 | 4;
/** Format menu: Hex, Bin, Oct, Dec, UDec, Bit Reverse (+ ASCII column). */
export type MemFormat = 'hex' | 'bin' | 'oct' | 'dec' | 'udec' | 'bitrev';

export const FORMAT_LABELS: Record<MemFormat, string> = { hex: '&Hex', bin: '&Bin', oct: '&Oct', dec: '&Dec', udec: '&UDec', bitrev: 'Bit &Reverse' };

/** 16-bit CPU space, or the 23-bit global space of the S12X. */
export const SPACE_SIZE: Record<AddressSpace, number> = { local: 0x10000, global: 0x800000 };

export const addressDigits = (space: AddressSpace): number => (space === 'global' ? 6 : 4);

/** Unique key of a byte across both spaces (ChangeTracker key). */
export const byteKey = (space: AddressSpace, address: number): number => (space === 'global' ? 0x1000000 + address : address);

/** Display width (characters) of one unit in a format. */
export function unitWidth(unit: MemUnit, fmt: MemFormat): number {
  const bits = unit * 8;
  switch (fmt) {
    case 'hex':
    case 'bitrev':
      return unit * 2;
    case 'bin':
      return bits;
    case 'oct':
      return Math.ceil(bits / 3);
    case 'dec':
      return String(-(2 ** (bits - 1))).length;
    case 'udec':
      return String(2 ** bits - 1).length;
  }
}

/** Big-endian value of `unit` bytes, or V_UNMAPPED / V_UNINIT when any byte is. */
export function unitValue(bytes: ArrayLike<number>, status: ArrayLike<number>, offset: number, unit: MemUnit): number {
  let v = 0;
  let uninit = false;
  for (let i = 0; i < unit; i++) {
    const st = status[offset + i];
    if (st === MEM_UNMAPPED || st === undefined) return V_UNMAPPED;
    if (st === MEM_UNINITIALIZED) uninit = true;
    v = v * 256 + (bytes[offset + i] ?? 0);
  }
  return uninit ? V_UNINIT : v;
}

/** Format one unit value as hiwave shows it: "uu"/"----" markers, zero-padded radix formats, right-aligned decimals. */
export function formatUnit(value: number, unit: MemUnit, fmt: MemFormat): string {
  const w = unitWidth(unit, fmt);
  if (value === V_UNMAPPED) return '-'.repeat(w);
  if (value === V_UNINIT) return 'u'.repeat(w);
  const bits = unit * 8;
  const u = value >>> 0;
  switch (fmt) {
    case 'hex':
      return hex(u, w);
    case 'bitrev':
      return hex(bitReverse(u, bits), w);
    case 'bin':
      return u.toString(2).padStart(w, '0');
    case 'oct':
      return u.toString(8).padStart(w, '0');
    case 'udec':
      return String(u).padStart(w, ' ');
    case 'dec':
      return String(u >= 2 ** (bits - 1) ? u - 2 ** bits : u).padStart(w, ' ');
  }
}

/** ASCII column character ('.' for non-printable and missing bytes). */
export function asciiChar(byte: number, status: number): string {
  if (status === MEM_UNMAPPED || status === MEM_UNINITIALIZED) return '.';
  return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
}

/**
 * Parse an edited unit in the current format. Bare digits use the format's radix (hex for Hex/Bit Reverse);
 * `$`/`0x`/`%`/`@` prefixes override. Returns null when invalid or out of range.
 */
export function parseUnitInput(text: string, unit: MemUnit, fmt: MemFormat): number | null {
  let s = text.trim().replace(/\s+/g, '');
  if (!s) return null;
  let neg = false;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  let radix = fmt === 'hex' || fmt === 'bitrev' ? 16 : fmt === 'bin' ? 2 : fmt === 'oct' ? 8 : 10;
  if (/^\$/.test(s)) (radix = 16), (s = s.slice(1));
  else if (/^0x/i.test(s)) (radix = 16), (s = s.slice(2));
  else if (/^%/.test(s)) (radix = 2), (s = s.slice(1));
  else if (/^@/.test(s)) (radix = 8), (s = s.slice(1));
  const digits = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : radix === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!digits.test(s)) return null;
  let v = parseInt(s, radix);
  const bits = unit * 8;
  const max = 2 ** bits;
  if (neg) {
    if (v > 2 ** (bits - 1)) return null;
    v = (max - v) % max;
  }
  if (v >= max) return null;
  if (fmt === 'bitrev' && radix === 16 && !/^(\$|0x)/i.test(text.trim())) v = bitReverse(v, bits);
  return v >>> 0;
}

/** Big-endian bytes of a unit value. */
export function unitBytes(value: number, unit: MemUnit): number[] {
  const out: number[] = [];
  for (let i = unit - 1; i >= 0; i--) out.push(Math.floor(value / 2 ** (8 * i)) & 0xff);
  return out;
}

/** Byte value / marker at an address from blocks (undefined when not loaded). */
export function byteAt(blocks: readonly MemoryBlockInfo[] | null, address: number): { value: number; status: number } | undefined {
  if (!blocks) return undefined;
  for (const b of blocks) {
    const i = address - b.address;
    if (i >= 0 && i < b.bytes.length) return { value: b.bytes[i], status: b.status[i] };
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ watchpoints

/** Underline colours: read green, write red, read/write black (ide.md §6 Memory). */
export const WATCH_COLORS: Record<WatchKind, string> = { read: '#008000', write: '#ff0000', readwrite: '#000000' };

/** The watchpoint covering [address, address+len) in `space`, if any (enabled first). */
export function watchAt(wps: readonly WatchpointInfo[], space: AddressSpace, address: number, len = 1): WatchpointInfo | undefined {
  let found: WatchpointInfo | undefined;
  for (const w of wps) {
    if ((w.space ?? 'local') !== space) continue;
    if (w.start <= address + len - 1 && w.end >= address) {
      if (w.enabled) return w;
      found ??= w;
    }
  }
  return found;
}

// ------------------------------------------------------------------------------------------------ attributes

export interface MemoryAttrs {
  format?: MemFormat;
  unit?: MemUnit;
  ascii?: boolean;
  showAddress?: boolean;
  mode?: RefreshMode;
  /** UPDATERATE in 100 ms steps. */
  updateRate?: number;
  address?: number;
  space?: AddressSpace;
}

const onOff = (v: string): boolean | undefined => (/^on$/i.test(v.trim()) ? true : /^off$/i.test(v.trim()) ? false : undefined);

export function parseFormat(v: string): MemFormat | undefined {
  const s = v.trim().toLowerCase().replace(/\s+/g, '');
  if (s === 'hex' || s === 'bin' || s === 'oct' || s === 'dec' || s === 'udec') return s;
  if (s.startsWith('bitrev') || s === 'bit_reverse' || s === 'reverse') return 'bitrev';
  return undefined;
}

/** Number as written in layouts/commands: 0x80, $80, 128, 80h. */
export function parseAttrNumber(v: string): number | undefined {
  const s = v.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(?:0x|\$)([0-9a-f]+)$/i.exec(s))) return parseInt(m[1], 16);
  if ((m = /^([0-9a-f]+)h$/i.exec(s))) return parseInt(m[1], 16);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return undefined;
}

/** Split an ATTRIBUTES argument list ("FORMAT hex,WORD 1,ASC on") into name/value pairs. */
export function splitAttributes(argText: string): { name: string; value: string }[] {
  return argText
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(\S+)\s*(.*)$/.exec(p)!;
      return { name: m[1], value: m[2] ?? '' };
    });
}

/** Apply Memory `attributes` (from the .hwl or `Memory < ATTRIBUTES ...`). Unknown names are ignored. */
export function parseMemoryAttributes(attrs: readonly { name: string; value: string }[]): MemoryAttrs {
  const out: MemoryAttrs = {};
  for (const { name, value } of attrs) {
    switch (name.toUpperCase()) {
      case 'FORMAT': {
        const f = parseFormat(value);
        if (f) out.format = f;
        break;
      }
      case 'WORD': {
        const n = parseAttrNumber(value);
        if (n === 1 || n === 2 || n === 4) out.unit = n;
        break;
      }
      case 'ASC':
        out.ascii = onOff(value) ?? out.ascii;
        break;
      case 'ADR':
        out.showAddress = onOff(value) ?? out.showAddress;
        break;
      case 'MODE':
        out.mode = parseMode(value) ?? out.mode;
        break;
      case 'UPDATERATE': {
        const n = parseAttrNumber(value);
        if (n !== undefined && n > 0) out.updateRate = n;
        break;
      }
      case 'ADDRESS': {
        const n = parseAttrNumber(value);
        if (n !== undefined) out.address = n;
        break;
      }
      case 'SHOW_ADDRESSSPACE':
        // UNCERTAIN: SHOW_ADDRESSSPACE 0 = local (CPU) addresses; non-zero taken as the global address space
        out.space = /^0$/.test(value.trim()) ? 'local' : 'global';
        break;
    }
  }
  return out;
}

/** `SMEM a..b` / `SMEM a,size` / `SMEM a` argument (numbers only; symbols are resolved by the caller). */
export function parseRangeText(text: string): { start: string; end?: string; size?: string } {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(.+?)\s*\.\.\s*(.+)$/.exec(t))) return { start: m[1], end: m[2] };
  if ((m = /^(.+?)\s*,\s*(.+)$/.exec(t))) return { start: m[1], size: m[2] };
  return { start: t };
}

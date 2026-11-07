/**
 * Text formats of the Command window (memory dumps, register display, evaluated values).
 *
 * DB/DW/DL dump line (ide.md §6, Ryerson HELP listing):  `4000: CF 40 00 10 EF 86 FF 7A 02 44 7A 02 62 41 7A 02 .@.....z.Dz.bAz.`
 * UNCERTAIN: the debugger manual's example puts a dash between bytes 7 and 8 (`... 27 10-35 ED ...`); that layout is
 * available with `{ dash: true }`. Uninitialized RAM prints `uu`, unmapped addresses `--` (Memory component markers).
 */
import { MEM_OK, MEM_UNINITIALIZED, type MemoryBlock, type RegisterSet } from './target';

export const hex = (v: number, digits: number): string => (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');

export interface DumpOptions {
  /** 1 (DB), 2 (DW) or 4 (DL). */
  unit?: 1 | 2 | 4;
  /** Bytes per line (default 16). */
  perLine?: number;
  /** Dash between the two 8-byte halves (byte dumps only). */
  dash?: boolean;
  /** Append the ASCII column (default true). */
  ascii?: boolean;
  /** Address digits (default 4, or 6 for addresses above $FFFF). */
  addressDigits?: number;
}

const byteText = (b: MemoryBlock, i: number): string => (b.status[i] === MEM_OK ? hex(b.bytes[i], 2) : b.status[i] === MEM_UNINITIALIZED ? 'uu' : '--');

/** Format a memory block as dump lines (the block start need not be line-aligned; hiwave starts at the given address). */
export function formatDump(block: MemoryBlock, opts: DumpOptions = {}): string[] {
  const unit = opts.unit ?? 1;
  const per = opts.perLine ?? 16;
  const digits = opts.addressDigits ?? (block.address + block.bytes.length - 1 > 0xffff ? 6 : 4);
  const out: string[] = [];
  for (let off = 0; off < block.bytes.length; off += per) {
    const n = Math.min(per, block.bytes.length - off);
    const items: string[] = [];
    let line = `${hex(block.address + off, digits)}:`;
    for (let i = 0; i < n; i += unit) {
      let s = '';
      for (let j = 0; j < unit && i + j < n; j++) s += byteText(block, off + i + j);
      items.push(s);
    }
    if (unit === 1 && opts.dash && items.length > 8) line += ' ' + items.slice(0, 8).join(' ') + '-' + items.slice(8).join(' ');
    else line += ' ' + items.join(' ');
    if (opts.ascii !== false) {
      const width = (per / unit) * (unit * 2 + 1) - 1;
      const used = line.length - (digits + 1) - 1;
      let a = '';
      for (let i = 0; i < n; i++) {
        const c = block.bytes[off + i];
        a += block.status[off + i] === MEM_OK && c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
      }
      line += ' '.repeat(Math.max(0, width - used) + 1) + a;
    }
    out.push(line);
  }
  return out;
}

/** CCR bits as `SXHINZVC` letters (clear bits lower-case). UNCERTAIN: hiwave command-window spelling. */
export function ccrBits(ccr: number): string {
  const names = 'SXHINZVC';
  let s = '';
  for (let i = 0; i < 8; i++) s += ccr & (0x80 >> i) ? names[i] : names[i].toLowerCase();
  return s;
}

/**
 * Register display for RD and T. UNCERTAIN: hiwave's exact command-window layout is not documented; this follows
 * the Register component order (D A B IX IY PC SP CCR).
 */
export function formatRegisters(r: RegisterSet): string[] {
  return [
    `D=${hex(r.D, 4)}  A=${hex(r.A, 2)}  B=${hex(r.B, 2)}  IX=${hex(r.X, 4)}  IY=${hex(r.Y, 4)}`,
    `PC=${hex(r.PC, 4)}  SP=${hex(r.SP, 4)}  CCR=${hex(r.CCR, 2)} (${ccrBits(r.CCR)})  IPL=${r.IPL}  PPAGE=${hex(r.PPAGE, 2)}`,
  ];
}

export type ValueFormat = 'hex' | 'dec' | 'udec' | 'oct' | 'bin' | 'char';

/** E command result formats (`;X ;D ;O ;B ;C`). UNCERTAIN: hiwave's prefixes for octal/binary output. */
export function formatValue(v: number, f: ValueFormat): string {
  switch (f) {
    case 'hex':
      return '0x' + (v < 0 ? (v >>> 0) : v).toString(16).toUpperCase();
    case 'dec':
      return String(v);
    case 'udec':
      return String(v >>> 0);
    case 'oct':
      return '0' + (v >>> 0).toString(8);
    case 'bin':
      return '%' + (v >>> 0).toString(2);
    case 'char': {
      const c = v & 0xff;
      return c >= 0x20 && c < 0x7f ? `'${String.fromCharCode(c)}'` : `'\\x${hex(c, 2)}'`;
    }
  }
}

/**
 * C printf subset for the PRINTF command: %d %i %u %x %X %o %c %s %% %b with flags `-0+ ` and width/precision.
 */
export function cFormat(fmt: string, args: (number | string)[]): string {
  let ai = 0;
  return fmt.replace(/%([-0+ #]*)(\d+)?(?:\.(\d+))?(l|h)?([diuxXocsb%])/g, (_m, flags: string, width: string | undefined, prec: string | undefined, _len, conv: string) => {
    if (conv === '%') return '%';
    const a = args[ai++];
    let s: string;
    const n = typeof a === 'number' ? a : Number(a ?? 0);
    switch (conv) {
      case 'd':
      case 'i':
        s = String(Math.trunc(n));
        if (flags.includes('+') && n >= 0) s = '+' + s;
        else if (flags.includes(' ') && n >= 0) s = ' ' + s;
        break;
      case 'u':
        s = String(n >>> 0);
        break;
      case 'x':
        s = (n >>> 0).toString(16);
        if (flags.includes('#')) s = '0x' + s;
        break;
      case 'X':
        s = (n >>> 0).toString(16).toUpperCase();
        if (flags.includes('#')) s = '0X' + s;
        break;
      case 'o':
        s = (n >>> 0).toString(8);
        break;
      case 'b':
        s = (n >>> 0).toString(2);
        break;
      case 'c':
        s = typeof a === 'string' ? a.slice(0, 1) : String.fromCharCode(n & 0xff);
        break;
      default:
        s = typeof a === 'string' ? a : String(a ?? '');
        if (prec !== undefined) s = s.slice(0, Number(prec));
    }
    if (prec !== undefined && /[diuxXob]/.test(conv)) {
      const neg = s.startsWith('-');
      const digits = neg ? s.slice(1) : s;
      s = (neg ? '-' : '') + digits.padStart(Number(prec), '0');
    }
    const w = width ? Number(width) : 0;
    if (s.length < w) {
      if (flags.includes('-')) s = s.padEnd(w);
      else if (flags.includes('0') && conv !== 's' && conv !== 'c') {
        const neg = /^[-+ ]/.test(s) ? s[0] : '';
        s = neg + s.slice(neg.length).padStart(w - neg.length, '0');
      } else s = s.padStart(w);
    }
    return s;
  });
}

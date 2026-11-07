/**
 * Number formatting/parsing as the hiwave components show and accept values.
 * Formats: Hex, Bin, Oct, Dec (signed), UDec, Bit Reverse, Char.
 */
export type NumberFormat = 'hex' | 'bin' | 'oct' | 'dec' | 'udec' | 'bitrev' | 'char';

/** Upper-case hex, zero padded: hex(0x4a, 2) = "4A". */
export const hex = (v: number, digits: number): string => (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');

/** "0x4000"-style address as hiwave prints it (4 digits, or 6 for logical/global addresses above $FFFF). */
export const addr = (v: number): string => '0x' + hex(v, v > 0xffff ? 6 : 4);

export function bitReverse(v: number, bits: number): number {
  let r = 0;
  for (let i = 0; i < bits; i++) if (v & (1 << i)) r |= 1 << (bits - 1 - i);
  return r >>> 0;
}

/** Format a value of `bits` width (8/16/32). */
export function formatNumber(v: number, fmt: NumberFormat, bits: 8 | 16 | 32 = 8): string {
  const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  const u = (v & mask) >>> 0;
  switch (fmt) {
    case 'hex':
      return hex(u, bits / 4);
    case 'bin':
      return u.toString(2).padStart(bits, '0');
    case 'oct':
      return u.toString(8).padStart(Math.ceil(bits / 3), '0');
    case 'dec':
      return String(u >= 2 ** (bits - 1) ? u - 2 ** bits : u);
    case 'udec':
      return String(u);
    case 'bitrev':
      return hex(bitReverse(u, bits), bits / 4);
    case 'char':
      return u >= 0x20 && u < 0x7f ? String.fromCharCode(u) : '.';
  }
}

/**
 * Parse a number as typed in hiwave fields: `$FF`, `0xFF`, `FFh`, `%1010`, `0b1010`, `@17`/`0o17`, decimal, with a
 * leading '-'. `defaultRadix` applies to bare digits (memory/register edits default to hex). Returns null if invalid.
 */
export function parseNumber(text: string, defaultRadix: 10 | 16 = 10): number | null {
  let s = text.trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1).trim();
  }
  let radix: number = defaultRadix;
  if (/^\$/.test(s)) (radix = 16), (s = s.slice(1));
  else if (/^0x/i.test(s)) (radix = 16), (s = s.slice(2));
  else if (/^[0-9a-f]+h$/i.test(s)) (radix = 16), (s = s.slice(0, -1));
  else if (/^%/.test(s)) (radix = 2), (s = s.slice(1));
  else if (/^0b[01]+$/i.test(s)) (radix = 2), (s = s.slice(2));
  else if (/^@/.test(s)) (radix = 8), (s = s.slice(1));
  else if (/^0o/i.test(s)) (radix = 8), (s = s.slice(2));
  const digits = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : radix === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!digits.test(s)) return null;
  const v = parseInt(s, radix);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

/** Status-bar frequency text, e.g. "10.000000 MHz". */
export const formatMHz = (hz: number): string => `${(hz / 1e6).toFixed(6)} MHz`;

/** CCR bit string "SXHINZVC" with set bits upper-case and clear bits as '-' (Command window style). */
export function ccrString(ccr: number): string {
  return 'SXHINZVC'
    .split('')
    .map((c, i) => (ccr & (0x80 >> i) ? c : '-'))
    .join('');
}

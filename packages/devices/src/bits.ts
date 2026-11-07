import type { BitField } from './types.js';

/**
 * Compact bit-layout notation, MSB first, space separated. Token forms:
 * - `-`            unimplemented bit
 * - `NAME`         one bit
 * - `NAME[n]`      field of n bits: emits field NAME (width n) plus bits NAME{n-1}..NAME0
 * - `NAME[h:l]`    field with explicit bit-name indices: bits NAME{h}..NAME{l}
 * - `NAME#n`       n individual bits NAME{n-1}..NAME0 without a field entry (port registers)
 * - `NAME#h:l`     like `NAME#n` with explicit indices
 * - `NAME(n)`      field of n bits WITHOUT member bit names (CodeWarrior defines only the group, e.g. DBGC1.COMRV)
 * - `D`            (alone) generic data register: BIT{size*8-1}..BIT0
 *
 * Result is MSB first; multi-bit fields precede their member bits.
 */
export function parseBits(spec: string, size: 1 | 2): BitField[] {
  const total = size * 8;
  const s = spec.trim();
  if (s === 'D') {
    const out: BitField[] = [];
    for (let b = total - 1; b >= 0; b--) out.push({ name: `BIT${b}`, bit: b, width: 1 });
    return out;
  }
  const out: BitField[] = [];
  let pos = total; // next free position is pos-1
  for (const tok of s.split(/\s+/)) {
    if (tok === '-') {
      pos -= 1;
      continue;
    }
    const fo = /^([A-Za-z_][A-Za-z0-9_]*)\((\d+)\)$/.exec(tok);
    if (fo) {
      const width = Number(fo[2]);
      if (width < 1) throw new Error(`bad width in '${tok}'`);
      pos -= width;
      out.push({ name: fo[1], bit: pos, width });
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*?)(?:(\[|#)(\d+)(?::(\d+))?\]?)?$/.exec(tok);
    if (!m) throw new Error(`bad bit token '${tok}' in '${spec}'`);
    const [, name, kind, a, b] = m;
    if (!kind) {
      pos -= 1;
      out.push({ name, bit: pos, width: 1 });
      continue;
    }
    let hi: number;
    let lo: number;
    if (b !== undefined) {
      hi = Number(a);
      lo = Number(b);
    } else {
      hi = Number(a) - 1;
      lo = 0;
    }
    const width = hi - lo + 1;
    if (width < 1) throw new Error(`bad width in '${tok}'`);
    pos -= width;
    if (kind === '[') out.push({ name, bit: pos, width });
    for (let i = 0; i < width; i++) out.push({ name: `${name}${hi - i}`, bit: pos + width - 1 - i, width: 1 });
  }
  if (pos !== 0) throw new Error(`bit spec '${spec}' covers ${total - pos} of ${total} bits`);
  return out;
}

/** Mask of a field/bit within its register. */
export const fieldMask = (f: BitField): number => ((1 << f.width) - 1) << f.bit;

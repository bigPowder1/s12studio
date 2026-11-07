/**
 * Memory > CopyMem and Memory > Search Pattern helpers (docs/research/r1/ide.md §6 Memory menu). Pure functions plus
 * chunked reads through `debug.readMemory`, so both work over the 64K local and the 8M global space.
 */
import { MEM_UNMAPPED, type AddressSpace, type S12Api } from '../../../shared/api';

/** Bytes per readMemory call. */
export const CHUNK = 0x1000;

/**
 * Search pattern text -> bytes. `"text"` / `'text'` is ASCII; otherwise space/comma separated byte values, or one
 * run of hex digits ("A55A"). Bare digits are hex when `hexFormat` (the dialog's "Hex Format" box), else decimal;
 * `$`/`0x` prefixes are always hex. Returns null when invalid.
 */
export function parsePattern(text: string, hexFormat = true): number[] | null {
  const t = text.trim();
  if (!t) return null;
  const q = /^(["'])(.*)\1$/.exec(t);
  if (q) return q[2].length ? [...q[2]].map((c) => c.charCodeAt(0) & 0xff) : null;
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 1 && hexFormat && /^[0-9a-f]+$/i.test(parts[0]) && parts[0].length > 2) {
    const h = parts[0].length % 2 ? '0' + parts[0] : parts[0];
    return h.match(/../g)!.map((b) => parseInt(b, 16));
  }
  const out: number[] = [];
  for (const p of parts) {
    let v: number;
    if (/^(\$|0x)[0-9a-f]{1,2}$/i.test(p)) v = parseInt(p.replace(/^(\$|0x)/i, ''), 16);
    else if (hexFormat && /^[0-9a-f]{1,2}$/i.test(p)) v = parseInt(p, 16);
    else if (!hexFormat && /^\d{1,3}$/.test(p)) v = parseInt(p, 10);
    else return null;
    if (v > 0xff) return null;
    out.push(v);
  }
  return out;
}

/** First index of `pattern` in `bytes` at or after `from`, skipping bytes whose status is MEM_UNMAPPED. */
export function indexOfPattern(bytes: ArrayLike<number>, status: ArrayLike<number>, pattern: readonly number[], from = 0): number {
  outer: for (let i = Math.max(0, from); i + pattern.length <= bytes.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (status[i + j] === MEM_UNMAPPED || bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

/** Search [start, end] for `pattern`; returns the address of the first match or null. Chunks overlap by len-1. */
export async function searchMemory(s12: S12Api, start: number, end: number, pattern: readonly number[], space: AddressSpace = 'local'): Promise<number | null> {
  if (!pattern.length || end < start) return null;
  for (let a = start; a + pattern.length - 1 <= end; a += CHUNK) {
    const len = Math.min(CHUNK + pattern.length - 1, end - a + 1);
    const b = await s12.debug.readMemory({ address: a, length: len, space });
    const i = indexOfPattern(b.bytes, b.status, pattern);
    if (i >= 0) return a + i;
  }
  return null;
}

/** Copy [start, end] to `dest` (reads first, so overlapping ranges copy correctly). Unmapped bytes are skipped. */
export async function copyMemory(s12: S12Api, start: number, end: number, dest: number, space: AddressSpace = 'local'): Promise<number> {
  const len = end - start + 1;
  const src: { address: number; bytes: Uint8Array; status: Uint8Array }[] = [];
  for (let a = start; a <= end; a += CHUNK) {
    const b = await s12.debug.readMemory({ address: a, length: Math.min(CHUNK, end - a + 1), space });
    src.push({ address: a, bytes: b.bytes, status: b.status });
  }
  let written = 0;
  for (const c of src) {
    // write runs of mapped bytes
    let i = 0;
    while (i < c.bytes.length) {
      while (i < c.bytes.length && c.status[i] === MEM_UNMAPPED) i++;
      const s = i;
      while (i < c.bytes.length && c.status[i] !== MEM_UNMAPPED) i++;
      if (i > s) {
        await s12.debug.writeMemory(dest + (c.address - start) + s, Array.prototype.slice.call(c.bytes, s, i) as number[], space);
        written += i - s;
      }
    }
  }
  return Math.min(written, len);
}

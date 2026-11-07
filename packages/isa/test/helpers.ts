/**
 * Test-only helpers: S19 loading, CodeWarrior .lst parsing, and a minimal ELF32-BE section reader
 * (local on purpose: @s12/formats is developed concurrently).
 */
import { readFixture } from '../../formats/test/fixtures.js';
export { hasFixtures, describeFx, itFx } from '../../formats/test/fixtures.js';

/** Load S1 records of an S19 file into a 64 KB image (unset bytes = $FF). Returns image + written mask. */
export function loadS19(...path: string[]): { image: Uint8Array; written: Uint8Array } {
  const image = new Uint8Array(0x10000).fill(0xff);
  const written = new Uint8Array(0x10000);
  for (const line of readFixture(...path).toString('latin1').split(/\r?\n/)) {
    if (!line.startsWith('S1')) continue;
    const count = parseInt(line.slice(2, 4), 16);
    const addr = parseInt(line.slice(4, 8), 16);
    for (let i = 0; i < count - 3; i++) {
      image[addr + i] = parseInt(line.slice(8 + i * 2, 10 + i * 2), 16);
      written[addr + i] = 1;
    }
  }
  return { image, written };
}

export interface ListingInsn {
  /** Physical .lst line number (1-based). */
  lstLine: number;
  section: string;
  loc: number;
  absolute: boolean;
  /** Bytes listed (main line + continuation lines). */
  byteCount: number;
  /** Object text with `x` for unresolved nibbles, spaces removed. */
  objText: string;
  label?: string;
  mnemonic: string;
  operands: string;
  source: string;
}

/** Strip a `;` comment that is not inside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === ';') return s.slice(0, i);
  }
  return s;
}

/** Parse CodeWarrior HC12 assembler listing lines that carry object code. */
export function parseListing(text: string): ListingInsn[] {
  const lines = text.split(/\r?\n/);
  const out: ListingInsn[] = [];
  let section = '';
  let cur: ListingInsn | null = null;
  lines.forEach((line, i) => {
    const main = /^[ \d]{4}\d[ \d]{4}\d  /.test(line);
    const cont = /^ {13}[0-9A-F]{6} /.test(line);
    if (cont && cur) {
      const obj = line.slice(20, 31).replace(/\s/g, '');
      cur.objText += obj;
      cur.byteCount += obj.length / 2;
      return;
    }
    if (!main) return;
    cur = null;
    const src = line.slice(32);
    const code = stripComment(src);
    let label: string | undefined;
    let rest = code;
    if (/^\S/.test(code)) {
      const m = /^(\S+?):?(\s+|$)/.exec(code)!;
      label = m[1].replace(/:$/, '');
      rest = code.slice(m[0].length);
    }
    const toks = rest.trim().split(/\s+/);
    const mnemonic = toks[0] ?? '';
    const operands = rest.trim().slice(mnemonic.length).trim();
    if (/^SECTION$/i.test(mnemonic)) section = label ?? '';
    const locText = line.slice(13, 19).trim();
    const obj = line.slice(20, 31).replace(/\s/g, '');
    if (!locText || !obj || mnemonic.toUpperCase() === 'EQU') return;
    cur = {
      lstLine: i + 1,
      section,
      loc: parseInt(locText, 16),
      absolute: line[12] === 'a',
      byteCount: obj.length / 2,
      objText: obj,
      label,
      mnemonic,
      operands,
      source: src,
    };
    out.push(cur);
  });
  return out;
}

export interface ElfSection {
  name: string;
  type: number;
  addr: number;
  offset: number;
  size: number;
  data: Uint8Array;
}

/** Minimal ELF32 big-endian section reader for an ELF image starting at `base` in `buf`. */
export function elfSections(buf: Uint8Array, base = 0): { sections: ElfSection[]; length: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(base) !== 0x7f454c46) throw new Error(`no ELF magic at ${base}`);
  const shoff = dv.getUint32(base + 0x20);
  const shentsize = dv.getUint16(base + 0x2e);
  const shnum = dv.getUint16(base + 0x30);
  const shstrndx = dv.getUint16(base + 0x32);
  const raw = Array.from({ length: shnum }, (_, i) => {
    const o = base + shoff + i * shentsize;
    return {
      nameOff: dv.getUint32(o),
      type: dv.getUint32(o + 4),
      addr: dv.getUint32(o + 12),
      offset: dv.getUint32(o + 16),
      size: dv.getUint32(o + 20),
    };
  });
  const strBase = base + raw[shstrndx].offset;
  const cstr = (off: number): string => {
    let s = '';
    for (let p = strBase + off; buf[p]; p++) s += String.fromCharCode(buf[p]);
    return s;
  };
  const sections = raw.map((r) => ({
    name: cstr(r.nameOff),
    type: r.type,
    addr: r.addr,
    offset: r.offset,
    size: r.size,
    data: r.type === 8 ? new Uint8Array(0) : buf.subarray(base + r.offset, base + r.offset + r.size),
  }));
  return { sections, length: shoff + shnum * shentsize };
}

/** Members of a HIWARE .lib: back-to-back ELF objects after the 5-string header, up to the directory. */
export function libMembers(buf: Uint8Array): Array<{ offset: number; sections: ElfSection[] }> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dirStart = buf.length - dv.getUint32(buf.length - 4);
  // header: magic(4) + u32 + u32 + 5 NUL-terminated strings
  let off = 12;
  for (let i = 0; i < 5; i++) {
    while (buf[off]) off++;
    off++;
  }
  const out: Array<{ offset: number; sections: ElfSection[] }> = [];
  while (off < dirStart) {
    const { sections, length } = elfSections(buf, off);
    out.push({ offset: off, sections });
    off += length;
  }
  return out;
}

/** Normalise an operand string for comparison: drop spaces/`<`/`>`, uppercase, numbers to decimal. */
export function normOperands(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/[<>]/g, '')
    .toUpperCase()
    .replace(/(-?)(?:\$|0X)([0-9A-F]+)|(-?)\b(\d+)\b/g, (_m, s1, h, s2, d) =>
      h !== undefined ? String((s1 ? -1 : 1) * parseInt(h, 16)) : String((s2 ? -1 : 1) * parseInt(d, 10)),
    );
}

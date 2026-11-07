// "looc" chunk container shared by CodeWarrior .mcp, CWSettingsWindows.stg and TargetDataWindows.tdt.
// Spec: docs/research/r2/mcp-format.md §1. Windows files are little-endian with magic "looc";
// Mac files use "cool" and big-endian integers.

export type LoocEndianness = 'le' | 'be';

export interface LoocHeader {
  magic: string;
  /** container version (3 in all known files) */
  version: number;
  /** start of data heap (always 0x128) */
  heapOff: number;
  heapLen: number;
  tableOff: number;
  tableSize: number;
  count: number;
  /** bytes 0x1C..0x1F, e.g. 02 03 04 00. UNCERTAIN: IDE/format version */
  formatBytes: Uint8Array;
  reserved: [number, number];
}

export interface LoocChunk {
  index: number;
  off: number;
  size: number;
  /** FourCC in reading order, e.g. 'mstr', 'pref', 'PLst' */
  tag: string;
  /** namespace for structural chunks; for 'pref' an opaque stamp (UNCERTAIN) — preserved as-is */
  ns: number;
  /** for pref/PLst/prpl: name id into the namespace-0 string table */
  id: number;
  /** reserved word, 0 in all known files; named `seq` for symmetry with the table layout */
  seq: number;
  data: Uint8Array;
}

export interface LoocFile {
  endianness: LoocEndianness;
  subtitle: string;
  header: LoocHeader;
  chunks: LoocChunk[];
  /** true when the header's table pointer failed sanity checks and the table was recovered by scanning */
  usedFallback: boolean;
  warnings: string[];
  bytes: Uint8Array;
}

export const LOOC_HEADER_SIZE = 0x128;
export const LOOC_ENTRY_SIZE = 24;

export class LoocError extends Error {}

/** Little helper bound to a buffer and an endianness. */
export class LoocReader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array, readonly le: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(o: number): number { return this.view.getUint8(o); }
  u16(o: number): number { return this.view.getUint16(o, this.le); }
  u32(o: number): number { return this.view.getUint32(o, this.le); }
  /** FourCC stored as an integer: reversed bytes on LE files. */
  fourcc(o: number): string { return fourcc(this.bytes, o, this.le); }
  cstr(o: number, max = this.bytes.length - o): string { return cstr(this.bytes, o, max); }
}

export function fourcc(b: Uint8Array, o: number, le: boolean): string {
  const s = latin1(b.subarray(o, o + 4));
  return le ? s.split('').reverse().join('') : s;
}

export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** NUL-terminated string, at most `max` bytes. UNCERTAIN: CodeWarrior uses the Windows ANSI code page; we decode as latin1. */
export function cstr(b: Uint8Array, o: number, max = b.length - o): string {
  const end = Math.min(b.length, o + max);
  let e = o;
  while (e < end && b[e] !== 0) e++;
  return latin1(b.subarray(o, e));
}

const isTagChar = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

function readEntry(r: LoocReader, o: number, index: number): Omit<LoocChunk, 'data'> {
  return { index, off: r.u32(o), size: r.u32(o + 4), tag: r.fourcc(o + 8), ns: r.u32(o + 12), id: r.u32(o + 16), seq: r.u32(o + 20) };
}

function plausibleEntry(r: LoocReader, o: number, limit: number): boolean {
  for (let i = 0; i < 4; i++) if (!isTagChar(r.u8(o + 8 + i))) return false;
  const off = r.u32(o), size = r.u32(o + 4);
  return off >= LOOC_HEADER_SIZE && off + size <= limit;
}

/** Parse a looc container. Only the chunk table is trusted; free space between chunks is ignored. */
export function readLooc(bytes: Uint8Array): LoocFile {
  if (bytes.length < LOOC_HEADER_SIZE) throw new LoocError(`file too short for a looc header (${bytes.length} bytes)`);
  const magic = latin1(bytes.subarray(0, 4));
  let le: boolean;
  if (magic === 'looc') le = true;
  else if (magic === 'cool') le = false;
  else throw new LoocError(`not a CodeWarrior looc container (magic ${JSON.stringify(magic)})`);
  const r = new LoocReader(bytes, le);
  const warnings: string[] = [];
  const header: LoocHeader = {
    magic,
    version: r.u32(4),
    heapOff: r.u32(8),
    heapLen: r.u32(0x0c),
    tableOff: r.u32(0x10),
    tableSize: r.u32(0x14),
    count: r.u32(0x18),
    formatBytes: bytes.slice(0x1c, 0x20),
    reserved: [r.u32(0x20), r.u32(0x24)],
  };
  const subtitle = r.cstr(0x28, 256);
  const len = bytes.length;

  let entries: Omit<LoocChunk, 'data'>[] = [];
  let usedFallback = false;
  const { tableOff, tableSize, count } = header;
  const headerOk =
    tableOff >= LOOC_HEADER_SIZE &&
    tableOff + tableSize === len &&
    count * LOOC_ENTRY_SIZE === tableSize;
  // Header table intact but not at end of file (trailing padding / appended data): trust it if every entry is plausible.
  const headerTableUsable =
    !headerOk &&
    count > 0 &&
    tableOff >= LOOC_HEADER_SIZE &&
    count * LOOC_ENTRY_SIZE === tableSize &&
    tableOff + tableSize <= len &&
    Array.from({ length: count }, (_, i) => plausibleEntry(r, tableOff + i * LOOC_ENTRY_SIZE, tableOff)).every(Boolean);
  let limit = len;
  if (headerOk || headerTableUsable) {
    for (let i = 0; i < count; i++) entries.push(readEntry(r, tableOff + i * LOOC_ENTRY_SIZE, i));
    if (headerTableUsable) warnings.push(`${len - tableOff - tableSize} bytes after the chunk table ignored`);
    if (header.heapOff !== LOOC_HEADER_SIZE) warnings.push(`unexpected heap offset 0x${header.heapOff.toString(16)}`);
    if (header.heapOff + header.heapLen !== tableOff) warnings.push('heap length does not end at the chunk table');
    limit = tableOff;
  } else {
    // Fallback: the table is normally the last thing in the file. Scan backwards for a run of plausible 24-byte
    // entries. Trailing junk or truncation can shift the table's alignment relative to EOF, so try every
    // alignment (the one implied by the header's tableOff first) and keep the longest run.
    usedFallback = true;
    warnings.push('chunk table header failed sanity checks; recovering table by scanning from end of file');
    const starts: number[] = [];
    if (tableOff >= LOOC_HEADER_SIZE && tableOff < len) {
      const aligned = tableOff + Math.floor((len - LOOC_ENTRY_SIZE - tableOff) / LOOC_ENTRY_SIZE) * LOOC_ENTRY_SIZE;
      if (aligned >= LOOC_HEADER_SIZE) starts.push(aligned);
    }
    for (let k = 0; k < LOOC_ENTRY_SIZE; k++) starts.push(len - LOOC_ENTRY_SIZE - k);
    let best: number[] = [];
    for (const st of starts) {
      const found: number[] = [];
      for (let o = st; o >= LOOC_HEADER_SIZE && plausibleEntry(r, o, len); o -= LOOC_ENTRY_SIZE) found.unshift(o);
      if (found.length > best.length) best = found;
    }
    if (best.length === 0) throw new LoocError('no chunk table found');
    entries = best.map((eo, i) => readEntry(r, eo, i));
    limit = best[0];
    if (best.length !== count) warnings.push(`recovered ${best.length} chunk table entries; header says ${count}`);
  }

  const chunks: LoocChunk[] = [];
  for (const e of entries) {
    if (e.off < LOOC_HEADER_SIZE || e.off + e.size > limit) {
      warnings.push(`chunk #${e.index} '${e.tag}' out of bounds (0x${e.off.toString(16)}+0x${e.size.toString(16)}); dropped`);
      continue;
    }
    if (e.seq !== 0) warnings.push(`chunk #${e.index} '${e.tag}' has non-zero reserved word`);
    chunks.push({ ...e, data: bytes.subarray(e.off, e.off + e.size) });
  }
  return { endianness: le ? 'le' : 'be', subtitle, header, chunks, usedFallback, warnings, bytes };
}

export function findChunks(f: LoocFile, tag: string, ns?: number): LoocChunk[] {
  return f.chunks.filter((c) => c.tag === tag && (ns === undefined || c.ns === ns));
}

export function findChunk(f: LoocFile, tag: string, ns?: number): LoocChunk | undefined {
  return f.chunks.find((c) => c.tag === tag && (ns === undefined || c.ns === ns));
}

/** A reader over a single chunk's bytes (offsets relative to the chunk). */
export function chunkReader(f: LoocFile, c: LoocChunk): LoocReader {
  return new LoocReader(c.data, f.endianness === 'le');
}

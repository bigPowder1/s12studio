// Motorola S-record reader and CodeWarrior-style writer. Spec: docs/research/r2/elf-lib-formats.md §5, asm.md §9.
// CodeWarrior Burner output (.abs.s19 / .abs.glo):
//   S0: address 0000, data = ASCII path of the .abs (no NUL)
//   data: 32 bytes per record, one run per contiguous block, ascending addresses; S1 for 16-bit, S2 for 24-bit
//   terminator: S9030000FC for both .s19 and .glo (not S8, address 0 rather than the entry point); CRLF line ends.

import { latin1BestFitBytes } from '../util/bytes';

export interface SRecord {
  /** 0..9 */
  type: number;
  address: number;
  data: Uint8Array;
  /** 1-based line number */
  line: number;
  checksum: number;
  checksumOk: boolean;
}

export interface SRecordBlock {
  address: number;
  data: Uint8Array;
}

export interface SRecordError {
  line: number;
  message: string;
}

export interface SRecordFile {
  records: SRecord[];
  /** S0 data as a latin1 string */
  header?: string;
  headerAddress?: number;
  /** data blocks in file order; consecutive records are merged when contiguous */
  blocks: SRecordBlock[];
  /** S5/S6 record count, if present */
  recordCount?: number;
  /** S7/S8/S9 */
  terminator?: { type: 7 | 8 | 9; address: number };
  eol: '\r\n' | '\n';
  errors: SRecordError[];
}

export type SRecordDataType = 'S1' | 'S2' | 'S3';

const ADDR_BYTES: Record<number, number> = { 0: 2, 1: 2, 2: 3, 3: 4, 5: 2, 6: 3, 7: 4, 8: 3, 9: 2 };

function toText(input: string | Uint8Array): string {
  if (typeof input === 'string') return input;
  let s = '';
  for (let i = 0; i < input.length; i++) s += String.fromCharCode(input[i]);
  return s;
}

export class SRecordParseError extends Error {}

/** Parse S-records. Malformed lines and checksum mismatches are reported in `errors` (strict: throw instead). */
export function readSRecords(input: string | Uint8Array, opts: { strict?: boolean } = {}): SRecordFile {
  const text = toText(input);
  const eol = text.includes('\r\n') || !text.includes('\n') ? '\r\n' : '\n';
  const out: SRecordFile = { records: [], blocks: [], eol, errors: [] };
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const l = rawLine.trim();
    if (l === '') return;
    const fail = (message: string) => {
      if (opts.strict) throw new SRecordParseError(`line ${line}: ${message}`);
      out.errors.push({ line, message });
    };
    if (!/^S[0-9]/.test(l)) return fail('not an S-record');
    const type = l.charCodeAt(1) - 48;
    if (type === 4) return fail('S4 records are reserved');
    if (!/^[0-9A-Fa-f]*$/.test(l.slice(2)) || l.length % 2 !== 0 || l.length < 4) return fail('malformed hex');
    const count = parseInt(l.slice(2, 4), 16);
    if (l.length !== 4 + count * 2) return fail(`byte count ${count} does not match line length`);
    const ab = ADDR_BYTES[type];
    if (count < ab + 1) return fail('record too short');
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) bytes[i] = parseInt(l.slice(4 + i * 2, 6 + i * 2), 16);
    let sum = count;
    for (let i = 0; i < count - 1; i++) sum += bytes[i];
    const checksum = bytes[count - 1];
    const checksumOk = ((~sum) & 0xff) === checksum;
    let address = 0;
    for (let i = 0; i < ab; i++) address = address * 256 + bytes[i];
    const rec: SRecord = { type, address, data: bytes.slice(ab, count - 1), line, checksum, checksumOk };
    if (!checksumOk) fail(`checksum mismatch (expected ${((~sum) & 0xff).toString(16).toUpperCase().padStart(2, '0')})`);
    out.records.push(rec);
    if (type === 0) {
      out.header = toText(rec.data);
      out.headerAddress = address;
    } else if (type >= 1 && type <= 3) {
      const last = out.blocks[out.blocks.length - 1];
      if (last && last.address + last.data.length === address) {
        const merged = new Uint8Array(last.data.length + rec.data.length);
        merged.set(last.data);
        merged.set(rec.data, last.data.length);
        last.data = merged;
      } else out.blocks.push({ address, data: rec.data.slice() });
    } else if (type === 5 || type === 6) out.recordCount = address;
    else if (type >= 7) out.terminator = { type: type as 7 | 8 | 9, address };
  });
  if (out.recordCount !== undefined) {
    const n = out.records.filter((r) => r.type >= 1 && r.type <= 3).length;
    if (n !== out.recordCount) out.errors.push({ line: 0, message: `S5/S6 count ${out.recordCount} != ${n} data records` });
  }
  return out;
}

/** Sort blocks by address and coalesce adjacent/overlapping ones (later data wins on overlap). */
export function mergeSRecordBlocks(blocks: SRecordBlock[]): SRecordBlock[] {
  const sorted = [...blocks].sort((a, b) => a.address - b.address);
  const out: SRecordBlock[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.address <= last.address + last.data.length) {
      const end = Math.max(last.address + last.data.length, b.address + b.data.length);
      const m = new Uint8Array(end - last.address);
      m.set(last.data);
      m.set(b.data, b.address - last.address);
      last.data = m;
    } else out.push({ address: b.address, data: b.data.slice() });
  }
  return out;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Format one record (type 0..9) with checksum, without line ending. */
export function formatSRecord(type: number, address: number, data: Uint8Array = new Uint8Array(0)): string {
  const ab = ADDR_BYTES[type];
  if (ab === undefined) throw new RangeError(`invalid S-record type S${type}`);
  if (address < 0 || address >= 2 ** (8 * ab)) throw new RangeError(`address 0x${address.toString(16)} does not fit S${type}`);
  const count = ab + data.length + 1;
  if (count > 255) throw new RangeError('S-record too long');
  let s = `S${type}${hex2(count)}`;
  let sum = count;
  for (let i = ab - 1; i >= 0; i--) {
    const b = Math.floor(address / 2 ** (8 * i)) & 0xff;
    s += hex2(b);
    sum += b;
  }
  for (const b of data) {
    s += hex2(b);
    sum += b;
  }
  return s + hex2(~sum & 0xff);
}

export interface SRecordWriteOptions {
  /**
   * S0 text (CodeWarrior: the absolute path of the .abs). Omit for no S0.
   * Text longer than 252 bytes (the S0 record limit) is truncated, keeping the first 252 bytes.
   * UNCERTAIN: CodeWarrior's behaviour for over-long paths is unknown.
   */
  header?: string;
  /** default 0 */
  headerAddress?: number;
  /**
   * 'auto' (Burner `SRECORD=Sx`): S1 if every address fits 16 bits, else S2 if 24 bits, else S3 — chosen once per file.
   * UNCERTAIN: CodeWarrior may choose per record; both fixtures are consistent with per-file.
   */
  recordType?: SRecordDataType | 'auto' | 'Sx';
  /**
   * How 'auto'/'Sx' picks the record type. 'per-file' (default): one type for the whole file, from the highest address.
   * 'per-record': each record gets the smallest type that holds its own address range.
   * UNCERTAIN: which one CodeWarrior's Burner uses for files mixing 16-bit and 24-bit addresses (no golden exists).
   */
  recordTypePolicy?: 'per-file' | 'per-record';
  /** data bytes per record (Burner SLINELEN; default 32) */
  bytesPerRecord?: number;
  /** default '\r\n' */
  eol?: '\r\n' | '\n';
  /**
   * Terminator. Default `{type: 9, address: 0}` — CodeWarrior writes S9030000FC even for S2 files.
   * 'matching' picks S9/S8/S7 to match the data record type.
   */
  terminator?: { type: 7 | 8 | 9; address: number } | 'matching' | 'none';
  /** entry address for a 'matching' terminator (default 0) */
  entry?: number;
  /** sort and coalesce blocks first (default true) */
  merge?: boolean;
  /** emit an S5 count record before the terminator (default false; CodeWarrior does not) */
  countRecord?: boolean;
}

/** Maximum S0 payload: count byte max 255 = 2 address bytes + data + 1 checksum byte. */
export const SRECORD_MAX_HEADER_BYTES = 252;

/** Smallest data record type that holds every byte of [address, address+len). */
export function recordTypeFor(address: number, len: number): SRecordDataType {
  const last = address + Math.max(len, 1) - 1;
  return last <= 0xffff ? 'S1' : last <= 0xffffff ? 'S2' : 'S3';
}

export function chooseSRecordType(blocks: SRecordBlock[]): SRecordDataType {
  let max = 0;
  for (const b of blocks) if (b.data.length) max = Math.max(max, b.address + b.data.length - 1);
  return max <= 0xffff ? 'S1' : max <= 0xffffff ? 'S2' : 'S3';
}

/** Write blocks as S-records the way CodeWarrior's Burner does. */
export function writeSRecords(blocks: SRecordBlock[], opts: SRecordWriteOptions = {}): string {
  const eol = opts.eol ?? '\r\n';
  const per = opts.bytesPerRecord ?? 32;
  if (per < 1 || per > 250) throw new RangeError('bytesPerRecord out of range');
  const bs = (opts.merge ?? true ? mergeSRecordBlocks(blocks) : blocks).filter((b) => b.data.length > 0);
  const auto = !opts.recordType || opts.recordType === 'auto' || opts.recordType === 'Sx';
  const perRecord = auto && opts.recordTypePolicy === 'per-record';
  const rt = auto ? chooseSRecordType(bs) : (opts.recordType as SRecordDataType);
  const typeNum = (t: SRecordDataType) => (t === 'S1' ? 1 : t === 'S2' ? 2 : 3);
  const dtype = typeNum(rt);
  const lines: string[] = [];
  if (opts.header !== undefined) {
    // characters above U+00FF (a path like "Lab 4 – 학생") are written as '?' rather than as their low byte
    const h = latin1BestFitBytes(opts.header).slice(0, SRECORD_MAX_HEADER_BYTES);
    lines.push(formatSRecord(0, opts.headerAddress ?? 0, h));
  }
  let n = 0;
  for (const b of bs) {
    for (let o = 0; o < b.data.length; o += per) {
      const chunk = b.data.subarray(o, Math.min(o + per, b.data.length));
      const t = perRecord ? typeNum(recordTypeFor(b.address + o, chunk.length)) : dtype;
      lines.push(formatSRecord(t, b.address + o, chunk));
      n++;
    }
  }
  if (opts.countRecord) lines.push(n <= 0xffff ? formatSRecord(5, n) : formatSRecord(6, n));
  const term = opts.terminator ?? { type: 9 as const, address: 0 };
  if (term === 'matching') lines.push(formatSRecord(10 - dtype, opts.entry ?? 0));
  else if (term !== 'none') lines.push(formatSRecord(term.type, term.address));
  return lines.map((l) => l + eol).join('');
}

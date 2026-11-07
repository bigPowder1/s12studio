// HIWARE library container (.lib), spec §1.
//
//   0x00 u32 magic FE 82 0A 8C
//   0x04 u32 field4 (0; UNCERTAIN meaning)
//   0x08 u32 field8 (0x10 = strlen(name)? or a version; UNCERTAIN)
//   0x0C 5 NUL-terminated strings: name, user, tool build date, ctime (with "\n"), "" (empty)
//   members: raw ELF objects back to back, no padding
//   directory: lead byte (0x42; UNCERTAIN), varint count, count × {name\0, varint start, varint end}
//   trailer: u32 BE directory size INCLUDING the trailer itself
import { ByteReader, ByteWriter, concatBytes } from '../util/bytes';
import { readHiwareVarint, writeHiwareVarint } from '../util/hiware-varint';
import { readElf } from '../elf/read';
import { writeElf } from '../elf/write';
import type { ElfFile } from '../elf/types';

export const HIWARE_LIB_MAGIC = 0xfe820a8c;

export interface HiwareLibHeader {
  magic: number;
  field4: number;
  field8: number;
  /** Library file name, e.g. "ME305LibV4.0.lib". */
  name: string;
  user: string;
  /** Tool build date, e.g. "Jul 23 2010". */
  toolDate: string;
  /** ctime() string including the trailing "\n". */
  created: string;
  /** Fifth header string (empty in every sample). UNCERTAIN meaning. */
  extra: string;
}

export interface HiwareLibMember {
  name: string;
  /** [start, end) byte offsets in the .lib file. */
  start: number;
  end: number;
  bytes: Uint8Array;
  /** Parsed ELF object, or undefined when `parseMembers: false`. */
  elf?: ElfFile;
}

export interface HiwareLib {
  header: HiwareLibHeader;
  /** Lead byte of the directory (0x42 = 'B' in the sample). */
  directoryLeadByte: number;
  members: HiwareLibMember[];
}

export class HiwareLibError extends Error {}

/**
 * Parse a HIWARE .lib.
 *
 * ALIASING: `member.bytes` and every section `data` of `member.elf` are views into `bytes` (no copies), so
 * mutating a member section (e.g. applyRelocation) also mutates `member.bytes` and the input buffer. Pass
 * `{ copy: true }` to parse a private copy of `bytes` (members still share that copy with each other), or
 * `cloneElf(member.elf)` before editing.
 */
export function readHiwareLib(bytes: Uint8Array, opts: { parseMembers?: boolean; copy?: boolean } = {}): HiwareLib {
  const parseMembers = opts.parseMembers ?? true;
  if (opts.copy) bytes = bytes.slice();
  if (bytes.length < 16) throw new HiwareLibError('file too short for a HIWARE library');
  const r = new ByteReader(bytes);
  const magic = r.u32();
  if (magic !== HIWARE_LIB_MAGIC) throw new HiwareLibError(`bad HIWARE library magic 0x${magic.toString(16)}`);
  const header: HiwareLibHeader = {
    magic,
    field4: r.u32(),
    field8: r.u32(),
    name: r.cstr(),
    user: r.cstr(),
    toolDate: r.cstr(),
    created: r.cstr(),
    extra: r.cstr(),
  };
  const headerEnd = r.pos;

  const dirSize = new ByteReader(bytes, bytes.length - 4).u32();
  if (dirSize < 6 || dirSize > bytes.length - headerEnd) throw new HiwareLibError(`bad directory size 0x${dirSize.toString(16)}`);
  const dirStart = bytes.length - dirSize;
  const d = new ByteReader(bytes.subarray(0, bytes.length - 4), dirStart);
  const directoryLeadByte = d.u8();
  const count = readHiwareVarint(d);
  const members: HiwareLibMember[] = [];
  for (let i = 0; i < count; i++) {
    const name = d.cstr();
    const start = readHiwareVarint(d);
    const end = readHiwareVarint(d);
    if (start < headerEnd || end < start || end > dirStart)
      throw new HiwareLibError(`member ${name} range [0x${start.toString(16)},0x${end.toString(16)}) out of bounds`);
    const mb = bytes.subarray(start, end);
    members.push({ name, start, end, bytes: mb, elf: parseMembers ? readElf(mb) : undefined });
  }
  if (!d.eof) throw new HiwareLibError(`${d.remaining} unparsed directory bytes`);
  return { header, directoryLeadByte, members };
}

/**
 * Inverse of readHiwareLib: header, members back to back (their start/end are recomputed from `bytes`), directory,
 * size trailer.
 *
 * `member.bytes` is AUTHORITATIVE: `member.elf` and `member.start`/`end` are ignored. To persist edits made to a
 * parsed member, first set `member.bytes = writeElf(member.elf)` (or call `syncLibMembers(lib)`).
 */
export function writeHiwareLib(lib: HiwareLib): Uint8Array {
  const h = lib.header;
  const head = new ByteWriter(128)
    .u32(h.magic)
    .u32(h.field4)
    .u32(h.field8)
    .cstr(h.name)
    .cstr(h.user)
    .cstr(h.toolDate)
    .cstr(h.created)
    .cstr(h.extra)
    .finish();
  const dir = new ByteWriter(256).u8(lib.directoryLeadByte);
  writeHiwareVarint(dir, lib.members.length);
  let pos = head.length;
  for (const m of lib.members) {
    dir.cstr(m.name);
    writeHiwareVarint(dir, pos);
    pos += m.bytes.length;
    writeHiwareVarint(dir, pos);
  }
  dir.u32(dir.length + 4);
  return concatBytes([head, ...lib.members.map((m) => m.bytes), dir.finish()]);
}

/** Re-serialize every member that has a parsed `elf` into `bytes` (writeElf). Mutates and returns `lib`. */
export function syncLibMembers(lib: HiwareLib): HiwareLib {
  for (const m of lib.members) if (m.elf) m.bytes = writeElf(m.elf);
  return lib;
}

/** Convenience: a member by name ("Lib_Delay.asm.o"). */
export function findLibMember(lib: HiwareLib, name: string): HiwareLibMember | undefined {
  return lib.members.find((m) => m.name === name);
}

// HIWARE ".note" records (spec §2.5): {u32 namesz, u32 descsz, u32 type, name (namesz bytes, UNPADDED),
// desc (descsz bytes, UNPADDED)}, packed back to back with no 4-byte alignment (readelf misparses them).
import { ByteReader, ByteWriter, bytesToLatin1, latin1ToBytes } from '../util/bytes';

export const HIWARE_NOTE_NAME = 'HIWARE AG';

export const HiwareNoteType = {
  /** Producer string, e.g. "Assembler for HC12 V-5.0.30 Build 10203, Jul 23 2010". */
  Producer: 1,
  /** u32 tool version (0x13A6 = 5030 assembler, 0x13B0 = 5040 linker). */
  Version: 2,
  /** Tool build date string. */
  BuildDate: 3,
  /** 00 35 00 73: 0x35 = EM_68HC12; 0x73 UNCERTAIN. */
  Machine: 4,
  /** User name string. */
  User: 5,
  /** One byte, 0. UNCERTAIN meaning. */
  Unknown6: 6,
  /** ctime() string with trailing "\n". */
  Created: 7,
  /** 'A' = assembler. UNCERTAIN for linker. */
  Tool: 8,
  /** Command line (truncated at ~1024 bytes). */
  CommandLine: 9,
  /** u32 0x42. UNCERTAIN meaning (same value as the .lib directory lead byte). */
  Unknown10: 10,
} as const;

export interface HiwareNote {
  type: number;
  /** Note name without the NUL ("HIWARE AG"). */
  name: string;
  /** Raw descriptor bytes (strings include their NUL terminator). */
  desc: Uint8Array;
}

/** Parse packed HIWARE note records. Any trailing bytes too short for a record header are returned as `tail`. */
export function parseHiwareNotes(data: Uint8Array): { notes: HiwareNote[]; tail: Uint8Array } {
  const r = new ByteReader(data);
  const notes: HiwareNote[] = [];
  while (r.remaining >= 12) {
    const start = r.pos;
    const namesz = r.u32();
    const descsz = r.u32();
    const type = r.u32();
    if (namesz + descsz > r.remaining) {
      r.seek(start);
      break;
    }
    const nameBytes = r.bytesN(namesz);
    const name = bytesToLatin1(nameBytes[namesz - 1] === 0 ? nameBytes.subarray(0, namesz - 1) : nameBytes);
    const desc = r.bytesN(descsz).slice();
    notes.push({ type, name, desc });
  }
  return { notes, tail: data.slice(r.pos) };
}

/** Inverse of parseHiwareNotes. */
export function buildHiwareNotes(notes: readonly HiwareNote[], tail?: Uint8Array): Uint8Array {
  const w = new ByteWriter(1024);
  for (const n of notes) {
    const name = latin1ToBytes(n.name);
    w.u32(name.length + 1).u32(n.desc.length).u32(n.type).bytes(name).u8(0).bytes(n.desc);
  }
  if (tail) w.bytes(tail);
  return w.finish();
}

/** Descriptor helpers. */
export const noteDescString = (desc: Uint8Array): string => {
  const end = desc.indexOf(0);
  return bytesToLatin1(end >= 0 ? desc.subarray(0, end) : desc);
};
export const noteDescU32 = (desc: Uint8Array): number => new ByteReader(desc).u32();
export const stringDesc = (s: string): Uint8Array => new ByteWriter(s.length + 1).cstr(s).finish();
export const u32Desc = (v: number): Uint8Array => new ByteWriter(4).u32(v).finish();

/** Convenience: a note with the standard "HIWARE AG" name. */
export const hiwareNote = (type: number, desc: Uint8Array): HiwareNote => ({ type, name: HIWARE_NOTE_NAME, desc });

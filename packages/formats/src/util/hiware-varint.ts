// HIWARE "inverted" varint used by the .lib directory.
//
// 7-bit groups, least significant first. Continuation bytes have bit 7 CLEAR; the LAST byte has bit 7 SET
// (the opposite of LEB128). Example: 3B 6A 81 = 0x3B | 0x6A<<7 | 0x01<<14 = 0x753B.
//
// Golden evidence for the encoder's length choice: 0x4D is stored as `4D 80` (two bytes) while 8 is stored as `88`
// (one byte), and 0x753B as `3B 6A 81`. That matches a *signed* encoding where the final group's bit 6 is the sign
// bit (like SLEB128 with inverted terminator): a value is terminated only once the remainder fits in 6 bits.
// UNCERTAIN: negative values never occur in the fixtures; the decoder sign-extends from bit 6 of the final byte
// only when `signed` is requested.

import { ByteReader, ByteWriter } from './bytes';

export function readHiwareVarint(r: ByteReader, signed = false): number {
  let v = 0;
  let mul = 1;
  for (;;) {
    const b = r.u8();
    v += (b & 0x7f) * mul;
    mul *= 128;
    if (b & 0x80) {
      if (signed && b & 0x40) v -= mul;
      return v;
    }
  }
}

export function writeHiwareVarint(w: ByteWriter, v: number): ByteWriter {
  if (!Number.isInteger(v)) throw new RangeError(`varint of non-integer ${v}`);
  // Emit 7-bit groups while the remainder does not fit a signed 7-bit final group.
  while (v >= 0x40 || v < -0x40) {
    w.u8(((v % 128) + 128) % 128);
    v = Math.floor(v / 128);
  }
  return w.u8(0x80 | (((v % 128) + 128) % 128));
}

export function encodeHiwareVarint(v: number): Uint8Array {
  return writeHiwareVarint(new ByteWriter(8), v).finish();
}

export function decodeHiwareVarint(bytes: Uint8Array, signed = false): { value: number; length: number } {
  const r = new ByteReader(bytes);
  const value = readHiwareVarint(r, signed);
  return { value, length: r.pos };
}

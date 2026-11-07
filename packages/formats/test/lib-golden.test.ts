import { describe, it, expect } from 'vitest';
import { ByteReader, ByteWriter, readHiwareVarint, writeHiwareVarint, encodeHiwareVarint, decodeHiwareVarint } from '../src/index';

// The golden checks on the ME305 library container itself (header, members, round trip) are private:
// s12studio-fixtures tests/formats/lib-golden.test.ts.

describe('HIWARE varint', () => {
  it('decodes the documented example 3B 6A 81 = 0x753B', () => {
    expect(decodeHiwareVarint(Uint8Array.from([0x3b, 0x6a, 0x81]))).toEqual({ value: 0x753b, length: 3 });
  });
  it('encodes with CW length choice (0x4D → 4D 80, 8 → 88, 0x20B1F → 1F 16 88)', () => {
    expect(Array.from(encodeHiwareVarint(0x4d))).toEqual([0x4d, 0x80]);
    expect(Array.from(encodeHiwareVarint(8))).toEqual([0x88]);
    expect(Array.from(encodeHiwareVarint(0x3f))).toEqual([0xbf]);
    expect(Array.from(encodeHiwareVarint(0x753b))).toEqual([0x3b, 0x6a, 0x81]);
    expect(Array.from(encodeHiwareVarint(0x20b1f))).toEqual([0x1f, 0x16, 0x88]);
  });
  it('round-trips a range of values (incl. signed)', () => {
    for (const v of [0, 1, 63, 64, 127, 128, 8191, 8192, 0x12345, 0x7fffffff, -1, -64, -65, -1000]) {
      const w = new ByteWriter();
      writeHiwareVarint(w, v);
      expect(readHiwareVarint(new ByteReader(w.finish()), v < 0)).toBe(v);
    }
  });
});

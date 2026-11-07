import { describe, expect, it } from 'vitest';
import { MEM_OK, MEM_UNMAPPED, type MemoryRange } from '../../../shared/api';
import { createMockS12 } from '../../common/testing/mockS12';
import { CHUNK, copyMemory, indexOfPattern, parsePattern, searchMemory } from './memtools';

describe('memtools', () => {
  it('parses search patterns', () => {
    expect(parsePattern('A5 5A')).toEqual([0xa5, 0x5a]);
    expect(parsePattern('a55a')).toEqual([0xa5, 0x5a]);
    expect(parsePattern('$41,0x42')).toEqual([0x41, 0x42]);
    expect(parsePattern('"Hi"')).toEqual([0x48, 0x69]);
    expect(parsePattern('65 66', false)).toEqual([65, 66]);
    expect(parsePattern('256', false)).toBeNull();
    expect(parsePattern('G1')).toBeNull();
    expect(parsePattern('')).toBeNull();
  });

  it('finds a pattern, skipping unmapped bytes', () => {
    const bytes = [1, 2, 3, 1, 2, 3];
    expect(indexOfPattern(bytes, [0, 0, 0, 0, 0, 0], [2, 3])).toBe(1);
    expect(indexOfPattern(bytes, [0, MEM_UNMAPPED, 0, 0, 0, 0], [2, 3])).toBe(4);
    expect(indexOfPattern(bytes, [0, 0, 0, 0, 0, 0], [2, 3], 2)).toBe(4);
  });

  it('searches across chunk boundaries and copies mapped runs', async () => {
    const mem = new Uint8Array(0x10000);
    const st = new Uint8Array(0x10000).fill(MEM_OK);
    mem.set([0xde, 0xad], CHUNK - 1); // straddles the first chunk boundary
    st[0x3002] = MEM_UNMAPPED;
    const m = createMockS12({
      debug: { readMemory: async (r: MemoryRange) => ({ address: r.address, space: 'local' as const, bytes: mem.slice(r.address, r.address + r.length), status: st.slice(r.address, r.address + r.length) }) },
    });
    expect(await searchMemory(m.api, 0, 0xffff, [0xde, 0xad])).toBe(CHUNK - 1);
    expect(await searchMemory(m.api, CHUNK, 0xffff, [0xde, 0xad])).toBeNull();
    mem.set([1, 2, 3, 4, 5], 0x3000);
    await copyMemory(m.api, 0x3000, 0x3004, 0x4000);
    expect(m.calls('debug', 'writeMemory')).toEqual([
      [0x4000, [1, 2], 'local'],
      [0x4003, [4, 5], 'local'],
    ]);
  });
});

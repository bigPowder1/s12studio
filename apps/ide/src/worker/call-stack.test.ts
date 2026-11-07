import { describe, expect, it } from 'vitest';
import { callBefore, unwindStack } from './call-stack';

/** 64 KiB memory image. */
function mem(writes: [number, number[]][]): (a: number) => number {
  const m = new Uint8Array(0x10000);
  for (const [a, bytes] of writes) m.set(bytes, a);
  return (a) => m[a & 0xffff];
}

describe('call-stack heuristic (Procedure component)', () => {
  it('recognises JSR ext / BSR / JSR idx call sites before a return address', () => {
    const read = mem([
      [0xc000, [0x16, 0xc1, 0x00]], // JSR $C100 -> returns to $C003
      [0xc010, [0x07, 0x10]], // BSR -> returns to $C012
      [0xc020, [0x15, 0x00]], // JSR 0,X -> returns to $C022
      [0xc030, [0x86, 0x01]], // LDAA #1 (not a call)
    ]);
    expect(callBefore(read, 0xc003)).toBe(0xc000);
    expect(callBefore(read, 0xc012)).toBe(0xc010);
    expect(callBefore(read, 0xc022)).toBe(0xc020);
    expect(callBefore(read, 0xc032)).toBeUndefined();
  });

  it('walks the stack: nested calls, skipping pushed data', () => {
    const read = mem([
      [0xc000, [0x16, 0xc1, 0x00]], // main: JSR sub1 (ret $C003)
      [0xc100, [0x34, 0x16, 0xc2, 0x00]], // sub1: PSHX ; JSR sub2 (ret $C104)
      // stack (SP = $3FF8): ret $C104, pushed X = $1234, ret $C003
      [0x3ff8, [0xc1, 0x04, 0x12, 0x34, 0xc0, 0x03]],
    ]);
    const f = unwindStack(read, 0xc200, 0x3ff8);
    expect(f.map((x) => x.pc)).toEqual([0xc200, 0xc101, 0xc000]);
    expect(f[1]).toMatchObject({ level: 1, returnAddress: 0xc104, stackAddress: 0x3ff8 });
    expect(f[2]).toMatchObject({ level: 2, returnAddress: 0xc003, stackAddress: 0x3ffc });
  });

  it('respects stackTop, maxFrames and isCode', () => {
    const read = mem([
      [0xc000, [0x16, 0xc1, 0x00]],
      [0x2000, [0xc0, 0x03, 0xc0, 0x03, 0xc0, 0x03]],
    ]);
    expect(unwindStack(read, 0xc100, 0x2000, { stackTop: 0x2002 })).toHaveLength(2);
    expect(unwindStack(read, 0xc100, 0x2000, { maxFrames: 2 })).toHaveLength(2);
    expect(unwindStack(read, 0xc100, 0x2000, { isCode: () => false })).toHaveLength(1);
  });
});

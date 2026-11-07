// Pins the behaviour of the two line-program fallback paths that no CodeWarrior fixture exercises
// (marked UNCERTAIN in src/dwarf/cw.ts). If CW evidence appears, update cw.ts and this test together.
import { describe, it, expect } from 'vitest';
import { newCwCompileUnit, encodeCwCompileUnit, parseLineProgram } from '../src/index';

describe('CW line program: unobserved fallback paths (UNCERTAIN)', () => {
  const cu = newCwCompileUnit('t.dbg', 'C:\\x', 'C:\\x\\bin\\t.dbg');
  cu.sequences = [
    {
      start: { value: 0x4000 },
      rows: [
        { address: 0x4000, line: 10 }, // observed shape: line step > 3 → advance_line, copy
        { address: 0x4064, line: 11 }, // (a1) line step 1, addr step 100 > 61 → advance_line, advance_pc, copy
        { address: 0x40c8, line: 11 }, // (a0) line step 0, addr step 100 → advance_pc, copy (no advance_line)
        { address: 0x40c8, line: 5 }, // (b) negative line step → advance_line(-6), copy
        { address: 0x40ca, line: 6 }, // special opcode
      ],
      end: 0x40ca,
    },
  ];
  const { line } = encodeCwCompileUnit(cu);
  const prog = parseLineProgram(line);
  it('decodes back to the same rows', () => {
    expect(prog.rows.filter((r) => !r.endSequence).map((r) => [r.address, r.line])).toEqual([
      [0x4000, 10],
      [0x4064, 11],
      [0x40c8, 11],
      [0x40c8, 5],
      [0x40ca, 6],
    ]);
    expect(prog.rows.at(-1)).toMatchObject({ address: 0x40ca, endSequence: true });
  });
  it('(a1) advance_line+advance_pc, (a0) advance_pc only, (b) negative advance_line', () => {
    const std = prog.ops.filter((o) => o.opcode !== 0).map((o) => (o.opcode >= 10 ? 'special' : [o.opcode, o.operand]));
    expect(std).toEqual([
      [3, 9], [1, undefined],
      [3, 1], [2, 100], [1, undefined],
      [2, 100], [1, undefined],
      [3, -6], [1, undefined],
      'special',
    ]);
  });
});

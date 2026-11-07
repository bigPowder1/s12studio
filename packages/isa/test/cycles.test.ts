import { describe, expect, it } from 'vitest';
import {
  accessCycles,
  branchCycles,
  decode,
  formCycles,
  formsAt,
  formsByMnemonic,
  loopedCycles,
  parseAccess,
} from '../src/index.js';
import { normOperands } from './helpers.js';

const cyc = (bytes: number[], cpu: 'cpu12' | 's12x' = 's12x') => {
  const i = decode((a) => bytes[a] ?? 0, 0, { cpu });
  return i.cyclesNotTaken !== undefined ? [i.cycles, i.cyclesNotTaken] : i.cycles;
};

describe('access strings', () => {
  it('parses letters, ignores commas, separates loops', () => {
    expect(accessCycles('OVSPSSPSsP')).toBe(10);
    expect(accessCycles('uUUUUfVfPPP')).toBe(11);
    expect(accessCycles('ORROfffRRfWWP')).toBe(13);
    expect(parseAccess('Orf(t,tx)O')).toEqual({ text: 'Orf(t,tx)O', cycles: 4, loop: 't,tx', loopCycles: 3 });
    expect(parseAccess('Of(frr,ffff)O')).toMatchObject({ cycles: 3, loopCycles: 7 });
  });
});

describe('per-form cycles (HCS12 column unless CPU12X-specific)', () => {
  it('indexed variants of a read (LDAA): 3/3/4/6/6', () => {
    expect(cyc([0xa6, 0x00])).toBe(3); // 0,X
    expect(cyc([0xa6, 0x31])).toBe(3); // 2,X+
    expect(cyc([0xa6, 0xe4])).toBe(3); // A,X
    expect(cyc([0xa6, 0xe0, 0x20])).toBe(3); // IDX1
    expect(cyc([0xa6, 0xe2, 0x01, 0x00])).toBe(4); // IDX2
    expect(cyc([0xa6, 0xe7])).toBe(6); // [D,X]
    expect(cyc([0xa6, 0xe3, 0x01, 0x00])).toBe(6); // [n16,X]
    expect(cyc([0x86, 0x00])).toBe(1);
    expect(cyc([0xcc, 0x00, 0x00])).toBe(2);
  });

  it('stores, RMW, jumps, calls', () => {
    expect(cyc([0x6a, 0x00])).toBe(2);
    expect(cyc([0x6a, 0xe7])).toBe(4);
    expect(cyc([0x7a, 0x12, 0x34])).toBe(3);
    expect(cyc([0x72, 0x12, 0x34])).toBe(4); // INC ext
    expect(cyc([0x62, 0xe2, 0, 0])).toBe(5); // INC IDX2
    expect(cyc([0x16, 0x12, 0x34])).toBe(4);
    expect(cyc([0x05, 0xe7])).toBe(6);
    expect(cyc([0x4a, 0x80, 0x00, 0x30])).toBe(7);
    expect(cyc([0x4b, 0xe2, 0, 0, 0x30])).toBe(8);
    expect(cyc([0x4b, 0xe7])).toBe(10);
    expect(cyc([0x3d])).toBe(5);
    expect(cyc([0x0a])).toBe(7);
    expect(cyc([0x12])).toBe(1); // MUL, HCS12
    expect(cyc([0x11])).toBe(11);
    expect(cyc([0x18, 0x10])).toBe(12);
    expect(cyc([0x18, 0x3d, 0x00])).toBe(6); // TBL
    expect(cyc([0x18, 0x3f, 0x00])).toBe(10); // ETBL
    expect(cyc([0x18, 0x12, 0, 0])).toBe(13); // EMACS
    expect(cyc([0xb7, 0x01])).toBe(1);
    expect(cyc([0x36])).toBe(2);
    expect(cyc([0x3a])).toBe(3);
    expect(cyc([0x18, 0x30])).toBe(10); // TRAP
    expect(cyc([0x0b])).toBe(8); // RTI
  });

  it('branches: taken / not taken', () => {
    expect(cyc([0x20, 0x00])).toBe(3);
    expect(cyc([0x21, 0x00])).toBe(1);
    expect(cyc([0x26, 0x00])).toEqual([3, 1]);
    expect(cyc([0x18, 0x27, 0, 0])).toEqual([4, 3]);
    expect(cyc([0x18, 0x20, 0, 0])).toBe(4);
    expect(cyc([0x04, 0x35, 0xfd])).toEqual([3, 3]);
    expect(cyc([0x4f, 0x4e, 0x02, 0xfc])).toBe(4);
    expect(cyc([0x1f, 0x00, 0x4e, 0x02, 0xfc])).toBe(5);
    expect(cyc([0x0f, 0xe2, 0, 0, 0x02, 0xfc])).toBe(6);
    const bne = formsAt('s12x', 0, 0x26)[0];
    expect(branchCycles(bne)).toEqual({ taken: 3, notTaken: 1 });
  });

  it('moves: CPU12 table values and CPU12X extended-index extras (UNCERTAIN)', () => {
    expect(cyc([0x18, 0x0b, 0x01, 0x12, 0x34])).toBe(4);
    expect(cyc([0x18, 0x08, 0x00, 0x01])).toBe(4);
    expect(cyc([0x18, 0x0c, 0, 0, 0, 0])).toBe(6);
    expect(cyc([0x18, 0x0d, 0xe4, 0x10, 0x01])).toBe(5);
    expect(cyc([0x18, 0x03, 0, 0, 0, 0])).toBe(5);
    expect(cyc([0x18, 0x04, 0, 0, 0, 0])).toBe(6);
    expect(cyc([0x18, 0x00, 0x00, 0, 0])).toBe(4);
    expect(cyc([0x18, 0x08, 0xe0, 0xc8, 0x12])).toBe(5); // IDX1 destination: +1
    expect(cyc([0x18, 0x0a, 0xeb, 0x12, 0x34, 0xe3, 0x43, 0x21])).toBe(5 + 3 + 2);
  });

  it('CPU12X page-2 instructions', () => {
    expect(cyc([0x18, 0x73, 0x12, 0x34])).toBe(5); // DECW ext ORPWO
    expect(cyc([0x18, 0x63, 0x00])).toBe(4);
    expect(cyc([0x18, 0x63, 0xe2, 0, 0])).toBe(6);
    expect(cyc([0x18, 0x63, 0xe7])).toBe(7);
    expect(cyc([0x18, 0x8b, 0, 0])).toBe(3); // ADDX # OPO
    expect(cyc([0x18, 0x9b, 0])).toBe(4);
    expect(cyc([0x18, 0xab, 0xe2, 0, 0])).toBe(5);
    expect(cyc([0x18, 0xab, 0xe3, 0, 0])).toBe(7);
    expect(cyc([0x18, 0x96, 0x00])).toBe(4); // GLDAA dir OrPf
    expect(cyc([0x18, 0xb6, 0, 0])).toBe(4);
    expect(cyc([0x18, 0xa6, 0xe7])).toBe(7);
  });

  it('alt strings and loops', () => {
    const rti = formsByMnemonic('RTI')[0];
    expect(formCycles(rti)).toBe(8);
    expect(formCycles(rti, { alt: true })).toBe(10); // default cpu: s12x (UNCERTAIN CPU12X string)
    // review finding 1: HCS12 RTI with another interrupt pending is 11 (uUUUUfVfPPP)
    expect(formCycles(rti, { alt: true, cpu: 'cpu12' })).toBe(11);
    expect(formCycles(rti, { cpu: 'cpu12' })).toBe(8);
    expect(cyc([0x0b], 'cpu12')).toBe(8);
    expect(formCycles(formsByMnemonic('SWI')[0], { cpu: 'cpu12' })).toBe(9);
    expect(formCycles(formsByMnemonic('SWI')[0], { cpu: 's12x' })).toBe(9);
    expect(cyc([0x18, 0x30], 'cpu12')).toBe(10); // TRAP HCS12 OVSPSSPSsP
    expect(cyc([0x18, 0x30], 's12x')).toBe(10); // TRAP HCS12X OVSPSSPSSP
    expect(formCycles(formsByMnemonic('WAI')[0], { cpu: 'cpu12', alt: true })).toBe(6);
    const stop = formsByMnemonic('STOP')[0];
    expect(formCycles(stop)).toBe(8);
    expect(formCycles(stop, { alt: true })).toBe(2);
    expect(loopedCycles(formsByMnemonic('WAV')[0], 4)).toBe(3 + 7 * 4);
    expect(loopedCycles(formsByMnemonic('REV')[0], 2)).toBe(4 + 3 * 2);
    // review finding 4: weighted REVW - separators cost 5 ((r,RfRf)) instead of 3 ((t,Tx))
    const revw = formsByMnemonic('REVW')[0];
    expect(loopedCycles(revw, 10)).toBe(4 + 3 * 10);
    expect(loopedCycles(revw, 10, { weightedSeparators: 4 })).toBe(4 + 3 * 6 + 5 * 4);
    expect(loopedCycles(formsByMnemonic('REV')[0], 10, { weightedSeparators: 4 })).toBe(4 + 3 * 10);
    expect(() => loopedCycles(revw, 2, { weightedSeparators: 3 })).toThrow(RangeError);
  });
});

describe('test helper', () => {
  it('normOperands normalises numbers and spacing', () => {
    expect(normOperands('#$0A, 9,X')).toBe('#10,9,X');
    expect(normOperands('-$064,Y, >$0001')).toBe('-100,Y,1');
    expect(normOperands('[0x1234,SP]')).toBe('[4660,SP]');
    expect(normOperands('#10,9,X')).not.toBe(normOperands('#11,9,X'));
  });
});

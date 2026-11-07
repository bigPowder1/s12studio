import { describe, expect, it } from 'vitest';
import {
  decodeIndexed,
  decodeLoop,
  decodeTfrExg,
  encodeIndexed,
  encodeLoop,
  encodeTfrExg,
  formatIndexed,
  indexedClass,
  indexedEA,
  indexedExtBytes,
  loopOffset,
  xferCcr,
  xferWritesIpl,
  reencodeIndexed,
  smallestOffsetKind,
} from '../src/index.js';

describe('indexed postbyte', () => {
  it('exhaustive round trip: all 256 postbytes (with varied extension bytes) decode -> encode identically', () => {
    for (let xb = 0; xb < 256; xb++) {
      const n = indexedExtBytes(xb);
      const exts = n === 0 ? [[]] : n === 1 ? [[0x00], [0x7f], [0x80], [0xff]] : [[0, 0], [0x12, 0x34], [0xff, 0xfe], [0x80, 0x00]];
      for (const ext of exts) {
        const op = decodeIndexed(xb, ext);
        expect(op.postbyte).toBe(xb);
        expect(op.extBytes).toBe(n);
        expect(reencodeIndexed(op), `xb=${xb.toString(16)} ext=${ext}`).toEqual([xb, ...ext]);
      }
    }
  });

  it('extension byte counts and classes', () => {
    const counts = [0, 0, 0, 0, 0];
    for (let xb = 0; xb < 256; xb++) counts[['IDX', 'IDX1', 'IDX2', '[D,IDX]', '[IDX2]'].indexOf(indexedClass(xb))]++;
    // 5-bit: 128 (X/Y/SP/PC x 32); auto: 96 (X/Y/SP x 32); A/B/D,r: 12 => IDX 236
    expect(counts).toEqual([236, 8, 4, 4, 4]);
    expect(indexedExtBytes(0xe0)).toBe(1);
    expect(indexedExtBytes(0xe1)).toBe(1);
    expect(indexedExtBytes(0xe2)).toBe(2);
    expect(indexedExtBytes(0xe3)).toBe(2);
    expect(indexedExtBytes(0xe7)).toBe(0);
    expect(indexedExtBytes(0xdf)).toBe(0);
  });

  it('CPU12RM worked encodings (isa.md 2.2)', () => {
    const enc = (kind: Parameters<typeof encodeIndexed>[0]['kind'], reg: 'X' | 'Y' | 'SP' | 'PC', offset?: number) =>
      encodeIndexed({ kind, reg, offset });
    expect(enc('pre', 'SP', -1)).toEqual([0xaf]);
    expect(enc('pre', 'SP', -2)).toEqual([0xae]);
    expect(enc('post', 'SP', 1)).toEqual([0xb0]);
    expect(enc('post', 'SP', 2)).toEqual([0xb1]);
    expect(enc('post', 'X', 1)).toEqual([0x30]);
    expect(enc('pre', 'X', 1)).toEqual([0x20]);
    expect(enc('post', 'X', -1)).toEqual([0x3f]);
    expect(enc('post', 'X', 8)).toEqual([0x37]);
    expect(enc('post', 'X', -8)).toEqual([0x38]);
    expect(enc('n9', 'X', 0xff)).toEqual([0xe0, 0xff]);
    expect(enc('n9', 'Y', -20)).toEqual([0xe9, 0xec]);
    expect(enc('n5', 'X', 0)).toEqual([0x00]);
    expect(encodeIndexed({ kind: 'acc', reg: 'X', acc: 'B' })).toEqual([0xe5]);
    expect(encodeIndexed({ kind: 'acc', reg: 'X', acc: 'A' })).toEqual([0xe4]);
    expect(encodeIndexed({ kind: 'indD', reg: 'Y' })).toEqual([0xef]);
    expect(enc('ind16', 'SP', 0x1234)).toEqual([0xf3, 0x12, 0x34]);
    expect(enc('n16', 'PC', -2)).toEqual([0xfa, 0xff, 0xfe]);
    expect(() => enc('post', 'PC', 1)).toThrow(RangeError);
    expect(() => enc('n5', 'X', 16)).toThrow(RangeError);
    expect(() => enc('pre', 'X', 0)).toThrow(RangeError);
    expect(smallestOffsetKind(-16)).toBe('n5');
    expect(smallestOffsetKind(16)).toBe('n9');
    expect(smallestOffsetKind(-257)).toBe('n16');
  });

  it('formatting', () => {
    const f = (xb: number, ...ext: number[]) => formatIndexed(decodeIndexed(xb, ext));
    expect(f(0x00)).toBe('0,X');
    expect(f(0x1f)).toBe('-1,X');
    expect(f(0xaf)).toBe('1,-SP');
    expect(f(0xb0)).toBe('1,SP+');
    expect(f(0x20)).toBe('1,+X');
    expect(f(0x3f)).toBe('1,X-');
    expect(f(0xe9, 0xec)).toBe('-0x14,Y');
    expect(f(0xe0, 0xff)).toBe('0xFF,X');
    expect(f(0xf2, 0x12, 0x34)).toBe('0x1234,SP');
    expect(f(0xeb, 0x12, 0x34)).toBe('[0x1234,Y]');
    expect(f(0xe4)).toBe('A,X');
    expect(f(0xfe)).toBe('D,PC');
    expect(f(0xe7)).toBe('[D,X]');
    expect(formatIndexed(decodeIndexed(0xe9, [0xec]), { hex: '$' })).toBe('-$14,Y');
  });

  it('effective addresses (pre/post modify, accumulator offsets, PC-relative)', () => {
    const regs = { X: 0x1000, Y: 0x2000, SP: 0x3000, A: 0x80, B: 0x01 };
    expect(indexedEA(decodeIndexed(0xaf), regs, 0)).toEqual({
      address: 0x2fff,
      indirect: false,
      writeback: { reg: 'SP', value: 0x2fff },
    });
    expect(indexedEA(decodeIndexed(0x31), regs, 0)).toEqual({
      address: 0x1000,
      indirect: false,
      writeback: { reg: 'X', value: 0x1002 },
    });
    expect(indexedEA(decodeIndexed(0xe4), regs, 0).address).toBe(0x1080); // A unsigned
    expect(indexedEA(decodeIndexed(0xe6), regs, 0).address).toBe(0x1000 + 0x8001);
    expect(indexedEA(decodeIndexed(0xc2), regs, 0x4005).address).toBe(0x4007);
    expect(indexedEA(decodeIndexed(0xe7), regs, 0)).toMatchObject({ address: 0x9001, indirect: true });
  });
});

describe('TFR/EXG/SEX postbyte', () => {
  it('CPU12 decode follows Table A-5 (bit 3 is don\'t-care)', () => {
    expect(decodeTfrExg(0x01, 'cpu12')).toMatchObject({ op: 'TFR', src: 'A', dst: 'B' });
    expect(decodeTfrExg(0x04, 'cpu12')).toMatchObject({ op: 'SEX', src: 'A', dst: 'D' });
    expect(decodeTfrExg(0x15, 'cpu12')).toMatchObject({ op: 'SEX', src: 'B', dst: 'X' });
    expect(decodeTfrExg(0x75, 'cpu12')).toMatchObject({ op: 'TFR', src: 'SP', dst: 'X' });
    expect(decodeTfrExg(0xc5, 'cpu12')).toMatchObject({ op: 'EXG', src: 'D', dst: 'X' });
    expect(decodeTfrExg(0x33, 'cpu12')).toMatchObject({ op: 'TFR', src: 'TMP3', dst: 'TMP2', reserved: true });
    expect(decodeTfrExg(0x4d, 'cpu12')).toMatchObject({ op: 'TFR', src: 'D', dst: 'X', s12x: false });
  });

  it('CPU12X extended encodings', () => {
    expect(decodeTfrExg(0x4d)).toMatchObject({ op: 'SEX', src: 'D', dst: 'X', s12x: true });
    expect(decodeTfrExg(0x2c)).toMatchObject({ op: 'TFR', src: 'CCRW', dst: 'D' });
    expect(decodeTfrExg(0x0a)).toMatchObject({ op: 'TFR', src: 'A', dst: 'CCRH' });
    expect(decodeTfrExg(0xaa)).toMatchObject({ op: 'EXG', src: 'CCRW', dst: 'CCRW' });
    expect(decodeTfrExg(0xd9)).toMatchObject({ op: 'EXG', src: 'XL', dst: 'B' });
    // not in the extended table -> bit 3 ignored (libasm: EXG X,D for $DC, TFR B,CCR for $1A)
    expect(decodeTfrExg(0xdc)).toMatchObject({ op: 'EXG', src: 'X', dst: 'D', s12x: false });
    expect(decodeTfrExg(0x1a)).toMatchObject({ op: 'TFR', src: 'B', dst: 'CCR' });
    expect(decodeTfrExg(0x0c)).toMatchObject({ op: 'SEX', src: 'A', dst: 'D' });
  });

  it('encode/decode round trip over all postbytes', () => {
    for (const cpu of ['cpu12', 's12x'] as const) {
      for (let eb = 0; eb < 256; eb++) {
        const d = decodeTfrExg(eb, cpu);
        const back = encodeTfrExg(d.op, d.src, d.dst, cpu);
        expect(back, `${cpu} ${eb.toString(16)}`).toBeDefined();
        expect(decodeTfrExg(back!, cpu), `${cpu} ${eb.toString(16)}`).toMatchObject({ op: d.op, src: d.src, dst: d.dst });
      }
    }
    expect(encodeTfrExg('TFR', 'A', 'X')).toBe(0x05);
    expect(encodeTfrExg('tfr', 'ccrw', 'd')).toBe(0x2c);
    expect(encodeTfrExg('TFR', 'CCRW', 'D', 'cpu12')).toBeUndefined();
    expect(encodeTfrExg('SEX', 'D', 'Y')).toBe(0x4e);
  });
});

describe('TFR/EXG CCR effect (review finding 3)', () => {
  it('xferCcr reports CCR writes', () => {
    expect(xferCcr(0x02)).toBe('WvWWWWWW'); // TFR A,CCR (TAP)
    expect(xferCcr(0x20)).toBe('--------'); // TFR CCR,A (TPA)
    expect(xferCcr(0x42, 'cpu12')).toBe('WvWWWWWW'); // TFR D,CCR
    expect(xferCcr(0x4a)).toBe('WvWWWWWW'); // TFR D,CCRW
    expect(xferCcr(0x4a, 'cpu12')).toBe('WvWWWWWW'); // CPU12: bit 3 ignored -> TFR D,CCR
    expect(xferCcr(0xd2)).toBe('WvWWWWWW'); // EXG X,CCR
    expect(xferCcr(0xa1)).toBe('WvWWWWWW'); // EXG CCR,B: CCR on the source side is written too
    expect(xferCcr(0x2c)).toBe('--------'); // TFR CCRW,D
    expect(xferCcr(0xac)).toBe('WvWWWWWW'); // EXG CCRW,D
    expect(xferCcr(0x0a)).toBe('--------'); // TFR A,CCRH: IPL only, flags unchanged
    expect(xferCcr(0x01)).toBe('--------');
    expect(xferWritesIpl(0x0a)).toBe(true);
    expect(xferWritesIpl(0x4a)).toBe(true);
    expect(xferWritesIpl(0x02)).toBe(false);
    expect(xferWritesIpl(0x4a, 'cpu12')).toBe(false);
  });
});

describe('loop primitive postbyte', () => {
  it('decode/encode', () => {
    expect(decodeLoop(0x35)).toEqual({ op: 'DBNE', reg: 'X', negative: true, valid: true, dontCare: false });
    expect(decodeLoop(0x00)).toEqual({ op: 'DBEQ', reg: 'A', negative: false, valid: true, dontCare: false });
    // review finding 5: bit 3 is don't-care (CPU12RM Table A-6) - decoded, but flagged
    expect(decodeLoop(0x3d)).toEqual({ op: 'DBNE', reg: 'X', negative: true, valid: true, dontCare: true });
    expect(decodeLoop(0xc0).valid).toBe(false);
    expect(decodeLoop(0x02).valid).toBe(false);
    expect(encodeLoop('DBNE', 'X', -3)).toEqual([0x35, 0xfd]); // DBNE X,* = 04 35 FD
    expect(encodeLoop('dbeq', 'a', 5)).toEqual([0x00, 0x05]);
    expect(encodeLoop('IBNE', 'SP', -256)).toEqual([0xb7, 0x00]);
    expect(loopOffset(0x35, 0xf4)).toBe(-12);
    expect(loopOffset(0x25, 0xf4)).toBe(0xf4);
    for (let lb = 0; lb < 256; lb++) {
      const d = decodeLoop(lb);
      if (!d.valid || lb & 0x08) continue;
      const [l2] = encodeLoop(d.op!, d.reg!, d.negative ? -1 : 1);
      expect(l2).toBe(lb);
    }
  });
});

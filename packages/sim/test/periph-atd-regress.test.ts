// Regression tests for review findings on atd.ts (FIFO skip-ahead, sync on accessors, analog trigger, special channels).
import { describe, expect, it } from 'vitest';
import { S12XSystem, createBoardNets, type BoardNets } from '@s12/sim';
import { ATD_BASES, ATD_RANGES, AtdModule, type AtdOptions } from '../src/periph/atd';

interface Rig {
  s: S12XSystem;
  nets: BoardNets;
  atd: AtdModule;
  base: number;
}

function rig(opts: AtdOptions = {}): Rig {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  const atd = new AtdModule(nets, opts);
  s.addPeripheral(atd, [ATD_RANGES[opts.index ?? 1]]);
  s.reset();
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  return { s, nets, atd, base: ATD_BASES[opts.index ?? 1] };
}

const rd = (s: S12XSystem, a: number, t: number) => s.bus.regRead(a, t);
const wr = (s: S12XSystem, a: number, v: number, t: number) => s.bus.regWrite(a, v, t);
const pad = (n: number) => `PAD${String(n).padStart(2, '0')}`;

describe('ATD long-SCAN skip-ahead matches stepping (FIFO and normal)', () => {
  const cases: Array<[number, number, number, string]> = [
    // [index, CTL3, CTL5, label]
    [1, (3 << 3) | 4, 0xb0, 'ATD1 FIFO len3 MULT'],
    [1, (5 << 3) | 4, 0xa0, 'ATD1 FIFO len5 single channel'],
    [1, (7 << 3) | 4, 0xb2, 'ATD1 FIFO len7 MULT from AN2'],
    [1, (1 << 3) | 4, 0xb0, 'ATD1 FIFO len1 MULT'],
    [1, 3 << 3, 0xb0, 'ATD1 normal len3 MULT'],
    [0, (3 << 3) | 4, 0xb0, 'ATD0 FIFO len3 MULT'],
    [0, (6 << 3) | 4, 0xb1, 'ATD0 FIFO len6 MULT from AN1'],
  ];
  for (const [index, ctl3, ctl5, label] of cases) {
    it(label, () => {
      const a = rig({ index: index as 0 | 1 });
      const b = rig({ index: index as 0 | 1 });
      const first = index === 0 ? 0 : 8;
      const n = index === 0 ? 8 : 16;
      for (const r of [a, b]) {
        for (let i = 0; i < n; i++) r.nets.analog.set(pad(first + i), (c) => ((c * (i + 1)) % 997) / 200);
        wr(r.s, r.base + 2, 0x80, 0);
        wr(r.s, r.base + 3, ctl3, 0);
        wr(r.s, r.base + 5, ctl5, 0);
      }
      const T = 2_000_003;
      for (let t = 50; t <= T; t += 50) rd(b.s, b.base + 6, t);
      rd(a.s, a.base + 6, T);
      const pa = a.atd.snapshot();
      const pb = b.atd.snapshot();
      expect({ dr: pa.dr, ccf: pa.ccf, fifor: pa.fifor, cc: pa.cc, nd: pa.nextDone, ci: pa.convIdx }).toEqual({
        dr: pb.dr,
        ccf: pb.ccf,
        fifor: pb.fifor,
        cc: pb.cc,
        nd: pb.nextDone,
        ci: pb.convIdx,
      });
      // FIFO: every register was really written (no zero left over from before the jump).
      if (ctl3 & 4) expect(pa.dr.slice(0, n).every((v) => v !== 0)).toBe(true);
    });
  }
});

describe('ATD accessors sync to the CPU time', () => {
  it('busy and result() reflect conversions completed while the CPU ran', () => {
    const { s, nets, atd, base } = rig();
    nets.analog.set('PAD08', 2.5);
    wr(s, base + 2, 0x80, 0);
    wr(s, base + 5, 0x80, 0); // DJM, single channel AN0, length 0000 = 16
    s.poke(0x3000, 0x20);
    s.poke(0x3001, 0xfe); // BRA *
    s.setRegisters({ pc: 0x3000 });
    s.run(10000);
    expect(atd.busy).toBe(false);
    expect(atd.result(0)).toBe(512);
  });
});

describe('ATD external trigger on an analog-only AN pin', () => {
  it('uses the analog voltage when nothing drives the pin digitally; analogInputChanged() re-evaluates', () => {
    const { s, nets, atd, base } = rig();
    nets.analog.set('PAD15', 0);
    wr(s, base + 1, 0x07, 0); // ETRIGSEL=0, ETRIGCH=AN7 (PAD15)
    wr(s, base + 3, 0x08, 0); // 1 conversion
    wr(s, base + 2, 0x80 | 0x10 | 0x08 | 0x04, 0); // ADPU, level, high, ETRIGE
    wr(s, base + 5, 0x80, 0);
    expect(atd.busy).toBe(false);
    nets.analog.set('PAD15', 4.5);
    atd.analogInputChanged();
    expect(atd.busy).toBe(true);
  });

  it('a level trigger already asserted through the analog voltage starts when ETRIGE is set', () => {
    const { s, nets, atd, base } = rig();
    nets.analog.set('PAD15', 4.5);
    wr(s, base + 1, 0x07, 0);
    wr(s, base + 3, 0x08, 0);
    wr(s, base + 2, 0x80 | 0x10 | 0x08 | 0x04, 0);
    wr(s, base + 5, 0x80, 0);
    // Level mode: the trigger being active keeps sequences running.
    rd(s, base + 6, 10_000);
    expect(s.peek(base + 6) & 0x80).toBe(0x80);
    expect(atd.busy).toBe(true);
  });
});

describe('ATD special channels (ATDTEST1.SC)', () => {
  it('ATD1: 0100/0101/0110 = VRH/VRL/mid; 1100-1110 are reserved (not aliases)', () => {
    const { s, nets, base } = rig();
    nets.analog.vrh = 5;
    nets.analog.vrl = 0;
    wr(s, base + 2, 0x80, 0);
    wr(s, base + 3, 0x08, 0); // 1 conversion
    wr(s, base + 9, 0x01, 0); // ATDTEST1.SC
    let t = 0;
    const conv = (sel: number) => {
      wr(s, base + 5, 0x80 | sel, t);
      t += 10_000;
      expect(rd(s, base + 6, t) & 0x80).toBe(0x80);
      return (rd(s, base + 0x10, t) << 8) | rd(s, base + 0x11, t);
    };
    expect(conv(4)).toBe(1023);
    expect(conv(5)).toBe(0);
    expect(conv(6)).toBe(512);
    expect(conv(12)).toBe(0);
    expect(conv(14)).toBe(0);
  });
});

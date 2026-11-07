import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets, type BoardNets } from '@s12/sim';
import { addr, mask, vectorByName } from '@s12/devices';
import { ECT_BITS, ECT_PINS, ECT_RANGE, ECT_REGS as R_, ECT_VECTORS, EctModule, defaultDelayCycles, type EctOptions } from '../src/periph/ect';

/** Assemble an absolute-mode (ORG) snippet and poke it into the system. */
function load(s: S12XSystem, src: string): Map<string, number> {
  const a = new Assembler({
    sourcePath: 't.asm',
    readFile: (p: string) => (p === 't.asm' ? src : undefined),
    options: resolveOptions('-CPUHCS12X').options,
    env: {},
  });
  a.run();
  const errs = a.messages.filter((m) => m.severity === 'ERROR' || m.severity === 'FATAL');
  if (errs.length) throw new Error(errs.map((m) => m.text).join('\n'));
  for (const st of a.stmts) if (st.bytes && st.section?.kind === 'org') st.bytes.forEach((b, i) => s.poke(st.loc + i, b));
  return new Map(a.symList.filter((x) => x.defined).map((x) => [x.name, x.value]));
}

interface Rig {
  s: S12XSystem;
  nets: BoardNets;
  ect: EctModule;
  /** Move "now" (the CPU cycle counter) forward to t. */
  at(t: number): void;
  rd(t: number, a: number): number;
  wr(t: number, a: number, v: number): void;
  rd16(t: number, a: number): number;
  wr16(t: number, a: number, v: number): void;
  /** Board drives PTn at cycle t. */
  drive(t: number, n: number, level: 0 | 1 | null): void;
  /** Recorded MCU-side changes of PT pins: [pin, level|null, cycle]. */
  pinLog: Array<[string, number | null, number]>;
  irq(offset: number): boolean;
}

function rig(opts: EctOptions = {}): Rig {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  nets.pins.now = () => s.totalCycles;
  // Inputs idle low (an undriven pin without a pull device floats high); the MCU side still wins when it drives.
  for (const p of ECT_PINS) nets.pins.setPull(p, 'down');
  const ect = new EctModule(nets, opts);
  s.addPeripheral(ect, [ECT_RANGE]);
  s.reset();
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  const at = (t: number) => {
    if (t < s.cpu.cycles) throw new Error(`time going backwards: ${t} < ${s.cpu.cycles}`);
    s.cpu.cycles = t;
  };
  const rd = (t: number, a: number) => {
    at(t);
    return s.bus.regRead(a, t);
  };
  const wr = (t: number, a: number, v: number) => {
    at(t);
    s.bus.regWrite(a, v, t);
  };
  const pinLog: Rig['pinLog'] = [];
  nets.pins.on('*', (pin, st, cyc) => {
    if (pin.startsWith('PT') && st.mcuLayer !== 'gpio') pinLog.push([pin, st.mcu, cyc]);
  });
  return {
    s,
    nets,
    ect,
    at,
    rd,
    wr,
    rd16: (t, a) => (rd(t, a) << 8) | rd(t, a + 1),
    wr16: (t, a, v) => {
      wr(t, a, v >> 8);
      wr(t, a + 1, v & 0xff);
    },
    drive: (t, n, level) => {
      at(t);
      nets.pins.drive(ECT_PINS[n], level);
    },
    pinLog,
    irq: (o) => s.bus.xint.pending.includes(o),
  };
}

const TC = (n: number) => R_.TC0 + 2 * n;
const TCH = (n: number) => R_.TC0H + 2 * n;

describe('ECT register map', () => {
  it('range, registers, vectors and bits come from @s12/devices', () => {
    expect(ECT_RANGE).toEqual([0x40, 0x7f]);
    expect(R_.TCNT).toBe(addr('TCNT'));
    expect([R_.TCNT, R_.TSCR1, R_.TFLG1, R_.TC0, R_.TC7, R_.PACTL, R_.MCCTL, R_.PTPSR, R_.MCCNT, R_.TC0H]).toEqual([
      0x44, 0x46, 0x4e, 0x50, 0x5e, 0x60, 0x66, 0x6e, 0x76, 0x78,
    ]);
    expect(ECT_VECTORS.ch).toEqual([0xee, 0xec, 0xea, 0xe8, 0xe6, 0xe4, 0xe2, 0xe0]);
    expect([ECT_VECTORS.ovf, ECT_VECTORS.paaovf, ECT_VECTORS.paie, ECT_VECTORS.mdcu, ECT_VECTORS.pabovf]).toEqual([
      0xde, 0xdc, 0xda, 0xca, 0xc8,
    ]);
    expect(vectorByName('Vtimch1')!.offset).toBe(0xec);
    expect(ECT_BITS.TFFCA).toBe(0x10);
    expect(ECT_BITS.PRNT).toBe(0x08);
    expect(ECT_BITS.CLK).toBe(0x0c);
    expect(mask('ICSYS', 'SH04')).toBe(0x10);
  });

  it('reset values, read masks, write-only and read-only registers', () => {
    const { s } = rig();
    for (let a = 0x40; a <= 0x7f; a++) {
      const exp = a === R_.MCCNT || a === R_.MCCNT + 1 ? 0xff : 0;
      expect([a, s.peek(a)]).toEqual([a, exp]);
    }
    const W = [
      [R_.TSCR1, 0xff, 0xf8],
      [R_.TSCR2, 0xff, 0x8f],
      [R_.PACTL, 0xff, 0x7f],
      [R_.ICPAR, 0xff, 0x0f],
      [R_.PBCTL, 0xff, 0x42],
      [R_.CFORC, 0xff, 0x00],
      [R_.MCCTL, 0xff & ~(ECT_BITS.ICLAT | ECT_BITS.FLMC), 0xe7],
    ] as const;
    for (const [a, v, e] of W) {
      s.poke(a, v);
      expect([a, s.peek(a)]).toEqual([a, e]);
    }
    s.poke(R_.PA3H, 0x12);
    s.poke(TCH(0), 0x12);
    expect([s.peek(R_.PA3H), s.peek(TCH(0))]).toEqual([0, 0]);
  });
});

describe('ECT main counter (lazy, cycle exact)', () => {
  it('TCNT counts one tick per bus cycle with PR=0; first tick 1 cycle after TEN; word reads coherent', () => {
    const r = rig();
    r.wr(1000, R_.TSCR1, 0x80);
    expect(r.rd16(1000, R_.TCNT)).toBe(0);
    expect(r.rd16(1001, R_.TCNT)).toBe(1);
    expect(r.rd16(1255, R_.TCNT)).toBe(0x00ff);
    // byte reads in different cycles straddle the carry
    expect(r.rd(1255, R_.TCNT)).toBe(0x00);
    expect(r.rd(1256, R_.TCNT + 1)).toBe(0x00);
    expect(r.rd16(1000 + 65536 + 5, R_.TCNT)).toBe(5);
    expect(r.ect.tcnt).toBe(5);
  });

  it('a TEN=0 timer holds TCNT; re-enabling restarts the prescaler', () => {
    const r = rig();
    r.wr(0x100, R_.TSCR2, 3); // /8
    r.wr(0x100, R_.TSCR1, 0x80);
    expect(r.rd16(0x100 + 79, R_.TCNT)).toBe(9);
    expect(r.rd16(0x100 + 80, R_.TCNT)).toBe(10);
    r.wr(0x100 + 83, R_.TSCR1, 0x00);
    expect(r.rd16(0x100 + 1000, R_.TCNT)).toBe(10);
    r.wr(5000, R_.TSCR1, 0x80);
    expect(r.rd16(5007, R_.TCNT)).toBe(10);
    expect(r.rd16(5008, R_.TCNT)).toBe(11);
  });

  it('a new PR takes effect at the next point where all 7 prescaler stages are zero', () => {
    const r = rig();
    r.wr(1000, R_.TSCR1, 0x80);
    r.wr(1050, R_.TSCR2, 2); // /4, pending until 1000 + 128
    expect(r.rd16(1127, R_.TCNT)).toBe(127);
    expect(r.rd16(1128, R_.TCNT)).toBe(128);
    expect(r.rd16(1131, R_.TCNT)).toBe(128);
    expect(r.rd16(1132, R_.TCNT)).toBe(129);
    expect(r.ect.prescaler).toBe(4);
    expect(r.ect.timerClockHz).toBe(r.s.busHz / 4);
  });

  it('precision prescaler: PRNT=1 divides by PTPSR+1; a new PTPSR applies after the next tick', () => {
    const r = rig();
    r.wr(0, R_.PTPSR, 9);
    r.wr(0, R_.TSCR1, 0x88);
    expect(r.rd16(99, R_.TCNT)).toBe(9);
    expect(r.rd16(100, R_.TCNT)).toBe(10);
    r.wr(105, R_.PTPSR, 1); // /2 from the tick at 110
    expect(r.rd16(110, R_.TCNT)).toBe(11);
    expect(r.rd16(111, R_.TCNT)).toBe(11);
    expect(r.rd16(112, R_.TCNT)).toBe(12);
  });

  it('PRNT is write-once in normal mode, writable in special mode; TCNT writable only in special mode', () => {
    const n = rig({ mode: 'normal' });
    n.wr(0, R_.TSCR1, 0x08);
    n.wr(1, R_.TSCR1, 0x80);
    expect(n.s.peek(R_.TSCR1)).toBe(0x88);
    n.wr16(2, R_.TCNT, 0x1234);
    expect(n.rd16(2, R_.TCNT)).toBe(1); // PRNT=1, PTPSR=0: /1, first tick at cycle 2
    const sp = rig();
    sp.wr(0, R_.TSCR1, 0x08);
    sp.wr(1, R_.TSCR1, 0x80);
    expect(sp.s.peek(R_.TSCR1)).toBe(0x80);
    sp.wr16(10, R_.TCNT, 0x1234);
    expect(sp.rd16(10, R_.TCNT)).toBe(0x1234);
    expect(sp.rd16(12, R_.TCNT)).toBe(0x1236);
  });

  it('TOF on $FFFF -> $0000; TOI interrupt; TFLG2 is write-1-to-clear', () => {
    const r = rig();
    r.wr(0, R_.TSCR2, 0x80);
    r.wr(0, R_.TSCR1, 0x80);
    expect(r.rd(65535, R_.TFLG2)).toBe(0);
    expect(r.irq(0xde)).toBe(false);
    expect(r.rd(65536, R_.TFLG2)).toBe(0x80);
    expect(r.irq(0xde)).toBe(true);
    r.wr(65537, R_.TFLG2, 0x00);
    expect(r.s.peek(R_.TFLG2)).toBe(0x80);
    r.wr(65537, R_.TFLG2, 0x80);
    expect(r.s.peek(R_.TFLG2)).toBe(0);
    expect(r.irq(0xde)).toBe(false);
  });

  it('nextEventCycles is Infinity while nothing can raise an interrupt or move a pin', () => {
    const r = rig();
    expect(r.ect.nextEventCycles()).toBe(Infinity);
    r.wr(10, R_.TSCR1, 0x80);
    r.wr(10, R_.TIOS, 0x01);
    r.wr16(10, TC(0), 500);
    expect(r.ect.nextEventCycles()).toBe(Infinity); // flag only: computed lazily on read
    r.wr(10, R_.TIE, 0x01);
    expect(r.ect.nextEventCycles()).toBe(500);
  });
});

describe('ECT output compare: equality on each timer tick (critique C11)', () => {
  it('CnF sets exactly at the tick where TCNT becomes TCn', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 50);
    r.wr(0, R_.TSCR1, 0x80);
    expect(r.rd(49, R_.TFLG1)).toBe(0);
    expect(r.rd(50, R_.TFLG1)).toBe(0x01);
  });

  it('with a prescaler the flag sets at the tick that enters TCn, not later in the period', () => {
    const r = rig();
    r.wr(0, R_.TSCR2, 3);
    r.wr(0, R_.TIOS, 0x02);
    r.wr16(0, TC(1), 5);
    r.wr(0, R_.TSCR1, 0x80);
    expect(r.rd(39, R_.TFLG1)).toBe(0);
    expect(r.rd(40, R_.TFLG1)).toBe(0x02);
  });

  it('never ">=": a TCn behind TCNT waits for the counter to come round (65536 ticks)', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr(0, R_.TSCR1, 0x80);
    r.wr16(60, TC(0), 55); // TCNT = 60 already
    expect(r.rd(61, R_.TFLG1)).toBe(0);
    expect(r.rd(55 + 65535, R_.TFLG1)).toBe(0);
    expect(r.rd(55 + 65536, R_.TFLG1)).toBe(0x01);
  });

  it("same-cycle tie: a TCn write in the cycle of the matching tick misses ('miss', default) or hits ('hit')", () => {
    for (const mode of ['miss', 'hit'] as const) {
      const r = rig({ compareWriteSameTick: mode });
      r.wr(0, R_.TIOS, 0x01);
      r.wr(0, R_.TSCR1, 0x80);
      r.wr16(100, TC(0), 100); // TCNT becomes 100 at cycle 100: the tick precedes the access
      expect(r.ect.lastTickCycle).toBe(100);
      expect([mode, r.rd(100, R_.TFLG1)]).toEqual([mode, mode === 'hit' ? 1 : 0]);
      r.wr16(101, TC(0), 102); // one cycle early: always in time
      expect(r.rd(101, R_.TFLG1) & 1).toBe(mode === 'hit' ? 1 : 0);
      r.wr(101, R_.TFLG1, 1);
      expect(r.rd(102, R_.TFLG1)).toBe(1);
    }
  });

  it('TFFCA: a TCn write clears CnF for output compares; TFLG1 w1c still works', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x03);
    r.wr16(0, TC(0), 10);
    r.wr16(0, TC(1), 10);
    r.wr(0, R_.TSCR1, 0x90);
    expect(r.rd(20, R_.TFLG1)).toBe(0x03);
    r.wr16(21, TC(0), 1000);
    expect(r.rd(21, R_.TFLG1)).toBe(0x02);
    r.wr(22, R_.TFLG1, 0x02);
    expect(r.rd(22, R_.TFLG1)).toBe(0x00);
    // without TFFCA a TCn write does not clear the flag
    r.wr(23, R_.TSCR1, 0x80);
    r.wr16(1001, TC(0), 2000);
    expect(r.rd(1001, R_.TFLG1)).toBe(0x01);
  });

  it('TFFCA: any TCNT access clears TOF', () => {
    const r = rig();
    r.wr(0, R_.TSCR1, 0x90);
    expect(r.s.peek(R_.TFLG2)).toBe(0); // peek has no side effects
    r.at(70000);
    expect(r.s.peek(R_.TFLG2)).toBe(0x80);
    expect(r.s.peek(R_.TCNT)).toBe((70000 - 65536) >> 8);
    expect(r.s.peek(R_.TFLG2)).toBe(0x80);
    r.rd(70001, R_.TCNT + 1);
    expect(r.s.peek(R_.TFLG2)).toBe(0);
  });

  it('TCRE: the counter resets after the OC7 match (period TC7+1); TC7=$FFFF never sets TOF; TC7=0 holds 0', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x80);
    r.wr16(0, TC(7), 99);
    r.wr(0, R_.TSCR2, 0x08);
    r.wr(0, R_.TSCR1, 0x80);
    expect(r.rd16(99, R_.TCNT)).toBe(99);
    expect(r.rd(99, R_.TFLG1)).toBe(0x80);
    expect(r.rd16(100, R_.TCNT)).toBe(0);
    expect(r.rd16(250, R_.TCNT)).toBe(50);
    expect(r.rd16(1_000_000 + 37, R_.TCNT)).toBe(37);
    expect(r.rd(1_000_000 + 37, R_.TFLG2)).toBe(0);

    const f = rig();
    f.wr(0, R_.TIOS, 0x80);
    f.wr16(0, TC(7), 0xffff);
    f.wr(0, R_.TSCR2, 0x08);
    f.wr(0, R_.TSCR1, 0x80);
    expect(f.rd16(65536, R_.TCNT)).toBe(0);
    expect(f.rd(65536 * 3 + 7, R_.TFLG2)).toBe(0);
    expect(f.rd(65536 * 3 + 7, R_.TFLG1)).toBe(0x80);

    const z = rig();
    z.wr(0, R_.TIOS, 0x80);
    z.wr(0, R_.TSCR2, 0x08);
    z.wr(0, R_.TSCR1, 0x80);
    expect(z.rd16(10, R_.TCNT)).toBe(0);
    z.wr(10, R_.TFLG1, 0x80);
    expect(z.rd(11, R_.TFLG1)).toBe(0x80);
    expect(z.rd16(5_000_000, R_.TCNT)).toBe(0);
  });

  it('TCRE with a TC7 written below TCNT: counts on to $FFFF (TOF) and then runs 0..TC7', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x80);
    r.wr(0, R_.TSCR2, 0x08);
    r.wr16(0, TC(7), 0xffff);
    r.wr(0, R_.TSCR1, 0x80);
    r.wr16(200, TC(7), 100);
    expect(r.rd16(65535, R_.TCNT)).toBe(0xffff);
    expect(r.rd(65536, R_.TFLG2)).toBe(0x80);
    expect(r.rd16(65536 + 100, R_.TCNT)).toBe(100);
    expect(r.rd16(65536 + 101, R_.TCNT)).toBe(0);
  });
});

describe('ECT output pins', () => {
  it('toggle on compare: PT0 is taken over low, toggles at exact cycles; released when TEN=0', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 1000);
    r.wr(0, R_.TCTL2, 0x01); // OM0:OL0 = toggle
    expect(r.nets.pins.mcuOutput('PT0')).toBe(null); // TEN=0: not driven yet
    r.wr(5, R_.TSCR1, 0x80);
    expect(r.ect.claimedPins()).toEqual(['PT0']);
    expect(r.nets.pins.state('PT0')).toMatchObject({ mcu: 0, mcuLayer: 'periph' });
    r.at(5 + 65536 * 2 + 2000);
    r.s.bus.syncAll(r.s.totalCycles);
    expect(r.pinLog.filter(([p]) => p === 'PT0')).toEqual([
      ['PT0', 0, 5],
      ['PT0', 1, 1005],
      ['PT0', 0, 1005 + 65536],
      ['PT0', 1, 1005 + 2 * 65536],
    ]);
    r.wr(r.s.totalCycles, R_.TSCR1, 0x00);
    expect(r.nets.pins.mcuOutput('PT0')).toBe(null);
  });

  it('output actions: clear / set; OC7M/OC7D override channel actions on an OC7 match', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x87);
    r.wr16(0, TC(0), 10);
    r.wr16(0, TC(1), 20);
    r.wr16(0, TC(7), 30);
    r.wr(0, R_.TCTL2, 0b00_11_11_11); // ch0, ch1, ch2 set on match (ch2 never matches: TC2 = 0 is reached after wrap)
    r.wr(0, R_.OC7M, 0x03);
    r.wr(0, R_.OC7D, 0x01); // OC7 match: PT0 <- 1, PT1 <- 0
    r.wr(0, R_.TSCR1, 0x80);
    expect([r.nets.pins.read('PT0'), r.nets.pins.read('PT1'), r.nets.pins.read('PT2')]).toEqual([0, 0, 0]);
    r.at(25);
    r.s.bus.syncAll(25);
    // OC7M bits disable the OMn/OLn actions of ch0/ch1
    expect([r.nets.pins.read('PT0'), r.nets.pins.read('PT1')]).toEqual([0, 0]);
    r.at(30);
    r.s.bus.syncAll(30);
    expect([r.nets.pins.read('PT0'), r.nets.pins.read('PT1'), r.nets.pins.read('PT7')]).toEqual([1, 0, 0]);
    expect(r.s.peek(R_.TFLG1)).toBe(0x83);
    // TCTL clear action once OC7M is removed
    r.wr(31, R_.OC7M, 0);
    r.wr(31, R_.TCTL2, 0b00_00_00_10); // ch0 clear
    r.wr16(31, TC(0), 40);
    r.at(40);
    r.s.bus.syncAll(40);
    expect(r.nets.pins.read('PT0')).toBe(0);
  });

  it('OC7M drives a pin without TEN (IOS7=IOSn=1)', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x84);
    r.wr(0, R_.OC7M, 0x04);
    expect(r.ect.claimedPins()).toEqual(['PT2']);
  });

  it('CFORC applies the action at once without a flag (and cancels a same-cycle compare flag)', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 50);
    r.wr(0, R_.TCTL2, 0x01);
    r.wr(0, R_.TSCR1, 0x80);
    r.wr(10, R_.CFORC, 0x01);
    expect(r.nets.pins.read('PT0')).toBe(1);
    expect(r.s.peek(R_.TFLG1)).toBe(0);
    r.wr(50, R_.CFORC, 0x01); // same cycle as the compare: forced action wins, no flag
    expect(r.s.peek(R_.TFLG1)).toBe(0);
    // One action (the forced one replaces the compare's action of that tick), not two cancelling toggles.
    expect(r.nets.pins.read('PT0')).toBe(0);
  });

  it('CFORC in the cycle of a toggle compare acts once (pin starting low ends high)', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 50);
    r.wr(0, R_.TCTL2, 0x01);
    r.wr(0, R_.TSCR1, 0x80);
    r.wr(50, R_.CFORC, 0x01);
    expect(r.nets.pins.read('PT0')).toBe(1);
    expect(r.s.peek(R_.TFLG1)).toBe(0);
    // A force in another cycle still acts normally.
    r.wr(60, R_.CFORC, 0x01);
    expect(r.nets.pins.read('PT0')).toBe(0);
  });

  it('CFORC with a set action in the cycle of a clear-on-compare: the forced set wins', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 50);
    r.wr(0, R_.TCTL2, 0x03); // set on compare
    r.wr(0, R_.TSCR1, 0x80);
    r.wr(50, R_.TCTL2, 0x02); // too late for the tick at 50 (it already set the pin)
    r.wr(50, R_.CFORC, 0x01); // forced action = clear
    expect(r.nets.pins.read('PT0')).toBe(0);
  });

  it('TOVn takes precedence over a same-cycle forced compare', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 0x8000);
    r.wr(0, R_.TCTL2, 0x03); // set
    r.wr(0, R_.TTOV, 0x01);
    r.wr(0, R_.TSCR1, 0x80);
    expect(r.rd(0x8000, R_.TFLG1)).toBe(0x01);
    expect(r.nets.pins.read('PT0')).toBe(1); // set by the compare at $8000
    r.wr(65536, R_.CFORC, 0x01); // the overflow tick toggled PT0 1 -> 0 in this cycle; the forced set does not act
    expect(r.nets.pins.read('PT0')).toBe(0);
    r.wr(65537, R_.CFORC, 0x01); // next cycle: the forced set acts
    expect(r.nets.pins.read('PT0')).toBe(1);
  });

  it('TTOV toggles an OC pin on overflow', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x08);
    r.wr16(0, TC(3), 0x8000);
    r.wr(0, R_.TCTL2, 0x80); // ch3 clear on compare
    r.wr(0, R_.TTOV, 0x08);
    r.wr(0, R_.TSCR1, 0x80);
    r.at(3 * 65536);
    r.s.bus.syncAll(3 * 65536);
    expect(r.pinLog.filter(([p]) => p === 'PT3').map(([, l, c]) => [l, c])).toEqual([
      [0, 0],
      [1, 65536],
      [0, 65536 + 0x8000],
      [1, 2 * 65536],
      [0, 2 * 65536 + 0x8000],
      [1, 3 * 65536],
    ]);
  });
});

describe('ECT input capture', () => {
  function icRig(opts: EctOptions = {}) {
    const r = rig(opts);
    r.wr(0, R_.TSCR1, 0x80);
    return r;
  }

  it('captures TCNT at the edge cycle on the selected edge; TFFCA clears CnF on a TCn read', () => {
    const r = icRig();
    r.wr(0, R_.TCTL4, 0x04); // ch1 rising
    r.wr(0, R_.TIE, 0x02);
    r.drive(300, 1, 1);
    expect(r.rd16(400, TC(1))).toBe(300);
    expect(r.s.peek(R_.TFLG1)).toBe(0x02);
    expect(r.irq(0xec)).toBe(true);
    r.drive(500, 1, 0); // falling: ignored
    expect(r.rd16(600, TC(1))).toBe(300);
    r.wr(600, R_.TSCR1, 0x90); // TFFCA
    r.rd(601, TC(1));
    expect(r.s.peek(R_.TFLG1)).toBe(0);
    expect(r.irq(0xec)).toBe(false);
    // writes to an IC channel's TCn are ignored by default
    r.wr16(602, TC(1), 0x1234);
    expect(r.s.peek(TC(1) + 1)).toBe(300 & 0xff);
  });

  it('EDG both edges; NOVW keeps the first capture until TCn is read', () => {
    const r = icRig();
    r.wr(0, R_.TCTL3, 0x30); // ch6 both edges
    r.wr(0, R_.ICOVW, 0x40);
    r.drive(100, 6, 1);
    r.drive(200, 6, 0);
    expect(r.rd16(250, TC(6))).toBe(100);
    r.drive(300, 6, 1);
    expect(r.rd16(350, TC(6))).toBe(300);
  });

  it('queue mode (BUFEN=1, LATQ=0): previous TCn moves to TCnH', () => {
    const r = icRig();
    r.wr(0, R_.ICSYS, 0x02);
    r.wr(0, R_.TCTL4, 0x01); // ch0 rising
    r.drive(100, 0, 1);
    r.drive(150, 0, 0);
    r.drive(200, 0, 1);
    expect(r.rd16(210, TC(0))).toBe(200);
    expect(r.rd16(210, TCH(0))).toBe(100);
  });

  it('queue mode + NOVW + TFMOD: flag only on the second capture', () => {
    const r = icRig();
    r.wr(0, R_.ICSYS, 0x0a); // TFMOD | BUFEN
    r.wr(0, R_.ICOVW, 0x01);
    r.wr(0, R_.TCTL4, 0x01);
    r.drive(100, 0, 1);
    r.drive(150, 0, 0);
    expect(r.rd(160, R_.TFLG1)).toBe(0);
    r.drive(200, 0, 1);
    expect(r.rd(210, R_.TFLG1)).toBe(1);
    expect([r.s.peek(TC(0) + 1), r.s.peek(TCH(0) + 1)]).toEqual([200, 100]);
    r.drive(250, 0, 0);
    r.drive(300, 0, 1); // both full: no overwrite
    expect(r.rd16(310, TC(0))).toBe(200);
  });

  it('latch mode: ICLAT and MCCNT=$0000 latch TC0..3 and PAC0..3 into the holding registers (PACs cleared)', () => {
    const r = icRig();
    r.wr(0, R_.ICSYS, 0x03); // BUFEN | LATQ
    r.wr(0, R_.TCTL4, 0x05); // ch0, ch1 rising
    r.wr(0, R_.ICPAR, 0x01); // PAC0 counts ch0 edges
    for (let i = 0; i < 3; i++) {
      r.drive(100 + 20 * i, 0, 1);
      r.drive(110 + 20 * i, 0, 0);
    }
    r.drive(170, 1, 1);
    expect(r.rd(180, R_.PACN0)).toBe(3);
    r.wr(200, R_.MCCTL, ECT_BITS.ICLAT);
    expect(r.rd16(200, TCH(0))).toBe(140);
    expect(r.rd16(200, TCH(1))).toBe(170);
    expect(r.s.peek(R_.PA0H)).toBe(3);
    expect(r.s.peek(R_.PACN0)).toBe(0);
    r.drive(300, 0, 1);
    r.wr16(400, R_.MCCNT, 0);
    expect(r.rd16(400, TCH(0))).toBe(300);
    expect(r.s.peek(R_.PA0H)).toBe(1);
  });

  it('delay counter rejects pulses shorter than the delay and captures at edge + delay', () => {
    // PRNT=0: DLY1:0 only, 256/512/1024 (ECT_16B8C V01.06 Table 3-8). PRNT=1: (DLYCT+1) x 4 (UNCERTAIN).
    expect([0, 1, 2, 3, 0x10, 0x81].map((d) => defaultDelayCycles(d))).toEqual([0, 256, 512, 1024, 0, 256]);
    expect([0, 1, 7, 0x80, 0xff].map((d) => defaultDelayCycles(d, true))).toEqual([0, 8, 32, 516, 1024]);
    const r = icRig({ delayCycles: (d) => (d ? 32 : 0) });
    r.wr(0, R_.DLYCT, 0x01); // 32 bus cycles (custom table)
    r.wr(0, R_.TCTL4, 0x01);
    r.wr(0, R_.TIE, 0x01);
    r.drive(100, 0, 1);
    r.drive(120, 0, 0); // 20-cycle pulse: rejected
    r.at(200);
    r.s.bus.syncAll(200);
    expect(r.s.peek(R_.TFLG1)).toBe(0);
    r.drive(300, 0, 1);
    expect(r.ect.nextEventCycles()).toBe(32);
    r.at(331);
    r.s.bus.syncAll(331);
    expect(r.s.peek(R_.TFLG1)).toBe(0);
    r.at(332);
    r.s.bus.syncAll(332);
    expect(r.s.peek(R_.TFLG1)).toBe(1);
    expect(r.rd16(400, TC(0))).toBe(332);
  });

  it('default delay counter: DLYCT=1 is 256 bus cycles with PRNT=0, (1+1)*4 with PRNT=1', () => {
    const r = icRig();
    r.wr(0, R_.TCTL4, 0x01);
    r.wr(0, R_.DLYCT, 0x01);
    r.drive(100, 0, 1);
    expect(r.ect.nextEventCycles()).toBe(256);
    expect(r.rd16(400, TC(0))).toBe(356);
    const q = rig();
    q.wr(0, R_.TSCR1, 0x80 | ECT_BITS.PRNT);
    q.wr(0, R_.TCTL4, 0x01);
    q.wr(0, R_.DLYCT, 0x01);
    q.drive(100, 0, 1);
    expect(q.rd16(400, TC(0))).toBe(108);
  });

  it('a delayed edge caused by the ECT itself (OC0 looped to IC1 by a board model) is captured at edge + delay', () => {
    const r = rig();
    r.nets.pins.on('PT0', (_p, st) => r.nets.pins.drive('PT1', st.level));
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 300);
    r.wr(0, R_.TCTL2, 0x01); // toggle
    r.wr(0, R_.TCTL4, 0x0c); // ch1 both edges
    r.wr(0, R_.TIE, 0x02);
    r.wr(0, R_.DLYCT, 0x01); // 256
    r.wr(0, R_.TSCR1, 0x80);
    r.at(1000);
    r.s.bus.syncAll(1000);
    expect(r.s.peek(R_.TFLG1) & 0x02).toBe(0x02);
    expect(r.irq(ECT_VECTORS.ch[1])).toBe(true);
    expect(r.rd16(1000, TC(1))).toBe(556);
    expect(r.ect.nextEventCycles()).toBeGreaterThan(1);
    // Without a delay the loopback captures the exact tick.
    const q = rig();
    q.nets.pins.on('PT0', (_p, st) => q.nets.pins.drive('PT1', st.level));
    q.wr(0, R_.TIOS, 0x01);
    q.wr16(0, TC(0), 300);
    q.wr(0, R_.TCTL2, 0x01);
    q.wr(0, R_.TCTL4, 0x0c);
    q.wr(0, R_.TSCR1, 0x80);
    expect(q.rd16(1000, TC(1))).toBe(300);
  });

  it('PAC0 counts its own delayed OC0 toggles in order (no lost or late edges)', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 300);
    r.wr(0, R_.TCTL2, 0x01);
    r.wr(0, R_.TCTL4, 0x03);
    r.wr(0, R_.ICPAR, 0x01);
    r.wr(0, R_.DLYCT, 0x01); // 256
    r.wr(0, R_.TSCR1, 0x80);
    expect(r.rd(555, R_.PACN0)).toBe(0);
    expect(r.rd(556, R_.PACN0)).toBe(1);
    expect(r.rd(70000, R_.PACN0)).toBe(2); // second toggle at 65836, valid at 66092
  });

  it('SH04: input 0 also captures on channel 4; POLF records the first edge polarity', () => {
    const r = icRig();
    r.wr(0, R_.ICSYS, 0x10);
    r.wr(0, R_.TCTL4, 0x03); // ch0 both edges
    r.drive(100, 0, 1);
    r.drive(150, 0, 0);
    expect([r.rd16(160, TC(0)), r.rd16(160, TC(4))]).toEqual([150, 150]);
    expect(r.s.peek(R_.TFLG1)).toBe(0x11);
    // POLF0 was set by the first capture (rising, at 100) and re-armed by the TC0 read above
    expect(r.s.peek(R_.MCFLG) & 0x0f).toBe(0x01);
    r.drive(200, 0, 1);
    r.drive(250, 0, 0);
    expect(r.s.peek(R_.MCFLG) & 0x01).toBe(1);
    r.rd(260, TC(0));
    r.drive(300, 0, 1);
    r.drive(310, 0, 0);
    expect(r.s.peek(R_.MCFLG) & 0x01).toBe(1);
  });
});

describe('ECT pulse accumulators', () => {
  it('PACA event mode counts PT7 edges, PAIF, PAOVF on overflow; TFFCA clears PAFLG on a PACN access', () => {
    const r = rig();
    r.wr(0, R_.PACTL, ECT_BITS.PAEN | ECT_BITS.PEDGE | ECT_BITS.PAOVI);
    r.wr16(0, R_.PACN3, 0xfffe);
    for (let i = 0; i < 3; i++) {
      r.drive(10 + 10 * i, 7, 1);
      r.drive(15 + 10 * i, 7, 0);
    }
    expect(r.rd16(100, R_.PACN3)).toBe(1);
    expect(r.s.peek(R_.PAFLG)).toBe(0x03);
    expect(r.irq(0xdc)).toBe(true);
    r.wr(101, R_.TSCR1, 0x10);
    r.rd(102, R_.PACN3);
    expect(r.s.peek(R_.PAFLG)).toBe(0);
    expect(r.irq(0xdc)).toBe(false);
  });

  it('PACA gated mode counts bus/64 while PT7 is high; the trailing edge sets PAIF', () => {
    const r = rig();
    r.wr(0, R_.TSCR1, 0x80);
    r.wr(0, R_.PACTL, ECT_BITS.PAEN | ECT_BITS.PAMOD);
    r.drive(100, 7, 1);
    expect(r.rd16(100 + 64 * 10, R_.PACN3)).toBe(10); // /64 edges at 128, 192, ..., 704 -> 10
    r.drive(1000, 7, 0);
    expect(r.rd16(5000, R_.PACN3)).toBe(14);
    expect(r.s.peek(R_.PAFLG)).toBe(0x01);
  });

  it('gated PACA driven by its own OC7 output: count independent of when the CPU reads', () => {
    const results: number[] = [];
    for (const mid of [null, 3000, 6400, 10000]) {
      const r = rig();
      r.wr(0, R_.TIOS, 0x80);
      r.wr16(0, TC(7), 6400);
      r.wr(0, R_.TCTL1, 0x40); // toggle PT7 at 6400 (gate opens)
      r.wr(0, R_.PACTL, ECT_BITS.PAEN | ECT_BITS.PAMOD);
      r.wr(0, R_.TSCR1, 0x80);
      if (mid !== null) r.rd(mid, R_.TFLG1);
      results.push(r.rd16(20000, R_.PACN3));
    }
    // /64 edges in (6400, 20000]: 312 - 100.
    expect(results).toEqual([212, 212, 212, 212]);
  });

  it('PACLK as the timer clock (CLK=01, event mode): TCNT counts PT7 edges', () => {
    const r = rig();
    r.wr(0, R_.TSCR1, 0x80);
    r.wr(0, R_.PACTL, ECT_BITS.PAEN | ECT_BITS.PEDGE | 0x04);
    for (let i = 0; i < 5; i++) {
      r.drive(100 + 10 * i, 7, 1);
      r.drive(105 + 10 * i, 7, 0);
    }
    expect(r.rd16(10_000, R_.TCNT)).toBe(5);
  });

  it('PACLK/256 in gated mode: one TCNT tick per 256 x 64 bus cycles of gate', () => {
    const r = rig();
    r.wr(0, R_.TSCR1, 0x80);
    r.wr(0, R_.PACTL, ECT_BITS.PAEN | ECT_BITS.PAMOD | 0x08);
    r.drive(0, 7, 1);
    expect(r.rd16(64 * 256 - 1, R_.TCNT)).toBe(0);
    expect(r.rd16(64 * 256, R_.TCNT)).toBe(1);
    expect(r.rd16(64 * 256 * 3, R_.TCNT)).toBe(3);
  });

  it('PACB (PBEN) counts ch0 edges per EDG0; PBOVF; 8-bit PAC3 with PACMX saturates and sets PAOVF', () => {
    const r = rig();
    r.wr(0, R_.PBCTL, ECT_BITS.PBEN | ECT_BITS.PBOVI);
    r.wr(0, R_.TCTL4, 0x01);
    r.wr16(0, R_.PACN0 - 1, 0xffff);
    r.drive(10, 0, 1);
    expect(r.rd16(20, R_.PACN0 - 1)).toBe(0);
    expect(r.s.peek(R_.PBFLG)).toBe(0x02);
    expect(r.irq(0xc8)).toBe(true);

    const q = rig();
    q.wr(0, R_.ICSYS, ECT_BITS.PACMX);
    q.wr(0, R_.ICPAR, 0x08);
    q.wr(0, R_.TCTL4, 0x40); // ch3 rising
    q.wr(0, R_.PACN3, 0xfe);
    for (let i = 0; i < 3; i++) {
      q.drive(10 + 10 * i, 3, 1);
      q.drive(15 + 10 * i, 3, 0);
    }
    expect(q.rd(100, R_.PACN3)).toBe(0xff);
    expect(q.s.peek(R_.PAFLG) & 0x02).toBe(0x02);
  });
});

describe('ECT modulus down counter', () => {
  it('modulus mode: MCZF every load x prescale cycles, interrupt, RDMCL, FLMC', () => {
    const r = rig();
    r.wr16(0, R_.MCCNT, 1000); // MCEN=0: count stays at the $FFFF preset
    expect(r.rd16(0, R_.MCCNT)).toBe(0xffff);
    r.wr(10, R_.MCCTL, ECT_BITS.MCZI | ECT_BITS.MODMC | ECT_BITS.MCEN | ECT_BITS.FLMC | 1); // /4
    expect(r.rd16(10, R_.MCCNT)).toBe(1000);
    expect(r.ect.nextEventCycles()).toBe(4000);
    expect(r.rd16(14, R_.MCCNT)).toBe(999);
    expect(r.rd(4009, R_.MCFLG)).toBe(0);
    expect(r.rd(4010, R_.MCFLG)).toBe(0x80);
    expect(r.irq(0xca)).toBe(true);
    expect(r.rd16(4010, R_.MCCNT)).toBe(1000);
    r.wr(4011, R_.MCFLG, 0x80);
    expect(r.irq(0xca)).toBe(false);
    r.wr(4011, R_.MCCTL, ECT_BITS.MCZI | ECT_BITS.MODMC | ECT_BITS.MCEN | ECT_BITS.RDMCL | 1);
    r.wr16(4012, R_.MCCNT, 50); // modulus mode: load register only
    expect(r.rd16(4012, R_.MCCNT)).toBe(50);
    r.wr(4012, R_.MCCTL, ECT_BITS.MCZI | ECT_BITS.MODMC | ECT_BITS.MCEN | 1);
    expect(r.rd16(4012, R_.MCCNT)).toBe(1000 - 0); // count continues from its reload at 4010
    expect(r.rd(8010, R_.MCFLG)).toBe(0x80);
    expect(r.rd16(8010 + 4 * 10, R_.MCCNT)).toBe(40);
  });

  it('one-shot mode (MODMC=0): a write loads at once, counts to 0 and stops; MCEN=0 presets $FFFF', () => {
    const r = rig();
    r.wr(0, R_.MCCTL, ECT_BITS.MCEN);
    r.wr16(100, R_.MCCNT, 20);
    expect(r.rd16(119, R_.MCCNT)).toBe(1);
    expect(r.rd(119, R_.MCFLG)).toBe(0);
    expect(r.rd16(120, R_.MCCNT)).toBe(0);
    expect(r.rd(120, R_.MCFLG)).toBe(0x80);
    expect(r.rd16(10_000, R_.MCCNT)).toBe(0);
    r.wr(10_001, R_.MCCTL, 0);
    expect(r.rd16(10_001, R_.MCCNT)).toBe(0xffff);
  });

  it('PTMCPSR (PRNT=1) sets the modulus prescaler at the next load; TFFCA clears MCZF on an MCCNT access', () => {
    const r = rig();
    r.wr(0, R_.TSCR1, 0x18); // TFFCA | PRNT
    r.wr(0, R_.PTMCPSR, 9);
    r.wr(0, R_.MCCTL, ECT_BITS.MCEN);
    r.wr16(0, R_.MCCNT, 5);
    expect(r.rd(49, R_.MCFLG)).toBe(0);
    expect(r.s.peek(R_.MCFLG)).toBe(0);
    r.at(50);
    expect(r.s.peek(R_.MCFLG)).toBe(0x80);
    r.rd(51, R_.MCCNT);
    expect(r.s.peek(R_.MCFLG)).toBe(0);
  });
});

describe('ECT flag set vs clear in the same cycle (set wins)', () => {
  it('a TFLG1 / TFLG2 write-1-to-clear in the cycle the flag is set leaves it set', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 50);
    r.wr(0, R_.TSCR1, 0x80);
    r.wr(50, R_.TFLG1, 0x01);
    expect(r.s.peek(R_.TFLG1)).toBe(0x01);
    r.wr(51, R_.TFLG1, 0x01);
    expect(r.s.peek(R_.TFLG1)).toBe(0);
    r.wr(65536, R_.TFLG2, 0x80);
    expect(r.s.peek(R_.TFLG2)).toBe(0x80);
    r.wr(65537, R_.TFLG2, 0x80);
    expect(r.s.peek(R_.TFLG2)).toBe(0);
  });

  it('TFFCA fast clears follow the same rule (TCn write, TCNT read, MCCNT read)', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 50);
    r.wr(0, R_.TSCR1, 0x80 | ECT_BITS.TFFCA);
    r.wr16(50, TC(0), 1000);
    expect(r.s.peek(R_.TFLG1)).toBe(0x01);
    r.wr16(51, TC(0), 1000);
    expect(r.s.peek(R_.TFLG1)).toBe(0);
    r.rd(65536, R_.TCNT);
    expect(r.s.peek(R_.TFLG2)).toBe(0x80);
    r.rd(65537, R_.TCNT);
    expect(r.s.peek(R_.TFLG2)).toBe(0);
    r.wr(70000, R_.MCCTL, ECT_BITS.MCEN | ECT_BITS.MODMC);
    r.wr16(70000, R_.MCCNT, 10);
    r.wr(70000, R_.MCCTL, ECT_BITS.MCEN | ECT_BITS.MODMC | ECT_BITS.FLMC);
    r.rd(70010, R_.MCCNT);
    expect(r.s.peek(R_.MCFLG) & 0x80).toBe(0x80);
    r.rd(70011, R_.MCCNT);
    expect(r.s.peek(R_.MCFLG) & 0x80).toBe(0);
  });

  it('PAFLG: an edge-set PAIF survives a same-cycle clear', () => {
    const r = rig();
    r.wr(0, R_.TSCR1, 0x80);
    r.wr(0, R_.PACTL, ECT_BITS.PAEN);
    r.drive(100, 7, 1);
    r.drive(100, 7, 0); // falling edge (PEDGE=0) at 100
    r.wr(100, R_.PAFLG, 0x03);
    expect(r.s.peek(R_.PAFLG)).toBe(ECT_BITS.PAIF);
    r.wr(101, R_.PAFLG, 0x03);
    expect(r.s.peek(R_.PAFLG)).toBe(0);
  });
});

describe('ECT integration API', () => {
  it('mode accepts a getter (read at each use)', () => {
    let mode: 'special' | 'normal' = 'normal';
    const r = rig({ mode: () => mode });
    r.wr16(0, R_.TCNT, 0x1234);
    expect((r.s.peek(R_.TCNT) << 8) | r.s.peek(R_.TCNT + 1)).toBe(0);
    mode = 'special';
    r.wr16(1, R_.TCNT, 0x1234);
    expect((r.s.peek(R_.TCNT) << 8) | r.s.peek(R_.TCNT + 1)).toBe(0x1234);
  });

  it('dispose() removes the PinNet listeners', () => {
    const r = rig();
    r.wr(0, R_.TCTL4, 0x01);
    r.wr(0, R_.TSCR1, 0x80);
    r.ect.dispose();
    r.drive(100, 0, 1);
    expect(r.s.peek(R_.TFLG1)).toBe(0);
  });
});

describe('ECT in a running system', () => {
  it('periodic output-compare interrupt (TFFCA, ISR adds the period): exact count and ISR timing', () => {
    const r = rig();
    const s = r.s;
    const sym = load(
      s,
      `
 ORG $4000
 MOVB #$01,$40      ; TIOS: ch0 OC
 MOVB #$01,$4C      ; TIE
 LDD  #1000
 STD  $50           ; TC0
 MOVB #$90,$46      ; TEN | TFFCA
 CLI
loop: BRA loop
isr: LDD $50
 ADDD #1000
 STD  $50           ; clears C0F (TFFCA)
 INC  $2000
 RTI
 ORG $FFEE
 DC.W isr
`,
    );
    const entries: number[] = [];
    s.setTracer((acc, local, _g, _v, cyc) => {
      if (acc === 'read' && local === 0x50) entries.push(cyc);
    });
    s.setRegisters({ pc: 0x4000, ccr: 0x10 });
    s.run(100_000);
    expect(sym.has('isr')).toBe(true);
    const n = s.peek(0x2000);
    expect(n).toBeGreaterThanOrEqual(99);
    expect(n).toBeLessThanOrEqual(100);
    // matches are exactly 1000 cycles apart (TC0 = 1000 * count); ISR entry jitters by < one BRA (3 cycles)
    expect((((s.peek(0x50) << 8) | s.peek(0x51)) - 1000) & 0xffff).toBe((1000 * n) & 0xffff);
    const ph = entries.map((c) => (c - entries[0]) % 1000);
    for (const x of ph) expect(x < 3 || x > 1000 - 3).toBe(true);
  });

  it('snapshot/restore round-trips the module (lazy state included)', () => {
    const r = rig();
    r.wr(0, R_.TIOS, 0x01);
    r.wr16(0, TC(0), 300);
    r.wr(0, R_.TCTL2, 0x01);
    r.wr(0, R_.TSCR2, 0x02);
    r.wr(0, R_.TSCR1, 0x80);
    r.at(1250);
    const snap = r.s.snapshot();
    const pin = r.nets.pins.read('PT0');
    expect(pin).toBe(1); // toggled at 4*300
    const tcnt = r.rd16(1300, R_.TCNT);
    r.wr(1300, R_.TSCR1, 0);
    expect(r.nets.pins.mcuOutput('PT0')).toBe(null);
    r.s.restore(snap);
    expect(r.s.totalCycles).toBe(1250);
    expect(r.ect.claimedPins()).toEqual(['PT0']);
    expect(r.nets.pins.read('PT0')).toBe(1);
    expect((r.s.peek(R_.TCNT) << 8) | r.s.peek(R_.TCNT + 1)).toBe(312);
    expect(r.rd16(1300, R_.TCNT)).toBe(tcnt);
    expect(tcnt).toBe(325);
  });
});

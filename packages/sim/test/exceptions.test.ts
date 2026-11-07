/** Reset, SWI/TRAP/SYS, hardware interrupts (XINT priority/IPL), RTI, WAI, STOP, BGND. */
import { describe, expect, it } from 'vitest';
import { S12XSystem, type Peripheral, type PeripheralContext } from '@s12/sim';
import { CCR, CODE, STACK, getW, mk, put, putW } from './helpers';

const { C, Z, N, I, X, S } = CCR;

/** Program a vector slot (local $FFxx, fixed flash page $FF). */
function vec(s: S12XSystem, addr: number, target: number): void {
  putW(s, addr, target);
}

/** A fake peripheral with one IRQ line at `offset`, asserted after `delay` cycles (event-driven). */
class OneShot implements Peripheral {
  readonly name = 'oneshot';
  ctx!: PeripheralContext;
  remaining = Infinity;
  firedAt = -1;
  constructor(readonly offset: number, readonly flagAddr: number) {}
  attach(ctx: PeripheralContext) {
    this.ctx = ctx;
  }
  reset() {
    this.remaining = Infinity;
  }
  arm(delay: number) {
    this.ctx.sync();
    this.remaining = delay;
    this.ctx.reschedule();
  }
  read() {
    return this.firedAt >= 0 ? 0x80 : 0;
  }
  write(_a: number, v: number) {
    if (v & 0x80) {
      this.firedAt = -1;
      this.ctx.clearInterrupt(this.offset);
    }
  }
  tick(n: number) {
    if (this.remaining !== Infinity) {
      this.remaining -= n;
      if (this.remaining <= 0) {
        this.firedAt = this.ctx.now + this.remaining; // exact firing cycle
        this.remaining = Infinity;
        this.ctx.requestInterrupt(this.offset);
      }
    }
  }
  nextEventCycles() {
    return this.remaining;
  }
}

describe('reset', () => {
  it('CCR = $D0, IPL = 0, IVBR = $FF, PC from $FFFE, MMC reset values', () => {
    const s = new S12XSystem();
    vec(s, 0xfffe, 0xc000);
    s.poke(0x0121, 0x40); // move IVBR
    s.poke(0x0030, 0xe0);
    s.setRegisters({ ccr: 0, ipl: 5 });
    s.reset();
    expect(s.registers).toMatchObject({ pc: 0xc000, ccr: 0xd0, ipl: 0 });
    expect([s.peek(0x0121), s.peek(0x16), s.peek(0x17), s.peek(0x30), s.peek(0x10), s.peek(0x11)]).toEqual([
      0xff, 0xfd, 0xfe, 0xfe, 0x00, 0x00,
    ]);
  });
  it('COP and clock-monitor resets use $FFFA / $FFFC; $FFFF vector warns', () => {
    const s = new S12XSystem();
    vec(s, 0xfffa, 0x4100);
    vec(s, 0xfffc, 0x4200);
    s.reset('cop');
    expect(s.registers.pc).toBe(0x4100);
    s.reset('clock-monitor');
    expect(s.registers.pc).toBe(0x4200);
    s.reset('external');
    expect(s.registers.pc).toBe(0xffff);
    expect(s.events.some((e) => e.kind === 'uninitialized-vector' && e.address === 0xfffe)).toBe(true);
  });
  it('a peripheral can request a reset (taken at the next boundary)', () => {
    const s = mk();
    vec(s, 0xfffa, 0x4100);
    put(s, CODE, [0xa7, 0xa7, 0xa7]);
    put(s, 0x4100, [0xa7]);
    let ctx!: PeripheralContext;
    s.addPeripheral({ name: 'cop', attach: (c) => (ctx = c), reset() {}, read: () => 0, write() {} }, [[0x3c, 0x3c]]);
    s.step();
    ctx.requestReset('cop');
    s.step();
    expect(s.registers.pc).toBe(0x4101); // COP reset vector, then one NOP
  });
});

describe('software exceptions', () => {
  it('SWI: 10-byte frame (CCRH, CCRL, B, A, X, Y, RTN), I set, IPL kept; RTI restores everything', () => {
    const s = mk();
    vec(s, 0xfff6, 0x5000);
    put(s, CODE, [0x3f]);
    put(s, 0x5000, [0x0b]);
    s.setRegisters({ a: 0x11, b: 0x22, x: 0x3344, y: 0x5566, ccr: 0x0d, ipl: 3 });
    const c0 = s.cycles;
    s.step();
    expect(s.cycles - c0).toBe(9);
    expect(s.registers).toMatchObject({ pc: 0x5000, sp: STACK - 10, ccr: 0x0d | I, ipl: 3 });
    expect(s.readBlock(STACK - 10, 10)).toEqual([0x03, 0x0d, 0x22, 0x11, 0x33, 0x44, 0x55, 0x66, 0x40, 0x01]);
    s.setRegisters({ a: 0, b: 0, x: 0, y: 0, ipl: 7 });
    const c1 = s.cycles;
    s.step();
    expect(s.cycles - c1).toBe(8);
    expect(s.registers).toMatchObject({ a: 0x11, b: 0x22, x: 0x3344, y: 0x5566, ccr: 0x0d, ipl: 3, sp: STACK, pc: CODE + 1 });
  });
  it('TRAP: unimplemented page-2 opcode vectors through IVBR:$F8, return address after 18 xx', () => {
    const s = mk();
    s.poke(0x0121, 0x60); // IVBR = $60 -> vector at $60F8 (flash page $FD)
    putW(s, 0x60f8, 0x5100);
    put(s, CODE, [0x18, 0x30]);
    s.step();
    expect(s.registers.pc).toBe(0x5100);
    expect(getW(s, STACK - 2)).toBe(CODE + 2);
    expect(s.cpu.lastVector).toBe(0xf8);
  });
  it('SYS vectors through IVBR:$12', () => {
    const s = mk();
    putW(s, 0xff12, 0x5200);
    put(s, CODE, [0x18, 0xa7]);
    const c0 = s.cycles;
    s.step();
    expect([s.registers.pc, s.cycles - c0, s.registers.ccr & I]).toEqual([0x5200, 10, I]);
  });
  it('RTI cannot set X', () => {
    const s = mk();
    put(s, CODE, [0x0b]);
    s.setRegisters({ sp: 0x2100, ccr: 0 });
    put(s, 0x2100, [0x00, 0xff, 0, 0, 0, 0, 0, 0, 0x40, 0x00]);
    s.step();
    expect(s.registers.ccr).toBe(0xbf);
  });
});

describe('hardware interrupts and XINT arbitration', () => {
  function sys() {
    const s = mk();
    vec(s, 0xffce, 0x5000); // Port J
    vec(s, 0xfff0, 0x5100); // RTI
    vec(s, 0xffee, 0x5200); // TC0
    vec(s, 0xfff4, 0x5300); // XIRQ
    vec(s, 0xfff2, 0x5400); // IRQ
    put(s, CODE, Array(64).fill(0xa7)); // NOPs
    for (const a of [0x5000, 0x5100, 0x5200, 0x5300, 0x5400]) put(s, a, Array(16).fill(0xa7));
    return s;
  }
  it('masked by I; taken when I = 0 with a 9-cycle entry, I set and IPL = level', () => {
    const s = sys();
    s.setRegisters({ ccr: I });
    s.requestInterrupt(0xce);
    s.step();
    expect(s.registers.pc).toBe(CODE + 1);
    s.setRegisters({ ccr: 0 });
    const c0 = s.cycles;
    s.step(); // entry + first ISR NOP
    expect(s.registers.pc).toBe(0x5001);
    expect(s.cycles - c0).toBe(9 + 1);
    expect(s.registers.ipl).toBe(1);
    expect(s.registers.ccr & I).toBe(I);
    expect(s.readBlock(STACK - 10, 2)).toEqual([0x00, 0x00]); // stacked CCRW = IPL 0, CCR 0
  });
  it('level from INT_CFDATA (via INT_CFADDR); level 0 disables; level must exceed IPL', () => {
    const s = sys();
    // Port J ($CE) is INT_CFADDR=$C0, INT_CFDATA7
    s.poke(0x0127, 0xc0);
    expect(s.peek(0x012f)).toBe(0x01);
    s.poke(0x012f, 0x00);
    s.requestInterrupt(0xce);
    s.step();
    expect(s.registers.pc).toBe(CODE + 1); // disabled
    s.poke(0x012f, 0x04);
    s.setRegisters({ ipl: 4 });
    s.step();
    expect(s.registers.pc).toBe(CODE + 2); // 4 is not > 4
    s.setRegisters({ ipl: 3 });
    s.step();
    expect([s.registers.pc, s.registers.ipl]).toEqual([0x5001, 4]);
  });
  it('equal levels: higher vector address wins; higher level beats higher address', () => {
    const s = sys();
    s.requestInterrupt(0xce);
    s.requestInterrupt(0xf0);
    s.step();
    expect(s.registers.pc).toBe(0x5101); // RTI ($FFF0) > Port J ($FFCE)
    const t = sys();
    t.poke(0x0127, 0xc0);
    t.poke(0x012f, 0x06); // Port J level 6
    t.requestInterrupt(0xce);
    t.requestInterrupt(0xf0);
    t.step();
    expect(t.registers.pc).toBe(0x5001);
  });
  it('nesting: CLI in an ISR lets only higher-level requests in; RTI restores the IPL', () => {
    const s = sys();
    put(s, 0x5000, [0x10, 0xef, 0xa7, 0xa7, 0x0b]); // ISR(PortJ): CLI; NOP; NOP; RTI
    put(s, 0x5200, [0xa7, 0x0b]); // ISR(TC0): NOP; RTI
    s.poke(0x0127, 0xe0);
    s.poke(0x0128 + 7, 0x05); // TC0 ($EE): CFADDR $E0, slot 7 -> level 5
    s.requestInterrupt(0xce); // level 1
    s.step(); // enter PortJ + CLI
    expect(s.registers.ipl).toBe(1);
    s.clearInterrupt(0xce);
    s.requestInterrupt(0xf0); // RTI level 1: must NOT nest (1 <= IPL 1)
    s.requestInterrupt(0xee); // TC0 level 5: nests
    s.step(); // NOP after CLI always executes
    expect(s.registers.pc).toBe(0x5003);
    s.step(); // nested entry (TC0, level 5) + its first NOP
    expect([s.cpu.lastVector, s.registers.ipl, s.registers.pc]).toEqual([0xee, 5, 0x5201]);
    s.clearInterrupt(0xee);
    s.step(); // RTI of TC0: back in PortJ ISR at IPL 1; RTI request (level 1) still not taken
    expect([s.registers.pc, s.registers.ipl]).toEqual([0x5003, 1]);
    s.step(); // NOP
    s.step(); // RTI of PortJ: IPL back to 0 -> pending RTI request taken at once (re-vector)
    expect(s.cpu.lastVector).toBe(0xf0);
    expect(s.registers.ipl).toBe(1);
  });
  it('RTI with another interrupt pending re-vectors in 10 cycles without re-stacking', () => {
    const s = sys();
    put(s, 0x5000, [0x0b]);
    s.requestInterrupt(0xce);
    s.step(); // enter + RTI? no: entry then executes RTI as first instruction
    // The RTI already ran: PortJ still asserted -> re-vector to PortJ
    expect(s.cpu.lastVector).toBe(0xce);
    expect(s.registers.sp).toBe(STACK - 10);
    expect(s.registers.pc).toBe(0x5000);
    s.clearInterrupt(0xce);
    const c0 = s.cycles;
    s.step();
    expect(s.cycles - c0).toBe(8);
    expect(s.registers.pc).toBe(CODE);
    s.requestInterrupt(0xf0);
    s.setRegisters({ pc: 0x5000, sp: STACK - 10, ccr: I, ipl: 1 });
    const c1 = s.cycles;
    s.step();
    expect(s.cycles - c1).toBe(10);
    expect([s.registers.pc, s.registers.sp, s.cpu.lastVector]).toEqual([0x5100, STACK - 10, 0xf0]);
  });
  it('CLI delay: the instruction after CLI executes before a pending interrupt', () => {
    const s = sys();
    put(s, CODE, [0x10, 0xef, 0x86, 0x42, 0xa7]); // CLI; LDAA #$42; NOP
    s.setRegisters({ ccr: I });
    s.requestInterrupt(0xce);
    s.step(); // CLI
    s.step(); // LDAA executes
    expect(s.registers.a).toBe(0x42);
    s.step();
    expect(s.cpu.lastVector).toBe(0xce);
    expect(getW(s, STACK - 2)).toBe(CODE + 4);
  });
  it('XIRQ: masked by X only, sets X and I, IPL unchanged', () => {
    const s = sys();
    s.setRegisters({ ccr: X | I, ipl: 2 });
    s.requestInterrupt(0xf4);
    s.step();
    expect(s.registers.pc).toBe(CODE + 1);
    s.setRegisters({ ccr: I });
    s.step();
    expect([s.registers.pc, s.registers.ccr & (X | I), s.registers.ipl]).toEqual([0x5301, X | I, 2]);
  });
  it('IVBR relocates maskable vectors', () => {
    const s = sys();
    s.poke(0x0121, 0x70);
    putW(s, 0x70ce, 0x5600);
    put(s, 0x5600, [0xa7]);
    s.requestInterrupt(0xce);
    s.step();
    expect(s.registers.pc).toBe(0x5601);
  });
  it('spurious interrupt: the request disappears while stacking -> vector IVBR:$10', () => {
    const s = sys();
    vec(s, 0xff10, 0x5500);
    put(s, 0x5500, [0xa7]);
    // A peripheral whose registers receive the stacked frame and withdraw the request on write.
    s.addPeripheral(
      { name: 'withdraw', reset() {}, read: () => 0, write: () => s.clearInterrupt(0xce) },
      [[0x300, 0x30f]],
    );
    s.setRegisters({ sp: 0x0310 });
    s.requestInterrupt(0xce);
    s.step();
    expect([s.cpu.lastVector, s.registers.pc, s.registers.ipl]).toEqual([0x10, 0x5501, 0]);
  });
  it('event-driven peripheral interrupt fires at the exact cycle', () => {
    const s = sys();
    const p = new OneShot(0xce, 0x200);
    s.addPeripheral(p, [[0x200, 0x200]]);
    p.arm(25);
    const start = s.cycles;
    s.run(30);
    expect(p.firedAt - start).toBe(25);
    expect(s.cpu.lastVector).toBe(0xce);
  });
});

describe('WAI / STOP / BGND', () => {
  it('WAI stacks immediately, lets time pass to the next event, wakes with fVfPPP (no re-stack)', () => {
    const s = mk();
    vec(s, 0xffce, 0x5000);
    put(s, 0x5000, [0x20, 0xfe]); // BRA *
    put(s, CODE, [0x3e]);
    const p = new OneShot(0xce, 0x200);
    s.addPeripheral(p, [[0x200, 0x200]]);
    const c0 = s.cycles;
    s.step(); // WAI
    expect(s.cycles - c0).toBe(7);
    expect(s.runState).toBe('wait');
    expect(s.registers.sp).toBe(STACK - 10);
    p.arm(1000);
    expect(s.run(100)).toBe('limit'); // nothing yet: time passes
    expect(s.cycles - c0).toBe(107);
    s.run(2000);
    expect(s.runState).toBe('run');
    expect(p.firedAt - c0).toBe(1007);
    expect(s.registers.sp).toBe(STACK - 10);
    expect(getW(s, STACK - 2)).toBe(CODE + 1);
  });
  it('WAI with nothing scheduled: haltWhenIdle returns wait-idle', () => {
    const s = mk({ haltWhenIdle: true });
    put(s, CODE, [0x3e]);
    expect(s.run(1000)).toBe('wait-idle');
  });
  it('STOP is a 2-cycle NOP when S = 1; otherwise stops all clocks until an interrupt', () => {
    const s = mk();
    put(s, CODE, [0x18, 0x3e, 0x18, 0x3e]);
    vec(s, 0xffce, 0x5000);
    s.setRegisters({ ccr: S });
    const c0 = s.cycles;
    s.step();
    expect([s.cycles - c0, s.registers.pc]).toEqual([2, CODE + 2]);
    s.setRegisters({ ccr: 0 });
    s.step();
    expect(s.runState).toBe('stop');
    const c1 = s.cycles;
    expect(s.run(1000)).toBe('stop');
    expect(s.cycles).toBe(c1); // clocks stopped
    s.requestInterrupt(0xce);
    s.run(10);
    expect(s.cpu.lastVector).toBe(0xce);
  });
  it('STOP: XIRQ with X = 1 resumes after STOP', () => {
    const s = mk();
    put(s, CODE, [0x18, 0x3e, 0xa7]);
    s.setRegisters({ ccr: X });
    s.step();
    s.requestInterrupt(0xf4);
    s.step();
    expect([s.runState, s.registers.sp]).toEqual(['run', STACK]);
  });
  it('BGND halts with reason bgnd (PC past it, TMP2 = PC); NOP when BDM is disabled', () => {
    const s = mk();
    put(s, CODE, [0xa7, 0x00, 0xa7]);
    expect(s.run(100)).toBe('bgnd');
    expect([s.registers.pc, s.registers.tmp2]).toEqual([CODE + 2, CODE + 2]);
    const t = mk({ bdm: false });
    put(t, CODE, [0x00, 0x20, 0xfe]);
    expect(t.run(100)).toBe('limit');
  });
  it('uninitialized vector can halt the run', () => {
    const s = mk({ haltOnUninitializedVector: true });
    put(s, CODE, [0x3f]);
    expect(s.run(100)).toBe('uninitialized-vector');
    expect(s.registers.pc).toBe(0xffff);
  });
});

describe('flags sanity', () => {
  it('constants', () => {
    expect(C | Z | N).toBe(13);
  });
});

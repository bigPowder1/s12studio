/** Regression tests for review round 1: run/step control, ctx.sync timing, reset clock, S-record auto, C8. */
import { describe, expect, it } from 'vitest';
import { S12XSystem, type Peripheral, type PeripheralContext, type SimEvent } from '@s12/sim';
import { CODE, mk, put, putW } from './helpers';

const NOP = 0xa7;
const BRA_SELF = [0x20, 0xfe];

describe('breakpoint resume (finding 1)', () => {
  it('a breakpoint at the PC of a limit halt is hit by the next run', () => {
    const s = mk();
    put(s, CODE, [NOP, NOP, NOP, ...BRA_SELF]);
    s.addBreakpoint(CODE + 2);
    expect(s.run(2)).toBe('limit'); // one NOP (1 cycle) + ... stops with PC on the breakpoint
    expect(s.registers.pc).toBe(CODE + 2);
    expect(s.run(100)).toBe('breakpoint');
    expect(s.registers.pc).toBe(CODE + 2);
  });
  it('a breakpoint right after a watchpoint halt is hit by the resume', () => {
    const s = mk();
    put(s, CODE, [0x7a, 0x21, 0x00, NOP, ...BRA_SELF]); // STAA $2100 ; NOP
    s.addWatchpoint({ start: 0x2100, end: 0x2100, kind: 'write', space: 'local' });
    s.addBreakpoint(CODE + 3);
    expect(s.run(100)).toBe('watchpoint');
    expect(s.registers.pc).toBe(CODE + 3);
    expect(s.run(100)).toBe('breakpoint');
    expect(s.registers.pc).toBe(CODE + 3);
  });
  it('resuming from a breakpoint skips it exactly once, even across an empty run slice', () => {
    const s = mk();
    // loop: NOP ; BRA loop
    put(s, CODE, [NOP, 0x20, 0xfd]);
    s.addBreakpoint(CODE);
    s.setRegisters({ pc: CODE + 1 });
    expect(s.run(100)).toBe('breakpoint');
    const c0 = s.cycles;
    expect(s.run(0)).toBe('limit'); // nothing executed: the skip must survive
    expect(s.run(100)).toBe('breakpoint');
    expect(s.cycles - c0).toBe(1 + 3); // NOP + BRA, back at the breakpoint
  });
  it('step() after a breakpoint consumes the skip; moving PC away and back re-arms the breakpoint', () => {
    const s = mk();
    put(s, CODE, [NOP, NOP, 0x20, 0xfc]); // NOP ; NOP ; BRA CODE
    s.addBreakpoint(CODE + 1);
    expect(s.run(100)).toBe('breakpoint');
    s.setRegisters({ pc: CODE });
    s.setRegisters({ pc: CODE + 1 });
    expect(s.run(100)).toBe('breakpoint');
    expect(s.cycles).toBeGreaterThan(0);
    const c0 = s.cycles;
    expect(s.run(100)).toBe('breakpoint'); // skip, loop once, hit again
    expect(s.cycles - c0).toBe(1 + 3 + 1);
    expect(s.step()).toBe('step');
    expect(s.registers.pc).toBe(CODE + 2);
  });
  it('setRegisters with an unchanged PC keeps the skip (register window write-back)', () => {
    const s = mk();
    put(s, CODE, [NOP, NOP, ...BRA_SELF]);
    s.addBreakpoint(CODE + 1);
    expect(s.run(100)).toBe('breakpoint');
    s.setRegisters({ ...s.registers });
    expect(s.run(50)).toBe('limit');
  });
});

describe('requestHalt between runs (finding 9c)', () => {
  it('is honoured by the next run() without executing anything; step() discards it', () => {
    const s = mk();
    put(s, CODE, [NOP, ...BRA_SELF]);
    s.requestHalt();
    const c0 = s.cycles;
    expect(s.run(100)).toBe('halt');
    expect(s.cycles).toBe(c0);
    expect(s.run(10)).toBe('limit');
    s.requestHalt();
    expect(s.step()).toBe('step');
    expect(s.run(10)).toBe('limit');
  });
});

describe('step() in WAIT (finding 2)', () => {
  it('with no peripheral event returns wait-idle without advancing time', () => {
    const s = mk();
    put(s, CODE, [0x3e, NOP]); // WAI ; NOP
    expect(s.step()).toBe('step');
    const c0 = s.cycles;
    expect(s.step()).toBe('wait-idle');
    expect(s.cycles).toBe(c0);
    expect(s.runState).toBe('wait');
  });
  it('with a scheduled interrupt advances exactly to it and enters the ISR', () => {
    const s = mk();
    let ctx!: PeripheralContext;
    let elapsed = 0;
    let fired = false;
    const timer: Peripheral = {
      name: 'timer',
      attach(c) {
        ctx = c;
      },
      reset() {
        elapsed = 0;
        fired = false;
      },
      read: () => 0,
      write() {},
      tick(n) {
        elapsed += n;
        if (!fired && elapsed >= 100) {
          fired = true;
          ctx.requestInterrupt(0xf0);
        }
      },
      nextEventCycles: () => (fired ? Infinity : 100 - elapsed),
    };
    s.addPeripheral(timer, [[0x7f0, 0x7f0]]);
    s.reset();
    putW(s, 0xfff0, 0x4100);
    put(s, 0x4100, [NOP, ...BRA_SELF]);
    put(s, CODE, [0x3e, NOP]);
    s.setRegisters({ sp: 0x3f00, pc: CODE, ccr: 0, ipl: 0 });
    const c0 = s.cycles;
    expect(s.step()).toBe('step'); // WAI stacks the frame
    expect(s.step()).toBe('step'); // wakes at +100, vectors, executes the ISR's NOP
    expect(s.registers.pc).toBe(0x4101);
    expect(s.cycles - c0).toBeGreaterThanOrEqual(100);
    expect(s.cycles - c0).toBeLessThan(120);
  });
});

describe('ctx.sync() timing (finding 6)', () => {
  it('syncs to the time of the access being dispatched, not the instruction start', () => {
    const s = mk();
    let ctxA!: PeripheralContext;
    let ctxB!: PeripheralContext;
    const seen: number[] = [];
    let bTo = 0;
    s.addPeripheral(
      {
        name: 'a',
        attach: (c) => (ctxA = c),
        reset() {},
        read: () => 0,
        write() {
          seen.push(ctxA.now);
          ctxB.sync();
        },
      },
      [[0x40, 0x40]],
    );
    s.addPeripheral(
      {
        name: 'b',
        attach: (c) => (ctxB = c),
        reset() {},
        read: () => 0,
        write() {},
        tick() {
          bTo = ctxB.now;
        },
      },
      [[0x41, 0x41]],
    );
    // MOVB #$01,$0040 (ext dest: 'OPwP' -> write at cycle 2 of the instruction)
    put(s, CODE, [0x18, 0x0b, 0x01, 0x00, 0x40, ...BRA_SELF]);
    const t0 = s.totalCycles;
    s.step();
    expect(seen).toEqual([t0 + 2]);
    expect(bTo).toBe(t0 + 2);
  });
});

describe('reset restores the bus clock (finding 7)', () => {
  it('busHz returns to oscHz/2 after a reset even without a CRG model', () => {
    const s = new S12XSystem({ oscHz: 16e6 });
    s.bus.setBusClockHz(40e6);
    expect(s.busHz).toBe(40e6);
    s.reset();
    expect(s.busHz).toBe(8e6);
  });
});

describe('loadSrec auto addressing (finding 8)', () => {
  const s2 = (addr: number, data: number[]) => {
    const body = [4 + data.length, (addr >> 16) & 0xff, (addr >> 8) & 0xff, addr & 0xff, ...data];
    const sum = ~body.reduce((x, y) => x + y, 0) & 0xff;
    return `S2${[...body, sum].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}\r\n`;
  };
  it('treats S2 addresses <= $FFFF as local, $10000-$7FFFFF as global, larger as logical', () => {
    const s = new S12XSystem();
    const r = s.loadSrec(s2(0x00c000, [0x12]) + s2(0x0fe100, [0x34]) + s2(0xe08000, [0x56]));
    expect(r.skipped).toBe(0);
    expect(s.peekGlobal(0x7fc000)).toBe(0x12);
    expect(s.peekGlobal(0x0fe100)).toBe(0x34);
    expect(s.peekGlobal(0x780000)).toBe(0x56);
  });
});

describe('misaligned word access to the top of an on-chip block (C8, finding 9a)', () => {
  const run = (code: number[], regs: Record<string, number> = {}) => {
    const s = mk({ breakOnIllegalAccess: true });
    put(s, CODE, [...code, ...BRA_SELF]);
    s.setRegisters({ pc: CODE, ...regs });
    return { s, r: s.run(50) };
  };
  it('RAM top ($3FFF -> $0FFFFF): word read and write are illegal, aligned / byte accesses are not', () => {
    const rd = run([0xfc, 0x3f, 0xff]); // LDD $3FFF
    expect(rd.r).toBe('illegal-access');
    expect(rd.s.registers.pc).toBe(CODE);
    expect(rd.s.bus.lastIllegal).toMatchObject({ global: 0x0fffff, local: 0x3fff, access: 'read' });
    expect(run([0x7c, 0x3f, 0xff]).r).toBe('illegal-access'); // STD $3FFF
    expect(run([0xfc, 0x3f, 0xfe]).r).toBe('limit'); // LDD $3FFE
    expect(run([0xb6, 0x3f, 0xff]).r).toBe('limit'); // LDAA $3FFF
    expect(run([0xfc, 0x3b, 0xff]).r).toBe('limit'); // LDD $3BFF: inside RAM
  });
  it('register block top ($07FF) and EEPROM top ($0FFF -> $13FFFF) are illegal; flash top ($FFFF) is not', () => {
    expect(run([0xfc, 0x07, 0xff]).r).toBe('illegal-access');
    const ee = run([0xfc, 0x0f, 0xff]);
    expect(ee.r).toBe('illegal-access');
    expect(ee.s.bus.lastIllegal?.global).toBe(0x13ffff);
    expect(run([0xfc, 0xff, 0xff]).r).toBe('limit');
    expect(run([0xfc, 0x7f, 0xff]).r).toBe('limit'); // flash $7F7FFF
  });
  it('stack pushes and G-instructions are checked too', () => {
    expect(run([0x3b], { sp: 0x4001 }).r).toBe('illegal-access'); // PSHD -> word at $3FFF
    // MOVB #$0F,GPAGE ; GLDD $FFFF -> global $0FFFFF
    expect(run([0x18, 0x0b, 0x0f, 0x00, 0x10, 0x18, 0xfc, 0xff, 0xff]).r).toBe('illegal-access');
    expect(run([0x18, 0x0b, 0x0f, 0x00, 0x10, 0x18, 0xfc, 0xff, 0xfe]).r).toBe('limit');
  });
  it('resets by default, with a distinct event message', () => {
    const s = mk();
    putW(s, 0xfffe, 0xc000);
    put(s, 0xc000, [NOP, ...BRA_SELF]);
    put(s, CODE, [0xfc, 0x3f, 0xff]);
    s.setRegisters({ pc: CODE });
    const ev: SimEvent[] = [];
    s.onEvent((e) => ev.push(e));
    s.run(30);
    expect(s.registers.pc).toBe(0xc001);
    const ill = ev.find((e) => e.kind === 'illegal-access')!;
    expect(ill.message).toContain('misaligned word read');
    expect(ev.some((e) => e.kind === 'reset' && e.data?.cause === 'illegal-address')).toBe(true);
  });
});

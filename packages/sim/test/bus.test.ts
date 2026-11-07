/** MMC mapping, register dispatch, illegal access, warnings, peripheral timing, debug hooks, snapshots. */
import { describe, expect, it } from 'vitest';
import { S12XSystem, type Peripheral, type PeripheralContext, type SimEvent } from '@s12/sim';
import { CODE, STACK, getW, mk, put, putW } from './helpers';

describe('MMC local -> global mapping', () => {
  it('reset windows: EEPROM $0800 (EPAGE $FE), RAM $1000 (RPAGE $FD), fixed RAM/flash, PPAGE window', () => {
    const s = new S12XSystem();
    expect(s.toGlobal(0x0800)).toBe(0x13f800);
    expect(s.toGlobal(0x0c00)).toBe(0x13fc00);
    expect(s.toGlobal(0x1000)).toBe(0x0fd000);
    expect(s.toGlobal(0x2000)).toBe(0x0fe000);
    expect(s.toGlobal(0x3fff)).toBe(0x0fffff);
    expect(s.toGlobal(0x4000)).toBe(0x7f4000);
    expect(s.toGlobal(0x8000)).toBe(0x7f8000);
    expect(s.toGlobal(0xc000)).toBe(0x7fc000);
    s.poke(0x17, 0xfc);
    s.poke(0x16, 0xf8);
    s.poke(0x30, 0xe0);
    expect([s.toGlobal(0x0800), s.toGlobal(0x1000), s.toGlobal(0x8000)]).toEqual([0x13f000, 0x0f8000, 0x780000]);
  });
  it('executes library code from the EEPROM window at $0800 with EPAGE = $FE', () => {
    const s = mk();
    // JSR $0800 ; BRA * ; EEPROM page $FE: LDAA #$5A ; RTS
    put(s, CODE, [0x16, 0x08, 0x00, 0x20, 0xfe]);
    s.pokeGlobal(0x13f800, 0x86);
    s.pokeGlobal(0x13f801, 0x5a);
    s.pokeGlobal(0x13f802, 0x3d);
    s.run(30);
    expect(s.registers.a).toBe(0x5a);
    expect(s.registers.pc).toBe(CODE + 3);
    // EPAGE $FC maps a different page into the window
    s.pokeGlobal(0x13f000, 0x86);
    s.pokeGlobal(0x13f001, 0x77);
    s.pokeGlobal(0x13f002, 0x3d);
    s.poke(0x17, 0xfc);
    s.setRegisters({ pc: CODE, sp: STACK });
    s.run(30);
    expect(s.registers.a).toBe(0x77);
  });
  it('RAM window and fixed RAM alias the same global bytes', () => {
    const s = mk();
    put(s, CODE, [0x86, 0x99, 0x7a, 0x10, 0x00, 0xb6, 0x30, 0x00]); // LDAA #$99; STAA $1000; LDAA $3000
    s.poke(0x16, 0xff); // RPAGE $FF: $1000 -> $0FF000 = fixed $3000
    s.step();
    s.step();
    s.setRegisters({ a: 0 });
    s.step();
    expect(s.registers.a).toBe(0x99);
  });
  it('RPAGE = 0 maps registers into the RAM window (datasheet caveat)', () => {
    const s = mk();
    s.poke(0x16, 0x00);
    put(s, CODE, [0xb6, 0x10, 0x30]); // LDAA $1030 -> global $000030 = PPAGE
    s.step();
    expect(s.registers.a).toBe(0xfe);
  });
  it('DIRECT relocates direct addressing; write-once in normal mode', () => {
    const s = mk({ mode: 'normal' });
    s.poke(0x11, 0x21);
    s.poke(0x11, 0x22); // ignored in normal mode (debugger poke goes through the register path too)
    expect(s.peek(0x11)).toBe(0x21);
    put(s, CODE, [0x96, 0x05]);
    s.poke(0x2105, 0x3c);
    s.step();
    expect(s.registers.a).toBe(0x3c);
  });
  it('flash/EEPROM are read-only to CPU writes (warning) but writable by the loader', () => {
    const s = mk();
    const ev: SimEvent[] = [];
    s.onEvent((e) => ev.push(e));
    put(s, CODE, [0x86, 0x12, 0x7a, 0xc0, 0x00, 0x7a, 0x0c, 0x00]);
    s.run(8);
    expect(s.peek(0xc000)).toBe(0xff);
    expect(s.peek(0x0c00)).toBe(0xff);
    expect(ev.filter((e) => e.kind === 'rom-write').map((e) => e.global)).toEqual([0x7fc000, 0x13fc00]);
    s.poke(0xc000, 0x12);
    expect(s.peek(0xc000)).toBe(0x12);
  });
});

describe('illegal access (critique C8)', () => {
  const prog = (s: S12XSystem) => {
    putW(s, 0xfffe, 0xc000);
    put(s, 0xc000, [0xa7, 0x20, 0xfe]);
    s.poke(0x16, 0x00); // RPAGE 0
    put(s, CODE, [0x86, 0x01, 0xb6, 0x18, 0x00]); // LDAA #1 ; LDAA $1800 -> global $000800 unimplemented
    s.setRegisters({ pc: CODE });
  };
  it('performs an illegal-address reset (CRGINT.ILAF set) by default', () => {
    const s = mk();
    prog(s);
    const ev: SimEvent[] = [];
    s.onEvent((e) => ev.push(e));
    s.run(20);
    expect(s.registers.pc).toBe(0xc001); // reset to $C000: NOP ; BRA *
    expect(s.peek(0x16)).toBe(0xfd); // MMC reset
    expect(s.peek(0x38) & 0x40).toBe(0x40);
    const ill = ev.find((e) => e.kind === 'illegal-access')!;
    expect(ill).toMatchObject({ address: 0x1800, global: 0x000800, access: 'read', pc: CODE + 2 });
    expect(ill.message).toContain('illegal access reset');
    expect(ev.some((e) => e.kind === 'reset' && e.data?.cause === 'illegal-address')).toBe(true);
  });
  it('break-on-illegal halts at the faulting instruction instead', () => {
    const s = mk({ breakOnIllegalAccess: true });
    prog(s);
    expect(s.run(20)).toBe('illegal-access');
    expect(s.registers.pc).toBe(CODE + 2);
    expect(s.bus.lastIllegal).toMatchObject({ global: 0x800, access: 'read' });
  });
  it('fetching from an unimplemented page is illegal too (PPAGE $00)', () => {
    const s = mk({ breakOnIllegalAccess: true });
    put(s, CODE, [0x06, 0x80, 0x00]); // JMP $8000
    s.poke(0x30, 0x00);
    expect(s.run(20)).toBe('illegal-access');
    expect(s.bus.lastIllegal?.access).toBe('fetch');
  });
});

describe('register block', () => {
  it('unimplemented-register access logs an FCS warning (once per address by default) and acts as RAM', () => {
    const s = mk();
    const ev: SimEvent[] = [];
    s.onEvent((e) => ev.push(e));
    put(s, CODE, [0x96, 0x44, 0x96, 0x44, 0x5a, 0x4e]); // LDAA TCNT ; LDAA TCNT ; STAA TFLG1
    s.run(8);
    const w = ev.filter((e) => e.kind === 'unimplemented-register');
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ address: 0x44, access: 'read', register: 'TCNT', pc: CODE });
    expect(w[0].message).toBe('FCS Warning (ID 12): reading from unimplemented register 0x0044 (TCNT)');
    expect(w[1].message).toContain('writing to unimplemented register 0x004E (TFLG1)');
  });
  it('unclaimed registers start at their device reset values', () => {
    const s = mk();
    expect(s.peek(0x0c)).toBe(0xd0); // PUCR
    expect(s.peek(0x1e)).toBe(0x40); // IRQCR
    expect((s.peek(0x1a) << 8) | s.peek(0x1b)).toBe(0xc410); // PARTID (read-only)
    s.poke(0x1a, 0);
    expect(s.peek(0x1a)).toBe(0xc4);
  });
  it('dispatches to a registered peripheral with the exact access cycle (STD TC1 / LDD TCNT style)', () => {
    const s = mk();
    const log: Array<[string, number, number]> = [];
    let ctx!: PeripheralContext;
    const p: Peripheral = {
      name: 'probe',
      attach: (c) => (ctx = c),
      reset() {},
      read(a) {
        log.push(['r', a, ctx.now]);
        return 0;
      },
      write(a, v) {
        log.push(['w', a, ctx.now]);
        void v;
      },
    };
    s.addPeripheral(p, [[0x40, 0x7f]]);
    // MOVB #$B0,TSCR1 (dir dest 'OPwP': write at cycle 2) ; LDD TCNT ('RPf': read at 0) ; STD TC1 ('PW': write at 1)
    // BRCLR TFLG1,#2,* ('rPPP') ; MOVW $2100,TC2 (ext->ext 'ORPWPO': write at 3)
    put(s, CODE, [0x18, 0x0b, 0xb0, 0x00, 0x46, 0xdc, 0x44, 0x5c, 0x52, 0x4f, 0x4e, 0x02, 0x00, 0x18, 0x04, 0x21, 0x00, 0x00, 0x54]);
    const t0 = s.cycles;
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      times.push(s.cycles - t0);
      s.step();
    }
    const rel = log.map(([k, a, t]) => [k, a, t - t0]);
    expect(rel).toEqual([
      ['w', 0x46, times[0] + 2],
      ['r', 0x44, times[1] + 0],
      ['r', 0x45, times[1] + 0],
      ['w', 0x52, times[2] + 1],
      ['w', 0x53, times[2] + 1],
      ['r', 0x4e, times[3] + 0],
      ['w', 0x54, times[4] + 3],
      ['w', 0x55, times[4] + 3],
    ]);
  });
  it('a ticking peripheral is advanced lazily but exactly (free-running counter read)', () => {
    const s = mk();
    let count = 0;
    let ticks = 0;
    s.addPeripheral(
      {
        name: 'counter',
        reset() {
          count = 0;
        },
        read: (a) => (a === 0x44 ? (count >> 8) & 0xff : count & 0xff),
        write() {},
        tick(n) {
          ticks++;
          count = (count + n) & 0xffff;
        },
      },
      [[0x44, 0x45]],
    );
    const nops = Array(100).fill(0xa7);
    put(s, CODE, [...nops, 0xdc, 0x44, 0x20, 0xfe]); // 100 NOPs, LDD $44
    const t0 = s.cycles;
    for (let i = 0; i < 101; i++) s.step();
    expect(s.registers.d).toBe((t0 + 100) & 0xffff);
    expect(ticks).toBe(1); // one catch-up tick, not one per instruction
  });
  it('XINT registers: IVBR, INT_CFADDR window and INT_CFDATA levels', () => {
    const s = mk();
    expect(s.peek(0x0127)).toBe(0x10); // CFADDR reset (UNCERTAIN in device table)
    s.poke(0x0127, 0xf0);
    expect(s.peek(0x0128 + 1)).toBe(0x01); // IRQ ($F2) is configurable
    expect(s.peek(0x0128 + 2)).toBe(0x00); // XIRQ ($F4) is not
    s.poke(0x0128 + 1, 0x87);
    expect(s.peek(0x0128 + 1)).toBe(0x87);
  });
});

describe('uninitialized RAM tracking', () => {
  it('RAM is uu until written; zero/random/uninitialized power-up modes', () => {
    const s = new S12XSystem();
    expect(s.isInitialized(0x2100)).toBe(false);
    expect(s.isInitialized(0xc000)).toBe(true);
    s.poke(0x2100, 1);
    expect(s.isInitialized(0x2100)).toBe(true);
    const r = new S12XSystem({ ramInit: 'random', ramSeed: 7 });
    const block = r.readBlock(0x2000, 64);
    expect(new Set(block).size).toBeGreaterThan(20);
    expect(r.isInitialized(0x2000)).toBe(false);
    const z = new S12XSystem({ ramInit: 'zero' });
    expect([z.peek(0x2000), z.isInitialized(0x2000)]).toEqual([0, true]);
  });
  it('optional uninitialized-read warnings', () => {
    const s = new S12XSystem({ warnUninitializedReads: true });
    s.setRegisters({ pc: CODE, sp: STACK });
    put(s, CODE, [0xb6, 0x21, 0x00, 0xb6, 0x21, 0x01]);
    s.poke(0x2101, 5);
    s.step();
    s.step();
    const w = s.events.filter((e) => e.kind === 'uninitialized-read');
    expect(w.map((e) => e.address)).toEqual([0x2100]);
  });
  it('CPU writes mark RAM initialized; power-on clears it; other resets keep it', () => {
    const s = mk({ ramInit: 'uninitialized' });
    put(s, CODE, [0x86, 0x01, 0x7a, 0x21, 0x00]);
    s.run(4);
    expect(s.isInitialized(0x2100)).toBe(true);
    s.reset('external');
    expect([s.isInitialized(0x2100), s.peek(0x2100)]).toEqual([true, 1]);
    s.powerOn();
    expect(s.isInitialized(0x2100)).toBe(false);
  });
});

describe('debug hooks', () => {
  it('breakpoints stop before the instruction; resuming does not re-hit the same one', () => {
    const s = mk();
    put(s, CODE, [0xa7, 0xa7, 0xa7, 0x20, 0xfa]); // NOP x3 ; BRA CODE-? (loop to CODE+0? -> CODE)
    put(s, CODE + 3, [0x20, 0xfb]); // BRA CODE
    s.addBreakpoint(CODE + 2);
    expect(s.run(1000)).toBe('breakpoint');
    expect(s.registers.pc).toBe(CODE + 2);
    expect(s.run(1000)).toBe('breakpoint');
    expect(s.registers.pc).toBe(CODE + 2);
    s.removeBreakpoint(CODE + 2);
    expect(s.run(50)).toBe('limit');
  });
  it('global-qualified breakpoint in a paged window only hits on the right page', () => {
    const s = mk();
    put(s, CODE, [0x4a, 0x80, 0x00, 0xe1, 0x20, 0xfe]); // CALL $8000,$E1 ; BRA *
    s.pokeGlobal(0x784000, 0x0a); // $E1:8000 = RTC
    s.addBreakpoint(0x8000, 0x780000); // page $E0 only
    expect(s.run(100)).toBe('limit');
    s.setRegisters({ pc: CODE, sp: STACK });
    s.addBreakpoint(0x8000, 0x784000);
    expect(s.run(100)).toBe('breakpoint');
  });
  it('watchpoints (read / write / range / local space) halt after the access', () => {
    const s = mk();
    put(s, CODE, [0xb6, 0x21, 0x00, 0x7a, 0x21, 0x05, 0xa7, 0x20, 0xfe]);
    const w = s.addWatchpoint({ start: 0x0fe100, end: 0x0fe10f, kind: 'write' });
    expect(s.run(100)).toBe('watchpoint');
    expect(s.registers.pc).toBe(CODE + 6);
    expect(s.lastWatchHit).toMatchObject({ global: 0x0fe105, local: 0x2105, access: 'write', pc: CODE + 3 });
    s.removeWatchpoint(w);
    s.setRegisters({ pc: CODE });
    s.addWatchpoint({ start: 0x2100, end: 0x2100, kind: 'read', space: 'local' });
    expect(s.run(100)).toBe('watchpoint');
    expect(s.registers.pc).toBe(CODE + 3);
  });
  it('watchpoint on a register address', () => {
    const s = mk();
    put(s, CODE, [0x4c, 0x40, 0x02, 0x20, 0xfe]); // BSET TIOS,#2
    s.addWatchpoint({ start: 0x40, end: 0x40, kind: 'readwrite' });
    expect(s.run(100)).toBe('watchpoint');
    expect(s.lastWatchHit?.access).toBe('read');
  });
  it('access tracer sees data accesses (not fetches)', () => {
    const s = mk();
    const t: string[] = [];
    s.setTracer((k, l, _g, v) => t.push(`${k} ${l.toString(16)} ${v.toString(16)}`));
    put(s, CODE, [0x18, 0x0c, 0x21, 0x00, 0x21, 0x01]);
    s.poke(0x2100, 0x42);
    s.step();
    s.setTracer(null);
    expect(t).toEqual(['read 2100 42', 'write 2101 42']);
  });
  it('requestHalt stops a run', () => {
    const s = mk();
    put(s, CODE, [0x20, 0xfe]);
    s.addPeripheral(
      { name: 'h', reset() {}, read: () => 0, write() {}, tick: () => s.requestHalt(), nextEventCycles: () => 500 },
      [[0x300, 0x300]],
    );
    expect(s.run(10000)).toBe('halt');
  });
  it('cycle counter: resettable, BigInt view, simulated time', () => {
    const s = mk();
    put(s, CODE, [0x20, 0xfe]);
    s.run(1000);
    expect(s.cycles).toBeGreaterThanOrEqual(1000);
    s.resetCycleCounter();
    expect(s.cycles).toBe(0);
    s.run(3);
    expect(s.cyclesBig).toBe(3n);
    expect(s.busHz).toBe(8_000_000);
    expect(s.simTimeSeconds).toBeCloseTo(s.totalCycles / 8e6, 12);
  });
  it('snapshot / restore reproduces state exactly', () => {
    const s = mk();
    let n = 0;
    s.addPeripheral(
      {
        name: 'cnt',
        reset() {
          n = 0;
        },
        read: () => n & 0xff,
        write() {},
        tick(k) {
          n += k;
        },
        snapshot: () => n,
        restore: (v) => {
          n = v as number;
        },
      },
      [[0x300, 0x300]],
    );
    put(s, CODE, [0xb6, 0x03, 0x00, 0x7a, 0x21, 0x00, 0x08, 0x20, 0xf7]);
    s.run(50);
    const snap = s.snapshot();
    const r1 = s.registers;
    s.run(500);
    const after = [s.registers, s.peek(0x2100), s.cycles];
    s.restore(snap);
    expect(s.registers).toEqual(r1);
    s.run(500);
    expect([s.registers, s.peek(0x2100), s.cycles]).toEqual(after);
    expect(getW(s, 0) >= 0).toBe(true);
  });
});

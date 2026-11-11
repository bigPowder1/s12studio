/**
 * Regression tests for the ME3305 board-model review findings: undriven pins, history cost, LCD reset glitches,
 * keypad rollover/tap/snapshot/powerOn, LCD mid-transfer snapshots, MCP4922 long frames.
 */
import { describe, it, expect } from 'vitest';
import { createBoardNets, type BoardNets } from '@s12/sim';
import {
  BoardScheduler,
  DcMotor,
  Hd44780,
  Leds,
  Mcp4922,
  Mm74c923Keypad,
  Ring,
  createMe3305Board,
  makeBoardClock,
  portPrefix,
} from '../src/board/index.js';
import { PortBench, SPLASH_TEXT } from './board-helpers';

const HZ = 10e6;

describe('undriven pins (MAJOR 1)', () => {
  it('fresh nets, nothing driven: motor off, encoder still, all LEDs off', () => {
    const nets: BoardNets = createBoardNets();
    const bench = new PortBench(nets);
    const board = createMe3305Board(nets, { clock: { busHz: HZ } });
    const s0 = board.motor.state();
    expect(s0).toMatchObject({ volts: 0, duty: 0, enabled: false });
    bench.wait(HZ * 0.1);
    expect(board.motor.state().rpm).toBe(0);
    expect(board.motor.encoderEdges()).toBe(0);
    expect(board.leds.states().map((l) => l.on)).toEqual([false, false, false, false]);
    expect(board.leds.edges()).toHaveLength(0);
    board.dispose();
  });

  it('motor honours MCU pulls and drivers, and reacts to a pull change that leaves the resolved level alone', () => {
    const nets = createBoardNets();
    const bench = new PortBench(nets);
    const motor = new DcMotor(nets, { clock: makeBoardClock(nets.pins, { busHz: HZ }) });
    // Pull-ups on PA (resolved level stays 1 = floating level): enable/dir now really high.
    for (const p of ['PA4', 'PA6']) nets.pins.setPull(p, 'up');
    expect(motor.state().enabled).toBe(true);
    expect(motor.state().volts).toBe(0); // PP1 still undriven -> duty 0
    nets.pins.setMcuOutput('PP1', 1);
    expect(motor.state()).toMatchObject({ volts: 12, duty: 1, direction: 1 });
    bench.wait(HZ * 0.05);
    expect(motor.state().rpm).toBeGreaterThan(1000);
    nets.pins.setPull('PA6', null); // enable floats again -> bridge off
    expect(motor.state().enabled).toBe(false);
    // undrivenLevel 1 restores the old behaviour on request.
    const nets2 = createBoardNets();
    const m2 = new DcMotor(nets2, { undrivenLevel: 1 });
    expect(m2.state().enabled).toBe(true);
  });

  it('LEDs: pull-up alone is off unless pullLights; MCU drive lights them', () => {
    const nets = createBoardNets();
    const bench = new PortBench(nets);
    const leds = new Leds(nets, { clock: makeBoardClock(nets.pins, { busHz: HZ }) });
    const lit = new Leds(nets, { pullLights: true });
    nets.pins.setPull('PP4', 'up');
    expect(leds.isOn('PP4')).toBe(false);
    expect(lit.isOn('PP4')).toBe(true);
    expect(lit.edges('PP4')).toHaveLength(1);
    bench.setData('P', 0x80);
    bench.setDdr('P', 0x80);
    expect(leds.isOn('PP7')).toBe(true);
    expect(leds.edges()).toEqual([{ pin: 'PP7', on: true, cycle: bench.t, seconds: bench.t / HZ }]);
    bench.setDdr('P', 0x00); // released: floats -> off
    expect(leds.isOn('PP7')).toBe(false);
    expect(leds.edges('PP7').map((e) => e.on)).toEqual([true, false]);
  });
});

describe('bounded histories (MAJOR 2)', () => {
  it('Ring keeps the newest entries in order', () => {
    const r = new Ring<number>(3);
    for (let i = 1; i <= 7; i++) r.push(i);
    expect(r.toArray()).toEqual([5, 6, 7]);
    expect([...r]).toEqual([5, 6, 7]);
    expect(r.at(0)).toBe(5);
    expect(r.length).toBe(3);
    r.clear();
    expect(r.toArray()).toEqual([]);
    const z = new Ring<number>(0);
    z.push(1);
    expect(z.length).toBe(0);
  });

  it('LED history: O(1) per edge when full; period/duty/edges use the newest window', () => {
    const nets = createBoardNets();
    const bench = new PortBench(nets);
    const leds = new Leds(nets, { clock: makeBoardClock(nets.pins, { busHz: HZ }) });
    bench.setDdr('P', 0x10);
    const t0 = performance.now();
    // 300k edges (3x the default 100k capacity): 10 kHz square wave, 50 % duty.
    for (let k = 0; k < 150_000; k++) {
      bench.t = k * 1000;
      bench.bset('P', 0x10, 0);
      bench.t = k * 1000 + 500;
      bench.bclr('P', 0x10, 0);
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000); // was ~70 s with splice()
    expect(leds.edgeCount).toBe(100_000);
    const e = leds.edges('PP4');
    expect(e[0]).toMatchObject({ on: true, cycle: 100_000 * 1000 });
    expect(e[e.length - 1]).toMatchObject({ on: false, cycle: 149_999 * 1000 + 500 });
    expect(leds.period('PP4')).toBeCloseTo(1e-4, 12);
    // 50 000 on-intervals of 500 cycles between the first (rising) and last (falling) recorded edges.
    expect(leds.dutyCycle('PP4')).toBeCloseTo((50_000 * 500) / (49_999 * 1000 + 500), 12);
  });

  it('DAC history keeps the newest historyLength words', () => {
    const nets = createBoardNets();
    const dac = new Mcp4922(nets, { historyLength: 4 });
    for (let d = 0; d < 10; d++) dac.writeWord(0x3000 | (d * 100), d);
    expect(dac.history('A').map(([c]) => c)).toEqual([6, 7, 8, 9]);
    dac.clearHistory();
    expect(dac.history('A')).toEqual([]);
  });
});

describe('MCP4922 frame length (MINOR 8)', () => {
  function rig() {
    const nets = createBoardNets();
    const bench = new PortBench(nets);
    nets.pins.setPull('PH1', 'down');
    const dac = new Mcp4922(nets, { clock: makeBoardClock(nets.pins, { busHz: HZ }) });
    nets.spi.SPI0.attach(dac);
    bench.setData('H', 0x02);
    bench.setDdr('H', 0x02);
    const frame = (bytes: number[]) => {
      bench.bclr('H', 0x02);
      for (const b of bytes) bench.spi(b);
      bench.bset('H', 0x02);
    };
    return { dac, frame };
  }
  it('clocks past the 16th are ignored (first word used); short frames rejected', () => {
    const { dac, frame } = rig();
    frame([0x38, 0x00, 0xff]);
    expect(dac.channel('A').code).toBe(0x800);
    expect(dac.voltA).toBeCloseTo(2.5, 9);
    expect(dac.rejectedFrames).toBe(0);
    frame([0xbf]);
    expect(dac.rejectedFrames).toBe(1);
    expect(dac.voltB).toBe(0);
  });
});

describe('HD44780 bus glitches and snapshots (MINOR 3, 6, 10)', () => {
  function rig() {
    const nets = createBoardNets();
    const bench = new PortBench(nets);
    const lcd = new Hd44780(nets, { timing: 'zero', clock: makeBoardClock(nets.pins, { busHz: HZ }) });
    const xfers: string[] = [];
    lcd.transfers.on((t) => xfers.push(`${t.kind}:${t.value.toString(16)}`));
    return { nets, bench, lcd, xfers };
  }

  it('MCU in reset (PM4-6 floating) then the board start-up pull configuration: no bus cycle, AC untouched', () => {
    const { nets, lcd, xfers } = rig();
    // Floating E reads 1 on the PinNet but is not a driven E.
    expect(nets.pins.read('PM6')).toBe(1);
    nets.pins.setMcuOutput('PM6', null);
    for (let i = 0; i < 8; i++) nets.pins.setPull(`PB${i}`, 'up');
    for (const p of ['PM4', 'PM5', 'PM6']) nets.pins.setPull(p, 'down');
    expect(xfers).toEqual([]);
    expect(lcd.addressCounter).toBe(0);
    for (let i = 0; i < 8; i++) expect(nets.pins.state(`PB${i}`).ext).toBeNull();
  });

  it('a pull-up on E counts as high (real level on the glass)', () => {
    const { nets, bench, lcd, xfers } = rig();
    bench.setDdr('B', 0xff);
    bench.setData('B', 0x80 | 0x05);
    nets.pins.setPull('PM4', 'down');
    nets.pins.setPull('PM5', 'down');
    nets.pins.setPull('PM6', 'up');
    nets.pins.setPull('PM6', 'down');
    expect(xfers).toEqual(['cmd:85']);
    expect(lcd.addressCounter).toBe(5);
  });

  it('snapshot taken mid-read with E high: restore re-drives the bus; E falling completes the read once', () => {
    const { nets, bench, lcd } = rig();
    for (let i = 0; i < 8; i++) {
      nets.pins.setPull(`PB${i}`, 'up');
      nets.pins.setPull(`PM${i}`, 'down');
    }
    bench.initLcd();
    bench.setAddr(0x00);
    // Data read: RS=1, RW=1, E=1 (held)
    bench.setDdr('B', 0x00);
    bench.bset('M', 0x10);
    bench.bset('M', 0x20);
    bench.bset('M', 0x40);
    expect(nets.pins.readByte('PB')).toBe(SPLASH_TEXT[0].charCodeAt(0));
    const snap = lcd.snapshot();
    expect(snap).toMatchObject({ eHigh: true, rsAtRise: 1, rwAtRise: 1 });
    lcd.restore(snap);
    expect(nets.pins.readByte('PB')).toBe(SPLASH_TEXT[0].charCodeAt(0)); // still driven
    bench.bclr('M', 0x40);
    expect(lcd.addressCounter).toBe(1);
    expect(nets.pins.state('PB0').ext).toBeNull();
    // Restore of the E-high snapshot while E is now low: no transfer completes, AC from the snapshot.
    lcd.restore(snap);
    expect(lcd.addressCounter).toBe(0);
    expect(nets.pins.state('PB0').ext).toBeNull();
    bench.bset('M', 0x40);
    bench.bclr('M', 0x40);
    expect(lcd.addressCounter).toBe(1);
  });

  it('cursor shift while addressing CGRAM steps the CGRAM address', () => {
    const { nets, bench, lcd } = rig();
    for (let i = 0; i < 8; i++) {
      nets.pins.setPull(`PB${i}`, 'up');
      nets.pins.setPull(`PM${i}`, 'down');
    }
    bench.initLcd();
    bench.lcdCommand(0x40 | 0x08); // CGRAM address 8 (glyph 1 row 0)
    bench.lcdCommand(0x14); // cursor right
    bench.outChar(0x1f); // -> CGRAM[9]
    expect(lcd.view().cgram[1]).toEqual([0, 0x1f, 0, 0, 0, 0, 0, 0]);
    expect(lcd.view().cursor).toBeNull(); // still in CGRAM
    expect(lcd.addressCounter).toBe(10);
  });
});

describe('keypad API, timers and power (MINOR 4, 5, 7, 9)', () => {
  function rig(debounceSeconds = 0) {
    const nets = createBoardNets();
    const bench = new PortBench(nets);
    for (let i = 0; i < 8; i++) {
      nets.pins.setPull(`PK${i}`, 'up');
      nets.pins.setPull(`PJ${i}`, 'up');
    }
    const scheduler = new BoardScheduler();
    const kp = new Mm74c923Keypad(nets, { scheduler, debounceSeconds, clock: makeBoardClock(nets.pins, { busHz: HZ }) });
    bench.bset('K', 0x20);
    bench.setDdr('K', 0x20);
    bench.bclr('K', 0x20);
    return { nets, bench, kp, scheduler };
  }

  it('numbers are labels; { code } is the encoder code', () => {
    const { kp } = rig();
    kp.press(1);
    expect(kp.latchedCode).toBe(7); // '1'
    kp.release(1);
    kp.press({ code: 1 });
    expect(kp.heldKeys.map((k) => k.label)).toEqual(['8']);
    expect(kp.latchedCode).toBe(1);
    expect(() => kp.key({ code: 25 })).toThrow();
  });

  it('tap() on a held key does not cut the hold short; manual release cancels a pending tap', () => {
    const { nets, bench, kp, scheduler } = rig();
    kp.press('A');
    expect(kp.tap('A', 0.001)).toBe(Infinity);
    expect(scheduler.pending).toBe(0);
    kp.release('A');
    const at = kp.tap('B', 0.01);
    expect(kp.tap('B', 0.5)).toBe(at);
    kp.release('B');
    expect(scheduler.pending).toBe(0);
    kp.press('B'); // user hold after the tap
    bench.t = at + 1;
    scheduler.runDue(bench.t);
    expect(kp.heldKeys.map((k) => k.label)).toEqual(['B']);
    expect(nets.pins.read('PJ7')).toBe(1);
  });

  it('snapshot during a tap restores and re-arms the release; restoring an older snapshot drops it', () => {
    const { nets, bench, kp, scheduler } = rig();
    const before = kp.snapshot();
    const at = kp.tap('A', 0.002);
    const mid = kp.snapshot();
    expect(mid.taps).toEqual([[kp.key('A').code, at]]);
    scheduler.clear(); // what Me3305Board.restore() does
    kp.restore(mid);
    expect(nets.pins.read('PJ7')).toBe(1);
    bench.t = at;
    scheduler.runDue(at);
    expect(kp.heldKeys).toEqual([]);
    expect(nets.pins.read('PJ7')).toBe(0);
    // Older snapshot: a pending release must not fire against it.
    kp.tap('C', 0.002);
    kp.restore(before);
    expect(scheduler.pending).toBe(0);
    kp.press('D');
    bench.t += 30_000;
    scheduler.runDue(bench.t);
    expect(kp.heldKeys.map((k) => k.label)).toEqual(['D']);
  });

  it('snapshot with a pending debounce re-arms DA', () => {
    const { nets, bench, kp, scheduler } = rig(0.001);
    kp.press('5');
    const s = kp.snapshot();
    expect(s.pendingDaAt).toBe(bench.t + 10_000);
    scheduler.clear();
    kp.restore(s);
    expect(nets.pins.read('PJ7')).toBe(0);
    scheduler.runDue(s.pendingDaAt!);
    expect(nets.pins.read('PJ7')).toBe(1);
    expect(kp.latchedCode).toBe(kp.key('5').code);
  });

  it('board powerOn(): keys released, timers cancelled, latch reset, LED history cleared', () => {
    const nets = createBoardNets();
    const bench = new PortBench(nets);
    for (let i = 0; i < 8; i++) nets.pins.setPull(`PK${i}`, 'up');
    const board = createMe3305Board(nets, { clock: { busHz: HZ } });
    bench.bset('K', 0x20);
    bench.setDdr('K', 0x20);
    bench.bclr('K', 0x20);
    board.keypad.tap('F1', 0.01);
    board.keypad.press('7');
    bench.setData('P', 0x10);
    bench.setDdr('P', 0x10);
    expect(board.leds.edges()).toHaveLength(1);
    board.powerOn();
    expect(board.keypad.heldKeys).toEqual([]);
    expect(board.keypad.dataAvailable).toBe(false);
    expect(board.keypad.latchedCode).toBe(0);
    expect(board.scheduler.pending).toBe(0);
    expect(nets.pins.readByte('PK') & 0x1f).toBe(0);
    expect(nets.pins.read('PJ7')).toBe(0);
    expect(board.leds.edges()).toEqual([]);
    expect(board.leds.isOn('PP4')).toBe(true); // still driven by the MCU
    board.dispose();
  });
});

describe('portPrefix', () => {
  it('maps port registers to pin prefixes', () => {
    expect(portPrefix('PORTB')).toBe('PB');
    expect(portPrefix('PTM')).toBe('PM');
  });
});

import { describe, it, expect } from 'vitest';
import { createBoardNets } from '@s12/sim';
import { BoardScheduler, Mm74c923Keypad, makeBoardClock, me305Keys } from '../src/board/index.js';
import { PortBench } from './board-helpers';

function setup(daPolarity: 'activeHigh' | 'activeLow' = 'activeHigh', debounceSeconds = 0) {
  const nets = createBoardNets();
  const bench = new PortBench(nets);
  for (let i = 0; i < 8; i++) {
    nets.pins.setPull(`PK${i}`, 'up');
    nets.pins.setPull(`PJ${i}`, 'down');
  }
  const scheduler = new BoardScheduler();
  const sync: string[] = [];
  nets.pins.syncHook = () => sync.push('sync');
  const kp = new Mm74c923Keypad(nets, {
    daPolarity,
    debounceSeconds,
    scheduler,
    clock: makeBoardClock(nets.pins, { busHz: 10e6 }),
  });
  /** Keypad set-up as INITKEY leaves it: DDRK.5=1, PORTK.5=0 (/OE on), DDRK0-4 in; PJ7 pull-up. */
  const initKey = () => {
    bench.bset('K', 0x20);
    bench.setDdr('K', 0x20);
    bench.bclr('K', 0x20);
    nets.pins.setPull('PJ7', 'up');
  };
  /** What the keypad ISR does with the code: PORTK & $1F indexes the key-value table (the ME305 profile's values). */
  const TABLE: number[] = [];
  for (const k of me305Keys()) TABLE[k.code] = k.value;
  const isrChar = () => TABLE[bench.read('K') & 0x1f];
  return { nets, bench, kp, scheduler, initKey, isrChar, sync };
}

describe('MM74C923 keypad encoder', () => {
  it('key table matches the ME305 profile (code order and values)', () => {
    const keys = me305Keys();
    expect(keys).toHaveLength(20);
    const byCode = keys.slice().sort((a, b) => a.code - b.code).map((k) => k.label);
    expect(byCode).toEqual(['C', '8', '4', '0', 'D', '9', '5', '1', 'E', 'A', '6', '2', 'F', 'B', '7', '3', 'ENT', 'BKSP', 'F2', 'F1']);
    const f1 = keys.find((k) => k.label === 'F1')!;
    expect([f1.value, f1.row, f1.col]).toEqual([0xf1, 0, 4]);
    expect(keys.find((k) => k.label === 'ENT')!.pcKeys).toContain('Enter');
  });

  it('/OE high: PK0-4 float (pull-ups -> $1F); /OE low: latched code driven', () => {
    const { nets, bench, kp, initKey } = setup();
    expect(bench.read('K') & 0x1f).toBe(0x1f);
    initKey();
    expect(kp.outputEnabled).toBe(true);
    expect(bench.read('K') & 0x1f).toBe(0); // initial latch 0 (UNCERTAIN)
    kp.press('7');
    expect(bench.read('K') & 0x1f).toBe(14);
    bench.bset('K', 0x20); // /OE high again
    expect(nets.pins.state('PK0').ext).toBe(null);
    expect(bench.read('K') & 0x1f).toBe(0x1f);
  });

  it('activeHigh DA (default): PJ7 rises on press, falls on release -> ISR on release; data stays latched', () => {
    const { nets, bench, kp, initKey, isrChar, sync } = setup('activeHigh');
    initKey();
    expect(nets.pins.read('PJ7')).toBe(0);
    const edges: Array<[number, number]> = [];
    nets.pins.on('PJ7', (_p, st, c) => edges.push([st.level, c]));
    bench.wait(100);
    kp.press('A');
    expect(sync.length).toBeGreaterThan(0); // externalChange synced the MCU
    expect(nets.pins.read('PJ7')).toBe(1);
    expect(isrChar()).toBe(0x41);
    bench.wait(500);
    kp.release('A');
    expect(nets.pins.read('PJ7')).toBe(0);
    expect(edges.map((e) => e[0])).toEqual([1, 0]);
    expect(edges[1][1] - edges[0][1]).toBe(503);
    // the BRSET PTJ,#$80 spin passes now; data still latched
    expect(isrChar()).toBe(0x41);
    kp.tap('ENT', 0.05);
    expect(isrChar()).toBe(0x0a);
  });

  it('activeLow DA: falling edge on press', () => {
    const { nets, kp, initKey } = setup('activeLow');
    initKey();
    expect(nets.pins.read('PJ7')).toBe(1);
    kp.press('F1');
    expect(nets.pins.read('PJ7')).toBe(0);
    expect(kp.latchedCode).toBe(19);
    kp.release('F1');
    expect(nets.pins.read('PJ7')).toBe(1);
  });

  it('tap() schedules the release holdSeconds later (bus-cycle exact)', () => {
    const { nets, bench, kp, scheduler, initKey } = setup();
    initKey();
    const at = kp.tap('BKSP', 0.02);
    expect(at - bench.t).toBe(200_000);
    expect(nets.pins.read('PJ7')).toBe(1);
    scheduler.runDue(at - 1);
    expect(nets.pins.read('PJ7')).toBe(1);
    bench.t = at;
    scheduler.runDue(at);
    expect(nets.pins.read('PJ7')).toBe(0);
    expect(kp.latchedCode).toBe(17);
  });

  it('two-key rollover: DA pulses low, the ISR reads the first key, then the second key is encoded', () => {
    const { nets, bench, kp, scheduler, initKey, isrChar } = setup();
    initKey();
    // ISR model: Port J falling edge -> read PORTK at that instant.
    const seen: number[] = [];
    nets.pins.on('PJ7', (_p, st) => st.level === 0 && seen.push(isrChar()));
    kp.press('1');
    kp.press('2');
    expect(kp.latchedCode).toBe(7);
    const t0 = bench.t;
    kp.release('1');
    expect(seen.map((c) => String.fromCharCode(c))).toEqual(['1']);
    expect(kp.latchedCode).toBe(7); // not replaced yet
    expect(nets.pins.read('PJ7')).toBe(0);
    scheduler.runDue(t0 + 9_999); // default rolloverSeconds = 1 ms = 10 000 cycles
    expect(nets.pins.read('PJ7')).toBe(0);
    bench.t = t0 + 10_000;
    scheduler.runDue(bench.t);
    expect(kp.latchedCode).toBe(11);
    expect(nets.pins.read('PJ7')).toBe(1);
    kp.release('2');
    expect(nets.pins.read('PJ7')).toBe(0);
    expect(seen.map((c) => String.fromCharCode(c))).toEqual(['1', '2']);
  });

  it('debounce delays DA; PC key lookup; snapshot', () => {
    const { nets, bench, kp, scheduler, initKey } = setup('activeHigh', 0.001);
    initKey();
    kp.press(kp.keyForPc('b')!.label);
    expect(nets.pins.read('PJ7')).toBe(0);
    bench.t += 10_000;
    scheduler.runDue(bench.t);
    expect(nets.pins.read('PJ7')).toBe(1);
    expect(kp.latchedCode).toBe(13);
    const s = kp.snapshot();
    expect(s).toEqual({ held: [13], active: 13, latched: 13, daAsserted: true, taps: [], pendingDaAt: null });
    expect(kp.keyForPc('Escape')).toBeUndefined();
  });
});

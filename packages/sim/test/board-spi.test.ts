import { describe, it, expect } from 'vitest';
import { createBoardNets } from '@s12/sim';
import { Ls7366r, LS7366R_STR, Mcp4922, makeBoardClock } from '../src/board/index.js';
import { PortBench } from './board-helpers';

function setup() {
  const nets = createBoardNets();
  const bench = new PortBench(nets);
  for (let i = 0; i < 8; i++) nets.pins.setPull(`PH${i}`, 'down');
  const clock = makeBoardClock(nets.pins, { busHz: 10e6 });
  const enc = new Ls7366r(nets, { clock });
  const dac = new Mcp4922(nets, { clock });
  nets.spi.SPI0.attach(enc);
  nets.spi.SPI0.attach(dac);
  // start-up: both chip selects idle high
  bench.setData('H', 0x03);
  bench.setDdr('H', 0x03);
  /** One CS frame on PH<bit> with the given bytes; returns MISO bytes. */
  const frame = (bit: number, bytes: number[]) => {
    bench.bclr('H', 1 << bit);
    const r = bytes.map((b) => bench.spi(b));
    bench.bset('H', 1 << bit);
    return r;
  };
  const startupEncoder = () => {
    frame(0, [0x88, 0xc3]);
    frame(0, [0x90, 0x02]);
  };
  const readEncoder = () => {
    const r = frame(0, [0x60, 0x00, 0x00]);
    return (r[1] << 8) | r[2];
  };
  const disableEncoder = () => frame(0, [0x90, 0x06]);
  const outDac = (ch: 'A' | 'B', d: number) => frame(1, [((d >> 8) & 0x0f) | (ch === 'A' ? 0x30 : 0xb0), d & 0xff]);
  return { nets, bench, enc, dac, frame, startupEncoder, readEncoder, disableEncoder, outDac };
}

describe('LS7366R on SPI0 / PH0', () => {
  it('Entry DISABLE_ENCODER, then STARTUP_ENCODER and READ_ENCODER sequences', () => {
    const { enc, startupEncoder, readEncoder, disableEncoder } = setup();
    disableEncoder();
    enc.setPosition(1000);
    expect(readEncoder()).toBe(0); // counting disabled
    startupEncoder();
    const r = enc.registers();
    expect([r.mdr0, r.mdr1]).toEqual([0xc3, 0x02]);
    expect(r.str & LS7366R_STR.CEN).toBe(LS7366R_STR.CEN);
    enc.setPosition(1250);
    expect(readEncoder()).toBe(250);
    enc.setPosition(1000);
    expect(readEncoder()).toBe(0);
    enc.setPosition(990);
    expect(readEncoder()).toBe(65526); // 2-byte counter wraps (signed -10)
    expect(enc.registers().str & LS7366R_STR.BW).toBe(LS7366R_STR.BW);
    expect(enc.registers().str & LS7366R_STR.S).toBe(LS7366R_STR.S);
  });

  it('MISO idles $FF on the instruction byte; both slaves do not answer when deselected', () => {
    const { frame, bench } = setup();
    expect(frame(0, [0x60, 0, 0])[0]).toBe(0xff);
    expect(bench.spi(0x60)).toBe(0xff); // no CS low
  });

  it('x1/x2/x4, byte widths, RD MDR/STR, CLR, LOAD, WR DTR, modulo-n and range-limit', () => {
    const { enc, frame } = setup();
    frame(0, [0x88, 0x01]); // x1 free-run
    frame(0, [0x90, 0x00]); // 4 bytes, enabled
    enc.setPosition(41);
    expect(frame(0, [0x60, 0, 0, 0, 0]).slice(1)).toEqual([0, 0, 0, 10]);
    frame(0, [0x88, 0x02]); // x2
    enc.setPosition(61);
    expect(frame(0, [0x60, 0, 0, 0, 0])[4]).toBe(20);
    expect(frame(0, [0x48, 0])[1]).toBe(0x02); // RD MDR0
    expect(frame(0, [0x50, 0])[1]).toBe(0x00); // RD MDR1
    frame(0, [0x20]); // CLR CNTR
    expect(frame(0, [0x60, 0, 0, 0, 0])[4]).toBe(0);
    frame(0, [0x90, 0x03]); // 1 byte
    frame(0, [0x98, 0x05]); // WR DTR = 5
    frame(0, [0xe0]); // LOAD CNTR <- DTR
    expect(frame(0, [0x60, 0])[1]).toBe(5);
    frame(0, [0x88, 0x0f]); // x4 modulo-n (n = DTR+1 = 6)
    enc.step(7);
    expect(frame(0, [0x60, 0])[1]).toBe((5 + 7) % 6);
    expect(frame(0, [0x70, 0])[1] & LS7366R_STR.CY).toBe(LS7366R_STR.CY);
    frame(0, [0x30]); // CLR STR
    expect(frame(0, [0x70, 0])[1] & 0xf0).toBe(0);
    frame(0, [0x88, 0x0b]); // x4 range-limit 0..5
    enc.step(100);
    expect(frame(0, [0x60, 0])[1]).toBe(5);
    enc.step(-2);
    expect(frame(0, [0x60, 0])[1]).toBe(3);
    enc.step(-100);
    expect(frame(0, [0x60, 0])[1]).toBe(0);
    // LOAD OTR, RD OTR
    enc.step(4);
    frame(0, [0xe8]);
    enc.step(1);
    expect(frame(0, [0x68, 0])[1]).toBe(4);
  });

  it('live position source (e.g. the motor) is sampled at transfer time', () => {
    const { enc, bench, startupEncoder, readEncoder } = setup();
    enc.opts.positionSource = (cycle) => Math.floor(cycle / 100);
    enc.powerOn();
    startupEncoder();
    const a = readEncoder();
    bench.wait(10_000);
    const b = readEncoder();
    expect(b - a).toBeGreaterThanOrEqual(100);
    expect(b - a).toBeLessThan(110);
  });
});

describe('MCP4922 on SPI0 / PH1', () => {
  it('OUTDACA/OUTDACB words latch on CS rising edge', () => {
    const { bench, dac, outDac } = setup();
    const changes: Array<[string, number]> = [];
    dac.changes.on((c) => changes.push([c.channel, c.volts]));
    expect(dac.voltA).toBe(0);
    bench.bclr('H', 0x02);
    bench.spi(0x38);
    bench.spi(0x00);
    expect(dac.voltA).toBe(0); // not latched until CS rises
    bench.bset('H', 0x02);
    expect(dac.voltA).toBeCloseTo(2.5, 6);
    outDac('B', 0xfff);
    expect(dac.voltB).toBeCloseTo((5 * 4095) / 4096, 6);
    expect(dac.channel('B')).toMatchObject({ code: 0xfff, gain: 1, active: true, buffered: false });
    expect(changes.map((c) => c[0])).toEqual(['A', 'B']);
    expect(dac.history('A')).toHaveLength(1);
  });

  it('gain 2x clamps to VDD, shutdown = 0 V, odd-length frames are ignored', () => {
    const { dac, frame } = setup();
    frame(1, [0x1c, 0x00]); // A, 2x gain, active, code $C00 -> 7.5 V -> clamp 5 V
    expect(dac.voltA).toBe(5);
    frame(1, [0x88, 0x00]); // B, /SHDN = 0
    expect(dac.voltB).toBe(0);
    frame(1, [0x38]);
    expect(dac.rejectedFrames).toBe(1);
    expect(dac.voltA).toBe(5);
  });

  it('encoder and DAC are independent slaves on the same bus', () => {
    const { enc, dac, startupEncoder, readEncoder, outDac } = setup();
    startupEncoder();
    outDac('A', 0x400);
    enc.setPosition(77);
    expect(readEncoder()).toBe(77);
    expect(dac.voltA).toBeCloseTo(1.25, 6);
    expect(enc.registers().mdr0).toBe(0xc3);
  });
});

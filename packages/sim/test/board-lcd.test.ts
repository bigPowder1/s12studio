import { describe, it, expect } from 'vitest';
import { createBoardNets, type BoardNets } from '@s12/sim';
import { Hd44780, HD44780_A00, CGRAM_BASE, makeBoardClock } from '../src/board/index.js';
import { PortBench, SPLASH_TEXT } from './board-helpers';

function setup(timing: 'realistic' | 'zero' = 'realistic') {
  const nets: BoardNets = createBoardNets();
  const bench = new PortBench(nets);
  // ME3305 board pulls: B up, M down.
  for (let i = 0; i < 8; i++) {
    nets.pins.setPull(`PB${i}`, 'up');
    nets.pins.setPull(`PM${i}`, 'down');
  }
  const lcd = new Hd44780(nets, { timing, clock: makeBoardClock(nets.pins, { busHz: 10e6 }) });
  return { nets, bench, lcd };
}

const [L1, L2] = SPLASH_TEXT;

describe('HD44780 40x2 LCD on PORTB / PM4-PM6', () => {
  it('power-on state: display off, I/D=1 S=0, blank DDRAM', () => {
    const { lcd } = setup();
    const v = lcd.view();
    expect(v.displayOn).toBe(false);
    expect(lcd.entryMode).toEqual({ increment: true, shift: false });
    expect(v.codes[0].every((c) => c === 0x20)).toBe(true);
    expect(v.lines[0]).toHaveLength(40);
  });

  it('8-bit initialisation and two lines of text: 40x2 lines, cursor off, AC after text', () => {
    const { bench, lcd } = setup();
    bench.initLcd();
    const v = lcd.view();
    expect(v.displayOn).toBe(true);
    expect(v.cursorOn).toBe(false);
    expect(v.twoLine).toBe(true);
    expect(v.eightBit).toBe(true);
    expect(v.lines[0]).toBe(L1.padEnd(40));
    expect(v.lines[1]).toBe(L2.padEnd(40));
    expect(lcd.addressCounter).toBe(0x40 + L2.length);
    expect(v.cursor).toEqual({ row: 1, col: L2.length });
    expect(v.cursorVisible).toBe(false);
    // clear display
    bench.lcdCommand(0x01);
    expect(lcd.lines[0].trim()).toBe('');
    expect(lcd.addressCounter).toBe(0);
  });

  it('busy flag: ~37 us per write, 1.52 ms for clear; BF polling waits it out', () => {
    const { bench, lcd } = setup('realistic');
    bench.initLcd();
    const t0 = bench.t;
    const polls = bench.lcdCommand(0x01);
    const dt = bench.t - t0;
    expect(polls).toBeGreaterThan(100);
    expect(dt).toBeGreaterThanOrEqual(15200);
    expect(dt).toBeLessThan(15200 + 200);
    const t1 = bench.t;
    bench.outChar(0x41);
    expect(bench.t - t1).toBeGreaterThanOrEqual(370);
    expect(bench.t - t1).toBeLessThan(370 + 200);
    expect(lcd.busyViolations).toBe(3); // the three reset writes 2 us apart (executed anyway)
  });

  it("zero timing: BF never set, one poll per write", () => {
    const { bench, lcd } = setup('zero');
    bench.initLcd();
    expect(bench.lcdCommand(0x01)).toBe(1);
    expect(lcd.busy()).toBe(false);
  });

  it('BF/AC read drives PB only while E and R/W are high', () => {
    const { bench, nets } = setup('realistic');
    bench.initLcd();
    bench.setAddr(0x45);
    bench.wait(1000);
    bench.setDdr('B', 0);
    bench.bclr('M', 0x10);
    bench.bset('M', 0x20);
    expect(nets.pins.state('PB0').ext).toBe(null);
    bench.bset('M', 0x40);
    expect(nets.pins.readByte('PB')).toBe(0x45);
    expect(nets.pins.state('PB0').ext).toBe(1);
    bench.bclr('M', 0x40);
    expect(nets.pins.state('PB0').ext).toBe(null);
    expect(nets.pins.readByte('PB')).toBe(0xff); // pull-ups
    // GETADDR right after a write shows BF=1 and the new AC
    bench.bset('M', 0x10);
    bench.setDdr('B', 0xff);
    bench.bclr('M', 0x20);
    bench.bset('M', 0x40);
    bench.setData('B', 0x5a);
    bench.bclr('M', 0x40);
    expect(bench.getAddr()).toBe(0x80 | 0x46);
  });

  it('SETADDR/OUTCHAR, 2-line AC wrap $27->$40 and $67->$00, OUTCHAR_AT', () => {
    const { bench, lcd } = setup();
    bench.initLcd();
    bench.lcdCommand(0x01);
    bench.setAddr(0x26);
    bench.outString('XYZ');
    expect(lcd.view().codes[0][38]).toBe(0x58);
    expect(lcd.view().codes[0][39]).toBe(0x59);
    expect(lcd.view().codes[1][0]).toBe(0x5a);
    bench.setAddr(0x67);
    bench.outString('PQ');
    expect(lcd.view().codes[1][39]).toBe(0x50);
    expect(lcd.view().codes[0][0]).toBe(0x51);
    expect(lcd.addressCounter).toBe(0x01);
  });

  it('backspace (code $08) moves the cursor left without erasing; CURSOR_ON shows an underline', () => {
    const { bench, lcd } = setup();
    bench.initLcd();
    bench.lcdCommand(0x01);
    bench.lcdCommand(0x0e); // CURSOR_ON
    bench.setAddr(0x05);
    bench.outString('AB');
    bench.outChar(0x08);
    const v = lcd.view();
    expect(v.cursor).toEqual({ row: 0, col: 6 });
    expect(v.cursorVisible).toBe(true);
    expect(v.blinkOn).toBe(false);
    expect(v.lines[0].slice(5, 7)).toBe('AB');
    bench.outChar(0x43);
    expect(lcd.view().lines[0].slice(5, 7)).toBe('AC');
  });

  it('display off blanks the glass but keeps DDRAM', () => {
    const { bench, lcd } = setup();
    bench.initLcd();
    bench.lcdCommand(0x08);
    expect(lcd.lines[0].trim()).toBe('');
    expect(lcd.view().codes[0][0]).toBe(L1.charCodeAt(0));
    bench.lcdCommand(0x0c);
    expect(lcd.lines[0].startsWith(L1.slice(0, 6))).toBe(true);
  });

  it('entry mode decrement + display shift, cursor/display shift instructions, home', () => {
    const { bench, lcd } = setup('zero');
    bench.initLcd();
    bench.lcdCommand(0x01);
    bench.lcdCommand(0x04); // I/D=0, S=0
    bench.setAddr(0x03);
    bench.outString('abc');
    expect(lcd.view().lines[0].slice(0, 4)).toBe(' cba');
    expect(lcd.addressCounter).toBe(0x00);
    bench.lcdCommand(0x06);
    bench.lcdCommand(0x18); // display shift left
    expect(lcd.view().shift).toBe(1);
    expect(lcd.view().lines[0].slice(0, 3)).toBe('cba');
    expect(lcd.view().cursor).toEqual({ row: 0, col: 39 });
    bench.lcdCommand(0x1c); // shift right
    expect(lcd.view().shift).toBe(0);
    bench.lcdCommand(0x14); // cursor right
    expect(lcd.addressCounter).toBe(0x01);
    bench.lcdCommand(0x07); // I/D=1, S=1: display follows writes
    bench.outChar(0x5a);
    expect(lcd.view().shift).toBe(1);
    bench.lcdCommand(0x02); // home
    expect(lcd.view().shift).toBe(0);
    expect(lcd.addressCounter).toBe(0);
  });

  it('CGRAM write, data read back with AC auto-increment, glyph rendering', () => {
    const { bench, lcd } = setup('zero');
    bench.initLcd();
    bench.lcdCommand(0x01);
    bench.lcdCommand(0x40 | 8); // CGRAM glyph 1
    const glyph = [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11, 0x00];
    for (const g of glyph) bench.outChar(g === 0x08 ? 0x08 : g);
    expect(lcd.view().cgram[1]).toEqual(glyph);
    bench.setAddr(0x00);
    bench.outChar(0x01);
    bench.outChar(0x5c);
    bench.outChar(0x7e);
    const line = lcd.lines[0];
    expect(line.codePointAt(0)).toBe(CGRAM_BASE + 1);
    expect(line[1]).toBe('¥');
    expect(line[2]).toBe('→');
    // data read: RS=1 R/W=1
    bench.setAddr(0x00);
    bench.bset('M', 0x10);
    const a = bench.lcdRead();
    const b = bench.lcdRead();
    expect([a, b]).toEqual([0x01, 0x5c]);
    expect(lcd.addressCounter).toBe(0x02);
    expect(HD44780_A00[0xb1]).toBe('ｱ');
  });

  it('4-bit interface: nibble writes and reads', () => {
    const { bench, lcd } = setup('zero');
    bench.setDdr('M', 0x70);
    // 8-bit function set to 4-bit (raw write: a BF poll here would desynchronise the nibble pairing)
    bench.setDdr('B', 0xff);
    bench.bset('M', 0x40);
    bench.setData('B', 0x28);
    bench.bclr('M', 0x40);
    expect(lcd.view().eightBit).toBe(false);
    const w4 = (rs: boolean, v: number) => {
      for (const nib of [v & 0xf0, (v << 4) & 0xf0]) {
        if (rs) bench.bset('M', 0x10);
        else bench.bclr('M', 0x10);
        bench.setDdr('B', 0xff);
        bench.bclr('M', 0x20);
        bench.bset('M', 0x40);
        bench.setData('B', nib);
        bench.bclr('M', 0x40);
      }
    };
    w4(false, 0x0c);
    w4(false, 0x80 | 0x41);
    w4(true, 0x48);
    expect(lcd.view().displayOn).toBe(true);
    expect(lcd.view().codes[1][1]).toBe(0x48);
    bench.bclr('M', 0x10);
    const hi = bench.lcdRead();
    const lo = bench.lcdRead();
    expect(((hi & 0xf0) | (lo >> 4)) & 0x7f).toBe(0x42);
  });

  it('change events and snapshot/restore', () => {
    const { bench, lcd } = setup('zero');
    const seen: string[] = [];
    lcd.changes.on((e) => seen.push(e.what));
    bench.initLcd();
    expect(seen).toContain('ddram');
    expect(seen).toContain('display');
    const snap = JSON.parse(JSON.stringify(lcd.snapshot()));
    bench.lcdCommand(0x01);
    expect(lcd.lines[0].trim()).toBe('');
    lcd.restore(snap);
    expect(lcd.lines[0]).toBe(L1.padEnd(40));
  });

  it('blink phase helper alternates every 409.6 ms', () => {
    expect(Hd44780.blinkPhase(0.1)).toBe(true);
    expect(Hd44780.blinkPhase(0.5)).toBe(false);
    expect(Hd44780.blinkPhase(0.9)).toBe(true);
  });
});

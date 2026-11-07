/** The ME305 board profile (the keypad table vs the library's own table in the linked image: private, s12studio-fixtures tests/devices/me305-lib.test.ts). */
import { describe, expect, it } from 'vitest';
import { ME305, pinRef, registerByName, vectorByName } from '../src/index.js';

describe('ME305 board profile', () => {
  it('clocks', () => {
    expect(ME305.oscillatorHz).toBe(16_000_000);
    expect(ME305.busHzAfterPll).toBe(10_000_000);
    expect(ME305.pllClockHz).toBe(2 * ME305.oscillatorHz * (4 + 1) / (7 + 1));
  });

  it('LCD is a 40x2 HD44780 on PORTB / PM4-6', () => {
    expect(ME305.lcd).toMatchObject({ type: 'HD44780', cols: 40, rows: 2, data: 'PORTB', rs: 'PM4', rw: 'PM5', e: 'PM6' });
    expect(pinRef(ME305.lcd.e)).toEqual({ port: 'PTM', ddr: 'DDRM', bit: 6 });
  });

  it('keypad: 20 keys on PK0-4 with /OE PK5 and DA PJ7; values are the key characters', () => {
    const t = ME305.keypad.table;
    expect(t).toHaveLength(20);
    for (const k of t) {
      const special: Record<string, number> = { ENT: 0x0a, BKSP: 0x08, F1: 0xf1, F2: 0xf2 };
      expect(k.value, k.label).toBe(special[k.label] ?? k.label.charCodeAt(0));
    }
    expect(new Set(t.map((k) => k.code)).size).toBe(20);
    expect(ME305.keypad.codes).toEqual(['PK0', 'PK1', 'PK2', 'PK3', 'PK4']);
    expect(ME305.keypad).toMatchObject({ oe: 'PK5', da: 'PJ7', daPolarity: 'activeHigh' });
    expect(ME305.keypad.layout.flat().sort()).toEqual(t.map((k) => k.label).sort());
    expect(vectorByName(ME305.keypad.vector)!.address).toBe(0xffce);
  });

  it('LEDs, SPI peripherals and motor', () => {
    expect(ME305.leds.map((l) => `${l.pin}:${l.color}`)).toEqual(['PP4:green', 'PP5:red', 'PP6:green', 'PP7:red']);
    expect(ME305.encoder).toMatchObject({ part: 'LS7366R', bus: 'SPI0', cs: 'PH0' });
    expect(ME305.dac).toMatchObject({ part: 'MCP4922', bus: 'SPI0', cs: 'PH1' });
    expect(ME305.motor).toMatchObject({ pwm: 'PP1', dir: 'PA4', enable: 'PA6', period: 650 });
    expect(ME305.motor.current).toMatchObject({ module: 'ATD1', channel: 0 });
    expect(registerByName(ME305.motor.pwmDutyReg)!.address).toBe(0x031c);
  });

  it('every pin and register name resolves', () => {
    const pins = [
      ME305.lcd.rs, ME305.lcd.rw, ME305.lcd.e, ...ME305.keypad.codes, ME305.keypad.oe, ME305.keypad.da,
      ...ME305.leds.map((l) => l.pin), ME305.encoder.cs, ME305.dac.cs, ME305.motor.pwm, ME305.motor.dir,
      ME305.motor.enable, ...ME305.motor.faultInputs, ME305.spi.miso, ME305.spi.mosi, ME305.spi.sck, ME305.spi.ss,
    ];
    for (const p of pins) {
      const r = pinRef(p);
      expect(registerByName(r.port), p).toBeDefined();
      expect(registerByName(r.ddr), p).toBeDefined();
    }
    expect(() => pinRef('PZ9')).toThrow();
  });
});

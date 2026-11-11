/**
 * ME 3305 benchtop board profile (MC9S12XDP512): clocks, pin wiring and parts of the board S12 Studio simulates.
 * Source: private me3305-board.md (and critique C1: the LCD is 40x2).
 */

/** Pin reference such as 'PM4', 'PK5', 'PJ7', 'PP1', 'PA4', 'PH0', 'PS4'. */
export type PinName = string;

export interface PinRef {
  /** Port data register (e.g. 'PTM', 'PORTK'). */
  port: string;
  /** Data direction register. */
  ddr: string;
  bit: number;
}

/** Port letter -> data/DDR register names. */
const PORTS: Record<string, { port: string; ddr: string }> = {
  A: { port: 'PORTA', ddr: 'DDRA' },
  B: { port: 'PORTB', ddr: 'DDRB' },
  E: { port: 'PORTE', ddr: 'DDRE' },
  K: { port: 'PORTK', ddr: 'DDRK' },
  T: { port: 'PTT', ddr: 'DDRT' },
  S: { port: 'PTS', ddr: 'DDRS' },
  M: { port: 'PTM', ddr: 'DDRM' },
  P: { port: 'PTP', ddr: 'DDRP' },
  H: { port: 'PTH', ddr: 'DDRH' },
  J: { port: 'PTJ', ddr: 'DDRJ' },
};

/** Resolve 'PM4' -> { port: 'PTM', ddr: 'DDRM', bit: 4 }. */
export function pinRef(pin: PinName): PinRef {
  const m = /^P([A-Z])([0-7])$/.exec(pin);
  if (!m || !PORTS[m[1]]) throw new Error(`unknown pin ${pin}`);
  return { ...PORTS[m[1]], bit: Number(m[2]) };
}

export interface KeypadKey {
  /** 5-bit encoder code presented on PK0-PK4. */
  code: number;
  /** Character code the key stands for (what a program reading the keypad gets for it). */
  value: number;
  /** Label printed on the key. */
  label: string;
}

export interface Me3305Board {
  name: string;
  oscillatorHz: number;
  pllClockHz: number;
  busHzBeforePll: number;
  busHzAfterPll: number;
  lcd: {
    type: 'HD44780';
    cols: number;
    rows: number;
    /** DDRAM address of the first character of each line. */
    lineAddresses: number[];
    data: string;
    dataDdr: string;
    rs: PinName;
    rw: PinName;
    e: PinName;
    /** Entry mode the model starts in (the library never sends Entry Mode Set). */
    defaultEntryMode: { increment: boolean; shift: boolean };
  };
  keypad: {
    encoder: string;
    codes: PinName[];
    oe: PinName;
    oeActiveLow: boolean;
    da: PinName;
    daPolarity: 'activeHigh' | 'activeLow';
    vector: string;
    table: KeypadKey[];
    /** Suggested on-screen layout (rows of labels). */
    layout: string[][];
    uncertain: string;
  };
  leds: Array<{ pin: PinName; color: 'green' | 'red'; pair: number }>;
  spi: { module: 'SPI0'; miso: PinName; mosi: PinName; sck: PinName; ss: PinName };
  encoder: { part: string; bus: 'SPI0'; cs: PinName; csActiveLow: boolean; countsPerRevolution: number | null; uncertain: string };
  dac: { part: string; bus: 'SPI0'; cs: PinName; csActiveLow: boolean; bits: number; vrefVolts: number; uncertain: string };
  motor: {
    pwm: PinName;
    pwmChannels: string;
    pwmPeriodReg: string;
    pwmDutyReg: string;
    period: number;
    dir: PinName;
    enable: PinName;
    faultInputs: PinName[];
    current: { module: 'ATD1'; channel: number; pin: string };
    uncertain: string;
  };
  /** Pins pulled up / down by the board's start-up pull configuration (unused inputs read 1 on A,B,E,K and 0 on T,S,M,P,H,J). */
  pulls: { up: string[]; down: string[] };
  /** Library RAM/EEPROM layout facts other packages rely on. */
  library: { stackTop: number; libraryRamLocal: number };
}

/** Key characters for encoder codes 0..15 (keypad wiring); codes 16..19 are the function keys below. */
const KEY_VALUES = 'C840D951EA62FB73';

function keypadTable(): KeypadKey[] {
  const t: KeypadKey[] = [];
  for (let code = 0; code < 16; code++) {
    const ch = KEY_VALUES[code];
    t.push({ code, value: ch.charCodeAt(0), label: ch });
  }
  t.push({ code: 16, value: 0x0a, label: 'ENT' });
  t.push({ code: 17, value: 0x08, label: 'BKSP' });
  t.push({ code: 18, value: 0xf2, label: 'F2' });
  t.push({ code: 19, value: 0xf1, label: 'F1' });
  return t;
}

export const ME3305: Me3305Board = {
  name: 'ME 3305 benchtop board (MC9S12XDP512)',
  oscillatorHz: 16_000_000, // UNCERTAIN: derived from PLL/delay math, no schematic seen
  pllClockHz: 20_000_000,
  busHzBeforePll: 8_000_000,
  busHzAfterPll: 10_000_000,
  lcd: {
    type: 'HD44780',
    cols: 40,
    rows: 2,
    lineAddresses: [0x00, 0x40],
    data: 'PORTB',
    dataDdr: 'DDRB',
    rs: 'PM4',
    rw: 'PM5',
    e: 'PM6',
    defaultEntryMode: { increment: true, shift: false },
  },
  keypad: {
    encoder: 'MM74C923', // UNCERTAIN: inferred from 20 keys + 5-bit code + /OE
    codes: ['PK0', 'PK1', 'PK2', 'PK3', 'PK4'],
    oe: 'PK5',
    oeActiveLow: true,
    da: 'PJ7',
    daPolarity: 'activeHigh', // UNCERTAIN: 74C923-faithful; the falling-edge IRQ then fires on key release
    vector: 'Vportj',
    table: keypadTable(),
    layout: [
      ['0', '1', '2', '3', 'F1'],
      ['4', '5', '6', '7', 'F2'],
      ['8', '9', 'A', 'B', 'BKSP'],
      ['C', 'D', 'E', 'F', 'ENT'],
    ],
    uncertain: 'DA polarity and physical key positions are unknown; labels and code->value mapping are certain',
  },
  leds: [
    { pin: 'PP4', color: 'green', pair: 2 },
    { pin: 'PP5', color: 'red', pair: 2 },
    { pin: 'PP6', color: 'green', pair: 1 },
    { pin: 'PP7', color: 'red', pair: 1 },
  ],
  spi: { module: 'SPI0', miso: 'PS4', mosi: 'PS5', sck: 'PS6', ss: 'PS7' },
  encoder: {
    part: 'LS7366R',
    bus: 'SPI0',
    cs: 'PH0',
    csActiveLow: true,
    countsPerRevolution: null,
    uncertain: 'part inferred from command bytes; CPR unknown (make it a parameter)',
  },
  dac: {
    part: 'MCP4922',
    bus: 'SPI0',
    cs: 'PH1',
    csActiveLow: true,
    bits: 12,
    vrefVolts: 5,
    uncertain: 'part (MCP4922 vs MCP4822) and Vref unknown',
  },
  motor: {
    pwm: 'PP1',
    pwmChannels: 'PWM01',
    pwmPeriodReg: 'PWMPER01',
    pwmDutyReg: 'PWMDTY01',
    period: 650,
    dir: 'PA4',
    enable: 'PA6',
    faultInputs: ['PA5', 'PA7'],
    current: { module: 'ATD1', channel: 0, pin: 'PAD08' },
    uncertain: 'H-bridge part, PA5/PA7 function, current-sense scale and ATD1 AN0 pin name',
  },
  pulls: { up: ['A', 'B', 'E', 'K'], down: ['T', 'S', 'M', 'P', 'H', 'J'] },
  library: { stackTop: 0x2400, libraryRamLocal: 0x1000 },
};

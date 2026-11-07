/**
 * Cal Poly ME 305 benchtop board: wires the LCD, keypad encoder, LS7366R, MCP4922, DC motor and LEDs onto the
 * `BoardNets` glue using the @s12/devices ME305 profile pin assignments. Works with any MCU model that drives the
 * PinNet / SpiBus / PwmBus / AnalogBus.
 *
 * Integration with an S12XSystem (done by the integrator):
 *   const board = createMe305Board(nets, { clock: { busHz: () => sys.busHz, seconds: (c) => sys.bus.seconds(c) } });
 *   sys.addPeripheral(board.peripheral, []);   // fires timed board events (key tap release, debounce) on time
 */
import { ME305 } from '@s12/devices';
import type { BoardNets } from '../../pins.js';
import type { Peripheral } from '../../types.js';
import { BoardScheduler, makeBoardClock, type BoardClock, type BoardClockOptions } from '../clock.js';
import { Hd44780, type Hd44780Options, type Hd44780Snapshot } from '../hd44780.js';
import { Mm74c923Keypad, type KeypadOptions, type KeypadSnapshot } from '../keypad74c923.js';
import { Leds, type LedsOptions } from '../leds.js';
import { Ls7366r, type Ls7366rOptions, type Ls7366rSnapshot } from '../ls7366r.js';
import { Mcp4922, type Mcp4922Options, type Mcp4922Snapshot } from '../mcp4922.js';
import { DcMotor, type MotorOptions, type MotorSnapshot } from '../motor.js';

export interface Me305BoardOptions {
  clock?: BoardClockOptions;
  lcd?: Partial<Omit<Hd44780Options, 'clock'>>;
  keypad?: Partial<Omit<KeypadOptions, 'clock' | 'scheduler'>>;
  encoder?: Partial<Omit<Ls7366rOptions, 'clock'>>;
  dac?: Partial<Omit<Mcp4922Options, 'clock'>>;
  motor?: Partial<Omit<MotorOptions, 'clock'>>;
  leds?: Partial<Omit<LedsOptions, 'clock'>>;
  /** Feed the encoder counter from the motor shaft (default true). */
  motorDrivesEncoder?: boolean;
}

export interface Me305BoardSnapshot {
  lcd: Hd44780Snapshot;
  keypad: KeypadSnapshot;
  encoder: Ls7366rSnapshot;
  dac: Mcp4922Snapshot;
  motor: MotorSnapshot;
}

export interface Me305BoardModel {
  readonly nets: BoardNets;
  readonly clock: BoardClock;
  readonly scheduler: BoardScheduler;
  readonly lcd: Hd44780;
  readonly keypad: Mm74c923Keypad;
  readonly encoder: Ls7366r;
  readonly dac: Mcp4922;
  readonly motor: DcMotor;
  readonly leds: Leds;
  /** Register-less peripheral that fires board timers inside `S12XSystem.run()` (addPeripheral(p, [])). */
  readonly peripheral: Peripheral;
  /** Fire due board timers (alternative to registering `peripheral`). */
  service(cycle?: number): void;
  /**
   * Board power cycle: LCD/encoder/DAC/motor/keypad to power-on state (keys released, board timers cancelled) and
   * the LED edge history cleared. An MCU reset does NOT call this. Call from outside the CPU loop.
   */
  powerOn(): void;
  snapshot(): Me305BoardSnapshot;
  restore(s: Me305BoardSnapshot): void;
  dispose(): void;
}

/** 'PORTB' -> 'PB', 'PTM' -> 'PM'. */
export function portPrefix(reg: string): string {
  const m = /^(?:PORT|PT)([A-Z])$/.exec(reg);
  if (!m) throw new Error(`not a port data register: ${reg}`);
  return `P${m[1]}`;
}

export function createMe305Board(nets: BoardNets, opts: Me305BoardOptions = {}): Me305BoardModel {
  const clock = makeBoardClock(nets.pins, opts.clock);
  const scheduler = new BoardScheduler();
  const L = ME305.lcd;
  const lcd = new Hd44780(nets, {
    pins: { data: portPrefix(L.data), rs: L.rs, rw: L.rw, e: L.e },
    cols: L.cols,
    rows: L.rows,
    ...opts.lcd,
    clock,
  });
  const keypad = new Mm74c923Keypad(nets, { ...opts.keypad, clock, scheduler });
  const motor = new DcMotor(nets, { ...opts.motor, clock });
  const encoder = new Ls7366r(nets, {
    positionSource: opts.motorDrivesEncoder === false ? null : (cycle) => motor.encoderEdges(cycle),
    ...opts.encoder,
    clock,
  });
  const dac = new Mcp4922(nets, { ...opts.dac, clock });
  const leds = new Leds(nets, { ...opts.leds, clock });
  const spi = nets.spi[ME305.encoder.bus];
  spi.attach(encoder);
  nets.spi[ME305.dac.bus].attach(dac);
  // SpiBus has no detach: disposed slaves are muted by a wrapper flag.
  let disposed = false;
  const peripheral = scheduler.asPeripheral('ME305 board');

  const model: Me305BoardModel = {
    nets,
    clock,
    scheduler,
    lcd,
    keypad,
    encoder,
    dac,
    motor,
    leds,
    peripheral,
    service(cycle = clock.now()) {
      scheduler.runDue(cycle);
    },
    powerOn() {
      scheduler.clear();
      keypad.powerOn();
      leds.clearHistory();
      lcd.powerOn();
      encoder.powerOn();
      dac.powerOn();
      motor.powerOn();
    },
    snapshot() {
      return {
        lcd: lcd.snapshot(),
        keypad: keypad.snapshot(),
        encoder: encoder.snapshot(),
        dac: dac.snapshot(),
        motor: motor.snapshot(),
      };
    },
    restore(s) {
      // Board timers belong to the snapshot's timeline: drop them; the keypad re-arms its own from `s.keypad`.
      scheduler.clear();
      motor.restore(s.motor);
      encoder.restore(s.encoder);
      lcd.restore(s.lcd);
      keypad.restore(s.keypad);
      dac.restore(s.dac);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lcd.dispose();
      keypad.dispose();
      encoder.dispose();
      dac.dispose();
      motor.dispose();
      leds.dispose();
      scheduler.clear();
    },
  };
  // A disposed board must not answer on the SPI bus: make the slaves report "not selected".
  const encSel = encoder.selected.bind(encoder);
  const dacSel = dac.selected.bind(dac);
  encoder.selected = () => !disposed && encSel();
  dac.selected = () => !disposed && dacSel();
  return model;
}

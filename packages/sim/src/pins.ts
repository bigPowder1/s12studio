/**
 * Electrical glue between the MCU model and board models.
 *
 * - `PinNet`: every MCU pin (e.g. 'PB3', 'PM4', 'PJ7', 'PS5', 'PP1', 'PAD08'). The MCU side drives a pin
 *   through two layers - 'gpio' (written by the PIM / port registers from DDR + data) and 'periph' (a module
 *   that has taken the pin over: SPI, SCI, PWM, ECT output compare, ECLK...). A non-null 'periph' layer wins.
 *   Board models drive pins from outside with `drive()`. `read()` resolves the electrical level the MCU input
 *   circuitry sees.
 * - `SpiBus`: byte-level SPI exchange between an SPI master module and slave devices (chip selects are ordinary
 *   GPIO pins the slaves watch on the PinNet).
 * - `AnalogBus`: voltages on ATD inputs, supplied by board models.
 * - `PwmBus`: PWM channel state published by the PWM module (duty/period), so board models can integrate
 *   average voltage without toggling pins every cycle.
 *
 * Time: callbacks receive the bus cycle (`PeripheralContext.now`) of the change. A board model that changes a
 * pin from outside a register access must first call `ctx.sync()` on the affected peripherals (see
 * `PeripheralContext`), or use `PinNet.externalChange()` which does so via the registered sync hook.
 */

export type Level = 0 | 1;
export type Pull = 'up' | 'down' | null;
export type DriveLayer = 'gpio' | 'periph';

export interface PinState {
  /** Level driven by the MCU (null = MCU output disabled / input). */
  mcu: Level | null;
  /** Which MCU layer currently drives (null when `mcu` is null). */
  mcuLayer: DriveLayer | null;
  /** Level driven by the board (null = board not driving). */
  ext: Level | null;
  /** Pull device enabled on the MCU pin. */
  pull: Pull;
  /** Resolved electrical level. */
  level: Level;
}

export type PinListener = (pin: string, state: Readonly<PinState>, cycle: number) => void;

interface PinRec {
  gpio: Level | null;
  periph: Level | null;
  ext: Level | null;
  pull: Pull;
  level: Level;
  listeners: PinListener[];
}

/** Level of a pin with nothing driving it and no pull device. UNCERTAIN: CMOS inputs float; 1 matches erased-port reads. */
export const FLOATING_LEVEL: Level = 1;

export class PinNet {
  private readonly pins = new Map<string, PinRec>();
  private readonly anyListeners: PinListener[] = [];
  /** Current bus cycle provider (set by the system). */
  now: () => number = () => 0;
  /** Called before an external change is applied, to bring MCU peripherals up to date. */
  syncHook: () => void = () => {};
  /** Called after an external change, so peripherals can reschedule (e.g. key-wakeup edge detection). */
  rescheduleHook: () => void = () => {};

  private rec(pin: string): PinRec {
    let r = this.pins.get(pin);
    if (!r) {
      r = { gpio: null, periph: null, ext: null, pull: null, level: FLOATING_LEVEL, listeners: [] };
      this.pins.set(pin, r);
    }
    return r;
  }

  private resolve(r: PinRec): Level {
    const mcu = r.periph ?? r.gpio;
    // UNCERTAIN: contention (MCU and board both driving, different levels) - the board wins and a warning
    // could be raised by the caller; real hardware would be undefined.
    if (r.ext !== null) return r.ext;
    if (mcu !== null) return mcu;
    if (r.pull === 'up') return 1;
    if (r.pull === 'down') return 0;
    return FLOATING_LEVEL;
  }

  private update(pin: string, r: PinRec): void {
    r.level = this.resolve(r);
    const st = this.state(pin);
    const cyc = this.now();
    // Listeners are told about every driver change (not only level changes): an LCD needs to know when the
    // MCU stops driving the data bus, a board model may care about the pull device.
    for (const l of r.listeners) l(pin, st, cyc);
    for (const l of this.anyListeners) l(pin, st, cyc);
  }

  /** MCU-side drive (PIM uses 'gpio'; a module that owns the pin uses 'periph'; null releases). */
  setMcuOutput(pin: string, level: Level | null, layer: DriveLayer = 'gpio'): void {
    const r = this.rec(pin);
    if (r[layer] === level) return;
    r[layer] = level;
    this.update(pin, r);
  }

  setPull(pin: string, pull: Pull): void {
    const r = this.rec(pin);
    if (r.pull === pull) return;
    r.pull = pull;
    this.update(pin, r);
  }

  /** Board-side drive (null = stop driving). Does NOT sync peripherals - see `externalChange`. */
  drive(pin: string, level: Level | null): void {
    const r = this.rec(pin);
    if (r.ext === level) return;
    r.ext = level;
    this.update(pin, r);
  }

  /** Board-side drive from outside the simulation loop (UI stimulus): sync, drive, reschedule. */
  externalChange(changes: ReadonlyArray<readonly [pin: string, level: Level | null]>): void {
    this.syncHook();
    for (const [p, l] of changes) this.drive(p, l);
    this.rescheduleHook();
  }

  read(pin: string): Level {
    return this.pins.get(pin)?.level ?? FLOATING_LEVEL;
  }

  /** Level the MCU drives (null = not driving). */
  mcuOutput(pin: string): Level | null {
    const r = this.pins.get(pin);
    return r ? (r.periph ?? r.gpio) : null;
  }

  state(pin: string): PinState {
    const r = this.rec(pin);
    const mcu = r.periph ?? r.gpio;
    return { mcu, mcuLayer: r.periph !== null ? 'periph' : r.gpio !== null ? 'gpio' : null, ext: r.ext, pull: r.pull, level: r.level };
  }

  /** Subscribe to one pin, or to all pins with '*'. Returns an unsubscribe function. */
  on(pin: string, fn: PinListener): () => void {
    const arr = pin === '*' ? this.anyListeners : this.rec(pin).listeners;
    arr.push(fn);
    return () => {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** Read 8 pins `${prefix}0..7` as a byte (bit n = pin n), e.g. readByte('PB'). */
  readByte(prefix: string): number {
    let v = 0;
    for (let i = 0; i < 8; i++) v |= this.read(`${prefix}${i}`) << i;
    return v;
  }

  /** Drive 8 pins from the board side (null = release all). */
  driveByte(prefix: string, value: number | null): void {
    for (let i = 0; i < 8; i++) this.drive(`${prefix}${i}`, value === null ? null : (((value >> i) & 1) as Level));
  }

  /** Byte the MCU drives on `${prefix}0..7`, with undriven bits taken from `fill` (default 0). */
  mcuByte(prefix: string, fill = 0): number {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const o = this.mcuOutput(`${prefix}${i}`);
      v |= (o ?? ((fill >> i) & 1)) << i;
    }
    return v;
  }

  /** All known pins (for UI/debug). */
  names(): string[] {
    return [...this.pins.keys()].sort();
  }
}

/** A slave on an SPI bus. Chip select is a GPIO pin the slave watches itself on the PinNet. */
export interface SpiSlave {
  readonly name: string;
  /** True while this slave is selected (its CS pin active). */
  selected(): boolean;
  /**
   * One full-duplex byte exchange, completed at bus cycle `cycle`. `mosi` is the byte shifted out by the master
   * (MSB first unless `lsbFirst`). Return the byte the slave shifts back on MISO.
   */
  exchange(mosi: number, cycle: number, mode: { cpol: 0 | 1; cpha: 0 | 1; lsbFirst: boolean }): number;
}

export class SpiBus {
  private readonly slaves: SpiSlave[] = [];
  constructor(readonly name: string) {}
  attach(s: SpiSlave): void {
    this.slaves.push(s);
  }
  /**
   * Called by the SPI master at the end of a transfer. Every selected slave sees the byte; MISO is the AND of
   * the selected slaves' responses (open bus = 0xFF). UNCERTAIN: bus contention with 2 selected slaves.
   */
  exchange(mosi: number, cycle: number, mode: { cpol: 0 | 1; cpha: 0 | 1; lsbFirst: boolean }): number {
    let miso = 0xff;
    for (const s of this.slaves) if (s.selected()) miso &= s.exchange(mosi, cycle, mode) & 0xff;
    return miso;
  }
}

/** Voltage sources on ATD input pins ('PAD00'..'PAD23'). */
export class AnalogBus {
  private readonly sources = new Map<string, (cycle: number) => number>();
  /** Reference voltages (VRH/VRL). ME305 board: UNCERTAIN, assume 5 V / 0 V. */
  vrh = 5;
  vrl = 0;
  set(pin: string, source: number | ((cycle: number) => number)): void {
    this.sources.set(pin, typeof source === 'number' ? () => source : source);
  }
  clear(pin: string): void {
    this.sources.delete(pin);
  }
  /** Voltage at the pin at bus cycle `cycle` (unconnected pins read 0 V. UNCERTAIN: floating input). */
  volts(pin: string, cycle: number): number {
    return this.sources.get(pin)?.(cycle) ?? 0;
  }
}

/** State of one PWM output (or a concatenated 16-bit channel pair) as published by the PWM module. */
export interface PwmOutputState {
  /** Pin carrying the output, e.g. 'PP1'. */
  pin: string;
  enabled: boolean;
  /** Fraction of the period the output is HIGH (polarity already applied), 0..1. */
  dutyHigh: number;
  /** Period in seconds (0 when disabled or period register is 0). */
  periodSeconds: number;
}

export type PwmListener = (s: Readonly<PwmOutputState>, cycle: number) => void;

export class PwmBus {
  private readonly states = new Map<string, PwmOutputState>();
  private readonly listeners: PwmListener[] = [];
  publish(s: PwmOutputState, cycle: number): void {
    this.states.set(s.pin, { ...s });
    for (const l of this.listeners) l(s, cycle);
  }
  get(pin: string): PwmOutputState | undefined {
    return this.states.get(pin);
  }
  on(fn: PwmListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

/** The set of buses a board connects to. Created once per simulated system. */
export interface BoardNets {
  pins: PinNet;
  spi: { SPI0: SpiBus; SPI1: SpiBus; SPI2: SpiBus };
  analog: AnalogBus;
  pwm: PwmBus;
}

export function createBoardNets(): BoardNets {
  return {
    pins: new PinNet(),
    spi: { SPI0: new SpiBus('SPI0'), SPI1: new SpiBus('SPI1'), SPI2: new SpiBus('SPI2') },
    analog: new AnalogBus(),
    pwm: new PwmBus(),
  };
}

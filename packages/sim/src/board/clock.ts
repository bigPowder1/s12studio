/**
 * Time services shared by the board models: a clock (bus cycles -> seconds), a tiny timer queue for board-side
 * events that are not caused by an MCU access (keypad tap release, encoder debounce...), and a typed emitter.
 *
 * Board models only know the `BoardNets` glue, so they work with any MCU model or with replayed traces. When the
 * board runs next to an `S12XSystem`, the integrator should:
 *   - pass `seconds: (c) => sys.bus.seconds(c)` and `busHz: () => sys.busHz` (exact time across PLL switches);
 *   - register `board.peripheral` with `sys.addPeripheral(board.peripheral, [])` so timed board events fire at
 *     their exact bus cycle during `run()` (without it, call `board.service(cycle)` between run slices).
 */
import type { Level, PinNet, PinState } from '../pins.js';
import type { Peripheral, PeripheralContext } from '../types.js';

export interface BoardClock {
  /** Current bus cycle (the PinNet's time source). */
  now(): number;
  /** Current bus clock (Hz). */
  busHz(): number;
  /** Absolute simulated seconds at bus cycle `cycle` (only needs to be valid for cycle >= the last clock change). */
  seconds(cycle: number): number;
}

export interface BoardClockOptions {
  /** Bus clock in Hz, fixed or live. Default 10 MHz (ME3305 after PLL lock). */
  busHz?: number | (() => number);
  /** Exact cycle -> seconds mapping (e.g. `c => sys.bus.seconds(c)`). Default `cycle / busHz()`. */
  seconds?: (cycle: number) => number;
  /** Override the time source (default `pins.now`). */
  now?: () => number;
}

export function makeBoardClock(pins: PinNet, o: BoardClockOptions = {}): BoardClock {
  const hz = o.busHz ?? 10_000_000;
  const busHz = typeof hz === 'number' ? () => hz : hz;
  return {
    now: o.now ?? (() => pins.now()),
    busHz,
    // UNCERTAIN: the default ignores bus-clock changes (8 MHz before PLL lock); pass `seconds` for exact time.
    seconds: o.seconds ?? ((c) => c / busHz()),
  };
}

interface Timer {
  id: number;
  cycle: number;
  fn: (cycle: number) => void;
}

/** Ordered queue of board-side timed events (absolute bus cycles). */
export class BoardScheduler {
  private timers: Timer[] = [];
  private nextId = 1;
  /** Called whenever the earliest deadline may have changed (the peripheral adapter reschedules). */
  onChange: () => void = () => {};

  /** Run `fn(cycle)` at absolute bus cycle `cycle`. Returns a cancel function. */
  at(cycle: number, fn: (cycle: number) => void): () => void {
    const t: Timer = { id: this.nextId++, cycle: Math.ceil(cycle), fn };
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1].cycle > t.cycle) i--;
    this.timers.splice(i, 0, t);
    this.onChange();
    return () => {
      const k = this.timers.indexOf(t);
      if (k >= 0) {
        this.timers.splice(k, 1);
        this.onChange();
      }
    };
  }

  /** Earliest pending deadline (absolute cycle), Infinity when idle. */
  nextDeadline(): number {
    return this.timers.length ? this.timers[0].cycle : Infinity;
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Fire every timer due at or before `cycle` (each with its own deadline as argument), in order. */
  runDue(cycle: number): void {
    while (this.timers.length && this.timers[0].cycle <= cycle) {
      const t = this.timers.shift()!;
      t.fn(t.cycle);
    }
  }

  clear(): void {
    this.timers = [];
    this.onChange();
  }

  /**
   * A register-less `Peripheral` that fires the board timers at their exact bus cycle inside `S12XSystem.run()`.
   * Register it with `sys.addPeripheral(p, [])`. MCU resets do not cancel board timers (the board has its own
   * power). `onAttach` receives the context (e.g. to read `ctx.busHz`).
   */
  asPeripheral(name = 'ME3305 board', onAttach?: (ctx: PeripheralContext) => void): Peripheral {
    let ctx: PeripheralContext | null = null;
    let local = 0;
    const self = this;
    return {
      name,
      attach(c) {
        ctx = c;
        local = c.now;
        self.onChange = () => {
          // Bring our local time to "now" first so the relative deadline is measured from the right origin.
          ctx!.sync();
          ctx!.reschedule();
        };
        onAttach?.(c);
      },
      reset() {
        if (ctx) local = ctx.now;
      },
      read: () => 0xff,
      write: () => {},
      peek: () => 0xff,
      tick(n) {
        local += n;
        self.runDue(local);
      },
      nextEventCycles() {
        const d = self.nextDeadline();
        return d === Infinity ? Infinity : Math.max(1, d - local);
      },
    };
  }
}

export type Listener<T> = (ev: T) => void;

/** Minimal synchronous typed event emitter. */
export class Emitter<T> {
  private ls: Listener<T>[] = [];
  on(fn: Listener<T>): () => void {
    this.ls.push(fn);
    return () => {
      const i = this.ls.indexOf(fn);
      if (i >= 0) this.ls.splice(i, 1);
    };
  }
  emit(ev: T): void {
    for (const l of [...this.ls]) l(ev);
  }
  get size(): number {
    return this.ls.length;
  }
  clear(): void {
    this.ls = [];
  }
}

/** Pin-level watcher: PinNet listeners fire on every driver change; this reports only level edges. */
export function watchLevel(pins: PinNet, pin: string, fn: (level: 0 | 1, cycle: number) => void): () => void {
  let last = pins.read(pin);
  return pins.on(pin, (_p, st, cyc) => {
    if (st.level === last) return;
    last = st.level;
    fn(st.level, cyc);
  });
}

/**
 * Level a board input sees when it does not trust `PinNet`'s FLOATING_LEVEL: a board or MCU driver wins, then the
 * MCU pull device (when `usePull`), else `undriven`. Board inputs such as an H-bridge enable or an LED have no
 * reason to read an undriven MCU pin as 1.
 */
export function drivenLevel(st: Readonly<PinState>, undriven: Level, usePull = true): Level {
  if (st.ext !== null) return st.ext;
  if (st.mcu !== null) return st.mcu;
  if (usePull && st.pull !== null) return st.pull === 'up' ? 1 : 0;
  return undriven;
}

/**
 * Like `watchLevel`, but on the `drivenLevel` of the pin. Uses `pins.on` (every driver/pull change), because a pull
 * or driver change can change this value without changing the resolved level. `fn` gets only edges.
 */
export function watchDriven(
  pins: PinNet,
  pin: string,
  undriven: Level,
  fn: (level: Level, cycle: number) => void,
  usePull = true,
): () => void {
  let last = drivenLevel(pins.state(pin), undriven, usePull);
  return pins.on(pin, (_p, st, cyc) => {
    const lv = drivenLevel(st, undriven, usePull);
    if (lv === last) return;
    last = lv;
    fn(lv, cyc);
  });
}

/** Fixed-capacity ring buffer (oldest entries overwritten): O(1) push for long-running histories. */
export class Ring<T> {
  private buf: T[] = [];
  private head = 0; // index of the oldest entry once full
  constructor(private cap: number) {
    this.cap = Math.max(0, Math.floor(cap));
  }
  get capacity(): number {
    return this.cap;
  }
  get length(): number {
    return this.buf.length;
  }
  push(v: T): void {
    if (this.cap === 0) return;
    if (this.buf.length < this.cap) this.buf.push(v);
    else {
      this.buf[this.head] = v;
      this.head = (this.head + 1) % this.cap;
    }
  }
  /** Entry `i` (0 = oldest). */
  at(i: number): T | undefined {
    if (i < 0 || i >= this.buf.length) return undefined;
    return this.buf[(this.head + i) % this.buf.length];
  }
  *[Symbol.iterator](): IterableIterator<T> {
    const n = this.buf.length;
    for (let i = 0; i < n; i++) yield this.buf[(this.head + i) % n];
  }
  /** Copy, oldest first. */
  toArray(): T[] {
    return this.head === 0 ? this.buf.slice() : this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
  }
  clear(): void {
    this.buf = [];
    this.head = 0;
  }
}

/** Reverse the bit order of a byte (SPI LSB-first transfers seen by an MSB-first slave). */
export function reverseBits8(v: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((v >> i) & 1) << (7 - i);
  return r;
}

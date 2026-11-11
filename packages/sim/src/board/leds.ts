/**
 * ME3305 LEDs on PP4..PP7 (active high: on when the pin is DRIVEN high). Two red/green pairs:
 * PP4 green / PP5 red = pair 2, PP6 green / PP7 red = pair 1 (from course lab code comments; positions UNCERTAIN).
 * An undriven pin does not light an LED (PinNet reports a floating pin as 1, which must not count); a pin held up
 * only by the MCU pull device counts as off unless `pullLights` (UNCERTAIN: an internal ~50 kohm pull-up through an
 * LED gives at most a faint glow).
 * Every on/off edge is recorded with its bus cycle and simulated time (bounded ring history) for the UI and for
 * tests that measure blink periods.
 */
import { ME3305 } from '@s12/devices';
import type { BoardNets, PinNet } from '../pins.js';
import { Emitter, Ring, drivenLevel, makeBoardClock, watchDriven, type BoardClock } from './clock.js';

export interface LedInfo {
  pin: string;
  color: 'green' | 'red';
  pair: number;
}

export interface LedEdge {
  pin: string;
  on: boolean;
  cycle: number;
  seconds: number;
}

export interface LedsOptions {
  leds: LedInfo[];
  /** Max recorded edges (oldest dropped, O(1) per edge). Default 100000. */
  historyLength: number;
  /** A pin pulled up (not driven) lights its LED. Default false (UNCERTAIN). */
  pullLights: boolean;
  clock: BoardClock;
}

export class Leds {
  readonly opts: LedsOptions;
  readonly edgeEvents = new Emitter<LedEdge>();
  private readonly pins: PinNet;
  private readonly hist: Ring<LedEdge>;
  private readonly unsub: Array<() => void> = [];

  constructor(nets: BoardNets, opts: Partial<LedsOptions> = {}) {
    this.pins = nets.pins;
    this.opts = {
      leds: opts.leds ?? ME3305.leds.map((l) => ({ ...l })),
      historyLength: opts.historyLength ?? 100_000,
      pullLights: opts.pullLights ?? false,
      clock: opts.clock ?? makeBoardClock(nets.pins),
    };
    this.hist = new Ring<LedEdge>(this.opts.historyLength);
    for (const l of this.opts.leds) {
      this.unsub.push(
        watchDriven(
          this.pins,
          l.pin,
          0,
          (lv, cycle) => {
            const e: LedEdge = { pin: l.pin, on: lv === 1, cycle, seconds: this.opts.clock.seconds(cycle) };
            this.hist.push(e);
            this.edgeEvents.emit(e);
          },
          this.opts.pullLights,
        ),
      );
    }
  }

  dispose(): void {
    for (const u of this.unsub.splice(0)) u();
  }

  /** Subscribe to on/off edges. */
  onEdge(fn: (e: LedEdge) => void): () => void {
    return this.edgeEvents.on(fn);
  }

  isOn(pin: string): boolean {
    return drivenLevel(this.pins.state(pin), 0, this.opts.pullLights) === 1;
  }

  /** Current state of every LED. */
  states(): Array<LedInfo & { on: boolean }> {
    return this.opts.leds.map((l) => ({ ...l, on: this.isOn(l.pin) }));
  }

  /** Recorded edges (optionally for one pin), oldest first. */
  edges(pin?: string): LedEdge[] {
    const out: LedEdge[] = [];
    for (const e of this.hist) if (!pin || e.pin === pin) out.push(e);
    return out;
  }

  /** Number of recorded edges (all pins). */
  get edgeCount(): number {
    return this.hist.length;
  }

  clearHistory(): void {
    this.hist.clear();
  }

  /** Mean period (s) between rising edges of `pin` over the recorded history (NaN with < 2 rising edges). */
  period(pin: string): number {
    let first = NaN;
    let last = NaN;
    let n = 0;
    for (const e of this.hist) {
      if (e.pin !== pin || !e.on) continue;
      if (n === 0) first = e.seconds;
      last = e.seconds;
      n++;
    }
    return n < 2 ? NaN : (last - first) / (n - 1);
  }

  /** Fraction of time `pin` was on between its first and last recorded edges (NaN without edges). */
  dutyCycle(pin: string): number {
    let on = 0;
    let first = NaN;
    let prev: LedEdge | null = null;
    for (const e of this.hist) {
      if (e.pin !== pin) continue;
      if (prev === null) first = e.seconds;
      else if (prev.on) on += e.seconds - prev.seconds;
      prev = e;
    }
    if (prev === null || prev.seconds === first) return NaN;
    return on / (prev.seconds - first);
  }
}

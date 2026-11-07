/**
 * 20-key keypad behind an MM74C923-style encoder (ME305: codes on PK0-4, /OE = PK5 from the MCU, DA = PJ7).
 *
 * - The encoder latches the 5-bit code of the last key; the code stays latched after release (until the next key).
 * - PK0-4 are driven only while /OE is low; with /OE high they are high-Z (the board stops driving, so the MCU
 *   pull-ups / floating level decide).
 * - DA polarity is configurable. 'activeHigh' (74C923-faithful, default, UNCERTAIN) = DA high while a valid key is
 *   held: the library's falling-edge Port J interrupt then fires on key RELEASE. 'activeLow' = inverted DA: the
 *   interrupt fires on PRESS.
 * - Two-key rollover like the 74C923: while a key is held, further presses are queued; when the active key is
 *   released DA drops and the next held key is encoded (latched + DA) after max(debounceSeconds,
 *   rolloverSeconds), so the ISR for the first key still reads the first key's code. Timed events need the board
 *   scheduler to be serviced (see `BoardScheduler.asPeripheral`).
 * - Keys are named by label ('1', 'A', 'ENT', 'F1'...), by PC key name, or by `{ code }` (encoder code). A plain
 *   number is taken as a LABEL (`press(1)` presses '1'), never as an encoder code.
 *
 * Key code table, values and labels: @s12/devices ME305 profile (private me305-board.md §4).
 */
import { ME305 } from '@s12/devices';
import type { BoardNets, Level, PinNet } from '../pins.js';
import { BoardScheduler, Emitter, makeBoardClock, watchLevel, type BoardClock } from './clock.js';

export interface KeyInfo {
  /** Label printed on the key ('0'..'9', 'A'..'F', 'F1', 'F2', 'BKSP', 'ENT'). */
  label: string;
  /** 5-bit encoder code on PK0-4. */
  code: number;
  /** Byte the library ISR stores for this key. */
  value: number;
  /** Suggested on-screen position (UNCERTAIN). */
  row: number;
  col: number;
  /** Suggested PC keyboard keys (KeyboardEvent.key values, case-insensitive). */
  pcKeys: string[];
}

/** Key label / PC key name (string), label digit (number 0-9), or `{ code }` = encoder code 0-19. */
export type KeyId = string | number | { code: number };

export interface KeypadOptions {
  /** Code output pins, LSB first. Default PK0..PK4. */
  codePins: string[];
  /** Output enable pin (MCU output, active low). Default PK5. */
  oe: string;
  /** Data-available pin. Default PJ7. */
  da: string;
  daPolarity: 'activeHigh' | 'activeLow';
  /**
   * Key debounce delay before DA asserts (74C923 key-bounce mask, set by an external capacitor). Default 0.
   * Needs the scheduler to be serviced when > 0.
   */
  debounceSeconds: number;
  /**
   * Minimum gap between DA dropping for a released key and DA asserting for a still-held rollover key, when
   * `debounceSeconds` is shorter. Default 1 ms (UNCERTAIN: the real gap is the 74C923 scan + key-bounce mask time).
   */
  rolloverSeconds: number;
  /** Code latched at power-on. UNCERTAIN: 74C923 latch content at power-up is undefined; 0 chosen. */
  initialCode: number;
  clock: BoardClock;
  scheduler: BoardScheduler;
}

export interface KeypadEvent {
  cycle: number;
  kind: 'press' | 'release' | 'da';
  key?: KeyInfo;
  /** DA asserted after this event. */
  da: boolean;
  code: number;
}

export interface KeypadSnapshot {
  held: number[];
  active: number | null;
  latched: number;
  daAsserted: boolean;
  /** Pending tap releases `[code, cycle]` (optional for older snapshots). */
  taps?: Array<[number, number]>;
  /** Pending DA assertion (debounce / rollover) for the active key. */
  pendingDaAt?: number | null;
}

/** Suggested PC key bindings for each label. */
const PC_KEYS: Record<string, string[]> = {
  F1: ['F1'],
  F2: ['F2'],
  BKSP: ['Backspace', 'Delete'],
  ENT: ['Enter'],
};

/** Keys of the ME305 keypad with layout (rows of `ME305.keypad.layout`) and PC key suggestions. */
export function me305Keys(): KeyInfo[] {
  const layout = ME305.keypad.layout;
  return ME305.keypad.table.map((k) => {
    let row = -1;
    let col = -1;
    layout.forEach((r, ri) => {
      const ci = r.indexOf(k.label);
      if (ci >= 0) {
        row = ri;
        col = ci;
      }
    });
    const pc = PC_KEYS[k.label] ?? [k.label.toLowerCase(), k.label.toUpperCase()].filter((x, i, a) => a.indexOf(x) === i);
    return { label: k.label, code: k.code, value: k.value, row, col, pcKeys: pc };
  });
}

export class Mm74c923Keypad {
  readonly opts: KeypadOptions;
  readonly keys: readonly KeyInfo[];
  readonly events = new Emitter<KeypadEvent>();
  private readonly pins: PinNet;
  private held: number[] = [];
  private active: number | null = null;
  private latched: number;
  private daAsserted = false;
  private cancelDebounce: (() => void) | null = null;
  private debounceAt: number | null = null;
  /** Pending tap releases: code -> release cycle and cancel function. */
  private readonly taps = new Map<number, { at: number; cancel: () => void }>();
  private readonly unsub: Array<() => void> = [];

  constructor(nets: BoardNets, opts: Partial<KeypadOptions> = {}) {
    this.pins = nets.pins;
    const clock = opts.clock ?? makeBoardClock(nets.pins);
    this.opts = {
      codePins: opts.codePins ?? ME305.keypad.codes,
      oe: opts.oe ?? ME305.keypad.oe,
      da: opts.da ?? ME305.keypad.da,
      daPolarity: opts.daPolarity ?? ME305.keypad.daPolarity,
      debounceSeconds: opts.debounceSeconds ?? 0,
      rolloverSeconds: opts.rolloverSeconds ?? 1e-3,
      initialCode: opts.initialCode ?? 0,
      clock,
      scheduler: opts.scheduler ?? new BoardScheduler(),
    };
    this.keys = me305Keys();
    this.latched = this.opts.initialCode & 0x1f;
    this.unsub.push(watchLevel(this.pins, this.opts.oe, () => this.driveCode()));
    this.driveCode();
    this.driveDa();
  }

  dispose(): void {
    for (const u of this.unsub.splice(0)) u();
    this.cancelTimers();
    for (const p of this.opts.codePins) this.pins.drive(p, null);
    this.pins.drive(this.opts.da, null);
  }

  /** Resolve a key by label (case-insensitive), PC key name, or code number. */
  key(id: KeyId): KeyInfo {
    if (typeof id === 'object') {
      const k = this.keys.find((x) => x.code === id.code);
      if (!k) throw new Error(`no key with code ${id.code}`);
      return k;
    }
    const u = String(id).toUpperCase();
    const k =
      this.keys.find((x) => x.label.toUpperCase() === u) ??
      this.keys.find((x) => x.pcKeys.some((p) => p.toUpperCase() === u));
    if (!k) throw new Error(`unknown key '${id}'`);
    return k;
  }

  /** Map a PC KeyboardEvent.key to a keypad key (undefined when unmapped). */
  keyForPc(pcKey: string): KeyInfo | undefined {
    try {
      return this.key(pcKey);
    } catch {
      return undefined;
    }
  }

  get latchedCode(): number {
    return this.latched;
  }

  /** DA asserted (logical, before polarity). */
  get dataAvailable(): boolean {
    return this.daAsserted;
  }

  get heldKeys(): KeyInfo[] {
    return this.held.map((c) => this.key({ code: c }));
  }

  get outputEnabled(): boolean {
    return this.pins.read(this.opts.oe) === 0;
  }

  /** Press a key (UI stimulus, outside the CPU loop: synced through `PinNet.externalChange`). */
  press(id: KeyId): void {
    const k = this.key(id);
    if (this.held.includes(k.code)) return;
    this.held.push(k.code);
    const cycle = this.opts.clock.now();
    this.events.emit({ cycle, kind: 'press', key: k, da: this.daAsserted, code: this.latched });
    if (this.active === null) this.encode(k.code, cycle);
  }

  /** Release a key. */
  release(id: KeyId): void {
    const k = this.key(id);
    const i = this.held.indexOf(k.code);
    if (i < 0) return;
    this.held.splice(i, 1);
    const tap = this.taps.get(k.code);
    if (tap) {
      tap.cancel();
      this.taps.delete(k.code);
    }
    const cycle = this.opts.clock.now();
    if (this.active === k.code) {
      this.active = null;
      this.cancelPendingDa();
      this.setDa(false);
      this.events.emit({ cycle, kind: 'release', key: k, da: false, code: this.latched });
      // 74C923 two-key rollover: a still-held key is encoded next, after a scan/debounce gap so DA really pulses.
      if (this.held.length) this.encode(this.held[0], cycle, Math.max(this.opts.debounceSeconds, this.opts.rolloverSeconds));
    } else {
      this.events.emit({ cycle, kind: 'release', key: k, da: this.daAsserted, code: this.latched });
    }
  }

  releaseAll(): void {
    for (const c of [...this.held]) this.release({ code: c });
  }

  /**
   * Press now and release `holdSeconds` later (bus-cycle exact when the board scheduler is serviced, see
   * `BoardScheduler.asPeripheral`). Returns the release cycle. A key that is already held is left alone (a user hold
   * is not cut short): the result is its pending tap release, or Infinity when it is held with no release pending.
   */
  tap(id: KeyId, holdSeconds = 0.1): number {
    const k = this.key(id);
    if (this.held.includes(k.code)) return this.taps.get(k.code)?.at ?? Infinity;
    this.press({ code: k.code });
    const at = this.opts.clock.now() + Math.max(1, Math.round(holdSeconds * this.opts.clock.busHz()));
    this.armTap(k.code, at);
    return at;
  }

  /** Pending tap releases (code -> release cycle). */
  get pendingTaps(): ReadonlyMap<number, number> {
    return new Map([...this.taps].map(([c, t]) => [c, t.at]));
  }

  /**
   * Board power cycle: release all keys without events, cancel timers, DA deasserted, latch = `initialCode`.
   * Pins are updated through `externalChange` (call from outside the CPU loop).
   */
  powerOn(): void {
    this.cancelTimers();
    this.held = [];
    this.active = null;
    this.latched = this.opts.initialCode & 0x1f;
    this.daAsserted = false;
    this.applyPins([...this.codeChanges(), [this.opts.da, this.daLevel(false)]]);
  }

  private armTap(code: number, at: number): void {
    const cancel = this.opts.scheduler.at(at, () => {
      this.taps.delete(code);
      this.release({ code });
    });
    this.taps.set(code, { at, cancel });
  }

  private cancelPendingDa(): void {
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.debounceAt = null;
  }

  private cancelTimers(): void {
    this.cancelPendingDa();
    for (const t of this.taps.values()) t.cancel();
    this.taps.clear();
  }

  private assertDa(code: number): void {
    this.cancelDebounce = null;
    this.debounceAt = null;
    this.latched = code;
    this.applyPins([...this.codeChanges(), [this.opts.da, this.daLevel(true)]]);
    this.daAsserted = true;
    this.events.emit({ cycle: this.opts.clock.now(), kind: 'da', key: this.key({ code }), da: true, code });
  }

  private armDa(code: number, at: number): void {
    this.debounceAt = at;
    this.cancelDebounce = this.opts.scheduler.at(at, () => this.assertDa(code));
  }

  private encode(code: number, cycle: number, delaySeconds = this.opts.debounceSeconds): void {
    this.active = code;
    if (delaySeconds > 0) this.armDa(code, cycle + Math.max(1, Math.round(delaySeconds * this.opts.clock.busHz())));
    else this.assertDa(code);
  }

  private setDa(on: boolean): void {
    if (this.daAsserted === on) return;
    this.daAsserted = on;
    this.applyPins([[this.opts.da, this.daLevel(on)]]);
  }

  private daLevel(asserted: boolean): Level {
    return (this.opts.daPolarity === 'activeHigh') === asserted ? 1 : 0;
  }

  private codeChanges(): Array<[string, Level | null]> {
    const en = this.outputEnabled;
    return this.opts.codePins.map((p, i) => [p, en ? (((this.latched >> i) & 1) as Level) : null]);
  }

  /** Board-initiated change: sync the MCU first (externalChange), codes before DA so an ISR sees valid data. */
  private applyPins(changes: Array<[string, Level | null]>): void {
    this.pins.externalChange(changes);
  }

  /** /OE changed (MCU write, inside the simulation loop): plain drive. */
  private driveCode(): void {
    for (const [p, l] of this.codeChanges()) this.pins.drive(p, l);
  }

  private driveDa(): void {
    this.pins.drive(this.opts.da, this.daLevel(this.daAsserted));
  }

  snapshot(): KeypadSnapshot {
    return {
      held: [...this.held],
      active: this.active,
      latched: this.latched,
      daAsserted: this.daAsserted,
      taps: [...this.taps].map(([c, t]) => [c, t.at] as [number, number]),
      pendingDaAt: this.debounceAt,
    };
  }

  /** Restore state and re-arm pending tap releases / DA assertion on the scheduler (this keypad's timers only). */
  restore(s: KeypadSnapshot): void {
    this.cancelTimers();
    this.held = [...s.held];
    this.active = s.active;
    this.latched = s.latched;
    this.daAsserted = s.daAsserted;
    this.driveCode();
    this.driveDa();
    for (const [code, at] of s.taps ?? []) if (this.held.includes(code)) this.armTap(code, at);
    if (s.pendingDaAt != null && s.active !== null && !s.daAsserted) this.armDa(s.active, s.pendingDaAt);
  }
}

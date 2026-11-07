/**
 * Periodic Interrupt Timer (S12PIT24B4C) of the MC9S12XDP512, registers $0340-$0357. Cycle-exact, lazy.
 *
 * Two 8-bit micro timers (bus-clock down-counters, reload PITMTLDm) produce trigger pulses every PITMTLDm+1 bus
 * cycles; four 16-bit channel down-counters (PITCNTn, reload PITLDn) count the triggers of the micro timer selected
 * by PITMUX. When a channel counts down from 0 it reloads and sets PTFn: period = (PITMTLD+1) * (PITLD+1) bus cycles.
 *
 * Time model: micro timer m's triggers fall at `mtNext[m] + j * (PITMTLD[m] + 1)`; channels are advanced in closed
 * form between register accesses, so an idle or running PIT costs nothing per instruction. `nextEventCycles` reports
 * the next time-out of a channel whose interrupt is enabled and whose flag is clear.
 *
 * Behaviour notes (S12XD/S12XE PIT chapter as remembered, see UNCERTAIN marks):
 * - PITE 0->1 loads both micro timers (PITMTLD) and every enabled channel (PITLD); counting starts at that write.
 *   PITE 1->0 stops the PIT and clears all PTF flags.
 * - PCEn 0->1 (with PITE=1) loads channel n from PITLDn; PCEn 1->0 disables it and clears PTFn.
 * - Writing PITMTLD / PITLD does not restart a counter; the new value is used at the next reload. PFLMT / PFLT force
 *   an immediate load (no flag).
 * - PITTF is write-1-to-clear; a flag being set in the same bus cycle as the clearing write stays set.
 * - PITSWAI / PITFRZ are stored but not modelled (the simulator stops all clocks while halted; WAIT gating needs CPU
 *   state the PeripheralContext does not expose).
 */
import { addr as regAddr, vectorByName } from '@s12/devices';
import type { BoardNets } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

const A = {
  PITCFLMT: regAddr('PITCFLMT'),
  PITFLT: regAddr('PITFLT'),
  PITCE: regAddr('PITCE'),
  PITMUX: regAddr('PITMUX'),
  PITINTE: regAddr('PITINTE'),
  PITTF: regAddr('PITTF'),
  PITMTLD0: regAddr('PITMTLD0'),
  PITMTLD1: regAddr('PITMTLD1'),
  PITLD0: regAddr('PITLD0'),
  PITCNT0: regAddr('PITCNT0'),
  PITCNT3: regAddr('PITCNT3'),
} as const;

/** Register-block base of the PIT ($0340). */
export const PIT_BASE = A.PITCFLMT;
/** Register range to pass to `S12XSystem.addPeripheral` ($0340-$0357). */
export const PIT_RANGE: RegisterRange = [PIT_BASE, A.PITCNT3 + 1];
export const PIT_REGS = A;
/** IVBR-relative vector offsets Vpit0..Vpit3 ($7A, $78, $76, $74). */
export const PIT_VECTORS: readonly number[] = [0, 1, 2, 3].map((n) => vectorByName(`Vpit${n}`)!.offset);

export const PIT_BITS = { PITE: 0x80, PITSWAI: 0x40, PITFRZ: 0x20, PFLMT: 0x03 } as const;

export interface PitOptions {
  /** Unused (the PIT has no pins); accepted for a uniform constructor signature. */
  nets?: BoardNets;
}

interface PitState {
  t: number;
  cflmt: number;
  ce: number;
  mux: number;
  inte: number;
  tf: number;
  mtld: number[];
  ld: number[];
  cnt: number[];
  /** Absolute cycle of each micro timer's next trigger (-1 = stopped). */
  mtNext: number[];
  /** Cycle each PTF flag was last set (for the same-cycle w1c rule). */
  tfSetAt: number[];
}

export class PitModule implements Peripheral {
  readonly name = 'PIT';
  private ctx: PeripheralContext | null = null;
  private s: PitState = PitModule.initial(0);
  private irq = 0;

  constructor(_nets?: BoardNets, _opts: PitOptions = {}) {}

  private static initial(t: number): PitState {
    return {
      t,
      cflmt: 0,
      ce: 0,
      mux: 0,
      inte: 0,
      tf: 0,
      mtld: [0, 0],
      ld: [0, 0, 0, 0],
      cnt: [0, 0, 0, 0],
      mtNext: [-1, -1],
      tfSetAt: [-1, -1, -1, -1],
    };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  reset(_cause?: ResetCause): void {
    this.s = PitModule.initial(this.ctx ? this.ctx.now : 0);
    this.updateIrq(true);
  }

  private get enabled(): boolean {
    return (this.s.cflmt & PIT_BITS.PITE) !== 0;
  }

  /** Channel n counts (PITE and PCEn). */
  private chOn(n: number): boolean {
    return this.enabled && (this.s.ce & (1 << n)) !== 0;
  }

  /** Time-out period of channel n in bus cycles with the current load values. */
  periodCycles(n: number): number {
    const m = (this.s.mux >> n) & 1;
    return (this.s.mtld[m] + 1) * (this.s.ld[n] + 1);
  }

  // ------------------------------------------------------------------ time

  tick(_n: number): void {
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  private advance(to: number): void {
    const s = this.s;
    if (to <= s.t) return;
    if (this.enabled) {
      for (let m = 0; m < 2; m++) {
        const first = s.mtNext[m];
        if (first < 0 || first > to) continue;
        const p = s.mtld[m] + 1;
        const k = Math.floor((to - first) / p) + 1; // triggers in (t, to]
        for (let n = 0; n < 4; n++) if (this.chOn(n) && ((s.mux >> n) & 1) === m) this.count(n, k, first, p);
        s.mtNext[m] = first + k * p;
      }
    }
    s.t = to;
    this.updateIrq();
  }

  /** Channel n receives `k` triggers at first, first+p, ... */
  private count(n: number, k: number, first: number, p: number): void {
    const s = this.s;
    const c = s.cnt[n];
    if (k <= c) {
      s.cnt[n] = c - k;
      return;
    }
    // Time-outs at trigger indices c+1, c+1+(L+1), ...
    const L = s.ld[n];
    const rem = k - (c + 1);
    s.cnt[n] = L - (rem % (L + 1));
    const lastIdx = c + 1 + Math.floor(rem / (L + 1)) * (L + 1);
    s.tf |= 1 << n;
    s.tfSetAt[n] = first + (lastIdx - 1) * p;
  }

  nextEventCycles(): number {
    const s = this.s;
    if (!this.enabled) return Infinity;
    let best = Infinity;
    for (let n = 0; n < 4; n++) {
      const bit = 1 << n;
      if (!this.chOn(n) || !(s.inte & bit) || s.tf & bit) continue;
      const m = (s.mux >> n) & 1;
      if (s.mtNext[m] < 0) continue;
      const at = s.mtNext[m] + s.cnt[n] * (s.mtld[m] + 1);
      if (at < best) best = at;
    }
    return best === Infinity ? Infinity : Math.max(1, best - s.t);
  }

  private updateIrq(force = false): void {
    if (!this.ctx) return;
    const w = this.s.tf & this.s.inte & 0x0f;
    const diff = force ? 0x0f : w ^ this.irq;
    this.irq = w;
    for (let n = 0; n < 4; n++) if (diff & (1 << n)) this.ctx.setInterrupt(PIT_VECTORS[n], (w & (1 << n)) !== 0);
  }

  // ------------------------------------------------------------------ registers

  private sync(): number {
    const now = this.ctx ? this.ctx.now : this.s.t;
    this.advance(now);
    return Math.max(now, this.s.t);
  }

  read(a: number): number {
    this.sync();
    return this.peek(a);
  }

  peek(a: number): number {
    const s = this.s;
    if (a >= A.PITLD0 && a <= A.PITCNT3 + 1) {
      const n = (a - A.PITLD0) >> 2;
      const off = (a - A.PITLD0) & 3;
      const v = off < 2 ? s.ld[n] : s.cnt[n];
      return off & 1 ? v & 0xff : v >> 8;
    }
    switch (a) {
      case A.PITCFLMT:
        return s.cflmt & 0xe0;
      case A.PITFLT:
        return 0;
      case A.PITCE:
        return s.ce;
      case A.PITMUX:
        return s.mux;
      case A.PITINTE:
        return s.inte;
      case A.PITTF:
        return s.tf;
      case A.PITMTLD0:
        return s.mtld[0];
      case A.PITMTLD1:
        return s.mtld[1];
      default:
        return 0;
    }
  }

  write(a: number, v: number): void {
    const t = this.sync();
    const s = this.s;
    v &= 0xff;
    if (a >= A.PITLD0 && a <= A.PITCNT3 + 1) {
      const n = (a - A.PITLD0) >> 2;
      const off = (a - A.PITLD0) & 3;
      // PITLD: 16-bit load value, used at the next reload (no restart). PITCNT is read-only.
      if (off === 0) s.ld[n] = (v << 8) | (s.ld[n] & 0xff);
      else if (off === 1) s.ld[n] = (s.ld[n] & 0xff00) | v;
      this.updateIrq();
      return;
    }
    switch (a) {
      case A.PITCFLMT: {
        const was = this.enabled;
        s.cflmt = v & 0xe0;
        if (this.enabled && !was) {
          for (let m = 0; m < 2; m++) this.loadMicro(m, t);
          for (let n = 0; n < 4; n++) if (s.ce & (1 << n)) s.cnt[n] = s.ld[n];
        } else if (!this.enabled && was) {
          // Disabling the PIT clears the time-out flags; the counters hold. UNCERTAIN: counter contents.
          s.tf = 0;
          s.mtNext = [-1, -1];
        }
        // PFLMT1:0 force-load the micro timers (only effective while the PIT is enabled. UNCERTAIN).
        if (this.enabled) for (let m = 0; m < 2; m++) if (v & (1 << m)) this.loadMicro(m, t);
        break;
      }
      case A.PITFLT:
        // PFLT3:0 force-load the 16-bit counters from PITLD (no flag). UNCERTAIN: ignored for disabled channels.
        for (let n = 0; n < 4; n++) if (v & (1 << n) && this.chOn(n)) s.cnt[n] = s.ld[n];
        break;
      case A.PITCE: {
        const old = s.ce;
        s.ce = v & 0x0f;
        for (let n = 0; n < 4; n++) {
          const bit = 1 << n;
          if (s.ce & bit && !(old & bit) && this.enabled) s.cnt[n] = s.ld[n];
          if (!(s.ce & bit)) s.tf &= ~bit;
        }
        break;
      }
      case A.PITMUX:
        s.mux = v & 0x0f;
        break;
      case A.PITINTE:
        s.inte = v & 0x0f;
        break;
      case A.PITTF: {
        let clr = v & 0x0f;
        for (let n = 0; n < 4; n++) if (s.tfSetAt[n] === t) clr &= ~(1 << n);
        s.tf &= ~clr;
        break;
      }
      case A.PITMTLD0:
        s.mtld[0] = v; // used at the next micro timer reload
        break;
      case A.PITMTLD1:
        s.mtld[1] = v;
        break;
      default:
        break;
    }
    this.updateIrq();
  }

  /** Load micro timer m with PITMTLDm at cycle t: its next trigger comes PITMTLDm+1 cycles later. */
  private loadMicro(m: number, t: number): void {
    this.s.mtNext[m] = t + this.s.mtld[m] + 1;
  }

  // ------------------------------------------------------------------ snapshot

  snapshot(): unknown {
    const s = this.s;
    return { ...s, mtld: [...s.mtld], ld: [...s.ld], cnt: [...s.cnt], mtNext: [...s.mtNext], tfSetAt: [...s.tfSetAt] };
  }

  restore(state: unknown): void {
    const s = state as PitState;
    this.s = { ...s, mtld: [...s.mtld], ld: [...s.ld], cnt: [...s.cnt], mtNext: [...s.mtNext], tfSetAt: [...s.tfSetAt] };
    this.updateIrq(true);
  }
}

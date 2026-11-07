/**
 * CRG (S12CRGV6) of the MC9S12XDP512: PLL (SYNR/REFDV, lock detector, PLLSEL bus-clock switch), RTI, COP watchdog
 * (normal + window mode, ARMCOP $55/$AA servicing, reset from FCTL) and a clock-monitor / self-clock-mode stub.
 *
 * Registers ($0034-$003F): SYNR, REFDV, CTFLG, CRGFLG, CRGINT, CLKSEL, PLLCTL, RTICTL, COPCTL, FORBYP, CTCTL, ARMCOP.
 *
 * Time: the RTI and COP count OSCCLK cycles. The model keeps an exact oscillator-cycle clock next to the bus-cycle
 * clock: one bus cycle = p/q oscillator cycles (2/1 on OSCCLK, (REFDV+1)/(SYNR+1) on PLLCLK), accumulated with an
 * integer remainder so event times (RTIF, COP time-out, PLL lock) land on exact bus cycles. Lazy: flags are computed
 * on access; only events that raise an interrupt or a reset are scheduled (`nextEventCycles`).
 *
 * Sources: MC9S12XDP512RMV2 ch.2 (S12CRGV6) as summarised in docs/research/r2/xdp512-device.md §3-§4 and critique C7,
 * S12CRGV4 block guide (same PLL/COP/RTI register semantics) for the write rules quoted below.
 */
import { addr, mask, vectorByName } from '@s12/devices';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

/** Register-block addresses (from @s12/devices). */
export const CRG_REGS = {
  SYNR: addr('SYNR'),
  REFDV: addr('REFDV'),
  CTFLG: addr('CTFLG'),
  CRGFLG: addr('CRGFLG'),
  CRGINT: addr('CRGINT'),
  CLKSEL: addr('CLKSEL'),
  PLLCTL: addr('PLLCTL'),
  RTICTL: addr('RTICTL'),
  COPCTL: addr('COPCTL'),
  FORBYP: addr('FORBYP'),
  CTCTL: addr('CTCTL'),
  ARMCOP: addr('ARMCOP'),
} as const;
const R = CRG_REGS;

/** Range to pass to `S12XSystem.addPeripheral` ($0034-$003F). */
export const CRG_RANGE: RegisterRange = [R.SYNR, R.ARMCOP];

/** IVBR-relative vector offsets: RTI $F0, PLL lock $C6, self-clock mode $C4. */
export const CRG_VECTORS = {
  rti: vectorByName('Vrti')!.offset,
  lock: vectorByName('Vcrgplllck')!.offset,
  scm: vectorByName('Vcrgscm')!.offset,
} as const;

/** Bit masks (from the device table). */
export const CRG_BITS = {
  RTIF: mask('CRGFLG', 'RTIF'),
  PORF: mask('CRGFLG', 'PORF'),
  LVRF: mask('CRGFLG', 'LVRF'),
  LOCKIF: mask('CRGFLG', 'LOCKIF'),
  LOCK: mask('CRGFLG', 'LOCK'),
  TRACK: mask('CRGFLG', 'TRACK'),
  SCMIF: mask('CRGFLG', 'SCMIF'),
  SCM: mask('CRGFLG', 'SCM'),
  RTIE: mask('CRGINT', 'RTIE'),
  ILAF: mask('CRGINT', 'ILAF'),
  LOCKIE: mask('CRGINT', 'LOCKIE'),
  SCMIE: mask('CRGINT', 'SCMIE'),
  PLLSEL: mask('CLKSEL', 'PLLSEL'),
  PSTP: mask('CLKSEL', 'PSTP'),
  PLLWAI: mask('CLKSEL', 'PLLWAI'),
  RTIWAI: mask('CLKSEL', 'RTIWAI'),
  COPWAI: mask('CLKSEL', 'COPWAI'),
  CME: mask('PLLCTL', 'CME'),
  PLLON: mask('PLLCTL', 'PLLON'),
  AUTO: mask('PLLCTL', 'AUTO'),
  ACQ: mask('PLLCTL', 'ACQ'),
  FSTWKP: mask('PLLCTL', 'FSTWKP'),
  PRE: mask('PLLCTL', 'PRE'),
  PCE: mask('PLLCTL', 'PCE'),
  SCME: mask('PLLCTL', 'SCME'),
  RTDEC: mask('RTICTL', 'RTDEC'),
  WCOP: mask('COPCTL', 'WCOP'),
  RSBCK: mask('COPCTL', 'RSBCK'),
  WRTMASK: mask('COPCTL', 'WRTMASK'),
  CR: mask('COPCTL', 'CR'),
} as const;
const B = CRG_BITS;
const CRGFLG_W1C = B.RTIF | B.PORF | B.LVRF | B.LOCKIF | B.SCMIF; // $F2
const CLKSEL_MASK = B.PLLSEL | B.PSTP | B.PLLWAI | B.RTIWAI | B.COPWAI; // $CB
const PLLCTL_RESET = 0xf1;

/** Flash configuration byte loaded into FCTL at reset (global address; local $FF0E). Critique C7. */
export const FCTL_FLASH_GLOBAL = 0x7fff0e;

/** RTI decimal-mode base dividers for RTR[6:4] = 0..7 (RTDEC = 1). UNCERTAIN: from memory of the S12CRGV6 table 2-8. */
export const RTI_DECIMAL_BASES: readonly number[] = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];

/**
 * RTI time-out period in OSCCLK cycles for an RTICTL value; 0 = RTI off.
 * - RTDEC=0 (binary): (RTR[3:0]+1) * 2^(RTR[6:4]+9); RTR[6:4]=000 = off (S12CRGV4/V6 table, verified for V4).
 * - RTDEC=1 (decimal): (RTR[3:0]+1) * {1,2,5,10,20,50,100,200}*10^3 (never off). UNCERTAIN: decimal table from memory.
 */
export function rtiPeriodOsc(rtictl: number): number {
  const lo = (rtictl & 0x0f) + 1;
  const hi = (rtictl >> 4) & 7;
  if (rtictl & 0x80) return lo * RTI_DECIMAL_BASES[hi];
  if (hi === 0) return 0;
  return lo * 2 ** (hi + 9);
}

/** COP time-out in OSCCLK cycles for CR[2:0]; 0 = COP disabled (xdp512-device.md §4, [S1] Table 2-10). */
export function copPeriodOsc(cr: number): number {
  return [0, 2 ** 14, 2 ** 16, 2 ** 18, 2 ** 20, 2 ** 22, 2 ** 23, 2 ** 24][cr & 7];
}

/** COPCTL reset value derived from the FCTL NV byte: CR = ~NV[2:0], WCOP = ~NV[3] (critique C7). */
export function copctlFromFctl(nv: number): number {
  const inv = ~nv & 0xff;
  return (inv & 0x07) | (inv & 0x08 ? B.WCOP : 0);
}

export type CrgMode = 'special' | 'normal';

export interface CrgOptions {
  /**
   * Time from PLLON=1 / a SYNR or REFDV write until LOCK (and TRACK) set, in seconds of simulated time.
   * UNCERTAIN: the datasheet gives only lock/track tolerances and an example stabilisation time; default 300 us.
   */
  lockTimeSeconds?: number;
  /**
   * Operating mode for the write-once rules (COPCTL WCOP/CR, RSBCK clear, SCME). Default 'special' (matches the
   * Bus default: a debugger session runs the MCU in special single-chip mode). Pass `() => sys.bus.opts.mode`.
   */
  mode?: CrgMode | (() => CrgMode);
  /** Global address of the flash byte loaded into FCTL at reset (default $7FFF0E). */
  fctlGlobal?: number;
  /**
   * Self-clock-mode frequency (PLLCLK at the VCO minimum) used by `simulateClockLoss()`. UNCERTAIN: fSCM is only
   * specified as a range in the datasheet; default 2 MHz (bus 1 MHz).
   */
  scmHz?: number;
}

interface CrgState {
  synr: number;
  refdv: number;
  /** CRGFLG flag bits RTIF/PORF/LVRF/LOCKIF/SCMIF (LOCK/TRACK/SCM are derived). */
  flags: number;
  crgint: number;
  clksel: number;
  pllctl: number;
  rtictl: number;
  /** COPCTL without WRTMASK. */
  copctl: number;
  /** WCOP/CR already written once (normal mode). */
  copWritten: boolean;
  scmeWritten: boolean;
  /** CLKSEL already written once (COPWAI is write-once in normal modes, S12CRGV4 §3.3.6). */
  copwaiWritten: boolean;
  /** PLL frequency within lock tolerance. */
  locked: boolean;
  scm: boolean;
  /** Bus cycle processed so far. */
  t: number;
  /** Oscillator cycles elapsed (whole) and fractional remainder in units of 1/q. */
  osc: number;
  rem: number;
  /** Oscillator cycles per bus cycle = p / q. */
  p: number;
  q: number;
  /** Oscillator time at which the PLL locks (-1: not pending). */
  lockAt: number;
  rtiStart: number;
  copStart: number;
  /** $55 written, waiting for $AA. */
  copArmed: boolean;
  /** A COP reset was requested (no further time-out until reset). */
  copFired: boolean;
}

export class Crg implements Peripheral {
  readonly name = 'CRG';
  private ctx: PeripheralContext | null = null;
  readonly lockTimeSeconds: number;
  readonly fctlGlobal: number;
  readonly scmHz: number;
  private readonly modeOpt: CrgMode | (() => CrgMode);
  private s: CrgState = Crg.initial(0);

  constructor(opts: CrgOptions = {}) {
    this.lockTimeSeconds = opts.lockTimeSeconds ?? 300e-6;
    this.fctlGlobal = opts.fctlGlobal ?? FCTL_FLASH_GLOBAL;
    this.scmHz = opts.scmHz ?? 2_000_000;
    this.modeOpt = opts.mode ?? 'special';
  }

  private static initial(t: number): CrgState {
    return {
      synr: 0,
      refdv: 0,
      flags: 0,
      crgint: 0,
      clksel: 0,
      pllctl: PLLCTL_RESET,
      rtictl: 0,
      copctl: 0,
      copWritten: false,
      scmeWritten: false,
      copwaiWritten: false,
      locked: false,
      scm: false,
      t,
      osc: 0,
      rem: 0,
      p: 2,
      q: 1,
      lockAt: -1,
      rtiStart: 0,
      copStart: 0,
      copArmed: false,
      copFired: false,
    };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  private get mode(): CrgMode {
    return typeof this.modeOpt === 'function' ? this.modeOpt() : this.modeOpt;
  }

  private get oscHz(): number {
    return this.ctx ? this.ctx.oscHz : 16_000_000;
  }

  private get lockTicks(): number {
    return Math.max(1, Math.round(this.lockTimeSeconds * this.oscHz));
  }

  reset(cause: ResetCause = 'power-on'): void {
    const old = this.s;
    const t = this.ctx ? this.ctx.now : 0;
    const s = Crg.initial(t);
    // PORF/LVRF/ILAF are unaffected by a system reset other than power-on (S12CRGV4 CRGFLG text; S12XMMC for ILAF).
    if (cause === 'power-on') {
      s.flags = B.PORF;
    } else {
      s.flags = old.flags & (B.PORF | B.LVRF);
      s.crgint = old.crgint & B.ILAF;
      if (cause === 'illegal-address') s.crgint |= B.ILAF;
    }
    // COPCTL WCOP/CR from FCTL (flash byte $7FFF0E). UNCERTAIN: a secured MCU forces CR=111 after a COP reset (C7);
    // security is not modelled.
    const nv = this.ctx ? this.ctx.readGlobal(this.fctlGlobal) & 0xff : 0xff;
    s.copctl = copctlFromFctl(nv);
    // PLLON=1 out of reset: the PLL starts acquiring at the reset SYNR/REFDV.
    s.lockAt = this.lockTicks;
    this.s = s;
    if (this.ctx && this.ctx.busHz !== this.oscHz / 2) this.ctx.setBusClockHz(this.oscHz / 2);
    this.updateIrq();
  }

  // ------------------------------------------------------------------ derived values

  /** PLLCLK (Hz) for the current SYNR/REFDV: 2 * OSCCLK * (SYNR+1) / (REFDV+1). */
  get pllHz(): number {
    return (2 * this.oscHz * (this.s.synr + 1)) / (this.s.refdv + 1);
  }

  /** Bus clock selected by the CRG. */
  get busHz(): number {
    if (this.s.scm) return this.scmHz / 2;
    return this.s.clksel & B.PLLSEL ? this.pllHz / 2 : this.oscHz / 2;
  }

  get pllSelected(): boolean {
    return (this.s.clksel & B.PLLSEL) !== 0;
  }

  get locked(): boolean {
    return this.s.locked;
  }

  /** TRACK: tracking mode (AUTO=1: set together with LOCK; AUTO=0: software selects with ACQ=0). UNCERTAIN timing. */
  private get track(): boolean {
    const s = this.s;
    return s.locked && ((s.pllctl & B.AUTO) !== 0 || (s.pllctl & B.ACQ) === 0);
  }

  get rtiPeriodOsc(): number {
    return rtiPeriodOsc(this.s.rtictl);
  }

  get copPeriodOsc(): number {
    return copPeriodOsc(this.s.copctl & B.CR);
  }

  /** Oscillator cycles elapsed since reset (exact). */
  get oscCycles(): number {
    return this.s.osc;
  }

  private crgflg(): number {
    const s = this.s;
    return s.flags | (s.locked ? B.LOCK : 0) | (this.track ? B.TRACK : 0) | (s.scm ? B.SCM : 0);
  }

  // ------------------------------------------------------------------ time

  private advance(t: number): void {
    const s = this.s;
    const dt = t - s.t;
    if (dt <= 0) return;
    s.t = t;
    if (s.scm) return; // UNCERTAIN: OSCCLK absent in self-clock mode; RTI/COP/lock frozen in this stub.
    const tot = s.rem + dt * s.p;
    s.osc += Math.floor(tot / s.q);
    s.rem = tot % s.q;
    this.processEvents();
  }

  private processEvents(): void {
    const s = this.s;
    let irq = false;
    if (s.lockAt >= 0 && s.osc >= s.lockAt) {
      s.lockAt = -1;
      if ((s.pllctl & B.PLLON) && !s.locked) {
        s.locked = true;
        s.flags |= B.LOCKIF;
        irq = true;
      }
    }
    const rp = rtiPeriodOsc(s.rtictl);
    if (rp > 0 && s.osc >= s.rtiStart + rp) {
      s.rtiStart += Math.floor((s.osc - s.rtiStart) / rp) * rp;
      s.flags |= B.RTIF;
      irq = true;
    }
    const cp = copPeriodOsc(s.copctl & B.CR);
    if (cp > 0 && !s.copFired && s.osc >= s.copStart + cp) this.copReset('time-out');
    if (irq) this.updateIrq();
  }

  tick(_n: number): void {
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  /** Bus cycles from the model's time until the oscillator clock reaches `target`. */
  private busUntilOsc(target: number): number {
    const s = this.s;
    const need = (target - s.osc) * s.q - s.rem;
    return need <= 0 ? 0 : Math.ceil(need / s.p);
  }

  nextEventCycles(): number {
    const s = this.s;
    if (s.scm) return Infinity;
    let n = Infinity;
    if (s.lockAt >= 0) n = Math.min(n, this.busUntilOsc(s.lockAt));
    const rp = rtiPeriodOsc(s.rtictl);
    if (rp > 0 && s.crgint & B.RTIE && !(s.flags & B.RTIF)) n = Math.min(n, this.busUntilOsc(s.rtiStart + rp));
    const cp = copPeriodOsc(s.copctl & B.CR);
    if (cp > 0 && !s.copFired) n = Math.min(n, this.busUntilOsc(s.copStart + cp));
    return n;
  }

  private now(): number {
    const n = this.ctx ? this.ctx.now : 0;
    return n > this.s.t ? n : this.s.t;
  }

  // ------------------------------------------------------------------ interrupts / resets

  private updateIrq(): void {
    if (!this.ctx) return;
    const s = this.s;
    this.ctx.setInterrupt(CRG_VECTORS.rti, (s.crgint & B.RTIE) !== 0 && (s.flags & B.RTIF) !== 0);
    this.ctx.setInterrupt(CRG_VECTORS.lock, (s.crgint & B.LOCKIE) !== 0 && (s.flags & B.LOCKIF) !== 0);
    this.ctx.setInterrupt(CRG_VECTORS.scm, (s.crgint & B.SCMIE) !== 0 && (s.flags & B.SCMIF) !== 0);
  }

  private copReset(why: string): void {
    const s = this.s;
    if (s.copFired) return;
    s.copFired = true;
    this.ctx?.warn(`COP reset (${why})`, { cause: 'cop', why });
    this.ctx?.requestReset('cop');
  }

  /** Clear LOCK (LOCKIF when it was set) and restart the lock detector if the PLL is on. */
  private relock(): void {
    const s = this.s;
    if (s.locked) {
      s.locked = false;
      s.flags |= B.LOCKIF;
    }
    s.lockAt = s.pllctl & B.PLLON ? s.osc + this.lockTicks : -1;
  }

  /** Bus-clock ratio after a PLLSEL / SCM change (the time base is already advanced to now). */
  private setRatio(): void {
    const s = this.s;
    let p: number;
    let q: number;
    if (s.clksel & B.PLLSEL) {
      p = s.refdv + 1;
      q = s.synr + 1;
    } else {
      p = 2;
      q = 1;
    }
    if (p !== s.p || q !== s.q) {
      s.rem = Math.floor((s.rem * q) / s.q);
      s.p = p;
      s.q = q;
    }
    const hz = this.busHz;
    if (this.ctx && this.ctx.busHz !== hz) this.ctx.setBusClockHz(hz);
  }

  // ------------------------------------------------------------------ registers

  read(a: number): number {
    this.advance(this.now());
    return this.peek(a);
  }

  peek(a: number): number {
    const s = this.s;
    switch (a) {
      case R.SYNR:
        return s.synr;
      case R.REFDV:
        return s.refdv;
      case R.CRGFLG:
        return this.crgflg();
      case R.CRGINT:
        return s.crgint;
      case R.CLKSEL:
        return s.clksel;
      case R.PLLCTL:
        return s.pllctl;
      case R.RTICTL:
        return s.rtictl;
      case R.COPCTL:
        return s.copctl; // WRTMASK reads 0
      case R.CTCTL:
        // UNCERTAIN: S12CRGV4 "CTCTL always reads $80 except in special modes"; special-mode value assumed $00.
        return this.mode === 'normal' ? 0x80 : 0;
      case R.CTFLG:
      case R.FORBYP:
      case R.ARMCOP:
      default:
        return 0;
    }
  }

  write(a: number, v: number): void {
    this.advance(this.now());
    const s = this.s;
    v &= 0xff;
    switch (a) {
      case R.SYNR:
      case R.REFDV:
        // Write anytime except when PLLSEL=1; a write re-initialises the lock and track detectors.
        if (s.clksel & B.PLLSEL) {
          this.ctx?.warn(`write to ${a === R.SYNR ? 'SYNR' : 'REFDV'} ignored while PLLSEL=1`, { value: v });
          return;
        }
        if (a === R.SYNR) s.synr = v & 0x3f;
        else s.refdv = v & 0x3f;
        this.relock();
        break;
      case R.CRGFLG:
        s.flags &= ~(v & CRGFLG_W1C);
        break;
      case R.CRGINT:
        s.crgint = (s.crgint & ~(v & B.ILAF) & B.ILAF) | (v & (B.RTIE | B.LOCKIE | B.SCMIE));
        break;
      case R.CLKSEL:
        this.writeClksel(v & CLKSEL_MASK);
        break;
      case R.PLLCTL:
        this.writePllctl(v);
        break;
      case R.RTICTL:
        // A write restarts the RTI time-out period.
        s.rtictl = v;
        s.rtiStart = s.osc;
        break;
      case R.COPCTL:
        this.writeCopctl(v);
        break;
      case R.ARMCOP:
        this.writeArmcop(v);
        break;
      default:
        // CTFLG/FORBYP/CTCTL: factory test registers. UNCERTAIN: special-mode writes ignored.
        return;
    }
    this.updateIrq();
  }

  private writeClksel(v: number): void {
    const s = this.s;
    let sel = v & B.PLLSEL;
    const was = s.clksel & B.PLLSEL;
    if (sel && !was) {
      // Writing a one when LOCK=0 and AUTO=1, or TRACK=0 and AUTO=0, has no effect (S12CRGV4 CLKSEL).
      const auto = (s.pllctl & B.AUTO) !== 0;
      const ok = (s.pllctl & B.PLLON) !== 0 && !s.scm && (auto ? s.locked : this.track);
      if (!ok) {
        sel = 0;
        this.ctx?.warn('PLLSEL=1 ignored: PLL not locked', { pllctl: s.pllctl, lock: s.locked });
      }
    }
    // COPWAI: normal modes write once (the first CLKSEL write counts), special modes write anytime.
    let rest = v & ~B.PLLSEL;
    if (this.mode === 'normal') {
      if (s.copwaiWritten) rest = (rest & ~B.COPWAI) | (s.clksel & B.COPWAI);
      s.copwaiWritten = true;
    }
    s.clksel = rest | sel;
    // PLLWAI sets AUTO.
    if (s.clksel & B.PLLWAI) s.pllctl |= B.AUTO;
    if (sel !== was) this.setRatio();
  }

  private writePllctl(v: number): void {
    const s = this.s;
    const old = s.pllctl;
    let nv = v;
    // PLLON: write anytime except when PLLSEL=1.
    if (s.clksel & B.PLLSEL) nv = (nv & ~B.PLLON) | (old & B.PLLON);
    // CME: write anytime except when SCM=1.
    if (s.scm) nv = (nv & ~B.CME) | (old & B.CME);
    // SCME: UNCERTAIN: write-once in normal modes, anytime in special modes (S12CRGV6 from memory).
    if (this.mode === 'normal') {
      if (s.scmeWritten) nv = (nv & ~B.SCME) | (old & B.SCME);
      s.scmeWritten = true;
    }
    // SCME can not be cleared while operating in self-clock mode (S12CRGV4 §3.3.7).
    if (s.scm) nv |= old & B.SCME;
    // AUTO cannot be cleared while PLLWAI=1 (PLLWAI sets AUTO).
    if (s.clksel & B.PLLWAI) nv |= B.AUTO;
    s.pllctl = nv;
    if ((old ^ nv) & B.PLLON) {
      if (nv & B.PLLON) {
        s.lockAt = s.osc + this.lockTicks;
      } else {
        if (s.locked) s.flags |= B.LOCKIF;
        s.locked = false;
        s.lockAt = -1;
      }
    }
  }

  private writeCopctl(v: number): void {
    const s = this.s;
    const normal = this.mode === 'normal';
    // RSBCK: normal modes can set it but not clear it (C7).
    const rsbck = normal ? (s.copctl | v) & B.RSBCK : v & B.RSBCK;
    let rest = s.copctl & (B.WCOP | B.CR);
    // WRTMASK=1: WCOP/CR are not written and the write does not count as the one write (C7).
    if (!(v & B.WRTMASK) && (!normal || !s.copWritten)) {
      rest = v & (B.WCOP | B.CR);
      s.copWritten = true;
      // UNCERTAIN: a WCOP/CR write restarts the COP time-out period.
      s.copStart = s.osc;
      s.copArmed = false;
    }
    s.copctl = rsbck | rest;
  }

  private writeArmcop(v: number): void {
    const s = this.s;
    const period = copPeriodOsc(s.copctl & B.CR);
    if (period === 0) return; // COP disabled: no effect
    if (s.copctl & B.WCOP && s.osc - s.copStart < (period * 3) / 4) {
      this.copReset(`ARMCOP write $${hex2(v)} in the closed window (first 75% of the period)`);
      return;
    }
    if (v === 0x55) s.copArmed = true;
    else if (v === 0xaa) {
      if (s.copArmed) {
        s.copArmed = false;
        s.copStart = s.osc;
      }
    } else this.copReset(`ARMCOP write of $${hex2(v)} (only $55/$AA allowed)`);
  }

  // ------------------------------------------------------------------ clock monitor stub

  /**
   * Simulate loss of the oscillator (debug/UI stimulus, call outside a register access). CME=0: nothing is detected
   * (UNCERTAIN: the MCU would stall). CME=1, SCME=1: self-clock mode (SCM=1, SCMIF, PLLSEL cleared, bus = fSCM/2).
   * CME=1, SCME=0: clock-monitor reset.
   */
  simulateClockLoss(): void {
    this.ctx?.sync();
    const s = this.s;
    if (!(s.pllctl & B.CME) || s.scm) return;
    if (s.pllctl & B.SCME) {
      s.scm = true;
      s.flags |= B.SCMIF;
      if (s.locked) s.flags |= B.LOCKIF;
      s.locked = false;
      s.lockAt = -1;
      s.clksel &= ~B.PLLSEL;
      this.setRatio();
      this.updateIrq();
    } else {
      this.ctx?.requestReset('clock-monitor');
    }
    this.ctx?.reschedule();
  }

  /** The oscillator is back: leave self-clock mode (SCMIF set, bus = OSCCLK/2, PLL re-acquires). */
  simulateClockRecovery(): void {
    this.ctx?.sync();
    const s = this.s;
    if (!s.scm) return;
    s.scm = false;
    s.flags |= B.SCMIF;
    this.setRatio();
    if (s.pllctl & B.PLLON) s.lockAt = s.osc + this.lockTicks;
    this.updateIrq();
    this.ctx?.reschedule();
  }

  // ------------------------------------------------------------------ snapshot

  snapshot(): unknown {
    return { ...this.s };
  }

  restore(state: unknown): void {
    this.s = { ...(state as CrgState) };
    this.updateIrq();
  }
}

function hex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

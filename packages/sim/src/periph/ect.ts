/**
 * Enhanced Capture Timer ECT_16B8C (V3 on the MC9S12XDP512), registers $0040-$007F. Cycle-exact, lazy.
 *
 * Time model (all times are absolute bus cycles, `ctx.now`):
 * - The main counter TCNT is clocked by the timer prescaler (bus / 2^PR, or bus / (PTPSR+1) with PRNT=1), or by
 *   PACLK (pulse accumulator A) when PAEN=1 and PACTL.CLK != 0. With the prescaler, timer ticks happen at bus
 *   cycles `anchor + j*N` (j >= 1); `anchor` is the cycle TEN was set (prescaler cleared) or the last prescaler
 *   switch point. Nothing is done per cycle: TCNT is computed from elapsed cycles, and only "interesting" ticks
 *   (a compare match, an overflow, a TCRE reset) are processed individually.
 * - ORDERING RULE (C11, chosen and documented here): within one bus cycle the timer tick happens BEFORE the CPU's
 *   register access in that cycle. So a TCNT read at cycle c sees the tick of cycle c, and a TCn write at cycle c
 *   is NOT seen by the compare evaluated at the tick of cycle c (option `compareWriteSameTick: 'hit'` flips just
 *   that tie-break). The access cycle is `ctx.now` at the access (instruction start + the access-string offset of
 *   the R/W cycle); a 16-bit access arrives as two byte calls at the same cycle, so word accesses are coherent.
 * - OUTPUT COMPARE is an EQUALITY match evaluated once per timer tick: CnF sets at the tick where TCNT becomes
 *   equal to TCn (never `>=`). A TCn write that lands after that tick misses until TCNT comes round again
 *   (65536 ticks later, or the next TCRE period).
 *
 * Pins: PT0..PT7 on the PinNet. OC outputs drive the 'periph' layer (TEN=1, IOSn=1, OMn:OLn != 00, or OC7Mn=1
 * with IOS7=IOSn=1, per the ECT guide 4.2.4; the pin starts low when it is taken over). Input edges are seen through
 * PinNet listeners (the edge time is the cycle the level changed; the module syncs itself first).
 *
 * - FLAG SET vs CLEAR in the same bus cycle (a w1c write, or a TFFCA fast clear, in the cycle an event sets the flag):
 *   the set wins and the flag stays set (same rule as the PIT). UNCERTAIN: usual S12 flag-logic behaviour, not
 *   stated in the ECT guide.
 * - Self-caused edges: an OC output (or a board model reacting to it) changing a PT pin while the module advances is
 *   processed at the exact tick; the advance stops there so a delay-counter expiry it schedules is handled in order,
 *   and the gated pulse accumulator is brought up to the edge with the old gate level first.
 *
 * Sources: ECT_16B8C Block User Guide V01.06 (register and functional text), xdp512-device.md section 5, critique C11.
 * V3 additions (PRNT/PTPSR/PTMCPSR, 8-bit DLYCT with PRNT=1) are from the S12XD family RM text as remembered: see
 * UNCERTAIN notes.
 *
 * Not modelled: TSWAI/TSFRZ (the simulator stops all clocks while halted, which is what TSFRZ gives; WAIT-mode gating
 * needs CPU state the PeripheralContext does not expose), TIMTST test bypass, XGATE routing.
 */
import { addr as regAddr, mask, vectorByName } from '@s12/devices';
import type { BoardNets, Level } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

// ------------------------------------------------------------------ register map (from @s12/devices)

const A = {
  TIOS: regAddr('TIOS'),
  CFORC: regAddr('CFORC'),
  OC7M: regAddr('OC7M'),
  OC7D: regAddr('OC7D'),
  TCNT: regAddr('TCNT'),
  TSCR1: regAddr('TSCR1'),
  TTOV: regAddr('TTOV'),
  TCTL1: regAddr('TCTL1'),
  TCTL2: regAddr('TCTL2'),
  TCTL3: regAddr('TCTL3'),
  TCTL4: regAddr('TCTL4'),
  TIE: regAddr('TIE'),
  TSCR2: regAddr('TSCR2'),
  TFLG1: regAddr('TFLG1'),
  TFLG2: regAddr('TFLG2'),
  TC0: regAddr('TC0'),
  TC7: regAddr('TC7'),
  PACTL: regAddr('PACTL'),
  PAFLG: regAddr('PAFLG'),
  PACN3: regAddr('PACN3'),
  PACN0: regAddr('PACN0'),
  MCCTL: regAddr('MCCTL'),
  MCFLG: regAddr('MCFLG'),
  ICPAR: regAddr('ICPAR'),
  DLYCT: regAddr('DLYCT'),
  ICOVW: regAddr('ICOVW'),
  ICSYS: regAddr('ICSYS'),
  PTPSR: regAddr('PTPSR'),
  PTMCPSR: regAddr('PTMCPSR'),
  PBCTL: regAddr('PBCTL'),
  PBFLG: regAddr('PBFLG'),
  PA3H: regAddr('PA3H'),
  PA0H: regAddr('PA0H'),
  MCCNT: regAddr('MCCNT'),
  TC0H: regAddr('TC0H'),
  TC3H: regAddr('TC3H'),
} as const;

/** Register-block base of the ECT ($0040). */
export const ECT_BASE = A.TIOS;
/** Register range to pass to `S12XSystem.addPeripheral` ($0040-$007F). */
export const ECT_RANGE: RegisterRange = [ECT_BASE, ECT_BASE + 0x3f];
/** Register addresses (for tests and the integrator). */
export const ECT_REGS = A;

/** IVBR-relative vector offsets. */
export const ECT_VECTORS = {
  /** Vtimch0..Vtimch7 ($EE..$E0). */
  ch: [0, 1, 2, 3, 4, 5, 6, 7].map((n) => vectorByName(`Vtimch${n}`)!.offset) as readonly number[],
  ovf: vectorByName('Vtimovf')!.offset,
  paaovf: vectorByName('Vtimpaaovf')!.offset,
  paie: vectorByName('Vtimpaie')!.offset,
  mdcu: vectorByName('Vtimmdcu')!.offset,
  pabovf: vectorByName('Vtimpabovf')!.offset,
} as const;

/** Port T pins used by channels 0..7. */
export const ECT_PINS: readonly string[] = ['PT0', 'PT1', 'PT2', 'PT3', 'PT4', 'PT5', 'PT6', 'PT7'];

/** Bit masks (checked against the device table at load time). */
export const ECT_BITS = {
  TEN: mask('TSCR1', 'TEN'),
  TSWAI: mask('TSCR1', 'TSWAI'),
  TSFRZ: mask('TSCR1', 'TSFRZ'),
  TFFCA: mask('TSCR1', 'TFFCA'),
  PRNT: mask('TSCR1', 'PRNT'),
  TOI: mask('TSCR2', 'TOI'),
  TCRE: mask('TSCR2', 'TCRE'),
  PR: mask('TSCR2', 'PR'),
  TOF: mask('TFLG2', 'TOF'),
  PAEN: mask('PACTL', 'PAEN'),
  PAMOD: mask('PACTL', 'PAMOD'),
  PEDGE: mask('PACTL', 'PEDGE'),
  CLK: mask('PACTL', 'CLK'),
  PAOVI: mask('PACTL', 'PAOVI'),
  PAI: mask('PACTL', 'PAI'),
  PAOVF: mask('PAFLG', 'PAOVF'),
  PAIF: mask('PAFLG', 'PAIF'),
  MCZI: mask('MCCTL', 'MCZI'),
  MODMC: mask('MCCTL', 'MODMC'),
  RDMCL: mask('MCCTL', 'RDMCL'),
  ICLAT: mask('MCCTL', 'ICLAT'),
  FLMC: mask('MCCTL', 'FLMC'),
  MCEN: mask('MCCTL', 'MCEN'),
  MCPR: mask('MCCTL', 'MCPR'),
  MCZF: mask('MCFLG', 'MCZF'),
  TFMOD: mask('ICSYS', 'TFMOD'),
  PACMX: mask('ICSYS', 'PACMX'),
  BUFEN: mask('ICSYS', 'BUFEN'),
  LATQ: mask('ICSYS', 'LATQ'),
  SH04: mask('ICSYS', 'SH04'),
  PBEN: mask('PBCTL', 'PBEN'),
  PBOVI: mask('PBCTL', 'PBOVI'),
  PBOVF: mask('PBFLG', 'PBOVF'),
} as const;
const B = ECT_BITS;

/** Modulus counter prescaler (MCPR1:0, legacy mode): 1, 4, 8, 16. */
const MCPR_DIV = [1, 4, 8, 16] as const;

/**
 * Delay-counter length (bus cycles) for a DLYCT value ($00 = bypassed).
 * - PRNT=0: only DLY1:0 are used, 01/10/11 = 256/512/1024 bus cycles (ECT_16B8C V01.06 Table 3-8, verified).
 * - PRNT=1: all 8 bits, (DLYCT+1) x 4 bus cycles. UNCERTAIN: recalled from the S12X ECT V3 "PRNT = 1" example table
 *   (some recollections add a 2-cycle synchroniser latency); configurable through `EctOptions.delayCycles`.
 */
export function defaultDelayCycles(dlyct: number, prnt = false): number {
  dlyct &= 0xff;
  if (dlyct === 0) return 0;
  if (!prnt) return [0, 256, 512, 1024][dlyct & 3];
  return (dlyct + 1) * 4;
}

export type EctMode = 'special' | 'normal';

/** Flag bits of the internal "set in this cycle" mask (set-wins rule). */
const F_TOF = 1 << 8;
const F_PAOVF = 1 << 9;
const F_PAIF = 1 << 10;
const F_MCZF = 1 << 11;
const F_PBOVF = 1 << 12;

export interface EctOptions {
  /**
   * Chip mode (default 'special', like the bus default under a BDM debugger). In special mode TCNT is writable and the
   * write-once bits (TSCR1.PRNT, ICSYS) stay writable; in normal mode TCNT writes are ignored and PRNT/ICSYS can be
   * written once after reset. A getter (e.g. `() => sys.bus.opts.mode`) is read at each use, so a reset into another
   * mode is honoured.
   */
  mode?: EctMode | (() => EctMode);
  /**
   * C11 tie-break for a TCn write landing in the same bus cycle as the timer tick at which TCNT becomes equal to the
   * new TCn value. 'miss' (default): the tick (and its compare) precede the access in that cycle, so the match is lost
   * until the counter comes round again. 'hit': the late write still matches at that tick.
   * UNCERTAIN: needs a scope measurement on a real board (critique C11).
   */
  compareWriteSameTick?: 'miss' | 'hit';
  /** Delay-counter length in bus cycles for a DLYCT value and TSCR1.PRNT (default `defaultDelayCycles`). */
  delayCycles?: (dlyct: number, prnt: boolean) => number;
  /**
   * Writes to TCn while channel n is an input capture. The guide says they "have no meaning or effect" (default
   * 'ignore'); 'store' keeps the value (useful if code preloads TCn before setting TIOS). UNCERTAIN.
   */
  icWrite?: 'ignore' | 'store';
  /** Notified when the set of pins driven by the ECT changes (the PIM should show them as timer-owned). */
  onPinsChanged?: () => void;
}

interface EctState {
  /** Module time (latest bus cycle processed). */
  t: number;
  tios: number;
  oc7m: number;
  oc7d: number;
  tscr1: number;
  ttov: number;
  /** TCTL1:TCTL2 (OMn at bit 2n+1, OLn at bit 2n). */
  tctl12: number;
  /** TCTL3:TCTL4 (EDGnB at bit 2n+1, EDGnA at bit 2n). */
  tctl34: number;
  tie: number;
  tscr2: number;
  tflg1: number;
  tflg2: number;
  tc: number[];
  tch: number[];
  pactl: number;
  paflg: number;
  /** PACN0..PACN3 (index = n). */
  pacn: number[];
  /** PA0H..PA3H (index = n). */
  pah: number[];
  /** MCCTL stored bits (MCZI MODMC RDMCL MCEN MCPR). */
  mcctl: number;
  mczf: boolean;
  polf: number;
  icpar: number;
  dlyct: number;
  icovw: number;
  icsys: number;
  ptpsr: number;
  ptmcpsr: number;
  pbctl: number;
  pbflg: number;
  prntLocked: boolean;
  icsysLocked: boolean;
  // --- main counter
  tcnt: number;
  lastTickAt: number;
  matchedAtLastTick: number;
  flagsSetAtLastTick: number;
  /** Output latch before the actions of the last tick, and the TOV toggle mask applied at it (CFORC precedence). */
  tickLatch: number;
  tickTov: number;
  /** Set-wins rule: flags (TFLG1 bits 0-7, F_TOF, F_PAOVF, F_PAIF, F_MCZF, F_PBOVF) set in bus cycle `setCyc`. */
  setCyc: number;
  setMask: number;
  /** Time up to which the gated pulse accumulator A has been advanced. */
  gT: number;
  /** Prescaler output: ticks at prescAnchor + j*prescN. */
  prescAnchor: number;
  prescN: number;
  /** Binary prescaler phase (the /64 PACLK grid). */
  pscAnchor: number;
  /** Pending prescaler switch (cycle, -1 = none) and its new division. */
  pendAt: number;
  pendN: number;
  /** Gated-PACLK main clock (PAEN=1, PAMOD=1, CLK != 0): ticks at gAnchor + j*gN while the gate is active. */
  gAnchor: number;
  gN: number;
  /** TFLG1:TFLG2 at the start of the last TCRE period (skip optimisation). */
  periodFlags: number;
  // --- pins
  latch: number;
  driven: number;
  lvl: number;
  // --- input capture
  icFull: number;
  hFull: number;
  polArm: number;
  dlyAt: number[];
  dlyBefore: number[];
  // --- modulus down counter
  mcCount: number;
  mcLoad: number;
  mcAnchor: number;
  mcN: number;
  zeroLatchAt: number;
}

export class EctModule implements Peripheral {
  readonly name = 'ECT';
  private ctx: PeripheralContext | null = null;
  private readonly nets: BoardNets;
  private readonly modeOpt: EctMode | (() => EctMode);
  private readonly sameTickHit: boolean;
  private readonly delayFn: (dlyct: number, prnt: boolean) => number;
  private readonly unsubs: Array<() => void>;
  /** Set when an edge processed during an advance scheduled a discrete event (the advance must stop there). */
  private edgeDirty = false;
  private readonly icWriteStore: boolean;
  private readonly onPinsChanged?: () => void;
  private s: EctState;
  /** Interrupt lines currently asserted (bit n = channel n; 8 ovf, 9 paaovf, 10 paie, 11 mdcu, 12 pabovf). */
  private irq = 0;
  /** Re-entrancy guard: true while the module itself is processing (own pin drives come back via the listener). */
  private busy = false;
  /** Time of the event being processed while `busy`. */
  private procT = 0;
  private depth = 0;

  constructor(nets: BoardNets, opts: EctOptions = {}) {
    this.nets = nets;
    this.modeOpt = opts.mode ?? 'special';
    this.sameTickHit = opts.compareWriteSameTick === 'hit';
    this.delayFn = opts.delayCycles ?? defaultDelayCycles;
    this.icWriteStore = opts.icWrite === 'store';
    this.onPinsChanged = opts.onPinsChanged;
    this.s = EctModule.initial(0);
    this.unsubs = ECT_PINS.map((pin, n) => nets.pins.on(pin, (_p, st) => this.onPin(n, st.level)));
  }

  /** Remove the PinNet listeners (call when the system is torn down while the nets live on). */
  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    this.ctx = null;
  }

  private get special(): boolean {
    const m = typeof this.modeOpt === 'function' ? this.modeOpt() : this.modeOpt;
    return m === 'special';
  }

  private static initial(t: number): EctState {
    return {
      t,
      tios: 0,
      oc7m: 0,
      oc7d: 0,
      tscr1: 0,
      ttov: 0,
      tctl12: 0,
      tctl34: 0,
      tie: 0,
      tscr2: 0,
      tflg1: 0,
      tflg2: 0,
      tc: new Array<number>(8).fill(0),
      tch: new Array<number>(4).fill(0),
      pactl: 0,
      paflg: 0,
      pacn: new Array<number>(4).fill(0),
      pah: new Array<number>(4).fill(0),
      mcctl: 0,
      mczf: false,
      polf: 0,
      icpar: 0,
      dlyct: 0,
      icovw: 0,
      icsys: 0,
      ptpsr: 0,
      ptmcpsr: 0,
      pbctl: 0,
      pbflg: 0,
      prntLocked: false,
      icsysLocked: false,
      tcnt: 0,
      lastTickAt: -1,
      matchedAtLastTick: 0,
      flagsSetAtLastTick: 0,
      tickLatch: 0,
      tickTov: 0,
      setCyc: -1,
      setMask: 0,
      gT: t,
      prescAnchor: t,
      prescN: 1,
      pscAnchor: t,
      pendAt: -1,
      pendN: 1,
      gAnchor: t,
      gN: 64,
      periodFlags: -1,
      latch: 0,
      driven: 0,
      lvl: 0,
      icFull: 0,
      hFull: 0,
      polArm: 0x0f,
      dlyAt: [-1, -1, -1, -1],
      dlyBefore: [0, 0, 0, 0],
      mcCount: 0xffff,
      mcLoad: 0xffff,
      mcAnchor: t,
      mcN: 1,
      zeroLatchAt: -1,
    };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  reset(_cause?: ResetCause): void {
    const t = this.ctx ? this.ctx.now : 0;
    this.s = EctModule.initial(t);
    this.s.lvl = this.nets.pins.readByte('PT');
    this.applyPins(t, true);
    this.updateIrq(true);
  }

  // ================================================================== public helpers

  /** Current TCNT (after bringing the module up to date). */
  get tcnt(): number {
    this.ctx?.sync();
    return this.s.tcnt;
  }

  /** Main-timer tick frequency (Hz) with the prescaler clock (0 when stopped or clocked by PACLK). */
  get timerClockHz(): number {
    if (!(this.s.tscr1 & B.TEN) || this.mainClock() !== 'presc') return 0;
    return (this.ctx ? this.ctx.busHz : 0) / this.s.prescN;
  }

  /** Bus cycles per timer tick (prescaler clock). */
  get prescaler(): number {
    return this.s.prescN;
  }

  /** Pins currently driven by the ECT output-compare logic. */
  claimedPins(): string[] {
    return ECT_PINS.filter((_, n) => this.s.driven & (1 << n));
  }

  isPinClaimed(pin: string): boolean {
    const n = ECT_PINS.indexOf(pin);
    return n >= 0 && (this.s.driven & (1 << n)) !== 0;
  }

  /** Bus cycle of the most recent processed timer tick (-1 = none). For tests/diagnostics. */
  get lastTickCycle(): number {
    return this.s.lastTickAt;
  }

  // ================================================================== derived

  private get ten(): boolean {
    return (this.s.tscr1 & B.TEN) !== 0;
  }

  /** Prescaler division selected by the registers. */
  private regsPrescN(): number {
    return this.s.tscr1 & B.PRNT ? this.s.ptpsr + 1 : 1 << (this.s.tscr2 & 7);
  }

  private regsMcN(): number {
    return this.s.tscr1 & B.PRNT ? this.s.ptmcpsr + 1 : MCPR_DIV[this.s.mcctl & 3];
  }

  private get tcreActive(): boolean {
    return (this.s.tscr2 & B.TCRE) !== 0 && (this.s.tios & 0x80) !== 0;
  }

  private gateActive(): boolean {
    const hi = (this.s.lvl >> 7) & 1;
    // PEDGE=0: PT7 high enables the /64 clock; PEDGE=1: PT7 low enables it.
    return this.s.pactl & B.PEDGE ? hi === 0 : hi === 1;
  }

  /** Main counter clock: prescaler, gated PACLK (periodic), event PACLK (edges) or none. */
  private mainClock(): 'presc' | 'gated' | 'edges' | 'none' {
    const s = this.s;
    if (!(s.tscr1 & B.TEN)) return 'none';
    if (s.pactl & B.PAEN && s.pactl & B.CLK) {
      if (s.pactl & B.PAMOD) return this.gateActive() ? 'gated' : 'none';
      return 'edges';
    }
    return 'presc';
  }

  /** Periodic main clock (anchor, period) or null. */
  private mainSrc(): [number, number] | null {
    const k = this.mainClock();
    if (k === 'presc') return [this.s.prescAnchor, this.s.prescN];
    if (k === 'gated') return [this.s.gAnchor, this.s.gN];
    return null;
  }

  private static nextTick(anchor: number, n: number, after: number): number {
    return anchor + (Math.floor((after - anchor) / n) + 1) * n;
  }

  /** PACA (16-bit) value. */
  private get paca(): number {
    return (this.s.pacn[3] << 8) | this.s.pacn[2];
  }

  private set paca(v: number) {
    this.s.pacn[3] = (v >> 8) & 0xff;
    this.s.pacn[2] = v & 0xff;
  }

  /** 8-bit PAC n is counting (PAnEN, and not part of an enabled 16-bit accumulator). */
  private pac8On(n: number): boolean {
    const s = this.s;
    if (!(s.icpar & (1 << n))) return false;
    if (n >= 2) return !(s.pactl & B.PAEN);
    return !(s.pbctl & B.PBEN);
  }

  // ================================================================== time

  tick(_n: number): void {
    // A sync requested while this module is itself processing (e.g. a board model reacting to an OC pin calls
    // PinNet.externalChange) must not re-enter; the module is already at the right time.
    if (this.busy) return;
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  /** Process everything up to and including bus cycle `to`. */
  private advance(to: number): void {
    const s = this.s;
    if (to <= s.t) return;
    const wasBusy = this.busy;
    this.busy = true;
    try {
      for (;;) {
        const e = this.nextDiscrete();
        const target = e < to ? e : to;
        const mcZero = e <= to && this.mcZeroAt() === e;
        // advanceContinuous stops early after a tick whose (self-caused) pin edge scheduled a new discrete event:
        // re-evaluate the next discrete event from there.
        if (this.advanceContinuous(target) < target) continue;
        if (e > to) break;
        this.discreteAt(e, mcZero);
      }
    } finally {
      this.busy = wasBusy;
    }
    this.updateIrq();
  }

  /** Earliest discrete event (prescaler switch, delay-counter expiry, modulus-counter zero) after `t`. */
  private nextDiscrete(): number {
    const s = this.s;
    let e = Infinity;
    if (s.pendAt >= 0) e = s.pendAt;
    for (let n = 0; n < 4; n++) if (s.dlyAt[n] >= 0 && s.dlyAt[n] < e) e = s.dlyAt[n];
    const z = this.mcZeroAt();
    if (z < e) e = z;
    return e;
  }

  private discreteAt(e: number, mcZero: boolean): void {
    const s = this.s;
    this.procT = e;
    if (s.pendAt === e) {
      s.prescN = s.pendN;
      s.prescAnchor = e;
      s.pendAt = -1;
    }
    if (mcZero) this.mcZero(e);
    for (let n = 0; n < 4; n++) {
      if (s.dlyAt[n] === e) {
        s.dlyAt[n] = -1;
        const now = (s.lvl >> n) & 1;
        // The delayed edge is valid only if the level after the delay is the opposite of the level before it.
        if (now !== s.dlyBefore[n]) this.validEdge(n, now === 1);
      }
    }
  }

  /**
   * Advance the main counter, gated PACA and the modulus counter to `x` (no discrete event inside (t, x)). Returns the
   * time reached: `x`, or the earlier tick at which an edge scheduled a new discrete event.
   */
  private advanceContinuous(x: number): number {
    const s = this.s;
    if (x <= s.t) return s.t;
    this.edgeDirty = false;
    const stop = this.advanceMain(x);
    this.advanceGated(stop);
    this.advanceMc(stop);
    s.t = stop;
    return stop;
  }

  /** Set-wins rule: record flags set by an event at cycle `c` (events arrive in time order; older ones are moot). */
  private markSet(bits: number, c: number): void {
    const s = this.s;
    if (!bits || c < s.setCyc) return;
    if (c > s.setCyc) {
      s.setCyc = c;
      s.setMask = 0;
    }
    s.setMask |= bits;
  }

  /** Flags (setMask encoding) that a clear in the current access cycle must not clear. */
  private get prot(): number {
    return this.s.setCyc === this.procT ? this.s.setMask : 0;
  }

  /** PAFLG bits protected from a clear in this cycle. */
  private get paProt(): number {
    const p = this.prot;
    return (p & F_PAOVF ? B.PAOVF : 0) | (p & F_PAIF ? B.PAIF : 0);
  }

  // ------------------------------------------------------------------ main counter

  /**
   * TCRE (with IOS7=1) is modelled as a synchronous reset: a tick that finds TCNT == TC7 loads 0 instead of
   * TCNT+1. So the counter runs 0..TC7 (period TC7+1), TC7=$0000 holds TCNT at 0 and TC7=$FFFF never sets TOF,
   * as the guide states. UNCERTAIN: a TC7 written equal to the current TCNT resets at the next tick.
   */
  private get resetNext(): boolean {
    return this.tcreActive && this.s.tcnt === this.s.tc[7];
  }

  /** Ticks (>= 1) until TCNT next becomes `target` (Infinity = never), honouring TCRE. */
  private ticksUntil(target: number): number {
    const s = this.s;
    const v = s.tcnt;
    if (!this.tcreActive) return ((target - v - 1) & 0xffff) + 1;
    const top = s.tc[7];
    if (v === top) return target === 0 ? 1 : target <= top ? target + 1 : Infinity;
    if (v < top) {
      if (target > v && target <= top) return target - v;
      if (target <= top) return top - v + 1 + target;
      return Infinity;
    }
    if (target > v) return target - v;
    if (target <= top) return 0x10000 - v + target;
    return Infinity;
  }

  /** Ticks until the next real overflow ($FFFF -> $0000 by counting, not by a TCRE reset). */
  private ticksUntilOverflow(): number {
    const s = this.s;
    if (this.tcreActive && s.tcnt <= s.tc[7]) return Infinity;
    return 0x10000 - s.tcnt;
  }

  private ticksToInteresting(): number {
    const s = this.s;
    if (this.resetNext) return 1;
    let k = this.ticksUntilOverflow();
    for (let n = 0; n < 8; n++) {
      if (s.tios & (1 << n)) {
        const kn = this.ticksUntil(s.tc[n]);
        if (kn < k) k = kn;
      }
    }
    return k;
  }

  /** Advance the main counter to `x`; returns `x`, or the tick time where an edge scheduled a discrete event. */
  private advanceMain(x: number): number {
    const s = this.s;
    let cur = s.t;
    for (;;) {
      const src = this.mainSrc();
      if (!src) return x;
      const [anchor, n] = src;
      const next = EctModule.nextTick(anchor, n, cur);
      if (next > x) return x;
      const avail = Math.floor((x - next) / n) + 1;
      const k = this.ticksToInteresting();
      if (k > avail) {
        s.tcnt = (s.tcnt + avail) & 0xffff;
        s.lastTickAt = next + (avail - 1) * n;
        s.matchedAtLastTick = s.flagsSetAtLastTick = s.tickTov = 0;
        s.tickLatch = s.latch;
        return x;
      }
      s.tcnt = (s.tcnt + k - 1) & 0xffff;
      const at = next + (k - 1) * n;
      this.stepTick(at);
      if (this.edgeDirty) return at;
      cur = at;
      // TCRE short-period skip: at the start of a period (TCNT reset to 0) with no pin driven by the timer and no
      // flag change over the previous full period, further whole periods change nothing but time.
      if (this.tcreActive && s.tcnt === 0 && s.driven === 0) {
        const flags = (s.tflg1 << 8) | s.tflg2;
        if (s.periodFlags === flags) {
          const p = s.tc[7] + 1;
          const rem = Math.floor((x - at) / n);
          const m = Math.floor(rem / p);
          if (m > 0) {
            cur = at + m * p * n;
            s.lastTickAt = cur;
          }
        }
        s.periodFlags = flags;
      }
    }
  }

  /** One timer tick at bus cycle `c`: count, compare (equality), overflow, pin actions. */
  private stepTick(c: number): void {
    const s = this.s;
    this.procT = c;
    const old = s.tcnt;
    let ovf = false;
    let nv: number;
    if (this.resetNext) nv = 0;
    else {
      nv = (old + 1) & 0xffff;
      ovf = old === 0xffff;
    }
    s.tcnt = nv;
    s.lastTickAt = c;
    let matched = 0;
    for (let n = 0; n < 8; n++) if (s.tios & (1 << n) && s.tc[n] === nv) matched |= 1 << n;
    s.flagsSetAtLastTick = matched & ~s.tflg1;
    s.matchedAtLastTick = matched;
    s.tflg1 |= matched;
    if (ovf) s.tflg2 |= B.TOF;
    this.markSet(matched | (ovf ? F_TOF : 0), c);
    s.tickLatch = s.latch;
    s.tickTov = ovf ? s.ttov & s.tios : 0;
    if (matched || s.tickTov) this.outputActions(matched, s.tickTov, c);
  }

  /**
   * Output actions of a compare event: `matched` channels (OMn:OLn action unless OC7Mn masks it), `tov` toggles on
   * overflow (precedence over the channel's own compare action, UNCERTAIN), then the channel-7 OC7M/OC7D override.
   */
  private outputActions(matched: number, tov: number, c: number, noAct = 0): void {
    const s = this.s;
    let L = s.latch;
    for (let n = 0; n < 8; n++) {
      const bit = 1 << n;
      if (!(matched & bit) || s.oc7m & bit || (tov | noAct) & bit) continue;
      const act = (s.tctl12 >> (2 * n)) & 3;
      if (act === 1) L ^= bit;
      else if (act === 2) L &= ~bit;
      else if (act === 3) L |= bit;
    }
    // TOVn: toggles the OC pin on overflow (output compare mode only). UNCERTAIN: also when OC7Mn is set.
    L ^= tov & ~s.oc7m;
    if (matched & 0x80) L = (L & ~s.oc7m) | (s.oc7d & s.oc7m);
    if (L !== s.latch) {
      s.latch = L & 0xff;
      this.applyPins(c);
    }
  }

  // ------------------------------------------------------------------ gated pulse accumulator A

  private gatedCounting(): boolean {
    const s = this.s;
    return (s.tscr1 & B.TEN) !== 0 && (s.pactl & B.PAEN) !== 0 && (s.pactl & B.PAMOD) !== 0 && this.gateActive();
  }

  /** Number of /64 prescaler edges in (a, b]. */
  private div64Edges(a: number, b: number): number {
    const p = this.s.pscAnchor;
    return Math.floor((b - p) / 64) - Math.floor((a - p) / 64);
  }

  /** Advance the gated pulse accumulator A from its own cursor `gT` to `x` (the gate level is constant in between). */
  private advanceGated(x: number): void {
    const s = this.s;
    const from = s.gT;
    if (x <= from) return;
    s.gT = x;
    if (!this.gatedCounting()) return;
    const m = this.div64Edges(from, x);
    if (m <= 0) return;
    const v = this.paca + m;
    if (v > 0xffff) {
      s.paflg |= B.PAOVF;
      this.markSet(F_PAOVF, EctModule.nextTick(s.pscAnchor, 64, from) + (0x10000 - this.paca - 1) * 64);
    }
    this.paca = v & 0xffff;
  }

  /** Recompute the gated-PACLK main clock phase at time `at` (after any change of PACA, gate, CLK, TEN). */
  private recalcGated(at: number): void {
    const s = this.s;
    const clk = (s.pactl & B.CLK) >> 2;
    const div = clk === 1 ? 1 : clk === 2 ? 256 : 65536;
    const first64 = EctModule.nextTick(s.pscAnchor, 64, at);
    const m = div - (div === 1 ? 0 : this.paca % div);
    s.gN = 64 * div;
    s.gAnchor = first64 + (m - 1) * 64 - s.gN;
  }

  // ------------------------------------------------------------------ modulus down counter

  private get mcEnabled(): boolean {
    return (this.s.mcctl & B.MCEN) !== 0;
  }

  /** Bus cycle at which the modulus counter reaches zero (Infinity if not counting). */
  private mcZeroAt(): number {
    const s = this.s;
    if (!this.mcEnabled || s.mcCount === 0) return Infinity;
    return EctModule.nextTick(s.mcAnchor, s.mcN, s.t) + (s.mcCount - 1) * s.mcN;
  }

  private advanceMc(x: number): void {
    const s = this.s;
    if (!this.mcEnabled || s.mcCount === 0) return;
    const m = Math.floor((x - s.mcAnchor) / s.mcN) - Math.floor((s.t - s.mcAnchor) / s.mcN);
    if (m > 0) s.mcCount = Math.max(0, s.mcCount - m);
  }

  /**
   * The modulus counter reaches zero at `e`: MCZF, latch (LATQ=BUFEN=1), reload in modulus mode.
   * UNCERTAIN: in modulus mode the reload happens in the same prescaled tick as the zero (period = load value
   * ticks, the commonly documented "MCCNT x prescale" period); the count never reads $0000 in that mode.
   */
  private mcZero(e: number): void {
    const s = this.s;
    s.mcCount = 0;
    s.mczf = true;
    this.markSet(F_MCZF, e);
    if ((s.icsys & (B.BUFEN | B.LATQ)) === (B.BUFEN | B.LATQ)) this.latchHolding();
    if (s.mcctl & B.MODMC && s.mcLoad !== 0) {
      s.mcCount = s.mcLoad;
      s.mcN = this.regsMcN();
      s.mcAnchor = e;
    }
  }

  // ------------------------------------------------------------------ input capture / pulse accumulators

  private onPin(n: number, level: Level): void {
    const s = this.s;
    if (((s.lvl >> n) & 1) === level) return;
    if (this.busy) {
      // A change caused while this module is processing (its own OC output, or a board model reacting to it).
      if (this.depth > 4) return;
      this.depth++;
      try {
        // Gated PACA counts up to the edge with the old gate level.
        this.advanceGated(this.procT);
        this.edgeAt(n, level, this.procT);
      } finally {
        this.depth--;
      }
      return;
    }
    this.ctx?.sync();
    s.periodFlags = -1;
    this.busy = true;
    try {
      this.procT = s.t;
      this.edgeAt(n, level, s.t);
    } finally {
      this.busy = false;
    }
    this.updateIrq();
    this.ctx?.reschedule();
  }

  /** Raw level change on PTn at cycle `e` (module already advanced to `e`). */
  private edgeAt(n: number, level: Level, e: number): void {
    const s = this.s;
    const old = (s.lvl >> n) & 1;
    if (old === level) return;
    s.lvl = (s.lvl & ~(1 << n)) | (level << n);
    if (n === 7 && s.pactl & B.PAEN) this.paEdge(level === 1, e, old);
    if (n < 4) {
      const d = this.delayFn(s.dlyct, (s.tscr1 & B.PRNT) !== 0);
      if (d > 0) {
        if (s.dlyAt[n] < 0) {
          s.dlyAt[n] = e + d;
          s.dlyBefore[n] = old;
          // A discrete event created while advancing: the advance must stop at this tick and pick it up in order.
          this.edgeDirty = true;
        }
        return;
      }
    }
    this.validEdge(n, level === 1);
  }

  /** Pulse accumulator A input (PT7) edge. */
  private paEdge(rising: boolean, e: number, oldLevel: number): void {
    const s = this.s;
    if (!(s.pactl & B.PAMOD)) {
      const active = s.pactl & B.PEDGE ? rising : !rising;
      if (!active) return;
      s.paflg |= B.PAIF;
      const v = (this.paca + 1) & 0xffff;
      if (v === 0) s.paflg |= B.PAOVF;
      this.markSet(F_PAIF | (v === 0 ? F_PAOVF : 0), e);
      this.paca = v;
      // Event-mode PACLK as the main timer clock.
      if (this.mainClock() === 'edges' && this.depth <= 1) {
        const clk = (s.pactl & B.CLK) >> 2;
        if (clk === 1 || (clk === 2 && (v & 0xff) === 0) || (clk === 3 && v === 0)) this.stepTick(e);
      }
      return;
    }
    // Gated time accumulation: the trailing edge of the gate sets PAIF.
    const wasActive = s.pactl & B.PEDGE ? oldLevel === 0 : oldLevel === 1;
    if (wasActive && !this.gateActive()) {
      s.paflg |= B.PAIF;
      this.markSet(F_PAIF, e);
    }
    this.recalcGated(e);
  }

  /** A validated (post-delay) edge on channel input n. */
  private validEdge(n: number, rising: boolean): void {
    const s = this.s;
    const edg = (s.tctl34 >> (2 * n)) & 3;
    const active = edg === 3 || (edg === 1 && rising) || (edg === 2 && !rising);
    if (!active) return;
    if (n < 4) this.pacEdge(n);
    // SHxy: input x (0..3) also acts on channel y = x+4; pin y no longer feeds channel y.
    // UNCERTAIN: channel y uses channel x's edge configuration and delay counter.
    const sharedIn = n >= 4 && (s.icsys & (B.SH04 << (n - 4))) !== 0;
    if (!sharedIn && !(s.tios & (1 << n))) this.capture(n, rising);
    if (n < 4 && s.icsys & (B.SH04 << n) && !(s.tios & (1 << (n + 4)))) this.capture(n + 4, rising);
  }

  private pacEdge(n: number): void {
    const s = this.s;
    if (n === 0 && s.pbctl & B.PBEN) {
      const v = (((s.pacn[1] << 8) | s.pacn[0]) + 1) & 0xffff;
      if (v === 0) {
        s.pbflg |= B.PBOVF;
        this.markSet(F_PBOVF, this.procT);
      }
      s.pacn[1] = v >> 8;
      s.pacn[0] = v & 0xff;
      return;
    }
    if (!this.pac8On(n)) return;
    const ovfFlag = n === 3 ? 'pa' : n === 1 ? 'pb' : null;
    if (s.pacn[n] === 0xff) {
      if (!(s.icsys & B.PACMX)) s.pacn[n] = 0;
      if (ovfFlag === 'pa') {
        s.paflg |= B.PAOVF;
        this.markSet(F_PAOVF, this.procT);
      } else if (ovfFlag === 'pb') {
        s.pbflg |= B.PBOVF;
        this.markSet(F_PBOVF, this.procT);
      }
    } else s.pacn[n]++;
  }

  /** Input capture on channel n (buffered/queue/latch and NOVW rules of ECT guide 4.2.1). */
  private capture(n: number, rising: boolean): void {
    const s = this.s;
    const bit = 1 << n;
    const novw = (s.icovw & bit) !== 0;
    const buffered = n < 4 && (s.icsys & B.BUFEN) !== 0;
    let flag = true;
    if (buffered && !(s.icsys & B.LATQ)) {
      // Queue mode.
      if (novw) {
        if (!(s.icFull & bit)) {
          s.tc[n] = s.tcnt;
          s.icFull |= bit;
          if (s.icsys & B.TFMOD) flag = false;
        } else if (!(s.hFull & bit)) {
          s.tch[n] = s.tc[n];
          s.hFull |= bit;
          s.tc[n] = s.tcnt;
        } else return;
      } else {
        s.tch[n] = s.tc[n];
        s.hFull |= bit;
        s.tc[n] = s.tcnt;
        s.icFull |= bit;
      }
    } else {
      if (novw && s.icFull & bit) return;
      s.tc[n] = s.tcnt;
      s.icFull |= bit;
    }
    if (flag) {
      s.tflg1 |= bit;
      this.markSet(bit, this.procT);
    }
    // POLFn: polarity of the first capture after TCn was read. UNCERTAIN: "after the capture latch has been read".
    if (n < 4 && s.polArm & bit) {
      s.polf = (s.polf & ~bit) | (rising ? bit : 0);
      s.polArm &= ~bit;
    }
  }

  /** Latch-mode transfer TC0..3 -> TC0H..3H and PAC0..3 -> PA0H..3H (8-bit PACs cleared). */
  private latchHolding(): void {
    const s = this.s;
    for (let n = 0; n < 4; n++) {
      const bit = 1 << n;
      if (!(s.icovw & bit && s.hFull & bit)) {
        s.tch[n] = s.tc[n];
        s.hFull |= bit;
        s.icFull &= ~bit;
      }
      s.pah[n] = s.pacn[n];
      // UNCERTAIN: only accumulators running as 8-bit PACs are cleared; 16-bit PACA/PACB keep counting.
      if (this.pac8On(n)) s.pacn[n] = 0;
    }
  }

  // ================================================================== pins

  private computeDriven(): number {
    const s = this.s;
    let d = 0;
    for (let n = 0; n < 8; n++) {
      const bit = 1 << n;
      if (!(s.tios & bit)) continue;
      const oc = (s.tscr1 & B.TEN) !== 0 && ((s.tctl12 >> (2 * n)) & 3) !== 0;
      const m7 = (s.tios & 0x80) !== 0 && (s.oc7m & bit) !== 0;
      if (oc || m7) d |= bit;
    }
    return d;
  }

  /** Re-evaluate which pins the OC logic drives and drive them (at cycle `c`, for PinNet listeners). */
  private applyPins(c: number, force = false, keepLatch = false): void {
    const s = this.s;
    const d = this.computeDriven();
    const newly = d & ~s.driven;
    // A pin taken over by the OC logic starts low (ECT guide 4.2.4). UNCERTAIN for OC7M-driven pins.
    if (!keepLatch) s.latch &= ~newly;
    const changed = d !== s.driven;
    s.driven = d;
    const pins = this.nets.pins;
    const saved = pins.now;
    pins.now = () => c;
    try {
      for (let n = 0; n < 8; n++) {
        const bit = 1 << n;
        const lv: Level | null = d & bit ? ((s.latch & bit ? 1 : 0) as Level) : null;
        if (force || changed || d & bit) pins.setMcuOutput(ECT_PINS[n], lv, 'periph');
      }
    } finally {
      pins.now = saved;
    }
    if (changed) this.onPinsChanged?.();
  }

  // ================================================================== interrupts

  private updateIrq(force = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.s;
    let w = s.tflg1 & s.tie;
    if (s.tflg2 & B.TOF && s.tscr2 & B.TOI) w |= 1 << 8;
    if (s.paflg & B.PAOVF && s.pactl & B.PAOVI) w |= 1 << 9;
    if (s.paflg & B.PAIF && s.pactl & B.PAI) w |= 1 << 10;
    if (s.mczf && s.mcctl & B.MCZI) w |= 1 << 11;
    if (s.pbflg & B.PBOVF && s.pbctl & B.PBOVI) w |= 1 << 12;
    const diff = force ? 0x1fff : w ^ this.irq;
    if (!diff) return;
    this.irq = w;
    const V = ECT_VECTORS;
    const vec = [...V.ch, V.ovf, V.paaovf, V.paie, V.mdcu, V.pabovf];
    for (let i = 0; i < 13; i++) if (diff & (1 << i)) ctx.setInterrupt(vec[i], (w & (1 << i)) !== 0);
  }

  nextEventCycles(): number {
    const s = this.s;
    let best = Infinity;
    const src = this.mainSrc();
    if (src) {
      const [anchor, n] = src;
      const next = EctModule.nextTick(anchor, n, s.t);
      let k = Infinity;
      for (let c = 0; c < 8; c++) {
        const bit = 1 << c;
        if (!(s.tios & bit)) continue;
        const irq = (s.tie & bit) !== 0 && !(s.tflg1 & bit);
        const pin = (s.driven & bit) !== 0 && !(s.oc7m & bit) && ((s.tctl12 >> (2 * c)) & 3) !== 0;
        const ov7 = c === 7 && (s.driven & s.oc7m) !== 0;
        if (irq || pin || ov7) k = Math.min(k, this.ticksUntil(s.tc[c]));
      }
      const ovfIrq = (s.tscr2 & B.TOI) !== 0 && !(s.tflg2 & B.TOF);
      if (ovfIrq || (s.ttov & s.tios & s.driven) !== 0) k = Math.min(k, this.ticksUntilOverflow());
      if (k < Infinity) best = next + (k - 1) * n;
    }
    if (s.pendAt >= 0 && s.pendAt < best) best = s.pendAt;
    for (let c = 0; c < 4; c++) if (s.dlyAt[c] >= 0 && s.dlyAt[c] < best) best = s.dlyAt[c];
    if (s.mcctl & B.MCZI && !s.mczf) best = Math.min(best, this.mcZeroAt());
    if (s.pactl & B.PAOVI && !(s.paflg & B.PAOVF) && this.gatedCounting()) {
      const need = 0x10000 - this.paca;
      best = Math.min(best, EctModule.nextTick(s.pscAnchor, 64, s.t) + (need - 1) * 64);
    }
    return best === Infinity ? Infinity : Math.max(1, best - s.t);
  }

  // ================================================================== registers

  private sync(): number {
    const now = this.ctx ? this.ctx.now : this.s.t;
    this.advance(now);
    // Any register access may change what a TCRE period does: restart the period-skip check.
    this.s.periodFlags = -1;
    return Math.max(now, this.s.t);
  }

  read(a: number): number {
    const t = this.sync();
    this.busy = true;
    this.procT = t;
    try {
      const v = this.readReg(a, true);
      return v;
    } finally {
      this.busy = false;
      this.updateIrq();
    }
  }

  peek(a: number): number {
    return this.readReg(a, false);
  }

  private readReg(a: number, live: boolean): number {
    const s = this.s;
    const tffca = live && (s.tscr1 & B.TFFCA) !== 0;
    if (a >= A.TC0 && a <= A.TC7 + 1) {
      const n = (a - A.TC0) >> 1;
      const bit = 1 << n;
      if (live && !(s.tios & bit)) {
        if (tffca) s.tflg1 &= ~(bit & ~this.prot);
        s.icFull &= ~bit;
        s.polArm |= bit & 0x0f;
      }
      return a & 1 ? s.tc[n] & 0xff : s.tc[n] >> 8;
    }
    if (a >= A.TC0H && a <= A.TC3H + 1) {
      const n = (a - A.TC0H) >> 1;
      if (live) {
        s.hFull &= ~(1 << n);
        // Queue mode: reading the holding register latches the pulse accumulator into PAnH and clears it.
        if ((s.icsys & (B.BUFEN | B.LATQ)) === B.BUFEN) {
          s.pah[n] = s.pacn[n];
          if (this.pac8On(n)) s.pacn[n] = 0;
        }
      }
      return a & 1 ? s.tch[n] & 0xff : s.tch[n] >> 8;
    }
    if (a >= A.PACN3 && a <= A.PACN0) {
      const n = A.PACN0 - a;
      if (tffca) this.fastClearPac(n);
      return s.pacn[n];
    }
    if (a >= A.PA3H && a <= A.PA0H) return s.pah[A.PA0H - a];
    switch (a) {
      case A.TIOS:
        return s.tios;
      case A.CFORC:
        return 0;
      case A.OC7M:
        return s.oc7m;
      case A.OC7D:
        return s.oc7d;
      case A.TCNT:
      case A.TCNT + 1:
        if (tffca && !(this.prot & F_TOF)) s.tflg2 &= ~B.TOF;
        return a === A.TCNT ? s.tcnt >> 8 : s.tcnt & 0xff;
      case A.TSCR1:
        return s.tscr1 & 0xf8;
      case A.TTOV:
        return s.ttov;
      case A.TCTL1:
        return s.tctl12 >> 8;
      case A.TCTL2:
        return s.tctl12 & 0xff;
      case A.TCTL3:
        return s.tctl34 >> 8;
      case A.TCTL4:
        return s.tctl34 & 0xff;
      case A.TIE:
        return s.tie;
      case A.TSCR2:
        return s.tscr2 & 0x8f;
      case A.TFLG1:
        return s.tflg1;
      case A.TFLG2:
        return s.tflg2 & B.TOF;
      case A.PACTL:
        return s.pactl & 0x7f;
      case A.PAFLG:
        return s.paflg & 0x03;
      case A.MCCTL:
        return s.mcctl & (B.MCZI | B.MODMC | B.RDMCL | B.MCEN | B.MCPR);
      case A.MCFLG:
        return (s.mczf ? B.MCZF : 0) | (s.polf & 0x0f);
      case A.ICPAR:
        return s.icpar & 0x0f;
      case A.DLYCT:
        return s.dlyct;
      case A.ICOVW:
        return s.icovw;
      case A.ICSYS:
        return s.icsys;
      case A.PTPSR:
        return s.ptpsr;
      case A.PTMCPSR:
        return s.ptmcpsr;
      case A.PBCTL:
        return s.pbctl & (B.PBEN | B.PBOVI);
      case A.PBFLG:
        return s.pbflg & B.PBOVF;
      case A.MCCNT:
      case A.MCCNT + 1: {
        if (tffca && !(this.prot & F_MCZF)) s.mczf = false;
        const v = s.mcctl & B.RDMCL ? s.mcLoad : s.mcCount;
        return a === A.MCCNT ? v >> 8 : v & 0xff;
      }
      default:
        return 0; // TIMTST and reserved
    }
  }

  write(a: number, v: number): void {
    const t = this.sync();
    v &= 0xff;
    this.busy = true;
    this.procT = t;
    try {
      this.writeReg(a, v, t);
    } finally {
      this.busy = false;
    }
    this.updateIrq();
  }

  private writeReg(a: number, v: number, t: number): void {
    const s = this.s;
    const tffca = (s.tscr1 & B.TFFCA) !== 0;
    if (a >= A.TC0 && a <= A.TC7 + 1) {
      const n = (a - A.TC0) >> 1;
      const bit = 1 << n;
      if (!(s.tios & bit)) {
        // UNCERTAIN: "writes have no meaning or effect during input capture".
        if (this.icWriteStore) s.tc[n] = a & 1 ? (s.tc[n] & 0xff00) | v : (v << 8) | (s.tc[n] & 0xff);
        return;
      }
      s.tc[n] = a & 1 ? (s.tc[n] & 0xff00) | v : (v << 8) | (s.tc[n] & 0xff);
      if (tffca) s.tflg1 &= ~(bit & ~this.prot);
      // C11 tie-break: the tick of this cycle already ran; with 'hit' a matching low-byte write still counts.
      if (this.sameTickHit && a & 1 && s.lastTickAt === t && s.tc[n] === s.tcnt && !(s.matchedAtLastTick & bit)) {
        s.matchedAtLastTick |= bit;
        s.tflg1 |= bit;
        this.markSet(bit, t);
        this.outputActions(bit, 0, t);
      }
      return;
    }
    if (a >= A.PACN3 && a <= A.PACN0) {
      const n = A.PACN0 - a;
      if (tffca) this.fastClearPac(n);
      s.pacn[n] = v;
      if (n >= 2) this.recalcGated(t);
      return;
    }
    if ((a >= A.PA3H && a <= A.PA0H) || (a >= A.TC0H && a <= A.TC3H + 1)) return; // read-only
    switch (a) {
      case A.TIOS:
        s.tios = v;
        this.applyPins(t);
        return;
      case A.CFORC:
        this.forceCompare(v & s.tios, t);
        return;
      case A.OC7M:
        s.oc7m = v;
        this.applyPins(t);
        return;
      case A.OC7D:
        s.oc7d = v;
        return;
      case A.TCNT:
      case A.TCNT + 1:
        if (tffca && !(this.prot & F_TOF)) s.tflg2 &= ~B.TOF;
        // Writable only in special modes; the prescaler phase is kept (first count may be short, per the guide).
        if (this.special) {
          s.tcnt = a === A.TCNT ? (v << 8) | (s.tcnt & 0xff) : (s.tcnt & 0xff00) | v;
        }
        return;
      case A.TSCR1:
        this.writeTscr1(v, t);
        return;
      case A.TTOV:
        s.ttov = v;
        return;
      case A.TCTL1:
        s.tctl12 = (v << 8) | (s.tctl12 & 0xff);
        this.applyPins(t);
        return;
      case A.TCTL2:
        s.tctl12 = (s.tctl12 & 0xff00) | v;
        this.applyPins(t);
        return;
      case A.TCTL3:
        s.tctl34 = (v << 8) | (s.tctl34 & 0xff);
        return;
      case A.TCTL4:
        s.tctl34 = (s.tctl34 & 0xff00) | v;
        return;
      case A.TIE:
        s.tie = v;
        return;
      case A.TSCR2: {
        const oldPr = s.tscr2 & 7;
        s.tscr2 = v & 0x8f;
        if ((v & 7) !== oldPr && this.ten && !(s.tscr1 & B.PRNT)) {
          // "The newly selected prescale factor will not take effect until the next synchronized edge where all
          // prescale counter stages equal zero": the next multiple of 128 bus cycles of the prescaler.
          s.pendAt = EctModule.nextTick(s.pscAnchor, 128, t);
          s.pendN = 1 << (v & 7);
        }
        return;
      }
      case A.TFLG1:
        s.tflg1 &= ~(v & ~this.prot);
        return;
      case A.TFLG2:
        if (!(this.prot & F_TOF)) s.tflg2 &= ~(v & B.TOF);
        return;
      case A.PACTL:
        s.pactl = v & 0x7f;
        this.recalcGated(t);
        return;
      case A.PAFLG:
        s.paflg &= ~(v & 0x03 & ~this.paProt);
        return;
      case A.MCCTL:
        this.writeMcctl(v, t);
        return;
      case A.MCFLG:
        if (v & B.MCZF && !(this.prot & F_MCZF)) s.mczf = false;
        return;
      case A.ICPAR:
        s.icpar = v & 0x0f;
        return;
      case A.DLYCT:
        // "Read or write any time" (ECT_16B8C V01.06 3.3.22; the write-once rule applies to ICSYS, not DLYCT).
        s.dlyct = v;
        return;
      case A.ICOVW:
        s.icovw = v;
        return;
      case A.ICSYS:
        if (this.special || !s.icsysLocked) s.icsys = v;
        s.icsysLocked = true;
        return;
      case A.PTPSR:
        if (v !== s.ptpsr && this.ten && s.tscr1 & B.PRNT) {
          // UNCERTAIN: the precision prescaler is a modulus counter whose stages are all zero at each output tick,
          // so a new PTPSR value takes effect after the next timer tick.
          s.pendAt = EctModule.nextTick(s.prescAnchor, s.prescN, t);
          s.pendN = v + 1;
        }
        s.ptpsr = v;
        return;
      case A.PTMCPSR:
        s.ptmcpsr = v; // takes effect at the next modulus counter load (like MCPR)
        return;
      case A.PBCTL:
        s.pbctl = v & (B.PBEN | B.PBOVI);
        return;
      case A.PBFLG:
        if (!(this.prot & F_PBOVF)) s.pbflg &= ~(v & B.PBOVF);
        return;
      case A.MCCNT:
      case A.MCCNT + 1:
        this.writeMccnt(a === A.MCCNT, v, t);
        return;
      default:
        return; // TIMTST (test register) and reserved
    }
  }

  private writeTscr1(v: number, t: number): void {
    const s = this.s;
    const old = s.tscr1;
    v &= 0xf8;
    // PRNT is write-once out of reset (normal modes). UNCERTAIN: special mode keeps it writable.
    if (!this.special && s.prntLocked) v = (v & ~B.PRNT) | (old & B.PRNT);
    s.prntLocked = true;
    s.tscr1 = v;
    const tenOn = (v & B.TEN) !== 0;
    if (tenOn && !(old & B.TEN)) {
      // UNCERTAIN: the prescaler is cleared while TEN=0, so the first tick comes N bus cycles after the enabling write.
      s.pscAnchor = t;
      s.prescAnchor = t;
      s.prescN = this.regsPrescN();
      s.pendAt = -1;
    } else if (!tenOn) {
      s.pendAt = -1;
    } else if ((old ^ v) & B.PRNT) {
      // UNCERTAIN: switching between the legacy and precision prescaler restarts the prescaler.
      s.prescAnchor = t;
      s.prescN = this.regsPrescN();
      s.pendAt = -1;
    }
    this.recalcGated(t);
    this.applyPins(t);
  }

  /** TFFCA fast clear by a PACNn access: PAFLG for PACN3/2, PBOVF for PACN1/0 (set-wins in the same cycle). */
  private fastClearPac(n: number): void {
    const s = this.s;
    if (n >= 2) s.paflg &= this.paProt;
    else if (!(this.prot & F_PBOVF)) s.pbflg &= ~B.PBOVF;
  }

  /**
   * CFORC: immediate output action on the given OC channels; no flag. In the cycle of a successful compare of the same
   * channel, "the forced output compare action will take precedence and interrupt flag won't get set": the compare's
   * own pin action of that tick is undone and only the forced action applies (one action, not two). TOVn "takes
   * precedence over forced output compare": a pin toggled on overflow in this cycle keeps the toggle. The channel-7
   * OC7M/OC7D override is idempotent. Note: the undone action was already driven at the tick, so PinNet listeners can
   * see a zero-width glitch in that cycle.
   */
  private forceCompare(m: number, t: number): void {
    const s = this.s;
    if (!m) return;
    let noAct = 0;
    let undo = 0;
    if (s.lastTickAt === t) {
      s.tflg1 &= ~(s.flagsSetAtLastTick & m);
      noAct = s.tickTov;
      undo = m & s.matchedAtLastTick & ~s.oc7m & ~s.tickTov;
      s.latch = (s.latch & ~undo) | (s.tickLatch & undo);
    }
    this.outputActions(m, 0, t, noAct);
    if (undo) this.applyPins(t);
  }

  private writeMcctl(v: number, t: number): void {
    const s = this.s;
    const old = s.mcctl;
    s.mcctl = v & (B.MCZI | B.MODMC | B.RDMCL | B.MCEN | B.MCPR);
    const en = (v & B.MCEN) !== 0;
    if (!en) {
      // "When MCEN=0, the counter is preset to $FFFF."
      s.mcCount = 0xffff;
    } else if (!(old & B.MCEN)) {
      // UNCERTAIN: enabling restarts the modulus prescaler; counting starts from the $FFFF preset.
      s.mcAnchor = t;
      s.mcN = this.regsMcN();
    }
    if (v & B.FLMC && en) this.mcLoadNow(t);
    if (v & B.ICLAT && (s.icsys & (B.BUFEN | B.LATQ)) === (B.BUFEN | B.LATQ)) this.latchHolding();
  }

  /** Load the load register into the count register and reset the modulus prescaler (applies a new MCPR). */
  private mcLoadNow(t: number): void {
    const s = this.s;
    s.mcCount = s.mcLoad;
    s.mcAnchor = t;
    s.mcN = this.regsMcN();
  }

  private writeMccnt(high: boolean, v: number, t: number): void {
    const s = this.s;
    if (s.tscr1 & B.TFFCA && !(this.prot & F_MCZF)) s.mczf = false;
    s.mcLoad = high ? (v << 8) | (s.mcLoad & 0xff) : (s.mcLoad & 0xff00) | v;
    // MODMC=0: the write clears the prescaler and loads the count register at once. MODMC=1: only the load register
    // changes until the next reload (or FLMC). UNCERTAIN: while MCEN=0 the count stays preset at $FFFF.
    if (!(s.mcctl & B.MODMC) && this.mcEnabled) this.mcLoadNow(t);
    if (!high && s.mcLoad === 0) {
      // "With a $0000 write to MCCNT the modulus counter stays at zero and does not set MCZF"; latch mode latches.
      if (this.mcEnabled) s.mcCount = 0;
      if ((s.icsys & (B.BUFEN | B.LATQ)) === (B.BUFEN | B.LATQ) && s.zeroLatchAt !== t) {
        s.zeroLatchAt = t;
        this.latchHolding();
      }
    }
  }

  // ================================================================== snapshot

  snapshot(): unknown {
    const s = this.s;
    return {
      ...s,
      tc: [...s.tc],
      tch: [...s.tch],
      pacn: [...s.pacn],
      pah: [...s.pah],
      dlyAt: [...s.dlyAt],
      dlyBefore: [...s.dlyBefore],
    };
  }

  restore(state: unknown): void {
    const st = state as EctState;
    this.s = {
      ...st,
      tc: [...st.tc],
      tch: [...st.tch],
      pacn: [...st.pacn],
      pah: [...st.pah],
      dlyAt: [...st.dlyAt],
      dlyBefore: [...st.dlyBefore],
    };
    this.applyPins(this.s.t, true, true);
    this.updateIrq(true);
  }
}

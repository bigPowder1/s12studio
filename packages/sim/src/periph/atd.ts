/**
 * ATD0 (ATD_10B8C, 8 channels, $02C0-$02DF) and ATD1 (ATD_10B16C, 16 channels, $0080-$00AF) of the MC9S12XDP512.
 *
 * Register offsets from the module base (both modules):
 *   0 CTL0 (WRAP)  1 CTL1 (ETRIGSEL, ETRIGCH)  2 CTL2 (ADPU AFFC AWAI ETRIGLE ETRIGP ETRIGE ASCIE ASCIF)
 *   3 CTL3 (S8C S4C S2C S1C FIFO FRZ1:0)  4 CTL4 (SRES8 SMP1:0 PRS4:0)  5 CTL5 (DJM DSGN SCAN MULT [CD] CC CB CA)
 *   6 STAT0 (SCF ETORF FIFOR CC)  8 TEST0  9 TEST1 (SC)  $A STAT2 (ATD1: CCF15-8)  $B STAT1 (CCF7-0)
 *   $C DIEN0 (ATD1: IEN15-8)  $D DIEN / DIEN1 (IEN7-0)  $E PTAD0 (ATD1: 15-8)  $F PTAD / PTAD1 (7-0)
 *   $10-$1F (ATD0) / $10-$2F (ATD1) DR0..DRn result registers (16-bit, high byte first).
 *
 * Timing (cycle exact, lazily evaluated): ATD clock = bus / (2 * (PRS + 1)); one conversion takes
 * 2 (first sample phase) + 2^(SMP+1) (second sample phase) + 8 or 10 (resolution) ATD clocks. Conversions of a
 * sequence run back to back from the CTL5 write (plus `startDelayCycles`); the input voltage is read from
 * `nets.analog` at the end of each conversion's sample phase. Pins: ATD0 ANn = 'PAD0n', ATD1 ANn = 'PAD(08+n)'.
 *
 * Flag clearing (ATD_10B8C block guide V02.12 §3.3.7 / §3.3.10, same rules in the S12X ATD_10B16C):
 * - SCF: write 1 to SCF; write to CTL5; AFFC=1 and any result register read.
 * - CCFn: write to CTL5; AFFC=0: read STAT1/STAT2 (with CCFn set) then read DRn; AFFC=1: read DRn.
 * - ETORF: write 1; write to CTL2/3/4; write to CTL5.  FIFOR: write 1; start of a new sequence.
 * Writes to CTL0..CTL4 abort a sequence in progress (and clear the conversion counter); CTL5 aborts and restarts.
 *
 * Digital inputs: PTADn reads the pin level when IENn=1, else 1. The PIM's port-AD data registers
 * (PT1AD0, PT0AD1/PT1AD1) should call `digitalInputEnabled(ch)` / `pinDigitalLevel(ch)` (see below).
 */
import { addr as regAddr, mask, vectorByName } from '@s12/devices';
import type { BoardNets, Level } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

export type AtdIndex = 0 | 1;

/** Register-block base address of ATD0 / ATD1 (from @s12/devices: $02C0, $0080). */
export const ATD_BASES: readonly [number, number] = [regAddr('ATD0CTL0'), regAddr('ATD1CTL0')];
/** Number of analog channels (and result registers). */
export const ATD_CHANNELS: readonly [number, number] = [8, 16];
/** Register ranges for `S12XSystem.addPeripheral`. */
export const ATD_RANGES: readonly [RegisterRange, RegisterRange] = [
  [ATD_BASES[0], ATD_BASES[0] + 0x1f],
  [ATD_BASES[1], ATD_BASES[1] + 0x2f],
];
/** IVBR-relative vector offsets: Vatd0 $D2, Vatd1 $D0. */
export const ATD_VECTORS: readonly [number, number] = [vectorByName('Vatd0')!.offset, vectorByName('Vatd1')!.offset];

export const ATD_BITS = {
  ADPU: mask('ATD0CTL2', 'ADPU'),
  AFFC: mask('ATD0CTL2', 'AFFC'),
  AWAI: mask('ATD0CTL2', 'AWAI'),
  ETRIGLE: mask('ATD0CTL2', 'ETRIGLE'),
  ETRIGP: mask('ATD0CTL2', 'ETRIGP'),
  ETRIGE: mask('ATD0CTL2', 'ETRIGE'),
  ASCIE: mask('ATD0CTL2', 'ASCIE'),
  ASCIF: mask('ATD0CTL2', 'ASCIF'),
  FIFO: mask('ATD0CTL3', 'FIFO'),
  SRES8: mask('ATD0CTL4', 'SRES8'),
  DJM: mask('ATD0CTL5', 'DJM'),
  DSGN: mask('ATD0CTL5', 'DSGN'),
  SCAN: mask('ATD0CTL5', 'SCAN'),
  MULT: mask('ATD0CTL5', 'MULT'),
  SCF: mask('ATD0STAT0', 'SCF'),
  ETORF: mask('ATD0STAT0', 'ETORF'),
  FIFOR: mask('ATD0STAT0', 'FIFOR'),
  ETRIGSEL: mask('ATD0CTL1', 'ETRIGSEL'),
  SC: mask('ATD0TEST1', 'SC'),
} as const;
const B = ATD_BITS;

/** Default pin names: ATD0 AN0-7 = PAD00-PAD07, ATD1 AN0-15 = PAD08-PAD23. */
export function atdDefaultPins(index: AtdIndex): string[] {
  const first = index === 0 ? 0 : 8;
  return Array.from({ length: ATD_CHANNELS[index] }, (_, i) => `PAD${String(first + i).padStart(2, '0')}`);
}

export interface AtdOptions {
  /** Module number (default 1: ATD1, the one the ME3305 library uses). */
  index?: AtdIndex;
  /** Analog input pin per channel (default `atdDefaultPins(index)`). */
  pins?: readonly string[];
  /** External trigger pins ETRIG0..3 used when ETRIGSEL=1. UNCERTAIN: device-level routing unknown; default none (warns). */
  etrigPins?: readonly string[];
  /** Bus cycles between the CTL5 write (or trigger) and the first sample. UNCERTAIN: default 0. */
  startDelayCycles?: number;
  /**
   * Conversions per sequence when S8C..S1C = 0000. ATD_10B8C: 8. ATD_10B16C: 16.
   * UNCERTAIN for ATD1 (the XDP512 RM table was not available; S12X 16-channel ATDs use 0000 = 16).
   */
  zeroLength?: number;
}

export interface AtdSnapshot {
  ctl: number[];
  test1: number;
  dien: number;
  scf: boolean;
  etorf: boolean;
  fifor: boolean;
  ccf: number;
  armCcf: number;
  cc: number;
  dr: number[];
  active: boolean;
  seqLen: number;
  convIdx: number;
  nextDone: number;
  convCycles: number;
  chan: number;
  t: number;
  waitStopped: boolean;
  trigActive: boolean;
}

export class AtdModule implements Peripheral {
  readonly name: string;
  readonly index: AtdIndex;
  readonly base: number;
  readonly vector: number;
  readonly channels: number;
  readonly pins: readonly string[];
  private readonly etrigPins: readonly string[];
  readonly startDelayCycles: number;
  readonly zeroLength: number;
  private ctx: PeripheralContext | null = null;
  private readonly nets: BoardNets;
  private s: AtdSnapshot;
  private trigUnsub: (() => void) | null = null;
  private trigPin: string | null = null;

  constructor(nets: BoardNets, opts: AtdOptions = {}) {
    this.index = opts.index ?? 1;
    this.name = `ATD${this.index}`;
    this.nets = nets;
    this.base = ATD_BASES[this.index];
    this.vector = ATD_VECTORS[this.index];
    this.channels = ATD_CHANNELS[this.index];
    this.pins = opts.pins ?? atdDefaultPins(this.index);
    this.etrigPins = opts.etrigPins ?? [];
    this.startDelayCycles = opts.startDelayCycles ?? 0;
    this.zeroLength = opts.zeroLength ?? this.channels;
    this.s = this.initial(0);
  }

  private initial(t: number): AtdSnapshot {
    const max = this.channels - 1;
    return {
      // CTL0 WRAP = last channel, CTL1 ETRIGCH = last channel, CTL3 S4C (4 conversions), CTL4 PRS=5.
      ctl: [max, max, 0x00, 0x20, 0x05, 0x00],
      test1: 0,
      dien: 0,
      scf: false,
      etorf: false,
      fifor: false,
      ccf: 0,
      armCcf: 0,
      cc: 0,
      dr: new Array<number>(this.channels).fill(0),
      active: false,
      seqLen: 0,
      convIdx: 0,
      nextDone: 0,
      convCycles: 0,
      chan: 0,
      t,
      waitStopped: false,
      trigActive: false,
    };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  private get now(): number {
    const n = this.ctx ? this.ctx.now : 0;
    return n > this.s.t ? n : this.s.t;
  }

  reset(_cause?: ResetCause): void {
    this.s = this.initial(this.ctx ? this.ctx.now : 0);
    this.updateTrigger();
    this.updateIrq();
  }

  // ------------------------------------------------------------------ derived values

  get ctl2(): number {
    return this.s.ctl[2];
  }
  get poweredUp(): boolean {
    return (this.s.ctl[2] & B.ADPU) !== 0;
  }
  /** Bus cycles per ATD clock: 2 * (PRS + 1). */
  get atdClockDivisor(): number {
    return 2 * ((this.s.ctl[4] & 0x1f) + 1);
  }
  /** ATD conversion clock (Hz). */
  get atdClockHz(): number {
    return (this.ctx ? this.ctx.busHz : 0) / this.atdClockDivisor;
  }
  /** ATD clocks of the sample phase: 2 + 2^(SMP+1). */
  get sampleClocks(): number {
    return 2 + (2 << ((this.s.ctl[4] >> 5) & 3));
  }
  get resolutionBits(): 8 | 10 {
    return this.s.ctl[4] & B.SRES8 ? 8 : 10;
  }
  /** Bus cycles of one conversion. */
  get conversionCycles(): number {
    return (this.sampleClocks + this.resolutionBits) * this.atdClockDivisor;
  }
  /** Conversions per sequence (S8C..S1C). */
  get sequenceLength(): number {
    const n = (this.s.ctl[3] >> 3) & 0x0f;
    if (n === 0) return this.zeroLength;
    if (this.channels === 8 && n >= 8) return 8;
    return n;
  }
  /** True while a conversion sequence is running. */
  get busy(): boolean {
    this.ctx?.sync();
    return this.s.active;
  }
  /** WRAP: highest channel before a multi-channel sequence wraps to AN0. UNCERTAIN: WRAP=0 (reserved) = last channel. */
  private get wrapChannel(): number {
    const w = this.s.ctl[0] & (this.channels - 1);
    return w === 0 ? this.channels - 1 : w;
  }

  // ------------------------------------------------------------------ conversions

  /** Channel converted by conversion number `k` of the sequence (MULT walks from CC..CA, wrapping after WRAP). */
  private channelFor(k: number): number {
    const sel = this.s.ctl[5] & (this.channels - 1);
    if (!(this.s.ctl[5] & B.MULT)) return sel;
    const span = this.wrapChannel + 1;
    return sel > this.wrapChannel ? (k === 0 ? sel : (k - 1) % span) : (sel + k) % span;
  }

  /** Voltage converted for channel `ch` at bus cycle `cycle` (special channels via ATDTEST1.SC). */
  private inputVolts(ch: number, cycle: number): number {
    const an = this.nets.analog;
    if (this.s.test1 & B.SC) {
      // Special channels (block guide Table 3-10): CC..CA = 100 VRH, 101 VRL, 110 (VRH+VRL)/2; others reserved.
      // ATD1 (16 channels): CD..CA = 0100/0101/0110; 1100-1110 are reserved, not aliases.
      switch (ch) {
        case 4:
          return an.vrh;
        case 5:
          return an.vrl;
        case 6:
          return (an.vrh + an.vrl) / 2;
        default:
          return an.vrl;
      }
    }
    return an.volts(this.pins[ch], cycle);
  }

  /** Ideal converter: code = round((V - VRL) / (VRH - VRL) * 2^bits), clamped. UNCERTAIN: rounding (1/2 LSB offset). */
  static code(volts: number, vrl: number, vrh: number, bits: number): number {
    const full = 1 << bits;
    if (!(vrh > vrl)) return 0;
    const c = Math.round(((volts - vrl) / (vrh - vrl)) * full);
    return c < 0 ? 0 : c > full - 1 ? full - 1 : c;
  }

  /** Result register value for a raw code with the CTL5/CTL4 format (Table 3-7). */
  private format(code: number): number {
    const bits = this.resolutionBits;
    const ctl5 = this.s.ctl[5];
    if (ctl5 & B.DJM) return code; // right justified; DSGN ignored
    const signed = (ctl5 & B.DSGN) !== 0;
    const c = signed ? code ^ (1 << (bits - 1)) : code;
    return (c << (16 - bits)) & 0xffff;
  }

  private startSequence(at: number, clearFlags: boolean): void {
    const s = this.s;
    if (clearFlags) {
      s.ccf = 0;
      s.scf = false;
      s.etorf = false;
      s.armCcf = 0;
    }
    s.fifor = false;
    s.active = true;
    s.seqLen = this.sequenceLength;
    s.convIdx = 0;
    s.convCycles = this.conversionCycles;
    s.nextDone = at + this.startDelayCycles + s.convCycles;
  }

  private abort(): void {
    this.s.active = false;
    this.s.cc = 0;
  }

  /** Complete conversion `convIdx` at time `s.nextDone` (restarting the sequence in SCAN / level-trigger mode). */
  private completeOne(): void {
    const s = this.s;
    const done = s.nextDone;
    const ch = this.channelFor(s.convIdx);
    const sampleEnd = done - this.resolutionBits * this.atdClockDivisor;
    const an = this.nets.analog;
    const code = AtdModule.code(this.inputVolts(ch, sampleEnd), an.vrl, an.vrh, this.resolutionBits);
    const reg = s.cc % this.channels;
    if (s.ccf & (1 << reg)) s.fifor = true;
    s.dr[reg] = this.format(code);
    s.ccf |= 1 << reg;
    s.convIdx++;
    const fifo = (s.ctl[3] & B.FIFO) !== 0;
    s.cc = (s.cc + 1) % this.channels;
    if (s.convIdx >= s.seqLen) {
      s.scf = true;
      if (!fifo) s.cc = 0;
      if (this.continues()) {
        // UNCERTAIN: the next scan sequence starts without a gap.
        s.convIdx = 0;
        s.nextDone = done + s.convCycles;
      } else {
        s.active = false;
      }
    } else {
      s.nextDone = done + s.convCycles;
    }
  }

  /** Whether another sequence follows immediately: SCAN, or a level external trigger still asserted. */
  private continues(): boolean {
    const c2 = this.s.ctl[2];
    if (c2 & B.ETRIGE) return (c2 & B.ETRIGLE) !== 0 && this.s.trigActive;
    return (this.s.ctl[5] & B.SCAN) !== 0;
  }

  private advance(t: number): void {
    const s = this.s;
    if (s.waitStopped) {
      // Conversions are halted (WAIT with AWAI=1): shift the schedule instead of converting.
      if (s.active && t > s.t) s.nextDone += t - s.t;
      if (t > s.t) s.t = t;
      return;
    }
    if (s.active && s.nextDone <= t) {
      // Skip whole scan sequences that nobody could observe (keeps long idle SCAN runs O(1)).
      const per = s.seqLen * s.convCycles;
      if (per > 0 && this.continues()) {
        const remaining = s.seqLen - s.convIdx; // conversions left in the current sequence
        const lastOfCurrent = s.nextDone + (remaining - 1) * s.convCycles;
        if (lastOfCurrent + 2 * per <= t) {
          // Finish the current sequence normally, then jump over whole sequences but the last one.
          for (let i = 0; i < remaining; i++) this.completeOne();
          const seqStart = s.nextDone - s.convCycles;
          // Sequences stepped after the jump must rewrite every result register the skipped ones touched: one in
          // normal mode (the sequence restarts at ATDDR0), ceil(channels / length) in FIFO mode (results keep
          // rotating through the registers), so no register keeps a value from before the jump.
          const fifo = (s.ctl[3] & B.FIFO) !== 0;
          const keep = fifo ? Math.ceil(this.channels / s.seqLen) : 1;
          const skip = Math.floor((t - seqStart) / per) - keep;
          if (skip > 0) {
            s.nextDone += skip * per;
            // Every result register of a full sequence was rewritten: CCFs set, overruns flagged.
            const touched = fifo ? Math.min(skip * s.seqLen, this.channels) : Math.min(s.seqLen, this.channels);
            for (let k = 0; k < touched; k++) {
              const reg = fifo ? (s.cc + k) % this.channels : k;
              if (s.ccf & (1 << reg)) s.fifor = true;
              s.ccf |= 1 << reg;
            }
            if (fifo) s.cc = (s.cc + skip * s.seqLen) % this.channels;
          }
        }
      }
      while (s.active && s.nextDone <= t) this.completeOne();
    }
    if (t > s.t) s.t = t;
    this.updateIrq();
  }

  tick(_n: number): void {
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  nextEventCycles(): number {
    const s = this.s;
    if (!s.active || s.waitStopped || s.scf || !(s.ctl[2] & B.ASCIE)) return Infinity;
    const endOfSeq = s.nextDone + (s.seqLen - 1 - s.convIdx) * s.convCycles;
    return Math.max(0, endOfSeq - s.t);
  }

  private updateIrq(): void {
    if (!this.ctx) return;
    this.ctx.setInterrupt(this.vector, this.s.scf && (this.s.ctl[2] & B.ASCIE) !== 0);
  }

  // ------------------------------------------------------------------ external trigger

  private triggerPinName(): string | null {
    const s = this.s;
    if (!(s.ctl[2] & B.ETRIGE)) return null;
    const ch = s.ctl[1] & (this.channels - 1);
    if (s.ctl[1] & B.ETRIGSEL) {
      const p = this.etrigPins[ch & 3];
      if (!p) this.ctx?.warn(`${this.name}: external trigger ETRIG${ch & 3} (ETRIGSEL=1) is not connected in the simulator`);
      return p ?? null;
    }
    return this.pins[ch];
  }

  private triggerAsserted(): boolean {
    const p = this.trigPin;
    if (!p) return false;
    // ETRIGSEL=0: the trigger is an AN pin, seen through the same digital level as PTADx (PinNet driver, else the
    // analog voltage against the mid threshold). ETRIGSEL=1: a separate ETRIG pin on the PinNet.
    const ch = this.pins.indexOf(p);
    const lvl = ch >= 0 ? this.pinDigitalLevel(ch) : this.nets.pins.read(p);
    return lvl === (this.s.ctl[2] & B.ETRIGP ? 1 : 0);
  }

  private updateTrigger(): void {
    const p = this.triggerPinName();
    if (p !== this.trigPin) {
      this.trigUnsub?.();
      this.trigUnsub = null;
      this.trigPin = p;
      if (p) this.trigUnsub = this.nets.pins.on(p, () => this.onTriggerPin());
    }
    this.s.trigActive = this.triggerAsserted();
  }

  /**
   * Re-evaluate the external trigger after an analog-only change of an AN pin's voltage (AnalogBus has no change
   * notification; PinNet changes are seen automatically). Board models that drive a trigger channel only through
   * `nets.analog` call this when the voltage crosses the threshold.
   */
  analogInputChanged(): void {
    if (this.trigPin) this.onTriggerPin();
  }

  private onTriggerPin(): void {
    this.ctx?.sync();
    const s = this.s;
    const was = s.trigActive;
    s.trigActive = this.triggerAsserted();
    if (s.trigActive !== was && s.trigActive) this.triggerEvent(this.now);
    this.updateIrq();
    this.ctx?.reschedule();
  }

  /** An active trigger edge (edge mode) or the trigger becoming active (level mode). */
  private triggerEvent(at: number): void {
    const s = this.s;
    if (!this.poweredUp || !(s.ctl[2] & B.ETRIGE)) return;
    if (s.active) {
      // Edge mode: additional active edges during a sequence flag an overrun. Level mode: no overrun.
      if (!(s.ctl[2] & B.ETRIGLE)) s.etorf = true;
      return;
    }
    this.startSequence(at, false);
  }

  // ------------------------------------------------------------------ registers

  private ccfOfStat(off: number): number {
    // STAT1 ($B) = CCF7..0, STAT2 ($A, 16-channel only) = CCF15..8.
    return off === 0x0b ? this.s.ccf & 0xff : (this.s.ccf >> 8) & 0xff;
  }

  private stat0(): number {
    const s = this.s;
    return (s.scf ? B.SCF : 0) | (s.etorf ? B.ETORF : 0) | (s.fifor ? B.FIFOR : 0) | (s.cc & (this.channels - 1));
  }

  private ctlValue(i: number): number {
    const v = this.s.ctl[i];
    if (i === 2) return (v & ~B.ASCIF) | (this.s.scf && v & B.ASCIE ? B.ASCIF : 0);
    if (i === 5 && this.channels === 8) return v & 0xf7;
    return v;
  }

  private ptad(off: number): number {
    // ATD0: $F = AN7..0. ATD1: $E = AN15..8, $F = AN7..0.
    const first = off === 0x0e ? 8 : 0;
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const ch = first + i;
      if (ch >= this.channels) {
        v |= 1 << i;
        continue;
      }
      v |= (this.digitalInputEnabled(ch) ? this.pinDigitalLevel(ch) : 1) << i;
    }
    return v;
  }

  private regValue(off: number): number {
    const s = this.s;
    if (off <= 5) return this.ctlValue(off);
    if (off >= 0x10) {
      const n = (off - 0x10) >> 1;
      if (n >= this.channels) return 0;
      return off & 1 ? s.dr[n] & 0xff : s.dr[n] >> 8;
    }
    switch (off) {
      case 6:
        return this.stat0();
      case 9:
        return s.test1 & B.SC;
      case 0x0a:
        return this.channels === 16 ? this.ccfOfStat(0x0a) : 0;
      case 0x0b:
        return this.ccfOfStat(0x0b);
      case 0x0c:
        return this.channels === 16 ? (s.dien >> 8) & 0xff : 0;
      case 0x0d:
        return s.dien & 0xff;
      case 0x0e:
        return this.channels === 16 ? this.ptad(0x0e) : 0;
      case 0x0f:
        return this.ptad(0x0f);
      default:
        return 0; // 7 reserved, 8 ATDTEST0 (unpredictable in the RM)
    }
  }

  read(a: number): number {
    this.advance(this.now);
    const s = this.s;
    const off = a - this.base;
    const v = this.regValue(off);
    if (off === 0x0a || off === 0x0b) {
      // Arm the normal (AFFC=0) clear of the CCFs that read as 1.
      const shift = off === 0x0b ? 0 : 8;
      s.armCcf |= v << shift;
    } else if (off >= 0x10 && (off - 0x10) >> 1 < this.channels) {
      const n = (off - 0x10) >> 1;
      const bit = 1 << n;
      if (s.ctl[2] & B.AFFC) {
        // Fast flag clear: any result register access clears its CCF and SCF.
        s.ccf &= ~bit;
        s.scf = false;
      } else if (s.armCcf & bit) {
        s.ccf &= ~bit;
      }
      s.armCcf &= ~bit;
      this.updateIrq();
    }
    return v;
  }

  peek(a: number): number {
    return this.regValue(a - this.base);
  }

  write(a: number, v: number): void {
    const t = this.now;
    this.advance(t);
    const s = this.s;
    v &= 0xff;
    const off = a - this.base;
    switch (off) {
      case 0:
        s.ctl[0] = v & (this.channels - 1);
        this.abort();
        break;
      case 1:
        s.ctl[1] = v & (B.ETRIGSEL | (this.channels - 1));
        this.abort();
        break;
      case 2:
        s.ctl[2] = v & ~B.ASCIF;
        this.abort();
        s.etorf = false;
        break;
      case 3:
        s.ctl[3] = v & 0x7f;
        this.abort();
        s.etorf = false;
        break;
      case 4:
        s.ctl[4] = v;
        this.abort();
        s.etorf = false;
        break;
      case 5:
        s.ctl[5] = this.channels === 8 ? v & 0xf7 : v;
        this.abort();
        s.ccf = 0;
        s.scf = false;
        s.etorf = false;
        s.fifor = false;
        s.armCcf = 0;
        // With ETRIGE=1 a CTL5 write does not start a conversion; the trigger does.
        if (this.poweredUp && !(s.ctl[2] & B.ETRIGE)) this.startSequence(t, true);
        break;
      case 6:
        if (v & B.SCF) s.scf = false;
        if (v & B.ETORF) s.etorf = false;
        if (v & B.FIFOR) s.fifor = false;
        break;
      case 9:
        s.test1 = v & B.SC;
        break;
      case 0x0c:
        if (this.channels === 16) s.dien = (s.dien & 0x00ff) | (v << 8);
        break;
      case 0x0d:
        s.dien = (s.dien & 0xff00) | v;
        break;
      default:
        return; // STAT1/2, PTAD, DRx: read-only (writes have no effect in normal modes)
    }
    if (off <= 2) this.updateTrigger();
    // Level trigger already asserted: a sequence starts at once (and restarts after an abort).
    if (off <= 5 && s.ctl[2] & B.ETRIGE && s.ctl[2] & B.ETRIGLE && s.trigActive && !s.active) this.triggerEvent(t);
    this.updateIrq();
  }

  // ------------------------------------------------------------------ integration hooks

  /** IENn: digital input buffer of channel `ch` enabled (ATDDIEN). For the PIM's port-AD input reads. */
  digitalInputEnabled(ch: number): boolean {
    return ((this.s.dien >> ch) & 1) === 1;
  }

  /**
   * Digital level of channel `ch`'s pin: a digital driver on the PinNet (board or MCU) wins; otherwise the analog
   * voltage against (VRH+VRL)/2. UNCERTAIN: real VIL/VIH thresholds (0.35/0.65 VDD) leave a band undefined.
   */
  pinDigitalLevel(ch: number): Level {
    const pin = this.pins[ch];
    const st = this.nets.pins.state(pin);
    if (st.ext !== null) return st.ext;
    if (st.mcu !== null) return st.mcu;
    const an = this.nets.analog;
    return an.volts(pin, this.now) >= (an.vrh + an.vrl) / 2 ? 1 : 0;
  }

  /**
   * CPU entered (true) / left (false) WAIT mode. With AWAI=1 conversions halt while waiting and resume afterwards
   * (the integrator calls this from the CPU's WAI handling; there is no context hook for it yet).
   */
  setWaitMode(waiting: boolean): void {
    this.ctx?.sync();
    this.s.waitStopped = waiting && (this.s.ctl[2] & B.AWAI) !== 0;
    this.ctx?.reschedule();
  }

  /** Result register n (16-bit, formatted), side-effect free. */
  result(n: number): number {
    this.ctx?.sync();
    return this.s.dr[n];
  }

  // ------------------------------------------------------------------ snapshot

  snapshot(): AtdSnapshot {
    return { ...this.s, ctl: [...this.s.ctl], dr: [...this.s.dr] };
  }

  restore(state: unknown): void {
    const st = state as AtdSnapshot;
    this.s = { ...st, ctl: [...st.ctl], dr: [...st.dr] };
    this.updateTrigger();
    this.s.trigActive = st.trigActive;
    this.updateIrq();
  }
}

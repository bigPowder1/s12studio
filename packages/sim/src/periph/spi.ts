/**
 * SPI0..SPI2 (S12SPIV4) of the MC9S12XDP512.
 *
 * Byte-level model: a master transfer takes `8 * divisor` bus cycles (divisor = (SPPR+1) * 2^(SPR+1)) plus a
 * configurable start latency, and the byte is exchanged with the slaves on `nets.spi.SPIx` (SpiBus) at the cycle
 * the transfer completes (16th SCK edge). SCK/MOSI are not toggled bit by bit on the PinNet; the pins are claimed
 * on the 'periph' layer at their idle levels while the module is enabled (SS also goes low during a transfer when
 * it is an automatic slave-select output).
 *
 * Registers (offsets from the module base): 0 SPICR1, 1 SPICR2, 2 SPIBR, 3 SPISR, 5 SPIDR; 4/6/7 reserved (read 0).
 *
 * Flag clearing (S12SPIV4):
 * - SPIF: read SPISR with SPIF set, then read SPIDR.
 * - SPTEF: read SPISR with SPTEF set, then write SPIDR (a write without that read is ignored).
 * - MODF: read SPISR with MODF set, then write SPICR1.
 * Receive overrun (S12SPIV4 text): while SPIF is set a newly received byte waits in the receive shift register;
 * it moves to SPIDR (SPIF stays set) when SPIF is serviced, unless another transfer started before that.
 */
import { addr as regAddr, mask, vectorByName } from '@s12/devices';
import { FLOATING_LEVEL, type BoardNets, type Level } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

export type SpiIndex = 0 | 1 | 2;

/** Register-block base address of SPI0/1/2 (from @s12/devices: $00D8, $00F0, $00F8). */
export const SPI_BASES: readonly [number, number, number] = [regAddr('SPI0CR1'), regAddr('SPI1CR1'), regAddr('SPI2CR1')];
/** Register ranges to pass to `S12XSystem.addPeripheral` (8 bytes each). */
export const SPI_RANGES: readonly [RegisterRange, RegisterRange, RegisterRange] = [
  [SPI_BASES[0], SPI_BASES[0] + 7],
  [SPI_BASES[1], SPI_BASES[1] + 7],
  [SPI_BASES[2], SPI_BASES[2] + 7],
];
/** IVBR-relative vector offsets (Vspi0 $D8, Vspi1 $BE, Vspi2 $BC). */
export const SPI_VECTORS: readonly [number, number, number] = [
  vectorByName('Vspi0')!.offset,
  vectorByName('Vspi1')!.offset,
  vectorByName('Vspi2')!.offset,
];

/** Bit masks (checked against the device table at load time). */
export const SPI_BITS = {
  SPIE: mask('SPI0CR1', 'SPIE'),
  SPE: mask('SPI0CR1', 'SPE'),
  SPTIE: mask('SPI0CR1', 'SPTIE'),
  MSTR: mask('SPI0CR1', 'MSTR'),
  CPOL: mask('SPI0CR1', 'CPOL'),
  CPHA: mask('SPI0CR1', 'CPHA'),
  SSOE: mask('SPI0CR1', 'SSOE'),
  LSBFE: mask('SPI0CR1', 'LSBFE'),
  MODFEN: mask('SPI0CR2', 'MODFEN'),
  BIDIROE: mask('SPI0CR2', 'BIDIROE'),
  SPISWAI: mask('SPI0CR2', 'SPISWAI'),
  SPC0: mask('SPI0CR2', 'SPC0'),
  SPIF: mask('SPI0SR', 'SPIF'),
  SPTEF: mask('SPI0SR', 'SPTEF'),
  MODF: mask('SPI0SR', 'MODF'),
} as const;
const B = SPI_BITS;
const CR2_MASK = B.MODFEN | B.BIDIROE | B.SPISWAI | B.SPC0; // $1B
const BR_MASK = 0x77;

export interface SpiPins {
  miso: string;
  mosi: string;
  sck: string;
  ss: string;
}

/**
 * Pin routing per module: [MODRR bit clear, MODRR bit set]. MODRR4 routes SPI0 (PS4-7 / PM2-5), MODRR5 SPI1
 * (PP0-3 / PH0-3), MODRR6 SPI2 (PP4-7 / PH4-7).
 * UNCERTAIN: the MODRR bit assignment and the port M/H pin order are from the S12XD family pinout (cross-checked
 * against the MC9S12DT256 PIM guide, which has the same MODRR6:4 and pin functions), not the XDP512 RM itself.
 */
export const SPI_PIN_ROUTES: readonly [readonly [SpiPins, SpiPins], readonly [SpiPins, SpiPins], readonly [SpiPins, SpiPins]] = [
  [
    { miso: 'PS4', mosi: 'PS5', sck: 'PS6', ss: 'PS7' },
    { miso: 'PM2', mosi: 'PM4', sck: 'PM5', ss: 'PM3' },
  ],
  [
    { miso: 'PP0', mosi: 'PP1', sck: 'PP2', ss: 'PP3' },
    { miso: 'PH0', mosi: 'PH1', sck: 'PH2', ss: 'PH3' },
  ],
  [
    { miso: 'PP4', mosi: 'PP5', sck: 'PP7', ss: 'PP6' },
    { miso: 'PH4', mosi: 'PH5', sck: 'PH6', ss: 'PH7' },
  ],
];
/** MODRR bit that reroutes SPIn. */
export const SPI_MODRR_BITS: readonly [number, number, number] = [0x10, 0x20, 0x40];

export interface SpiOptions {
  /** Module number (default 0). */
  index?: SpiIndex;
  /** Current MODRR value (wire to the PIM model; default: always 0 = SPI0 on port S). Call `routingChanged()` when it changes. */
  modrr?: () => number;
  /**
   * Bus cycles between the SPTEF-clearing SPIDR write (or the end of the previous transfer when a byte is
   * already buffered) and the start of the 8 SCK periods. UNCERTAIN: the RM gives the SCK/SS timing diagrams
   * (tL = 1/2 SCK before the first edge for CPHA=0, included in the 8 bit-times) but no exact bus-cycle
   * synchronisation delay; default 0, so one byte at SPIBR=$50 takes exactly 96 bus cycles.
   */
  startDelayCycles?: number;
  /** Notified when the set of pins claimed by the module changes (the PIM should stop driving claimed input pins). */
  onPinsChanged?: () => void;
}

export interface SpiPinClaim {
  pin: string;
  dir: 'in' | 'out';
  role: 'miso' | 'mosi' | 'sck' | 'ss';
}

interface SpiState {
  cr1: number;
  cr2: number;
  br: number;
  spif: boolean;
  sptef: boolean;
  modf: boolean;
  armSpif: boolean;
  armSptef: boolean;
  armModf: boolean;
  rxDr: number;
  rxPending: number | null;
  txBuf: number;
  txFull: boolean;
  busy: boolean;
  shift: number;
  xferStart: number;
  xferEnd: number;
  /** Module time (latest bus cycle processed). */
  t: number;
  mosiLevel: Level;
  slaveShift: number;
}

export class SpiModule implements Peripheral {
  readonly name: string;
  readonly index: SpiIndex;
  readonly base: number;
  readonly vector: number;
  private ctx: PeripheralContext | null = null;
  private readonly nets: BoardNets;
  private readonly modrr: () => number;
  readonly startDelayCycles: number;
  private readonly onPinsChanged?: () => void;

  private s: SpiState = SpiModule.initial();
  /** Pins currently claimed, and the SS listener. */
  private claims: SpiPinClaim[] = [];
  private ssUnsub: (() => void) | null = null;
  private ssWatched: string | null = null;
  private inEval = false;

  constructor(nets: BoardNets, opts: SpiOptions = {}) {
    this.index = opts.index ?? 0;
    this.name = `SPI${this.index}`;
    this.nets = nets;
    this.base = SPI_BASES[this.index];
    this.vector = SPI_VECTORS[this.index];
    this.modrr = opts.modrr ?? (() => 0);
    this.startDelayCycles = opts.startDelayCycles ?? 0;
    this.onPinsChanged = opts.onPinsChanged;
  }

  private static initial(): SpiState {
    return {
      cr1: 0x04,
      cr2: 0,
      br: 0,
      spif: false,
      sptef: true,
      modf: false,
      armSpif: false,
      armSptef: false,
      armModf: false,
      rxDr: 0,
      rxPending: null,
      txBuf: 0,
      txFull: false,
      busy: false,
      shift: 0,
      xferStart: 0,
      xferEnd: 0,
      t: 0,
      mosiLevel: 1,
      slaveShift: 0,
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
    const t = this.ctx ? this.ctx.now : 0;
    this.s = SpiModule.initial();
    this.s.t = t;
    this.applyPins();
    this.updateIrq();
  }

  // ------------------------------------------------------------------ derived values

  /** Baud-rate divisor (bus cycles per SCK period): (SPPR+1) * 2^(SPR+1). */
  get divisor(): number {
    const sppr = (this.s.br >> 4) & 7;
    const spr = this.s.br & 7;
    return (sppr + 1) * (1 << (spr + 1));
  }

  /** SCK frequency (Hz) at the current bus clock. */
  get baudHz(): number {
    return (this.ctx ? this.ctx.busHz : 0) / this.divisor;
  }

  /** Bus cycles of one byte transfer (8 SCK periods + start delay). */
  get transferCycles(): number {
    return 8 * this.divisor + this.startDelayCycles;
  }

  get enabled(): boolean {
    return (this.s.cr1 & B.SPE) !== 0;
  }

  get master(): boolean {
    return (this.s.cr1 & B.MSTR) !== 0;
  }

  /** True while a transfer is shifting. */
  get busy(): boolean {
    return this.s.busy;
  }

  get pins(): SpiPins {
    return SPI_PIN_ROUTES[this.index][this.modrr() & SPI_MODRR_BITS[this.index] ? 1 : 0];
  }

  private get mode(): { cpol: 0 | 1; cpha: 0 | 1; lsbFirst: boolean } {
    return {
      cpol: this.s.cr1 & B.CPOL ? 1 : 0,
      cpha: this.s.cr1 & B.CPHA ? 1 : 0,
      lsbFirst: (this.s.cr1 & B.LSBFE) !== 0,
    };
  }

  /** SS function: 'gpio' (not used by the SPI), 'input-modf', 'output' (auto slave select), 'slave-input'. */
  private ssMode(): 'gpio' | 'input-modf' | 'output' | 'slave-input' {
    if (!this.enabled) return 'gpio';
    if (!this.master) return 'slave-input';
    const modfen = (this.s.cr2 & B.MODFEN) !== 0;
    const ssoe = (this.s.cr1 & B.SSOE) !== 0;
    if (!modfen) return 'gpio';
    return ssoe ? 'output' : 'input-modf';
  }

  private srValue(): number {
    return (this.s.spif ? B.SPIF : 0) | (this.s.sptef ? B.SPTEF : 0) | (this.s.modf ? B.MODF : 0);
  }

  // ------------------------------------------------------------------ time

  /** Process every event up to time `t`. */
  private advance(t: number): void {
    const s = this.s;
    // A completing transfer starts the next buffered byte at once, which may also complete before `t`.
    while (s.busy && s.xferEnd <= t) {
      const e = s.xferEnd;
      this.complete(e);
      if (s.txFull && this.canStart()) this.start(e);
    }
    if (t > s.t) s.t = t;
  }

  tick(_n: number): void {
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  nextEventCycles(): number {
    const s = this.s;
    if (s.busy) return Math.max(0, s.xferEnd - s.t);
    return Infinity;
  }

  private canStart(): boolean {
    return this.enabled && this.master && !this.s.modf;
  }

  private start(at: number): void {
    const s = this.s;
    s.busy = true;
    s.shift = s.txBuf;
    s.txFull = false;
    s.sptef = true;
    // A byte waiting in the receive shift register becomes invalid once another transmission starts.
    s.rxPending = null;
    s.xferStart = at;
    s.xferEnd = at + this.transferCycles;
    if (this.ssMode() === 'output') this.drive(this.pins.ss, 0);
    this.updateIrq();
  }

  private complete(at: number): void {
    const s = this.s;
    s.busy = false;
    const bidir = (s.cr2 & B.SPC0) !== 0;
    const bus = this.nets.spi[`SPI${this.index}` as 'SPI0' | 'SPI1' | 'SPI2'];
    let rx: number;
    if (bidir) {
      // UNCERTAIN: bidirectional (SPC0=1) master. BIDIROE=1: the byte goes out on MOMI and the receiver reads the
      // pin it is driving (its own byte). BIDIROE=0: MOMI is an input, slaves see an undriven line ($FF) and the
      // master receives their answer.
      if (s.cr2 & B.BIDIROE) {
        bus.exchange(s.shift, at, this.mode);
        rx = s.shift;
      } else {
        rx = bus.exchange(0xff, at, this.mode);
      }
    } else {
      rx = bus.exchange(s.shift, at, this.mode);
    }
    rx &= 0xff;
    // MOSI holds the last bit shifted out.
    s.mosiLevel = ((s.cr1 & B.LSBFE ? s.shift >> 7 : s.shift) & 1) as Level;
    if (!s.spif) {
      s.rxDr = rx;
      s.spif = true;
    } else {
      s.rxPending = rx;
    }
    // UNCERTAIN: automatic SS between back-to-back bytes. S12SPIV4 timing figures: with CPHA=1 the minimum SS
    // high time is "not required for back-to-back transfers", so SS stays low; with CPHA=0 SS is deasserted
    // between bytes, which this model (no tL/tT/tI timing) shows as a zero-width 1->0 pulse at the same cycle.
    const keepSs = (s.cr1 & B.CPHA) !== 0 && s.txFull && this.canStart();
    for (const c of this.claims) {
      if (c.dir !== 'out') continue;
      if (c.role === 'ss') {
        if (!keepSs) this.drive(c.pin, 1);
      }
      else if (c.role === 'mosi') this.drive(c.pin, s.mosiLevel);
    }
    this.updateIrq();
  }

  private abort(): void {
    const s = this.s;
    if (s.busy) {
      s.busy = false;
      for (const c of this.claims) if (c.role === 'ss' && c.dir === 'out') this.drive(c.pin, 1);
    }
  }

  // ------------------------------------------------------------------ interrupts

  private updateIrq(): void {
    if (!this.ctx) return;
    const s = this.s;
    // UNCERTAIN: requests are gated with SPE (SPTEF reads 1 out of reset; an SPTIE=1 write with SPE=0 does not
    // interrupt in this model).
    const on =
      this.enabled && (((s.cr1 & B.SPIE) !== 0 && (s.spif || s.modf)) || ((s.cr1 & B.SPTIE) !== 0 && s.sptef));
    this.ctx.setInterrupt(this.vector, on);
  }

  // ------------------------------------------------------------------ registers

  read(a: number): number {
    this.advance(this.now);
    const s = this.s;
    switch (a - this.base) {
      case 0:
        return s.cr1;
      case 1:
        return s.cr2 & CR2_MASK;
      case 2:
        return s.br & BR_MASK;
      case 3: {
        const v = this.srValue();
        s.armSpif = s.spif;
        s.armSptef = s.sptef;
        s.armModf = s.modf;
        return v;
      }
      case 5: {
        const v = s.rxDr;
        if (s.armSpif && s.spif) {
          s.spif = false;
          if (s.rxPending !== null) {
            s.rxDr = s.rxPending;
            s.rxPending = null;
            s.spif = true;
          }
          this.updateIrq();
        }
        s.armSpif = false;
        return v;
      }
      default:
        return 0;
    }
  }

  peek(a: number): number {
    switch (a - this.base) {
      case 0:
        return this.s.cr1;
      case 1:
        return this.s.cr2 & CR2_MASK;
      case 2:
        return this.s.br & BR_MASK;
      case 3:
        return this.srValue();
      case 5:
        return this.s.rxDr;
      default:
        return 0;
    }
  }

  write(a: number, v: number): void {
    const t = this.now;
    this.advance(t);
    const s = this.s;
    v &= 0xff;
    switch (a - this.base) {
      case 0: {
        const old = s.cr1;
        if (s.armModf && s.modf) s.modf = false;
        s.armModf = false;
        s.cr1 = v;
        if ((old & B.SPE) && !(v & B.SPE)) {
          // SPE cleared: SPI forced idle, SPISR back to its reset state.
          this.abort();
          s.spif = s.modf = false;
          s.sptef = true;
          s.txFull = false;
          s.rxPending = null;
        } else if ((old ^ v) & B.MSTR) {
          // Mode change aborts a transmission in progress.
          this.abort();
        }
        break;
      }
      case 1:
        s.cr2 = v & CR2_MASK;
        break;
      case 2:
        // UNCERTAIN: a baud-rate change during a transfer only affects the next transfer.
        s.br = v & BR_MASK;
        break;
      case 3:
        return; // read-only
      case 5:
        if (s.armSptef && s.sptef) {
          s.txBuf = v;
          s.txFull = true;
          s.sptef = false;
          s.armSptef = false;
          if (!this.master && this.enabled) s.slaveShift = v;
        } else {
          this.ctx?.warn(`${this.name}: write to ${this.name}DR ignored (SPTEF not read as 1 in ${this.name}SR first)`, {
            register: `${this.name}DR`,
            value: v,
          });
          s.armSptef = false;
        }
        break;
      default:
        return;
    }
    this.applyPins();
    this.checkModeFault();
    this.startPending(t);
    this.updateIrq();
  }

  /** Start a buffered byte now if the module is an idle, enabled master (else it waits for the current transfer). */
  private startPending(t: number): void {
    const s = this.s;
    if (!s.busy && s.txFull && this.canStart()) this.start(t);
  }

  // ------------------------------------------------------------------ pins

  private drive(pin: string, level: Level | null): void {
    this.nets.pins.setMcuOutput(pin, level, 'periph');
  }

  /** Pins the module currently uses (inputs must not be driven by the GPIO layer). */
  claimedPins(): readonly SpiPinClaim[] {
    return this.claims;
  }

  isPinClaimed(pin: string): boolean {
    return this.claims.some((c) => c.pin === pin);
  }

  /** Call after MODRR changed (the PIM model): moves the pin claims. */
  routingChanged(): void {
    this.ctx?.sync();
    this.applyPins();
    this.checkModeFault();
    this.ctx?.reschedule();
  }

  private computeClaims(): SpiPinClaim[] {
    if (!this.enabled) return [];
    const p = this.pins;
    const out: SpiPinClaim[] = [];
    const bidir = (this.s.cr2 & B.SPC0) !== 0;
    if (this.master) {
      out.push({ pin: p.sck, dir: 'out', role: 'sck' });
      if (bidir) out.push({ pin: p.mosi, dir: this.s.cr2 & B.BIDIROE ? 'out' : 'in', role: 'mosi' });
      else {
        out.push({ pin: p.mosi, dir: 'out', role: 'mosi' });
        out.push({ pin: p.miso, dir: 'in', role: 'miso' });
      }
    } else {
      out.push({ pin: p.sck, dir: 'in', role: 'sck' });
      if (bidir) out.push({ pin: p.miso, dir: this.s.cr2 & B.BIDIROE ? 'out' : 'in', role: 'miso' });
      else {
        out.push({ pin: p.mosi, dir: 'in', role: 'mosi' });
        out.push({ pin: p.miso, dir: 'out', role: 'miso' });
      }
    }
    const ss = this.ssMode();
    if (ss === 'output') out.push({ pin: p.ss, dir: 'out', role: 'ss' });
    else if (ss === 'input-modf' || ss === 'slave-input') out.push({ pin: p.ss, dir: 'in', role: 'ss' });
    return out;
  }

  private applyPins(): void {
    const next = this.computeClaims();
    const prev = this.claims;
    const same =
      next.length === prev.length && next.every((c, i) => c.pin === prev[i].pin && c.dir === prev[i].dir && c.role === prev[i].role);
    this.claims = next;
    // Release pins no longer driven.
    for (const c of prev) {
      if (c.dir === 'out' && !next.some((n) => n.pin === c.pin && n.dir === 'out')) this.drive(c.pin, null);
    }
    const cpol = (this.s.cr1 & B.CPOL ? 1 : 0) as Level;
    for (const c of next) {
      if (c.dir !== 'out') continue;
      if (c.role === 'sck') this.drive(c.pin, cpol);
      else if (c.role === 'mosi') this.drive(c.pin, this.s.mosiLevel);
      else if (c.role === 'ss') this.drive(c.pin, this.s.busy ? 0 : 1);
      // UNCERTAIN: slave MISO idles high (the real pin is driven only while SS is low).
      else if (c.role === 'miso') this.drive(c.pin, 1);
    }
    // Watch SS when it is an input.
    const ssIn = next.find((c) => c.role === 'ss' && c.dir === 'in')?.pin ?? null;
    if (ssIn !== this.ssWatched) {
      this.ssUnsub?.();
      this.ssUnsub = null;
      this.ssWatched = ssIn;
      if (ssIn) this.ssUnsub = this.nets.pins.on(ssIn, () => this.onSsChange());
    }
    if (!same) this.onPinsChanged?.();
  }

  private onSsChange(): void {
    if (this.inEval) return;
    this.ctx?.sync();
    this.checkModeFault();
    this.ctx?.reschedule();
  }

  /**
   * Level seen by the SS input buffer. While the SPI uses SS as an input the port's GPIO output driver is
   * disconnected, so a stale PIM 'gpio' drive (DDRS7=1) is ignored: board drive, else pull device, else floating.
   * UNCERTAIN: the PIM model may also release the drive itself in `onPinsChanged`; either way the result is the same.
   */
  private ssInputLevel(): Level {
    const st = this.nets.pins.state(this.pins.ss);
    if (st.ext !== null) return st.ext;
    if (st.mcuLayer === 'periph' && st.mcu !== null) return st.mcu;
    return st.pull === 'up' ? 1 : st.pull === 'down' ? 0 : FLOATING_LEVEL;
  }

  /** Mode fault: master with MODFEN=1, SSOE=0 and the SS input low. */
  private checkModeFault(): void {
    if (this.ssMode() !== 'input-modf') return;
    if (this.ssInputLevel() !== 0) return;
    this.inEval = true;
    try {
      const s = this.s;
      this.abort();
      s.modf = true;
      s.cr1 &= ~B.MSTR; // switches to slave mode; outputs disabled
      this.applyPins();
      this.updateIrq();
    } finally {
      this.inEval = false;
    }
  }

  // ------------------------------------------------------------------ slave mode (external master)

  /**
   * An external master clocks one byte into this SPI while it is an enabled slave (SPE=1, MSTR=0) and its SS
   * input is low. Returns the byte shifted out on MISO, or null when the slave is not selected.
   * UNCERTAIN: the slave shifts out the last byte written to SPIDR (or the previous received byte when none
   * was written); timing is instantaneous at the current bus cycle.
   */
  slaveTransfer(mosi: number): number | null {
    this.ctx?.sync();
    const s = this.s;
    if (!this.enabled || this.master) return null;
    if (this.ssInputLevel() !== 0) return null;
    const out = s.txFull ? s.txBuf : s.slaveShift;
    if (s.txFull) {
      s.txFull = false;
      s.sptef = true;
    }
    s.slaveShift = mosi & 0xff;
    if (!s.spif) {
      s.rxDr = mosi & 0xff;
      s.spif = true;
    } else {
      s.rxPending = mosi & 0xff;
    }
    this.updateIrq();
    this.ctx?.reschedule();
    return out;
  }

  // ------------------------------------------------------------------ snapshot

  snapshot(): unknown {
    return { ...this.s };
  }

  restore(state: unknown): void {
    this.s = { ...(state as SpiState) };
    this.applyPins();
    this.updateIrq();
  }
}

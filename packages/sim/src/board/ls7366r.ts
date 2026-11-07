/**
 * LSI/CSI LS7366R 32-bit quadrature counter with SPI interface (ME305: SPI0, CS = PH0 active low).
 *
 * Instruction byte (first byte after CS falls): IR7:6 = operation (00 CLR, 01 RD, 10 WR, 11 LOAD),
 * IR5:3 = register (001 MDR0, 010 MDR1, 011 DTR, 100 CNTR, 101 OTR, 110 STR). Data bytes MSB first.
 * - CLR MDR0/MDR1/CNTR/STR -> 0.       - RD MDR0/MDR1/STR (1 byte), OTR (n bytes), CNTR (CNTR->OTR, then OTR).
 * - WR MDR0/MDR1 (1 byte), DTR (n).    - LOAD CNTR (DTR->CNTR), LOAD OTR (CNTR->OTR).
 * n = MDR1[1:0]: 00 = 4 bytes, 01 = 3, 10 = 2, 11 = 1. MDR1[2] = 1 disables counting.
 * MDR0[1:0] quadrature: 00 non-quadrature, 01 x1, 10 x2, 11 x4; MDR0[3:2] count mode: free-run, single-cycle,
 * range-limit, modulo-n (limits from DTR).
 * STR: CY BW CMP IDX CEN PLS U/D S (bit 7..0).
 *
 * Input: the quadrature position in edges (4 per encoder line) from `setPosition()` or a live `positionSource`
 * (e.g. the motor model), sampled lazily at every SPI transfer / CS edge.
 * Typical use: WR MDR0, WR MDR1, then RD CNTR to read the count (see test/board-spi.test.ts).
 */
import { ME305 } from '@s12/devices';
import type { BoardNets, PinNet, SpiSlave } from '../pins.js';
import { Emitter, makeBoardClock, reverseBits8, watchLevel, type BoardClock } from './clock.js';

export const LS7366R_REG = { MDR0: 1, MDR1: 2, DTR: 3, CNTR: 4, OTR: 5, STR: 6 } as const;
export const LS7366R_OP = { CLR: 0, RD: 1, WR: 2, LOAD: 3 } as const;
export const LS7366R_STR = { CY: 0x80, BW: 0x40, CMP: 0x20, IDX: 0x10, CEN: 0x08, PLS: 0x04, UD: 0x02, S: 0x01 } as const;

export interface Ls7366rOptions {
  /** Chip-select pin (active low). Default PH0. */
  cs: string;
  /** Live quadrature position in edges at bus cycle `cycle` (overrides `setPosition`). */
  positionSource: ((cycle: number) => number) | null;
  clock: BoardClock;
}

export interface Ls7366rSnapshot {
  mdr0: number;
  mdr1: number;
  dtr: number;
  cntr: number;
  otr: number;
  str: number;
  stopped: boolean;
  position: number;
  lastPos: number;
}

export interface Ls7366rTransfer {
  cycle: number;
  mosi: number;
  miso: number;
  /** Byte index inside the CS frame (0 = instruction). */
  index: number;
}

type Frame =
  | { kind: 'none' }
  | { kind: 'read'; bytes: number[]; next: number }
  | { kind: 'write'; reg: number; need: number; got: number[] }
  | { kind: 'done' };

export class Ls7366r implements SpiSlave {
  readonly name = 'LS7366R';
  readonly opts: Ls7366rOptions;
  readonly transfers = new Emitter<Ls7366rTransfer>();
  private readonly pins: PinNet;
  private mdr0 = 0;
  private mdr1 = 0;
  private dtr = 0;
  private cntr = 0;
  private otr = 0;
  /** Latched flags (CY BW CMP IDX) + PLS + U/D + S; CEN is derived from MDR1. */
  private str = 0;
  /** Single-cycle mode: counting stopped by a carry/borrow until CNTR is cleared/loaded. */
  private stopped = false;
  private position = 0;
  private lastPos = 0;
  private frame: Frame = { kind: 'none' };
  private index = 0;
  private readonly unsub: Array<() => void> = [];

  constructor(nets: BoardNets, opts: Partial<Ls7366rOptions> = {}) {
    this.pins = nets.pins;
    this.opts = {
      cs: opts.cs ?? ME305.encoder.cs,
      positionSource: opts.positionSource ?? null,
      clock: opts.clock ?? makeBoardClock(nets.pins),
    };
    this.unsub.push(
      watchLevel(this.pins, this.opts.cs, (lv, cyc) => {
        this.update(cyc);
        if (lv === 0) {
          this.frame = { kind: 'none' };
          this.index = 0;
        } else this.endFrame();
      }),
    );
    this.powerOn();
  }

  /** Power-up state: all registers 0, STR.PLS set (UNCERTAIN: U/D and S power up 0). */
  powerOn(): void {
    this.mdr0 = this.mdr1 = this.dtr = this.cntr = this.otr = 0;
    this.str = LS7366R_STR.PLS;
    this.stopped = false;
    this.lastPos = this.sourcePos(this.opts.clock.now());
    this.frame = { kind: 'none' };
    this.index = 0;
  }

  dispose(): void {
    for (const u of this.unsub.splice(0)) u();
  }

  selected(): boolean {
    return this.pins.read(this.opts.cs) === 0;
  }

  // ------------------------------------------------------------------ counting

  /** Set the quadrature position (edges) at the current time (ignored while a positionSource is attached). */
  setPosition(edges: number, cycle = this.opts.clock.now()): void {
    this.update(cycle);
    this.position = Math.floor(edges);
    this.update(cycle);
  }

  /** Move by a number of quadrature edges. */
  step(edges: number, cycle = this.opts.clock.now()): void {
    this.setPosition(this.position + edges, cycle);
  }

  private sourcePos(cycle: number): number {
    return this.opts.positionSource ? Math.floor(this.opts.positionSource(cycle)) : this.position;
  }

  get bytes(): number {
    return 4 - (this.mdr1 & 3);
  }

  private get max(): number {
    return 2 ** (8 * this.bytes) - 1;
  }

  get countingEnabled(): boolean {
    return (this.mdr1 & 0x04) === 0;
  }

  /** Bring the counter up to the input position at `cycle`. */
  update(cycle = this.opts.clock.now()): void {
    const pos = this.sourcePos(cycle);
    const prev = this.lastPos;
    this.lastPos = pos;
    if (pos === prev || !this.countingEnabled || this.stopped) return;
    // Counts per edge by quadrature mode. UNCERTAIN: non-quadrature mode (A = clock, B = direction) fed by
    // quadrature signals is modelled as x1.
    const div = [4, 4, 2, 1][this.mdr0 & 3];
    const d = Math.floor(pos / div) - Math.floor(prev / div);
    if (d !== 0) this.applyCounts(d);
  }

  private applyCounts(d: number): void {
    const mode = (this.mdr0 >> 2) & 3;
    const max = this.max;
    let c = this.cntr;
    let cy = false;
    let bw = false;
    let cmp = false;
    const hitsDtr = (from: number, delta: number, period: number): boolean => {
      if (this.dtr >= period) return false;
      if (Math.abs(delta) >= period) return true;
      const dist = delta > 0 ? (this.dtr - from - 1 + period * 2) % period : (from - 1 - this.dtr + period * 2) % period;
      return dist < Math.abs(delta);
    };
    if (mode === 2) {
      // Range-limit: count between 0 and DTR, freezing at the limits (CY above the top, BW below 0).
      // UNCERTAIN: flag timing at the limits.
      const top = Math.min(this.dtr, max);
      const n = c + d;
      const end = Math.max(0, Math.min(top, n));
      cmp = this.dtr <= max && (d > 0 ? c < this.dtr && end >= this.dtr : end <= this.dtr && this.dtr < c);
      cy = n > top;
      bw = n < 0;
      c = end;
    } else {
      const period = mode === 3 ? Math.min(this.dtr, max) + 1 : max + 1;
      cmp = hitsDtr(c, d, period);
      const n = c + d;
      if (n > period - 1) cy = true;
      if (n < 0) bw = true;
      c = ((n % period) + period) % period;
      if (mode === 1 && (cy || bw)) this.stopped = true;
    }
    this.cntr = c;
    let s = this.str & ~LS7366R_STR.UD;
    if (d > 0) s |= LS7366R_STR.UD;
    if (cy) s = (s | LS7366R_STR.CY) & ~LS7366R_STR.S;
    if (bw) s |= LS7366R_STR.BW | LS7366R_STR.S;
    if (cmp) s |= LS7366R_STR.CMP;
    this.str = s;
  }

  // ------------------------------------------------------------------ SPI

  exchange(mosiRaw: number, cycle: number, mode: { cpol: 0 | 1; cpha: 0 | 1; lsbFirst: boolean }): number {
    this.update(cycle);
    const mosi = mode.lsbFirst ? reverseBits8(mosiRaw) : mosiRaw & 0xff;
    // UNCERTAIN: MISO during the instruction byte and after the last data byte is high-Z; reads as $FF.
    let miso = 0xff;
    const idx = this.index++;
    const f = this.frame;
    if (f.kind === 'none') this.instruction(mosi);
    else if (f.kind === 'read') {
      if (f.next < f.bytes.length) miso = f.bytes[f.next++];
    } else if (f.kind === 'write') {
      if (f.got.length < f.need) {
        f.got.push(mosi);
        if (f.got.length === f.need) this.commitWrite(f);
      }
    }
    const out = mode.lsbFirst ? reverseBits8(miso) : miso;
    if (this.transfers.size) this.transfers.emit({ cycle, mosi: mosiRaw & 0xff, miso: out, index: idx });
    return out;
  }

  private instruction(ir: number): void {
    const op = ir >> 6;
    const reg = (ir >> 3) & 7;
    const R = LS7366R_REG;
    this.frame = { kind: 'done' };
    switch (op) {
      case LS7366R_OP.CLR:
        if (reg === R.MDR0) this.mdr0 = 0;
        else if (reg === R.MDR1) this.mdr1 = 0;
        else if (reg === R.CNTR) {
          this.cntr = 0;
          this.stopped = false;
        } else if (reg === R.STR) this.str = 0;
        // UNCERTAIN: CLR DTR / CLR OTR are not defined by the datasheet; ignored.
        break;
      case LS7366R_OP.RD: {
        let bytes: number[] = [];
        if (reg === R.MDR0) bytes = [this.mdr0];
        else if (reg === R.MDR1) bytes = [this.mdr1];
        else if (reg === R.STR) bytes = [this.strValue()];
        else if (reg === R.CNTR || reg === R.OTR || reg === R.DTR) {
          if (reg === R.CNTR) this.otr = this.cntr;
          // UNCERTAIN: RD DTR is not in the datasheet table; returns DTR.
          bytes = this.split(reg === R.DTR ? this.dtr : this.otr);
        }
        this.frame = { kind: 'read', bytes, next: 0 };
        break;
      }
      case LS7366R_OP.WR:
        if (reg === R.MDR0 || reg === R.MDR1) this.frame = { kind: 'write', reg, need: 1, got: [] };
        else if (reg === R.DTR) this.frame = { kind: 'write', reg, need: this.bytes, got: [] };
        // UNCERTAIN: WR CNTR/OTR/STR are not valid instructions; ignored.
        break;
      case LS7366R_OP.LOAD:
        if (reg === R.CNTR) {
          this.cntr = this.dtr & this.max;
          this.stopped = false;
        } else if (reg === R.OTR) this.otr = this.cntr;
        break;
    }
  }

  private split(v: number): number[] {
    const out: number[] = [];
    for (let i = this.bytes - 1; i >= 0; i--) out.push(Math.floor(v / 2 ** (8 * i)) & 0xff);
    return out;
  }

  private commitWrite(f: { reg: number; got: number[] }): void {
    if (f.reg === LS7366R_REG.MDR0) this.mdr0 = f.got[0];
    else if (f.reg === LS7366R_REG.MDR1) {
      this.mdr1 = f.got[0];
      // UNCERTAIN: changing the counter width truncates CNTR to the new width.
      this.cntr = this.cntr % (this.max + 1);
    } else if (f.reg === LS7366R_REG.DTR) {
      let v = 0;
      for (const b of f.got) v = v * 256 + b;
      this.dtr = v;
    }
    this.frame = { kind: 'done' };
  }

  private endFrame(): void {
    const f = this.frame;
    // UNCERTAIN: a DTR write cut short by CS rising commits the bytes received so far (right-aligned).
    if (f.kind === 'write' && f.reg === LS7366R_REG.DTR && f.got.length > 0 && f.got.length < f.need) this.commitWrite(f);
    this.frame = { kind: 'none' };
    this.index = 0;
  }

  private strValue(): number {
    return (this.str & ~LS7366R_STR.CEN) | (this.countingEnabled ? LS7366R_STR.CEN : 0);
  }

  // ------------------------------------------------------------------ UI / test API

  /** Register values (after bringing the count up to date). */
  registers(cycle = this.opts.clock.now()): { mdr0: number; mdr1: number; dtr: number; cntr: number; otr: number; str: number } {
    this.update(cycle);
    return { mdr0: this.mdr0, mdr1: this.mdr1, dtr: this.dtr, cntr: this.cntr, otr: this.otr, str: this.strValue() };
  }

  /** Current counter value. */
  counter(cycle = this.opts.clock.now()): number {
    this.update(cycle);
    return this.cntr;
  }

  /** Current quadrature input position (edges). */
  inputPosition(cycle = this.opts.clock.now()): number {
    return this.sourcePos(cycle);
  }

  snapshot(): Ls7366rSnapshot {
    this.update();
    return {
      mdr0: this.mdr0,
      mdr1: this.mdr1,
      dtr: this.dtr,
      cntr: this.cntr,
      otr: this.otr,
      str: this.str,
      stopped: this.stopped,
      position: this.position,
      lastPos: this.lastPos,
    };
  }

  restore(s: Ls7366rSnapshot): void {
    Object.assign(this, s);
    this.frame = { kind: 'none' };
    this.index = 0;
  }
}

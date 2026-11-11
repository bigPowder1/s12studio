/**
 * HD44780-compatible character LCD (ME3305: 40x2, 8-bit bus on PB0-7, RS=PM4, R/W=PM5, E=PM6).
 *
 * Bus protocol (datasheet timing diagrams): RS and R/W are sampled on the E rising edge; a write latches the data
 * bus on the E falling edge; a read drives the data bus (board layer of the PinNet) while E and R/W are high and
 * releases it when either drops. A data read advances the address counter at the end of the read (E falling).
 * In 4-bit mode (DL=0) transfers use DB4-7, high nibble first.
 *
 * Access patterns this must support (private me3305-board.md §3): reset writes (E high, data, E low, no busy
 * check), writes followed by busy-flag polling, BF/AC reads (GETADDR), character/address writes (OUTCHAR/SETADDR);
 * the library never sends Entry Mode Set, so the power-on I/D=1, S=0 is relied on.
 *
 * E is taken as LOW unless something drives it (MCU output, board, or an MCU pull device): PinNet's floating level
 * of 1 must not look like a bus cycle while the MCU is in reset. RS and R/W use the resolved level (the HD44780 has
 * internal pull-ups on them, matching the floating 1).
 */
import type { BoardNets, Level, PinNet } from '../pins.js';
import { Emitter, drivenLevel, makeBoardClock, watchLevel, type BoardClock } from './clock.js';
import { HD44780_A00 } from './hd44780-rom.js';

export interface Hd44780Pins {
  /** Data bus pin prefix (`${data}0..7`), default 'PB'. */
  data: string;
  rs: string;
  rw: string;
  e: string;
}

export interface Hd44780Options {
  pins: Hd44780Pins;
  /** Visible geometry. Default 40 x 2 (critique C1). */
  cols: number;
  rows: number;
  /**
   * Busy time per instruction: 'realistic' (37 us, 1.52 ms for clear/home, datasheet at fosc=270 kHz), 'zero'
   * (BF never set), or explicit seconds.
   */
  timing: 'realistic' | 'zero' | { command: number; clearHome: number };
  /**
   * What to do with a write that arrives while BF=1. 'execute' (default) performs it anyway; 'ignore' drops it.
   * UNCERTAIN: real controllers mostly ignore or corrupt such writes; the library's three reset writes 2 us apart
   * relies on the power-on reset state, so 'execute' keeps it working regardless.
   */
  whileBusy: 'execute' | 'ignore';
  clock: BoardClock;
}

export interface LcdCursor {
  row: number;
  col: number;
}

export interface LcdView {
  /** Visible text per row (`cols` characters; CGRAM glyphs as U+E000+n). Blank when the display is off. */
  lines: string[];
  /** Character codes per visible position (regardless of display on/off). */
  codes: number[][];
  displayOn: boolean;
  cursorOn: boolean;
  blinkOn: boolean;
  /** Cursor position on the glass (null when the AC is off-screen or points into CGRAM). */
  cursor: LcdCursor | null;
  /** Whether the underline cursor / blink block should be drawn (display on and C or B set). */
  cursorVisible: boolean;
  /** 8 CGRAM glyphs, 8 rows each, 5 LSBs = pixels (bit 4 leftmost). */
  cgram: number[][];
  /** Display shift (characters). */
  shift: number;
  twoLine: boolean;
  eightBit: boolean;
  addressCounter: number;
}

export interface LcdTransfer {
  cycle: number;
  /** 'cmd' (RS=0 write), 'data' (RS=1 write), 'status' (RS=0 read), 'read' (RS=1 read). */
  kind: 'cmd' | 'data' | 'status' | 'read';
  value: number;
  /** BF was set when the transfer happened. */
  busy: boolean;
}

export interface LcdChange {
  cycle: number;
  what: 'ddram' | 'cgram' | 'display' | 'cursor' | 'mode';
}

export interface Hd44780Snapshot {
  ddram: number[];
  cgram: number[];
  ac: number;
  cg: boolean;
  id: boolean;
  s: boolean;
  d: boolean;
  c: boolean;
  b: boolean;
  dl: boolean;
  n: boolean;
  f: boolean;
  shift: number;
  busyUntil: number;
  nibbleLow: boolean;
  readNibbleLow: boolean;
  /** Bus-cycle state (a snapshot taken mid-transfer). Optional for older snapshots. */
  eHigh?: boolean;
  rsAtRise?: Level;
  rwAtRise?: Level;
  pendingHigh?: number;
}

export const HD44780_DEFAULT_PINS: Hd44780Pins = { data: 'PB', rs: 'PM4', rw: 'PM5', e: 'PM6' };

/** Blink half-period at fosc = 270 kHz (datasheet: 409.6 ms). */
export const HD44780_BLINK_SECONDS = 0.4096;

export class Hd44780 {
  readonly opts: Hd44780Options;
  private readonly pins: PinNet;
  readonly changes = new Emitter<LcdChange>();
  readonly transfers = new Emitter<LcdTransfer>();
  /** Writes that arrived while BF=1 (diagnostic). */
  busyViolations = 0;
  /** Writes to DDRAM addresses outside the valid ranges (dropped). */
  invalidAddressWrites = 0;

  // ---- controller state
  private ddram = new Uint8Array(80);
  private cgram = new Uint8Array(64);
  private ac = 0;
  private cg = false;
  private id = true;
  private s = false;
  private d = false;
  private c = false;
  private b = false;
  private dl = true;
  private n = false;
  private f = false;
  private shift = 0;
  /** Seconds until which BF=1 (-1 = idle). */
  private busyUntil = -1;
  private nibbleLow = false;
  private readNibbleLow = false;
  private pendingHigh = 0;

  // ---- bus state
  private eHigh = false;
  private rsAtRise: Level = 0;
  private rwAtRise: Level = 0;
  private driving = false;
  private readonly unsub: Array<() => void> = [];

  constructor(nets: BoardNets, opts: Partial<Hd44780Options> = {}) {
    this.pins = nets.pins;
    this.opts = {
      pins: opts.pins ?? HD44780_DEFAULT_PINS,
      cols: opts.cols ?? 40,
      rows: opts.rows ?? 2,
      timing: opts.timing ?? 'realistic',
      whileBusy: opts.whileBusy ?? 'execute',
      clock: opts.clock ?? makeBoardClock(nets.pins),
    };
    const p = this.opts.pins;
    this.eHigh = this.eLevel() === 1;
    this.unsub.push(
      this.pins.on(p.e, (_p, st, cyc) => {
        const hi = drivenLevel(st, 0) === 1;
        if (hi === this.eHigh) return;
        if (hi) this.eRise(cyc);
        else this.eFall(cyc);
      }),
    );
    this.unsub.push(watchLevel(this.pins, p.rw, () => this.updateDrive()));
    this.powerOn();
  }

  /** Power-on reset ("initialization by internal reset circuit"): clear, DL=1, N=0, F=0, D=C=B=0, I/D=1, S=0. */
  powerOn(): void {
    this.ddram.fill(0x20);
    this.cgram.fill(0);
    this.ac = 0;
    this.cg = false;
    this.id = true;
    this.s = false;
    this.d = this.c = this.b = false;
    this.dl = true;
    this.n = false;
    this.f = false;
    this.shift = 0;
    // UNCERTAIN: the ~15 ms power-on busy period is not modelled (the library does not wait for it).
    this.busyUntil = -1;
    this.nibbleLow = false;
    this.readNibbleLow = false;
    this.release();
    this.changed(this.opts.clock.now(), 'display');
  }

  dispose(): void {
    for (const u of this.unsub.splice(0)) u();
    this.release();
  }

  // ------------------------------------------------------------------ bus

  /** E as the LCD sees it: undriven (no driver, no pull) = low. */
  private eLevel(): Level {
    return drivenLevel(this.pins.state(this.opts.pins.e), 0);
  }

  private eRise(cycle: number): void {
    this.eHigh = true;
    this.rsAtRise = this.pins.read(this.opts.pins.rs);
    this.rwAtRise = this.pins.read(this.opts.pins.rw);
    this.updateDrive(cycle);
  }

  private eFall(cycle: number): void {
    this.eHigh = false;
    if (this.rwAtRise === 1) {
      this.release();
      this.finishRead(cycle);
    } else {
      this.latchWrite(cycle);
    }
  }

  /** Drive the data bus while E=1, R/W=1 (and the cycle started as a read). */
  private updateDrive(cycle = this.opts.clock.now()): void {
    const want = this.eHigh && this.rwAtRise === 1 && this.pins.read(this.opts.pins.rw) === 1;
    if (want && !this.driving) {
      const v = this.readValue(cycle);
      this.driving = true;
      const pfx = this.opts.pins.data;
      if (this.dl) this.pins.driveByte(pfx, v);
      else {
        const nib = this.readNibbleLow ? v & 0x0f : v >> 4;
        for (let i = 0; i < 4; i++) this.pins.drive(`${pfx}${4 + i}`, ((nib >> i) & 1) as Level);
      }
    } else if (!want && this.driving) {
      this.release();
    }
  }

  private release(): void {
    if (!this.driving) return;
    this.driving = false;
    this.pins.driveByte(this.opts.pins.data, null);
  }

  /** Byte presented on a read (full byte; 4-bit mode picks the nibble). */
  private readValue(cycle: number): number {
    const busy = this.isBusy(cycle);
    if (this.rsAtRise === 0) {
      const v = (busy ? 0x80 : 0) | (this.ac & 0x7f);
      this.transfers.emit({ cycle, kind: 'status', value: v, busy });
      return v;
    }
    const v = this.cg ? this.cgram[this.ac & 0x3f] : this.ddramAt(this.ac);
    this.transfers.emit({ cycle, kind: 'read', value: v, busy });
    return v;
  }

  private finishRead(cycle: number): void {
    if (!this.dl) {
      this.readNibbleLow = !this.readNibbleLow;
      if (this.readNibbleLow) return; // first nibble of the pair
    }
    if (this.rsAtRise === 1) {
      // Data read: AC moves after the read (no display shift on reads).
      this.ac = this.stepAc(this.ac, this.id ? 1 : -1);
      this.changed(cycle, 'cursor');
    }
  }

  private latchWrite(cycle: number): void {
    let v = this.pins.readByte(this.opts.pins.data);
    if (!this.dl) {
      if (!this.nibbleLow) {
        this.pendingHigh = v & 0xf0;
        this.nibbleLow = true;
        return;
      }
      this.nibbleLow = false;
      v = this.pendingHigh | (v >> 4);
    }
    const busy = this.isBusy(cycle);
    this.transfers.emit({ cycle, kind: this.rsAtRise ? 'data' : 'cmd', value: v, busy });
    if (busy) {
      this.busyViolations++;
      if (this.opts.whileBusy === 'ignore') return;
    }
    if (this.rsAtRise) this.writeData(v, cycle);
    else this.instruction(v, cycle);
  }

  // ------------------------------------------------------------------ controller

  private isBusy(cycle: number): boolean {
    return this.opts.clock.seconds(cycle) < this.busyUntil;
  }

  private setBusy(cycle: number, long: boolean): void {
    const t = this.opts.timing;
    const dur = t === 'zero' ? 0 : t === 'realistic' ? (long ? 1.52e-3 : 37e-6) : long ? t.clearHome : t.command;
    this.busyUntil = dur > 0 ? this.opts.clock.seconds(cycle) + dur : -1;
  }

  private validDd(a: number): boolean {
    return this.n ? a <= 0x27 || (a >= 0x40 && a <= 0x67) : a <= 0x4f;
  }

  private ddIndex(a: number): number {
    return this.n && a >= 0x40 ? a - 0x40 + 40 : a;
  }

  private ddramAt(a: number): number {
    // UNCERTAIN: reads of invalid DDRAM addresses return a blank.
    return this.validDd(a) ? this.ddram[this.ddIndex(a)] : 0x20;
  }

  /** Address counter step with the HD44780 wrap rules ($27->$40, $67->$00 in 2-line mode; $4F->$00 in 1-line). */
  private stepAc(a: number, dir: 1 | -1): number {
    if (this.cg) return (a + dir) & 0x3f;
    if (this.n) {
      if (dir > 0) {
        if (a === 0x27) return 0x40;
        if (a === 0x67) return 0x00;
      } else {
        if (a === 0x40) return 0x27;
        if (a === 0x00) return 0x67;
      }
    } else {
      if (dir > 0 && a === 0x4f) return 0x00;
      if (dir < 0 && a === 0x00) return 0x4f;
    }
    // UNCERTAIN: stepping through the invalid gap ($28-$3F) just counts.
    return (a + dir) & 0x7f;
  }

  private lineLen(): number {
    return this.n ? 40 : 80;
  }

  private shiftDisplay(dir: 1 | -1): void {
    const L = this.lineLen();
    this.shift = (this.shift + dir + L) % L;
  }

  private writeData(v: number, cycle: number): void {
    if (this.cg) {
      this.cgram[this.ac & 0x3f] = v & 0x1f;
      this.changed(cycle, 'cgram');
    } else {
      if (this.validDd(this.ac)) this.ddram[this.ddIndex(this.ac)] = v;
      else this.invalidAddressWrites++;
      if (this.s) this.shiftDisplay(this.id ? 1 : -1);
      this.changed(cycle, 'ddram');
    }
    this.ac = this.stepAc(this.ac, this.id ? 1 : -1);
    this.changed(cycle, 'cursor');
    this.setBusy(cycle, false);
  }

  private instruction(v: number, cycle: number): void {
    let long = false;
    if (v & 0x80) {
      this.ac = v & 0x7f;
      this.cg = false;
      this.changed(cycle, 'cursor');
    } else if (v & 0x40) {
      this.ac = v & 0x3f;
      this.cg = true;
      this.changed(cycle, 'cursor');
    } else if (v & 0x20) {
      const dl = (v & 0x10) !== 0;
      this.dl = dl;
      this.n = (v & 0x08) !== 0;
      this.f = (v & 0x04) !== 0;
      this.nibbleLow = false;
      this.readNibbleLow = false;
      if (this.shift >= this.lineLen()) this.shift %= this.lineLen();
      this.changed(cycle, 'mode');
    } else if (v & 0x10) {
      const right = (v & 0x04) !== 0;
      if (v & 0x08) this.shiftDisplay(right ? -1 : 1);
      // Cursor shift moves the AC in the RAM currently addressed (UNCERTAIN for CGRAM: the datasheet only
      // describes DDRAM; the library never shifts the cursor while addressing CGRAM).
      else this.ac = this.stepAc(this.ac, right ? 1 : -1);
      this.changed(cycle, v & 0x08 ? 'display' : 'cursor');
    } else if (v & 0x08) {
      this.d = (v & 0x04) !== 0;
      this.c = (v & 0x02) !== 0;
      this.b = (v & 0x01) !== 0;
      this.changed(cycle, 'display');
    } else if (v & 0x04) {
      this.id = (v & 0x02) !== 0;
      this.s = (v & 0x01) !== 0;
      this.changed(cycle, 'mode');
    } else if (v & 0x02) {
      this.ac = 0;
      this.cg = false;
      this.shift = 0;
      long = true;
      this.changed(cycle, 'cursor');
    } else if (v & 0x01) {
      this.ddram.fill(0x20);
      this.ac = 0;
      this.cg = false;
      this.shift = 0;
      this.id = true; // datasheet: Clear Display sets I/D=1 (S unchanged)
      long = true;
      this.changed(cycle, 'ddram');
    }
    // v === 0: no instruction (UNCERTAIN: treated as a no-op with a normal busy time).
    this.setBusy(cycle, long);
  }

  private changed(cycle: number, what: LcdChange['what']): void {
    if (this.changes.size) this.changes.emit({ cycle, what });
  }

  // ------------------------------------------------------------------ UI / test API

  /** Address counter (7 bits). */
  get addressCounter(): number {
    return this.ac;
  }

  /** BF at the given cycle (default now). */
  busy(cycle = this.opts.clock.now()): boolean {
    return this.isBusy(cycle);
  }

  get entryMode(): { increment: boolean; shift: boolean } {
    return { increment: this.id, shift: this.s };
  }

  /** Raw DDRAM byte at a DDRAM address (as the controller addresses it in the current N mode). */
  ddramByte(addr: number): number {
    return this.ddramAt(addr & 0x7f);
  }

  private codeAt(row: number, col: number): number {
    if (this.n) {
      if (row > 1) return 0x20;
      return this.ddram[row * 40 + ((col + this.shift) % 40)];
    }
    if (row > 0) return 0x20;
    return this.ddram[(col + this.shift) % 80];
  }

  /** Render a code with the A00 ROM (CGRAM glyphs as U+E000+n). */
  static charFor(code: number): string {
    return HD44780_A00[code & 0xff];
  }

  view(): LcdView {
    const { cols, rows } = this.opts;
    const codes: number[][] = [];
    const lines: string[] = [];
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) row.push(this.codeAt(r, c));
      codes.push(row);
      lines.push(this.d ? row.map((x) => HD44780_A00[x]).join('') : ' '.repeat(cols));
    }
    let cursor: LcdCursor | null = null;
    if (!this.cg && this.validDd(this.ac)) {
      const idx = this.ddIndex(this.ac);
      const L = this.lineLen();
      const row = this.n ? (idx >= 40 ? 1 : 0) : 0;
      const pos = this.n ? idx % 40 : idx;
      const col = (pos - this.shift + L) % L;
      if (row < rows && col < cols) cursor = { row, col };
    }
    const cg: number[][] = [];
    for (let g = 0; g < 8; g++) cg.push([...this.cgram.subarray(g * 8, g * 8 + 8)]);
    return {
      lines,
      codes,
      displayOn: this.d,
      cursorOn: this.c,
      blinkOn: this.b,
      cursor,
      cursorVisible: this.d && (this.c || this.b) && cursor !== null,
      cgram: cg,
      shift: this.shift,
      twoLine: this.n,
      eightBit: this.dl,
      addressCounter: this.ac,
    };
  }

  /** Visible text lines (shortcut for `view().lines`). */
  get lines(): string[] {
    return this.view().lines;
  }

  /** Blink phase (true = block shown) at simulated time `seconds`. */
  static blinkPhase(seconds: number): boolean {
    return Math.floor(seconds / HD44780_BLINK_SECONDS) % 2 === 0;
  }

  snapshot(): Hd44780Snapshot {
    return {
      ddram: [...this.ddram],
      cgram: [...this.cgram],
      ac: this.ac,
      cg: this.cg,
      id: this.id,
      s: this.s,
      d: this.d,
      c: this.c,
      b: this.b,
      dl: this.dl,
      n: this.n,
      f: this.f,
      shift: this.shift,
      busyUntil: this.busyUntil,
      nibbleLow: this.nibbleLow,
      readNibbleLow: this.readNibbleLow,
      eHigh: this.eHigh,
      rsAtRise: this.rsAtRise,
      rwAtRise: this.rwAtRise,
      pendingHigh: this.pendingHigh,
    };
  }

  restore(s: Hd44780Snapshot): void {
    this.ddram.set(s.ddram);
    this.cgram.set(s.cgram);
    Object.assign(this, {
      ac: s.ac,
      cg: s.cg,
      id: s.id,
      s: s.s,
      d: s.d,
      c: s.c,
      b: s.b,
      dl: s.dl,
      n: s.n,
      f: s.f,
      shift: s.shift,
      busyUntil: s.busyUntil,
      nibbleLow: s.nibbleLow,
      readNibbleLow: s.readNibbleLow,
    });
    this.rsAtRise = s.rsAtRise ?? 0;
    this.rwAtRise = s.rwAtRise ?? 0;
    this.pendingHigh = s.pendingHigh ?? 0;
    this.release();
    // The E pin is the physical truth (the MCU side may or may not have been restored with us).
    const cycle = this.opts.clock.now();
    const eNow = this.eLevel() === 1;
    if (eNow && !(s.eHigh ?? false)) this.eRise(cycle); // E rose since the snapshot: sample RS/RW now
    else {
      this.eHigh = eNow;
      // Mid-read snapshot with E still high: drive the bus again so the read completes normally on E falling.
      this.updateDrive(cycle);
    }
    this.changed(cycle, 'display');
  }
}



/**
 * Microchip MCP4922 dual 12-bit DAC (ME3305: SPI0, CS = PH1 active low, LDAC tied low).
 *
 * 16-bit write word, MSB first: bit15 A/B (0 = DAC A), bit14 BUF, bit13 /GA (1 = 1x, 0 = 2x), bit12 /SHDN
 * (1 = active), bits 11-0 data. The word is latched into the DAC register on the CS rising edge (LDAC low);
 * Vout = Vref * D / 4096 * gain, limited to VDD. The device has no SDO pin (MISO left open).
 * A write is one 16-bit word in a single CS frame: the config nibble, then the 12-bit data.
 */
import { ME3305 } from '@s12/devices';
import type { BoardNets, PinNet, SpiSlave } from '../pins.js';
import { Emitter, Ring, makeBoardClock, reverseBits8, watchLevel, type BoardClock } from './clock.js';

export interface Mcp4922Options {
  /** Chip-select pin (active low). Default PH1. */
  cs: string;
  /** Reference voltage on VREFA/VREFB. UNCERTAIN: 5 V (MCP4922) vs 2.048 V internal (MCP4822). */
  vrefVolts: number;
  /** Supply voltage (output clamp). UNCERTAIN: 5 V. */
  vddVolts: number;
  /** Keep a history of output changes for scope views (entries per channel, 0 = off). */
  historyLength: number;
  clock: BoardClock;
}

export interface DacChannelState {
  code: number;
  buffered: boolean;
  gain: 1 | 2;
  active: boolean;
  volts: number;
}

export interface DacChange {
  cycle: number;
  channel: 'A' | 'B';
  volts: number;
  state: DacChannelState;
}

export interface Mcp4922Snapshot {
  a: DacChannelState;
  b: DacChannelState;
}

const initial = (): DacChannelState => ({ code: 0, buffered: false, gain: 1, active: false, volts: 0 });

export class Mcp4922 implements SpiSlave {
  readonly name = 'MCP4922';
  readonly opts: Mcp4922Options;
  readonly changes = new Emitter<DacChange>();
  /** CS frames shorter than 16 bits (ignored by the device). */
  rejectedFrames = 0;
  private readonly pins: PinNet;
  private a: DacChannelState = initial();
  private b: DacChannelState = initial();
  private shift: number[] = [];
  private readonly hist: { A: Ring<[number, number]>; B: Ring<[number, number]> };
  private readonly unsub: Array<() => void> = [];

  constructor(nets: BoardNets, opts: Partial<Mcp4922Options> = {}) {
    this.pins = nets.pins;
    this.opts = {
      cs: opts.cs ?? ME3305.dac.cs,
      vrefVolts: opts.vrefVolts ?? ME3305.dac.vrefVolts,
      vddVolts: opts.vddVolts ?? 5,
      historyLength: opts.historyLength ?? 4096,
      clock: opts.clock ?? makeBoardClock(nets.pins),
    };
    this.hist = { A: new Ring(this.opts.historyLength), B: new Ring(this.opts.historyLength) };
    this.unsub.push(
      watchLevel(this.pins, this.opts.cs, (lv, cyc) => {
        if (lv === 0) this.shift = [];
        else this.latch(cyc);
      }),
    );
  }

  /** Power-on: both channels shut down, code 0 (POR state). */
  powerOn(): void {
    this.a = initial();
    this.b = initial();
    this.shift = [];
  }

  dispose(): void {
    for (const u of this.unsub.splice(0)) u();
  }

  selected(): boolean {
    return this.pins.read(this.opts.cs) === 0;
  }

  exchange(mosi: number, _cycle: number, mode: { cpol: 0 | 1; cpha: 0 | 1; lsbFirst: boolean }): number {
    // UNCERTAIN: SPI modes 0,0 and 1,1 are supported by the part; other modes are accepted without complaint.
    this.shift.push(mode.lsbFirst ? reverseBits8(mosi) : mosi & 0xff);
    return 0xff;
  }

  private latch(cycle: number): void {
    const bytes = this.shift;
    this.shift = [];
    if (bytes.length === 0) return;
    if (bytes.length < 2) {
      // UNCERTAIN: a frame shorter than 16 clocks is treated as ignored by the device.
      this.rejectedFrames++;
      return;
    }
    // MCP492x datasheet: writes are 16-bit words and clocks past the 16th are ignored, so the first two bytes are
    // used (UNCERTAIN: recalled from the datasheet text; the library always sends exactly 2 bytes).
    this.writeWord((bytes[0] << 8) | bytes[1], cycle);
  }

  /** Apply a 16-bit command word (as if latched at `cycle`). */
  writeWord(word: number, cycle = this.opts.clock.now()): void {
    const ch: 'A' | 'B' = word & 0x8000 ? 'B' : 'A';
    const st: DacChannelState = {
      code: word & 0x0fff,
      buffered: (word & 0x4000) !== 0,
      gain: word & 0x2000 ? 1 : 2,
      active: (word & 0x1000) !== 0,
      volts: 0,
    };
    st.volts = st.active ? Math.min(this.opts.vddVolts, (this.opts.vrefVolts * st.code * st.gain) / 4096) : 0;
    if (ch === 'A') this.a = st;
    else this.b = st;
    const h = this.hist[ch];
    h.push([cycle, st.volts]);
    this.changes.emit({ cycle, channel: ch, volts: st.volts, state: { ...st } });
  }

  get voltA(): number {
    return this.a.volts;
  }

  get voltB(): number {
    return this.b.volts;
  }

  channel(ch: 'A' | 'B'): DacChannelState {
    return { ...(ch === 'A' ? this.a : this.b) };
  }

  /** Output change history `[cycle, volts]` (oldest first). */
  history(ch: 'A' | 'B'): ReadonlyArray<readonly [number, number]> {
    return this.hist[ch].toArray();
  }

  clearHistory(): void {
    this.hist.A.clear();
    this.hist.B.clear();
  }

  snapshot(): Mcp4922Snapshot {
    return { a: { ...this.a }, b: { ...this.b } };
  }

  restore(s: Mcp4922Snapshot): void {
    this.a = { ...s.a };
    this.b = { ...s.b };
    this.shift = [];
  }
}

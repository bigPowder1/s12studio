/**
 * PIM (port integration module) of the MC9S12XDP512: ports T, S, M, P, H, J and AD0/AD1 ($0240-$027F), plus the
 * `GpioPort` building block shared with the MEBI core ports A/B/E/K (mebi.ts).
 *
 * Electrical model (docs/research/r2/xdp512-device.md §6, PIM_9DT256 block guide for the shared semantics):
 * - The PIM owns only the 'gpio' drive layer of the PinNet: an output (DDR=1) drives its data latch; with WOMx=1
 *   (ports S/M) a 1 is not driven (open drain). Modules that take a pin over (SPI, SCI, PWM, ECT...) drive the
 *   'periph' layer, which wins. Pins a module uses as INPUTS can be declared with `setPeripheralInputs` so the GPIO
 *   output driver is disconnected even when DDR=1.
 * - Pull devices: PERx enables, PPSx selects pull-up (0) / pull-down (1); active when the pin is an input or an
 *   open-drain output, off for push-pull outputs. Port AD has pull-ups only. Out of reset ports S and J have their
 *   pull-ups enabled (PIM_RESET_OVERRIDES), all other PIM ports have none.
 * - Reads: PTx returns the latch for DDR=1 bits and the pin level for DDR=0 bits; PTIx always returns pin levels.
 *   Port AD input bits read the pin only when the ATD digital input buffer is enabled (ATDxDIEN), else 1 (UNCERTAIN:
 *   taken from the S12 ATD PORTAD text "If the digital input buffers are disabled (IENx=0), read returns a 1").
 * - Key wake-up (ports P, H, J): an active edge on a pin (PPS=0 falling, PPS=1 rising) sets PIFx.n; PIFx is
 *   write-1-to-clear; PIEx.n & PIFx.n requests Vportp/Vporth/Vportj. Flags are set whatever PIE is. Edges are
 *   detected on the resolved pin level for inputs AND outputs (PIM_9DT256 Table 3-2 lists edge interrupts on output
 *   pins). UNCERTAIN: the digital glitch filter (pulses <= 3 bus clocks ignored, >= 4 valid) is not modelled -
 *   every edge counts immediately.
 */
import { addr, registerByName, vectorByName } from '@s12/devices';
import type { BoardNets, Level, PinNet, Pull } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

/** Range to pass to `S12XSystem.addPeripheral` ($0240-$027F). */
export const PIM_RANGE: RegisterRange = [addr('PTT'), addr('PER1AD1')];

/** IVBR-relative key-wakeup vector offsets (Vportp $8E, Vporth $CC, Vportj $CE). */
export const PIM_VECTORS = {
  P: vectorByName('Vportp')!.offset,
  H: vectorByName('Vporth')!.offset,
  J: vectorByName('Vportj')!.offset,
} as const;

/**
 * Reset values that differ from the @s12/devices register table (which has 0 for every PERx). 9S12XDP512DGV2
 * Table 2-1 "Internal Pull Resistor, Reset State": ports S and J reset with pull-UPS enabled (PERS=$FF, PERJ=$FF
 * masked to the implemented $F7, PPS=0 = pull-up); ports T, M, P, H and AD are "Disabled".
 */
export const PIM_RESET_OVERRIDES: Readonly<Record<string, number>> = { PERS: 0xff, PERJ: 0xff };

/** Mask of the implemented bits of a register, from its @s12/devices bit list ($FF when it has none). */
export function regMask(name: string): number {
  const r = registerByName(name);
  if (!r) throw new Error(`unknown register ${name}`);
  if (!r.bits || r.bits.length === 0) return 0xff;
  let m = 0;
  for (const b of r.bits) m |= ((1 << b.width) - 1) << b.bit;
  return m & 0xff;
}

/** Reset value of a register from @s12/devices. */
export function regReset(name: string): number {
  const r = registerByName(name);
  if (!r) throw new Error(`unknown register ${name}`);
  return r.reset & 0xff;
}

export type PortField = 'data' | 'input' | 'ddr' | 'rdr' | 'per' | 'pps' | 'wom' | 'pie' | 'pif';

export interface GpioPortSpec {
  /** 'T', 'S', ..., 'AD1L', 'A', 'E'. */
  id: string;
  /** Pin name per bit (index = bit); null = no pin. */
  pins: readonly (string | null)[];
  /** Implemented data bits. */
  mask: number;
  /** Writable DDR bits (default `mask`). */
  ddrMask?: number;
  /** Bits that are always inputs (DDR forced 0), e.g. PE1:0. */
  inputOnly?: number;
  /** Pull device selection: 'pps' = PPS register picks up/down, 'up' = pull-ups only. */
  pull: 'pps' | 'up';
  /** Key wake-up vector (ports P/H/J). */
  kwuVector?: number;
  /** Returns the digital-input-enable mask for the port (port AD); input bits with DIEN=0 read 1. */
  dien?: () => number;
}

export interface GpioPortHooks {
  /** Bring the owning peripheral up to date before an externally driven edge is applied. */
  sync(): void;
  /** PIE/PIF changed: re-evaluate the interrupt line. */
  irqChanged(): void;
}

export interface GpioPortState {
  data: number;
  ddr: number;
  rdr: number;
  per: number;
  pps: number;
  wom: number;
  pie: number;
  pif: number;
  levels: number;
  periphInputs: number;
}

/** One 8-bit general-purpose port on the PinNet 'gpio' layer. */
export class GpioPort {
  data = 0;
  ddr = 0;
  rdr = 0;
  per = 0;
  pps = 0;
  wom = 0;
  pie = 0;
  pif = 0;
  /** Bits whose pin a module uses as an input: the GPIO output driver is disconnected. */
  periphInputs = 0;
  /** Last resolved pin levels (key wake-up edge detection). */
  private levels = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(
    readonly spec: GpioPortSpec,
    private readonly pins: PinNet,
    private readonly hooks: GpioPortHooks,
  ) {
    if (spec.kwuVector !== undefined) {
      spec.pins.forEach((p, bit) => {
        if (p) this.unsubs.push(pins.on(p, (_n, st) => this.onPin(bit, st.level)));
      });
    }
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
  }

  get ddrMask(): number {
    return (this.spec.ddrMask ?? this.spec.mask) & ~(this.spec.inputOnly ?? 0);
  }

  /** Effective output bits (DDR=1, not input-only, not taken by a module input). */
  get outputs(): number {
    return this.ddr & this.ddrMask & ~this.periphInputs;
  }

  /** Resolved pin levels as a byte (missing pins read 0). */
  pinLevels(): number {
    let v = 0;
    this.spec.pins.forEach((p, i) => {
      if (p) v |= this.pins.read(p) << i;
    });
    return v;
  }

  /** Data-register read: latch for DDR=1 bits, pin level (gated by DIEN on port AD) for inputs. */
  readData(): number {
    const ddr = this.ddr & this.ddrMask;
    let pins = this.pinLevels();
    if (this.spec.dien) {
      const en = this.spec.dien();
      pins = (pins & en) | (~en & 0xff);
    }
    return ((this.data & ddr) | (pins & ~ddr)) & this.spec.mask;
  }

  /** Input-register (PTIx) read: always the pins. */
  readInput(): number {
    return this.pinLevels() & this.spec.mask;
  }

  /** Re-drive the 'gpio' layer and pull devices from the registers. */
  apply(): void {
    const outs = this.outputs;
    this.spec.pins.forEach((pin, bit) => {
      if (!pin) return;
      const m = 1 << bit;
      const isOut = (outs & m) !== 0;
      let drive: Level | null = null;
      if (isOut) {
        const d: Level = this.data & m ? 1 : 0;
        drive = this.wom & m && d === 1 ? null : d;
      }
      const pullOn = (this.per & m) !== 0 && (!isOut || (this.wom & m) !== 0);
      const pull: Pull = pullOn ? (this.spec.pull === 'up' || !(this.pps & m) ? 'up' : 'down') : null;
      // Order avoids transient levels (spurious key-wakeup edges): a pin that ends up undriven gets its pull
      // first; a pin that ends up driven is driven first.
      if (drive === null) {
        this.pins.setPull(pin, pull);
        this.pins.setMcuOutput(pin, null, 'gpio');
      } else {
        this.pins.setMcuOutput(pin, drive, 'gpio');
        this.pins.setPull(pin, pull);
      }
    });
  }

  /** Re-sample the pin levels without raising edges (after reset/restore). */
  resample(): void {
    this.levels = this.pinLevels();
  }

  private onPin(bit: number, level: Level): void {
    const m = 1 << bit;
    const old = this.levels & m ? 1 : 0;
    if (old === level) return;
    this.hooks.sync();
    this.levels ^= m;
    const risingSensitive = (this.pps & m) !== 0;
    if ((level === 1) === risingSensitive) {
      this.pif |= m;
      this.hooks.irqChanged();
    }
  }

  /** Key wake-up request level. */
  get irq(): boolean {
    return (this.pie & this.pif & this.spec.mask) !== 0;
  }

  snapshot(): GpioPortState {
    return {
      data: this.data,
      ddr: this.ddr,
      rdr: this.rdr,
      per: this.per,
      pps: this.pps,
      wom: this.wom,
      pie: this.pie,
      pif: this.pif,
      levels: this.levels,
      periphInputs: this.periphInputs,
    };
  }

  restore(s: GpioPortState): void {
    this.data = s.data;
    this.ddr = s.ddr;
    this.rdr = s.rdr;
    this.per = s.per;
    this.pps = s.pps;
    this.wom = s.wom;
    this.pie = s.pie;
    this.periphInputs = s.periphInputs;
    // Re-driving the pins may look like edges to the listener: flags and levels are restored afterwards.
    this.apply();
    this.pif = s.pif;
    this.levels = s.levels;
  }
}

/** Pin names `${prefix}0..7`. */
export function pinNames(prefix: string): string[] {
  return Array.from({ length: 8 }, (_, i) => `${prefix}${i}`);
}

/** Port AD pin names for channels base..base+7 ('PAD08'...). */
function adPins(base: number): string[] {
  return Array.from({ length: 8 }, (_, i) => `PAD${String(base + i).padStart(2, '0')}`);
}

/** One register of a port: which port/field and its writable mask. */
interface RegSlot {
  port: GpioPort | null;
  field: PortField | 'modrr';
  name: string;
  mask: number;
}

export interface PimOptions {
  /**
   * ATD digital input enables as a 24-bit mask, bit n = pin PADnn (ATD0DIEN -> PAD00-07, ATD1DIEN1 -> PAD08-15,
   * ATD1DIEN0 -> PAD16-23). Default: always 0 (the reset state), so port AD input bits read 1. Wire it to the ATD
   * models, or use `atdDienFromRegisters(peek)`.
   */
  atdDien?: () => number;
  /** Called after MODRR changes (route SPI/CAN pins: e.g. `() => spi.routingChanged()`). */
  onModrrChange?: (modrr: number) => void;
}

/** Build a PimOptions.atdDien source that reads the ATD DIEN registers through a side-effect-free peek. */
export function atdDienFromRegisters(peek: (addr: number) => number): () => number {
  const a0 = addr('ATD0DIEN');
  const a1lo = addr('ATD1DIEN1');
  const a1hi = addr('ATD1DIEN0');
  return () => (peek(a0) & 0xff) | ((peek(a1lo) & 0xff) << 8) | ((peek(a1hi) & 0xff) << 16);
}

export type PimPortId = 'T' | 'S' | 'M' | 'P' | 'H' | 'J' | 'AD0' | 'AD1L' | 'AD1H';

interface PimState {
  ports: Record<string, GpioPortState>;
  modrr: number;
}

export class Pim implements Peripheral {
  readonly name = 'PIM';
  private ctx: PeripheralContext | null = null;
  private readonly nets: BoardNets;
  private readonly opts: PimOptions;
  readonly ports: Readonly<Record<PimPortId, GpioPort>>;
  private readonly slots = new Map<number, RegSlot>();
  private readonly resets = new Map<number, number>();
  private modrrValue = 0;
  private readonly claims = new Map<string, Set<string>>();

  constructor(nets: BoardNets, opts: PimOptions = {}) {
    this.nets = nets;
    this.opts = opts;
    const hooks: GpioPortHooks = { sync: () => this.ctx?.sync(), irqChanged: () => this.updateIrq() };
    const dien = (shift: number) => () => ((this.opts.atdDien ? this.opts.atdDien() : 0) >> shift) & 0xff;
    const mk = (spec: GpioPortSpec) => new GpioPort(spec, nets.pins, hooks);
    const std = (x: 'T' | 'S' | 'M' | 'P' | 'H' | 'J', kwu?: number) =>
      mk({ id: x, pins: pinNames(`P${x}`).map((p, i) => (regMask(`PT${x}`) >> i) & 1 ? p : null), mask: regMask(`PT${x}`), pull: 'pps', kwuVector: kwu });
    this.ports = {
      T: std('T'),
      S: std('S'),
      M: std('M'),
      P: std('P', PIM_VECTORS.P),
      H: std('H', PIM_VECTORS.H),
      J: std('J', PIM_VECTORS.J),
      AD0: mk({ id: 'AD0', pins: adPins(0), mask: regMask('PT1AD0'), pull: 'up', dien: dien(0) }),
      AD1L: mk({ id: 'AD1L', pins: adPins(8), mask: regMask('PT1AD1'), pull: 'up', dien: dien(8) }),
      AD1H: mk({ id: 'AD1H', pins: adPins(16), mask: regMask('PT0AD1'), pull: 'up', dien: dien(16) }),
    };
    const slot = (name: string, port: GpioPort | null, field: RegSlot['field']) => {
      const a = addr(name);
      this.slots.set(a, { port, field, name, mask: regMask(name) });
      this.resets.set(a, PIM_RESET_OVERRIDES[name] ?? regReset(name));
    };
    for (const x of ['T', 'S', 'M', 'P', 'H', 'J'] as const) {
      const p = this.ports[x];
      slot(`PT${x}`, p, 'data');
      slot(`PTI${x}`, p, 'input');
      slot(`DDR${x}`, p, 'ddr');
      slot(`RDR${x}`, p, 'rdr');
      slot(`PER${x}`, p, 'per');
      slot(`PPS${x}`, p, 'pps');
      if (x === 'S' || x === 'M') slot(`WOM${x}`, p, 'wom');
      if (x === 'P' || x === 'H' || x === 'J') {
        slot(`PIE${x}`, p, 'pie');
        slot(`PIF${x}`, p, 'pif');
      }
    }
    slot('MODRR', null, 'modrr');
    const ad: Array<[GpioPort, string]> = [
      [this.ports.AD0, '1AD0'],
      [this.ports.AD1L, '1AD1'],
      [this.ports.AD1H, '0AD1'],
    ];
    for (const [p, suf] of ad) {
      slot(`PT${suf}`, p, 'data');
      slot(`DDR${suf}`, p, 'ddr');
      slot(`RDR${suf}`, p, 'rdr');
      slot(`PER${suf}`, p, 'per');
    }
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  dispose(): void {
    for (const p of Object.values(this.ports)) p.dispose();
  }

  get modrr(): number {
    return this.modrrValue;
  }

  /** Port by id. */
  port(id: PimPortId): GpioPort {
    return this.ports[id];
  }

  reset(_cause?: ResetCause): void {
    const oldModrr = this.modrrValue;
    const apply = () => {
      for (const [a, slot] of this.slots) {
        const v = this.resets.get(a)! & slot.mask;
        if (slot.field === 'modrr') this.modrrValue = v;
        else if (slot.port && slot.field !== 'input') slot.port[slot.field] = v;
      }
    };
    apply();
    for (const p of Object.values(this.ports)) p.apply();
    // Pin changes caused by re-driving may have set flags: load the reset values again, then re-sample levels.
    apply();
    for (const p of Object.values(this.ports)) p.resample();
    this.updateIrq();
    if (this.modrrValue !== oldModrr) this.opts.onModrrChange?.(this.modrrValue);
  }

  /**
   * Declare the pins module `owner` currently uses as inputs (e.g. SPI MISO, SCI RXD): their GPIO output drivers are
   * disconnected even with DDR=1. Replaces the owner's previous set.
   */
  setPeripheralInputs(owner: string, pins: Iterable<string>): void {
    this.claims.set(owner, new Set(pins));
    const all = new Set<string>();
    for (const s of this.claims.values()) for (const p of s) all.add(p);
    for (const port of Object.values(this.ports)) {
      let m = 0;
      port.spec.pins.forEach((p, i) => {
        if (p && all.has(p)) m |= 1 << i;
      });
      if (m !== port.periphInputs) {
        port.periphInputs = m;
        port.apply();
      }
    }
  }

  private updateIrq(): void {
    if (!this.ctx) return;
    for (const id of ['P', 'H', 'J'] as const) this.ctx.setInterrupt(PIM_VECTORS[id], this.ports[id].irq);
  }

  read(a: number): number {
    return this.peek(a);
  }

  peek(a: number): number {
    const slot = this.slots.get(a);
    if (!slot) return 0; // reserved addresses in the PIM block read 0
    if (slot.field === 'modrr') return this.modrrValue;
    const p = slot.port!;
    switch (slot.field) {
      case 'data':
        return p.readData();
      case 'input':
        return p.readInput();
      default:
        return p[slot.field] & slot.mask;
    }
  }

  write(a: number, v: number): void {
    const slot = this.slots.get(a);
    if (!slot) return;
    v &= slot.mask;
    if (slot.field === 'modrr') {
      if (v !== this.modrrValue) {
        this.modrrValue = v;
        this.opts.onModrrChange?.(v);
      }
      return;
    }
    const p = slot.port!;
    switch (slot.field) {
      case 'input':
        return; // read-only
      case 'pif':
        p.pif &= ~v;
        this.updateIrq();
        return;
      case 'pie':
        p.pie = v;
        this.updateIrq();
        return;
      case 'rdr':
        p.rdr = v;
        return;
      default:
        p[slot.field] = v;
        p.apply();
    }
  }

  snapshot(): unknown {
    const ports: Record<string, GpioPortState> = {};
    for (const [id, p] of Object.entries(this.ports)) ports[id] = p.snapshot();
    const s: PimState = { ports, modrr: this.modrrValue };
    return s;
  }

  restore(state: unknown): void {
    const s = state as PimState;
    for (const [id, p] of Object.entries(this.ports)) if (s.ports[id]) p.restore(s.ports[id]);
    const changed = s.modrr !== this.modrrValue;
    this.modrrValue = s.modrr;
    this.updateIrq();
    if (changed) this.opts.onModrrChange?.(this.modrrValue);
  }
}

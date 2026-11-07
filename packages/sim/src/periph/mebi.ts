/**
 * MEBI / core ports of the MC9S12XDP512 in single-chip mode: ports A, B, E, K (data + DDR), ports C/D (not bonded on
 * the 112-pin package: register storage only), PUCR, RDRIV, EBICTL0/1, ECLKCTL and IRQCR, plus the IRQ (PE1) and
 * XIRQ (PE0) interrupt pins (9S12XDP512DGV2 §2.3.20/2.3.21, Table 2-1: "PE1 IRQ ... Maskable Interrupt",
 * "PE0 XIRQ ... Non Maskable Interrupt").
 *
 * MMCCTL0 ($000A), MODE ($000B), the page registers and PARTID stay in the core bus (bus.ts); this module does not
 * claim them.
 *
 * - PUCR enables pull-UPS for a whole port's input pins (PUPAE/PUPBE/PUPEE/PUPKE; reset $D0). Pull-ups never apply
 *   to push-pull outputs. Port E: UNCERTAIN: PUPEE applies to PE7 and PE4-PE0 (PE6/PE5 are MODB/MODA with reset-only
 *   pull-downs) - from memory of the S12X MEBI text.
 * - PE1:0 are input-only (IRQ/XIRQ): DDRE1:0 read 0.
 * - ECLK: NECLK=0 puts the bus clock (divided by EDIV+1) on PE4; NCLKX2=0 puts ECLKX2 (2x bus) on PE7. The clock is
 *   not toggled on the PinNet: the pin is claimed on the 'periph' layer at a constant level (`eclkPinLevel`,
 *   UNCERTAIN, default 0) and `eclkHz`/`eclkx2Hz` report the frequency.
 * - IRQ: IRQEN=1 enables the PE1 interrupt (Virq $F2): IRQE=0 level-sensitive (requested while PE1 is low);
 *   IRQE=1 falling-edge sensitive: the edge latch holds until the IRQ vector is fetched. The core reports vector
 *   fetches through `InterruptController.onVectorTaken`; wire it to `Mebi.vectorTaken` (or call `acknowledgeIrq()`)
 *   and pass `irqEdgeClear: 'vector'`. With the default `irqEdgeClear: 'pin-high'` (UNCERTAIN fallback for an
 *   unwired system) the latch is also cleared when PE1 returns high, so a short pulse taken late is lost.
 *   IRQE is write-once in normal modes.
 * - XIRQ: requested (Vxirq $F4) while PE0 is low; the CPU's X bit masks it.
 */
import { addr, mask, vectorByName } from '@s12/devices';
import type { BoardNets, Level } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';
import { GpioPort, pinNames, regMask, regReset, type GpioPortHooks, type GpioPortState } from './pim.js';

/** Ranges to pass to `S12XSystem.addPeripheral`: $0000-$0009, $000C-$000F, $001C, $001E, $0032-$0033. */
export const MEBI_RANGES: readonly RegisterRange[] = [
  [addr('PORTA'), addr('DDRE')],
  [addr('PUCR'), addr('EBICTL1')],
  [addr('ECLKCTL'), addr('ECLKCTL')],
  [addr('IRQCR'), addr('IRQCR')],
  [addr('PORTK'), addr('DDRK')],
];

export const MEBI_VECTORS = {
  irq: vectorByName('Virq')!.offset,
  xirq: vectorByName('Vxirq')!.offset,
} as const;

export const MEBI_BITS = {
  PUPKE: mask('PUCR', 'PUPKE'),
  BKPUE: mask('PUCR', 'BKPUE'),
  PUPEE: mask('PUCR', 'PUPEE'),
  PUPDE: mask('PUCR', 'PUPDE'),
  PUPCE: mask('PUCR', 'PUPCE'),
  PUPBE: mask('PUCR', 'PUPBE'),
  PUPAE: mask('PUCR', 'PUPAE'),
  NECLK: mask('ECLKCTL', 'NECLK'),
  NCLKX2: mask('ECLKCTL', 'NCLKX2'),
  EDIV: mask('ECLKCTL', 'EDIV'),
  IRQE: mask('IRQCR', 'IRQE'),
  IRQEN: mask('IRQCR', 'IRQEN'),
} as const;
const B = MEBI_BITS;

const A = {
  PORTC: addr('PORTC'),
  PORTD: addr('PORTD'),
  DDRC: addr('DDRC'),
  DDRD: addr('DDRD'),
  PUCR: addr('PUCR'),
  RDRIV: addr('RDRIV'),
  EBICTL0: addr('EBICTL0'),
  EBICTL1: addr('EBICTL1'),
  ECLKCTL: addr('ECLKCTL'),
  IRQCR: addr('IRQCR'),
} as const;
const MASK = {
  PUCR: regMask('PUCR'),
  RDRIV: regMask('RDRIV'),
  EBICTL0: regMask('EBICTL0'),
  EBICTL1: regMask('EBICTL1'),
  ECLKCTL: regMask('ECLKCTL'),
  IRQCR: regMask('IRQCR'),
} as const;

/** IRQ is PE1, XIRQ is PE0 (9S12XDP512DGV2 §2.3.20-2.3.21). */
export const IRQ_PIN = 'PE1';
export const XIRQ_PIN = 'PE0';

/** Port E bits that PUPEE pulls up. UNCERTAIN (see header). */
export const PORTE_PULLUP_BITS = 0x9f;

export interface MebiOptions {
  /** Operating mode for the IRQE write-once rule (default 'special'; pass `() => sys.bus.opts.mode`). */
  mode?: 'special' | 'normal' | (() => 'special' | 'normal');
  /** Level shown on PE4/PE7 while ECLK/ECLKX2 are enabled (default 0). UNCERTAIN. */
  eclkPinLevel?: Level;
  /** Model the IRQ/XIRQ pin interrupts (default true). */
  irqPins?: boolean;
  /**
   * When the IRQ edge latch (IRQE=1) clears: 'vector' = only on the IRQ vector fetch (`vectorTaken`/`acknowledgeIrq`,
   * the hardware rule; requires the core hook to be wired), 'pin-high' (default) = also when PE1 returns high
   * (UNCERTAIN fallback so an unwired system cannot loop on a stale latch).
   */
  irqEdgeClear?: 'vector' | 'pin-high';
}

type MebiPortId = 'A' | 'B' | 'E' | 'K';
type Field = 'data' | 'ddr';

interface MebiState {
  ports: Record<string, GpioPortState>;
  portC: number;
  portD: number;
  ddrC: number;
  ddrD: number;
  pucr: number;
  rdriv: number;
  ebictl0: number;
  ebictl1: number;
  eclkctl: number;
  irqcr: number;
  irqcrWritten: boolean;
  irqLatch: boolean;
  /** Last seen level of the IRQ pin (PE1). */
  irqPin: Level;
}

export class Mebi implements Peripheral {
  readonly name = 'MEBI';
  private ctx: PeripheralContext | null = null;
  private readonly nets: BoardNets;
  private readonly opts: MebiOptions;
  readonly ports: Readonly<Record<MebiPortId, GpioPort>>;
  private readonly portSlots = new Map<number, [GpioPort, Field]>();
  private readonly unsubs: Array<() => void> = [];
  private st: Omit<MebiState, 'ports'> = {
    portC: 0,
    portD: 0,
    ddrC: 0,
    ddrD: 0,
    pucr: 0,
    rdriv: 0,
    ebictl0: 0,
    ebictl1: 0,
    eclkctl: 0,
    irqcr: 0,
    irqcrWritten: false,
    irqLatch: false,
    irqPin: 1,
  };

  constructor(nets: BoardNets, opts: MebiOptions = {}) {
    this.nets = nets;
    this.opts = opts;
    const hooks: GpioPortHooks = { sync: () => this.ctx?.sync(), irqChanged: () => {} };
    const mk = (id: MebiPortId, dataReg: string, ddrReg: string, inputOnly = 0) =>
      new GpioPort(
        { id, pins: pinNames(`P${id}`), mask: regMask(dataReg), ddrMask: regMask(ddrReg), inputOnly, pull: 'up' },
        nets.pins,
        hooks,
      );
    this.ports = {
      A: mk('A', 'PORTA', 'DDRA'),
      B: mk('B', 'PORTB', 'DDRB'),
      E: mk('E', 'PORTE', 'DDRE', 0x03),
      K: mk('K', 'PORTK', 'DDRK'),
    };
    for (const id of ['A', 'B', 'E', 'K'] as const) {
      this.portSlots.set(addr(`PORT${id}`), [this.ports[id], 'data']);
      this.portSlots.set(addr(`DDR${id}`), [this.ports[id], 'ddr']);
    }
    if (opts.irqPins !== false) {
      this.unsubs.push(nets.pins.on(IRQ_PIN, (_p, s) => this.onIrqPin(s.level)));
      this.unsubs.push(nets.pins.on(XIRQ_PIN, () => this.updateIrq()));
    }
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) u();
    for (const p of Object.values(this.ports)) p.dispose();
  }

  private get mode(): 'special' | 'normal' {
    const m = this.opts.mode ?? 'special';
    return typeof m === 'function' ? m() : m;
  }

  port(id: MebiPortId): GpioPort {
    return this.ports[id];
  }

  get pucr(): number {
    return this.st.pucr;
  }

  get eclkctl(): number {
    return this.st.eclkctl;
  }

  /** ECLK frequency on PE4 (0 = disabled). UNCERTAIN: EDIV n divides the bus clock by n+1. */
  get eclkHz(): number {
    if (this.st.eclkctl & B.NECLK) return 0;
    return (this.ctx ? this.ctx.busHz : 0) / ((this.st.eclkctl & B.EDIV) + 1);
  }

  /** ECLKX2 frequency on PE7 (0 = disabled). */
  get eclkx2Hz(): number {
    if (this.st.eclkctl & B.NCLKX2) return 0;
    return (this.ctx ? this.ctx.busHz : 0) * 2;
  }

  reset(_cause?: ResetCause): void {
    for (const p of Object.values(this.ports)) {
      p.data = regReset(`PORT${p.spec.id}`);
      p.ddr = regReset(`DDR${p.spec.id}`) & p.ddrMask;
      p.rdr = 0;
      p.pps = 0;
      p.wom = 0;
      p.pie = 0;
      p.pif = 0;
    }
    const s = this.st;
    s.portC = regReset('PORTC');
    s.portD = regReset('PORTD');
    s.ddrC = regReset('DDRC');
    s.ddrD = regReset('DDRD');
    s.pucr = regReset('PUCR') & MASK.PUCR;
    s.rdriv = regReset('RDRIV') & MASK.RDRIV;
    s.ebictl0 = regReset('EBICTL0') & MASK.EBICTL0;
    s.ebictl1 = regReset('EBICTL1') & MASK.EBICTL1;
    s.eclkctl = regReset('ECLKCTL') & MASK.ECLKCTL;
    s.irqcr = regReset('IRQCR') & MASK.IRQCR;
    s.irqcrWritten = false;
    s.irqLatch = false;
    this.applyAll();
    for (const p of Object.values(this.ports)) p.resample();
    s.irqPin = this.nets.pins.read(IRQ_PIN);
    this.updateIrq();
  }

  private applyPulls(): void {
    const s = this.st;
    this.ports.A.per = s.pucr & B.PUPAE ? 0xff : 0;
    this.ports.B.per = s.pucr & B.PUPBE ? 0xff : 0;
    this.ports.E.per = s.pucr & B.PUPEE ? PORTE_PULLUP_BITS : 0;
    this.ports.K.per = s.pucr & B.PUPKE ? 0xff : 0;
  }

  private applyAll(): void {
    this.applyPulls();
    for (const p of Object.values(this.ports)) p.apply();
    this.applyEclk();
  }

  private applyEclk(): void {
    const lvl = this.opts.eclkPinLevel ?? 0;
    const pins = this.nets.pins;
    pins.setMcuOutput('PE4', this.st.eclkctl & B.NECLK ? null : lvl, 'periph');
    pins.setMcuOutput('PE7', this.st.eclkctl & B.NCLKX2 ? null : lvl, 'periph');
  }

  // ------------------------------------------------------------------ IRQ / XIRQ pins

  private onIrqPin(level: Level): void {
    const s = this.st;
    if (level === s.irqPin) return;
    this.ctx?.sync();
    s.irqPin = level;
    if (level === 0) {
      if (s.irqcr & B.IRQE) s.irqLatch = true;
    } else if (this.opts.irqEdgeClear !== 'vector') {
      s.irqLatch = false; // UNCERTAIN fallback: see header
    }
    this.updateIrq();
  }

  /** The IRQ vector was taken: clear the edge latch (IRQE=1). For an integrator hook; see header. */
  acknowledgeIrq(): void {
    if (!this.st.irqLatch) return;
    this.st.irqLatch = false;
    this.updateIrq();
  }

  /** Hook for `InterruptController.onVectorTaken`: clears the IRQ edge latch when the IRQ vector is fetched. */
  vectorTaken(offset: number): void {
    if (offset === MEBI_VECTORS.irq) this.acknowledgeIrq();
  }

  private updateIrq(): void {
    if (!this.ctx || this.opts.irqPins === false) return;
    const s = this.st;
    const en = (s.irqcr & B.IRQEN) !== 0;
    const irq = en && (s.irqcr & B.IRQE ? s.irqLatch : this.nets.pins.read(IRQ_PIN) === 0);
    this.ctx.setInterrupt(MEBI_VECTORS.irq, irq);
    this.ctx.setInterrupt(MEBI_VECTORS.xirq, this.nets.pins.read(XIRQ_PIN) === 0);
  }

  // ------------------------------------------------------------------ registers

  read(a: number): number {
    return this.peek(a);
  }

  peek(a: number): number {
    const ps = this.portSlots.get(a);
    const s = this.st;
    if (ps) {
      const [p, f] = ps;
      return f === 'data' ? p.readData() : p.ddr & p.ddrMask;
    }
    switch (a) {
      case A.PORTC:
        return s.portC;
      case A.PORTD:
        return s.portD;
      case A.DDRC:
        return s.ddrC;
      case A.DDRD:
        return s.ddrD;
      case A.PUCR:
        return s.pucr;
      case A.RDRIV:
        return s.rdriv;
      case A.EBICTL0:
        return s.ebictl0;
      case A.EBICTL1:
        return s.ebictl1;
      case A.ECLKCTL:
        return s.eclkctl;
      case A.IRQCR:
        return s.irqcr;
    }
    return 0;
  }

  write(a: number, v: number): void {
    v &= 0xff;
    const s = this.st;
    const ps = this.portSlots.get(a);
    if (ps) {
      const [p, f] = ps;
      if (f === 'data') p.data = v & p.spec.mask;
      else p.ddr = v & p.ddrMask;
      p.apply();
      return;
    }
    // Ports C/D: not bonded on the 112-pin package; registers are plain storage.
    switch (a) {
      case A.PORTC:
        s.portC = v;
        return;
      case A.PORTD:
        s.portD = v;
        return;
      case A.DDRC:
        s.ddrC = v;
        return;
      case A.DDRD:
        s.ddrD = v;
        return;
      case A.PUCR:
        s.pucr = v & MASK.PUCR;
        this.applyPulls();
        for (const p of Object.values(this.ports)) p.apply();
        return;
      case A.RDRIV:
        s.rdriv = v & MASK.RDRIV;
        return;
      case A.EBICTL0:
        s.ebictl0 = v & MASK.EBICTL0;
        return;
      case A.EBICTL1:
        s.ebictl1 = v & MASK.EBICTL1;
        return;
      case A.ECLKCTL:
        s.eclkctl = v & MASK.ECLKCTL;
        this.applyEclk();
        return;
      case A.IRQCR: {
        let irqe = v & B.IRQE;
        if (this.mode === 'normal' && s.irqcrWritten) irqe = s.irqcr & B.IRQE;
        s.irqcrWritten = true;
        s.irqcr = irqe | (v & B.IRQEN);
        // Level mode has no latch; a latched edge survives an IRQCR write (nothing documents a clear).
        if (!(s.irqcr & B.IRQE)) s.irqLatch = false;
        this.updateIrq();
        return;
      }
    }
  }

  snapshot(): unknown {
    const ports: Record<string, GpioPortState> = {};
    for (const [id, p] of Object.entries(this.ports)) ports[id] = p.snapshot();
    const s: MebiState = { ...this.st, ports };
    return s;
  }

  restore(state: unknown): void {
    const { ports, ...rest } = state as MebiState & { pe0?: Level };
    // Ports first: re-driving pins/pulls can call onIrqPin, which must not overwrite the restored latch.
    for (const [id, p] of Object.entries(this.ports)) if (ports[id]) p.restore(ports[id]);
    const { pe0, ...st } = rest;
    const saved: Omit<MebiState, 'ports'> = { ...st, irqPin: st.irqPin ?? pe0 ?? 1 };
    this.st = { ...saved };
    this.applyAll();
    // applyAll may re-drive the IRQ pin (pull change): put the snapshot's latch and pin level back (same rule as
    // GpioPort.restore: restored levels avoid missed/spurious edges whatever order the board model is restored in).
    this.st.irqLatch = saved.irqLatch;
    this.st.irqPin = saved.irqPin;
    this.updateIrq();
  }
}

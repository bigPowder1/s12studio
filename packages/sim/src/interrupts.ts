/**
 * S12XINT interrupt controller core: request lines, per-vector priority levels (INT_CFADDR/INT_CFDATA),
 * IVBR, and the arbitration rule of xdp512-device.md §8 / critique C6:
 *  - XIRQ ($F4) is taken when X = 0 (non-maskable once enabled); IPL unchanged.
 *  - an I-maskable request (IRQ $F2 and $F0..$12) is taken when I = 0 and PRIOLVL > IPL;
 *    among equal levels the higher vector address wins; PRIOLVL = 0 disables the source;
 *  - RQST = 1 routes the request to XGATE (not modelled: never reaches the CPU).
 * SWI/TRAP/SYS are instruction-synchronous and handled by the CPU; resets are handled by the system.
 */

export const VEC_RESET = 0xfe;
export const VEC_CLKMON = 0xfc;
export const VEC_COP = 0xfa;
export const VEC_TRAP = 0xf8;
export const VEC_SWI = 0xf6;
export const VEC_XIRQ = 0xf4;
export const VEC_IRQ = 0xf2;
/** UNCERTAIN: SYS vector at IVBR:$12 (CPU12X RM; the device table lists $12-$5E as reserved, critique C5). */
export const VEC_SYS = 0x12;
export const VEC_SPURIOUS = 0x10;

/** Lowest/highest configurable vector offsets (INT_CFDATA). */
const CFG_MIN = 0x10;
const CFG_MAX = 0xf2;

export interface XintState {
  ivbr: number;
  cfaddr: number;
  xgprio: number;
  levels: number[];
  rqst: number[];
  pending: number[];
  override: number[];
}

export class InterruptController {
  ivbr = 0xff;
  cfaddr = 0x10;
  xgprio = 0x01;
  /** PRIOLVL per vector (index = offset >> 1). */
  readonly levels = new Uint8Array(128);
  /** RQST (route to XGATE) per vector. */
  readonly rqst = new Uint8Array(128);
  /** Request line state per vector (index = offset >> 1). */
  readonly line = new Uint8Array(128);
  /** Per-request level override (0 = use INT_CFDATA). */
  readonly override = new Uint8Array(128);
  /** Offsets with an asserted line. */
  pending: number[] = [];
  /** Level of the request chosen by the last successful `select`. */
  selectedLevel = 0;
  /** Called whenever a line is asserted (the CPU sets its attention flag). */
  onAssert: () => void = () => {};
  /** Called when a request is routed to XGATE (RQST=1), once per assertion. */
  onXgate: (offset: number) => void = () => {};
  /**
   * Called when the CPU fetches the vector of an exception at IVBR-relative `offset` (hardware interrupt, SWI, TRAP...;
   * not reset). For peripherals whose request clears on the vector fetch (e.g. the edge-sensitive IRQ pin latch).
   */
  onVectorTaken: ((offset: number) => void) | null = null;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.ivbr = 0xff;
    this.cfaddr = 0x10;
    this.xgprio = 0x01;
    this.levels.fill(0);
    for (let o = CFG_MIN; o <= CFG_MAX; o += 2) this.levels[o >> 1] = 1;
    this.rqst.fill(0);
    // Request lines are driven by peripherals, which are reset separately and re-assert as needed.
    this.line.fill(0);
    this.override.fill(0);
    this.pending = [];
  }

  request(offset: number, level?: number): void {
    const i = (offset & 0xfe) >> 1;
    this.override[i] = level ? level & 7 : 0;
    if (this.line[i]) return;
    this.line[i] = 1;
    this.pending.push(offset & 0xfe);
    if (this.rqst[i] && offset !== VEC_XIRQ) this.onXgate(offset & 0xfe);
    this.onAssert();
  }

  clear(offset: number): void {
    const i = (offset & 0xfe) >> 1;
    if (!this.line[i]) return;
    this.line[i] = 0;
    const p = this.pending;
    const k = p.indexOf(offset & 0xfe);
    if (k >= 0) p.splice(k, 1);
  }

  levelOf(offset: number): number {
    const i = (offset & 0xfe) >> 1;
    return this.override[i] || this.levels[i];
  }

  /**
   * Highest-priority request the CPU would take now, or -1. `ccr` = CCRL, `ipl` = CCRH IPL.
   * Sets `selectedLevel` (the new IPL for a maskable request).
   */
  select(ccr: number, ipl: number): number {
    const p = this.pending;
    if (p.length === 0) return -1;
    if (!(ccr & 0x40) && this.line[VEC_XIRQ >> 1]) {
      this.selectedLevel = ipl;
      return VEC_XIRQ;
    }
    if (ccr & 0x10) return -1;
    let best = -1;
    let bestLvl = 0;
    for (let k = 0; k < p.length; k++) {
      const o = p[k];
      if (o === VEC_XIRQ || o > CFG_MAX) continue;
      const i = o >> 1;
      if (this.rqst[i]) continue;
      const lvl = this.override[i] || this.levels[i];
      if (lvl <= ipl) continue;
      if (lvl > bestLvl || (lvl === bestLvl && o > best)) {
        best = o;
        bestLvl = lvl;
      }
    }
    if (best >= 0) this.selectedLevel = bestLvl;
    return best;
  }

  /** True when any line is asserted. */
  get anyPending(): boolean {
    return this.pending.length > 0;
  }

  /** Local address of a vector slot (IVBR-relative, except reset/clock monitor/COP). */
  vectorAddress(offset: number): number {
    return offset >= VEC_COP ? 0xff00 | offset : ((this.ivbr & 0xff) << 8) | offset;
  }

  // ---- registers: IVBR $0121, INT_XGPRIO $0126, INT_CFADDR $0127, INT_CFDATA0..7 $0128-$012F

  ownsRegister(addr: number): boolean {
    return addr === 0x121 || (addr >= 0x126 && addr <= 0x12f);
  }

  private cfIndex(n: number): number {
    return ((this.cfaddr & 0xf0) + 2 * n) >> 1;
  }

  readRegister(addr: number): number {
    if (addr === 0x121) return this.ivbr;
    if (addr === 0x126) return this.xgprio & 7;
    if (addr === 0x127) return this.cfaddr & 0xf0;
    if (addr >= 0x128 && addr <= 0x12f) {
      const i = this.cfIndex(addr - 0x128);
      const o = i << 1;
      // Unused / non-configurable channels read 0.
      if (o < CFG_MIN || o > CFG_MAX) return 0;
      return (this.rqst[i] ? 0x80 : 0) | (this.levels[i] & 7);
    }
    return 0;
  }

  writeRegister(addr: number, v: number): void {
    if (addr === 0x121) this.ivbr = v & 0xff;
    else if (addr === 0x126) this.xgprio = v & 7;
    else if (addr === 0x127) this.cfaddr = v & 0xf0;
    else if (addr >= 0x128 && addr <= 0x12f) {
      const i = this.cfIndex(addr - 0x128);
      const o = i << 1;
      if (o < CFG_MIN || o > CFG_MAX) return;
      // UNCERTAIN: RQST can only be set for XGATE-capable sources; not checked here.
      this.rqst[i] = v & 0x80 ? 1 : 0;
      this.levels[i] = v & 7;
      if (this.line[i]) this.onAssert();
    }
  }

  snapshot(): XintState {
    return {
      ivbr: this.ivbr,
      cfaddr: this.cfaddr,
      xgprio: this.xgprio,
      levels: [...this.levels],
      rqst: [...this.rqst],
      pending: [...this.pending],
      override: [...this.override],
    };
  }

  restore(s: XintState): void {
    this.ivbr = s.ivbr;
    this.cfaddr = s.cfaddr;
    this.xgprio = s.xgprio;
    this.levels.set(s.levels);
    this.rqst.set(s.rqst);
    this.override.set(s.override);
    this.line.fill(0);
    this.pending = [...s.pending];
    for (const o of this.pending) this.line[o >> 1] = 1;
  }
}

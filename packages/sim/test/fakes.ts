/**
 * Tiny FAKE peripherals for tests (the real CRG/ECT/SPI/PIM models come in a later milestone).
 * They exercise the framework: lazy ticking, exact access times, event scheduling and interrupts.
 */
import type { Peripheral, PeripheralContext, S12XSystem } from '@s12/sim';

/** CRG stand-in: CRGFLG.LOCK reads 1 `lockCycles` after PLLCTL.PLLON is set; PLLSEL switches the bus clock. */
export class FakeCrg implements Peripheral {
  readonly name = 'fake-crg';
  private ctx!: PeripheralContext;
  private regs = new Uint8Array(0x0c);
  private pllOnAt = -1;
  constructor(readonly lockCycles = 2000) {}
  attach(ctx: PeripheralContext) {
    this.ctx = ctx;
  }
  reset() {
    this.regs.fill(0);
    this.regs[0x3a - 0x34] = 0xf1; // PLLCTL reset
    this.pllOnAt = this.ctx ? this.ctx.now : 0;
  }
  read(a: number): number {
    if (a === 0x37) {
      const lock = this.regs[6] & 0x40 && this.pllOnAt >= 0 && this.ctx.now - this.pllOnAt >= this.lockCycles;
      return (this.regs[3] & 0xf7) | (lock ? 0x08 : 0);
    }
    return this.regs[a - 0x34];
  }
  write(a: number, v: number): void {
    if (a === 0x3a && v & 0x40 && !(this.regs[6] & 0x40)) this.pllOnAt = this.ctx.now;
    if (a === 0x34 || a === 0x35) this.pllOnAt = this.ctx.now; // re-lock after SYNR/REFDV change
    if (a === 0x39) {
      const syn = (this.regs[0] & 0x3f) + 1;
      const ref = (this.regs[1] & 0x3f) + 1;
      this.ctx.setBusClockHz(v & 0x80 ? (this.ctx.oscHz * syn) / ref : this.ctx.oscHz / 2);
    }
    this.regs[a - 0x34] = v;
  }
}

/**
 * ECT stand-in: TCNT, prescaler, TIOS, TC0..TC7 output compare by EQUALITY (TCNT == TCn on each timer tick),
 * TFLG1 (write-1-to-clear), TFFCA fast flag clear on TCn write, TIE -> channel interrupts (event-scheduled).
 */
export class FakeEct implements Peripheral {
  readonly name = 'fake-ect';
  private ctx!: PeripheralContext;
  tcnt = 0;
  private phase = 0;
  tios = 0;
  tscr1 = 0;
  tscr2 = 0;
  tflg1 = 0;
  tie = 0;
  tc = new Uint16Array(8);
  private latchLo = 0;
  /** Bus cycle at which each compare matched last (for tests). */
  readonly matchAt = new Array<number>(8).fill(-1);
  attach(ctx: PeripheralContext) {
    this.ctx = ctx;
  }
  reset() {
    this.tcnt = 0;
    this.phase = 0;
    this.tios = this.tscr1 = this.tscr2 = this.tflg1 = this.tie = 0;
    this.tc.fill(0);
  }
  private get presc(): number {
    return 1 << (this.tscr2 & 7);
  }
  private get running(): boolean {
    return (this.tscr1 & 0x80) !== 0;
  }
  tick(n: number): void {
    if (!this.running) return;
    const p = this.presc;
    const p0 = this.phase;
    const total = p0 + n;
    const ticks = Math.floor(total / p);
    this.phase = total % p;
    if (ticks === 0) return;
    const start = this.ctx.now - n; // time this advance starts from
    for (let ch = 0; ch < 8; ch++) {
      if (!(this.tios & (1 << ch))) continue;
      let d = (this.tc[ch] - this.tcnt) & 0xffff;
      if (d === 0) d = 0x10000;
      if (d <= ticks) {
        this.tflg1 |= 1 << ch;
        this.matchAt[ch] = start + d * p - p0; // cycle of the d-th timer tick
      }
    }
    this.tcnt = (this.tcnt + ticks) & 0xffff;
    this.updateIrq();
  }
  nextEventCycles(): number {
    if (!this.running) return Infinity;
    let best = Infinity;
    for (let ch = 0; ch < 8; ch++) {
      const m = 1 << ch;
      if (!(this.tios & m) || !(this.tie & m) || this.tflg1 & m) continue;
      let d = (this.tc[ch] - this.tcnt) & 0xffff;
      if (d === 0) d = 0x10000;
      best = Math.min(best, d * this.presc - this.phase);
    }
    return best;
  }
  private updateIrq() {
    for (let ch = 0; ch < 8; ch++) this.ctx.setInterrupt(0xee - 2 * ch, (this.tflg1 & this.tie & (1 << ch)) !== 0);
  }
  read(a: number): number {
    switch (a) {
      case 0x40:
        return this.tios;
      case 0x44:
        this.latchLo = this.tcnt & 0xff;
        return this.tcnt >> 8;
      case 0x45:
        return this.latchLo;
      case 0x46:
        return this.tscr1;
      case 0x4c:
        return this.tie;
      case 0x4d:
        return this.tscr2;
      case 0x4e:
        return this.tflg1;
    }
    if (a >= 0x50 && a <= 0x5f) {
      const ch = (a - 0x50) >> 1;
      return a & 1 ? this.tc[ch] & 0xff : this.tc[ch] >> 8;
    }
    return 0;
  }
  write(a: number, v: number): void {
    switch (a) {
      case 0x40:
        this.tios = v;
        return;
      case 0x46:
        this.tscr1 = v;
        return;
      case 0x4c:
        this.tie = v;
        this.updateIrq();
        return;
      case 0x4d:
        this.tscr2 = v;
        return;
      case 0x4e:
        if (!(this.tscr1 & 0x10)) this.tflg1 &= ~v;
        this.updateIrq();
        return;
    }
    if (a >= 0x50 && a <= 0x5f) {
      const ch = (a - 0x50) >> 1;
      this.tc[ch] = a & 1 ? (this.tc[ch] & 0xff00) | v : (v << 8) | (this.tc[ch] & 0xff);
      if (this.tscr1 & 0x10) this.tflg1 &= ~(1 << ch); // TFFCA: a write to TCn clears CnF
      this.updateIrq();
    }
  }
  peek(a: number): number {
    return a === 0x44 ? this.tcnt >> 8 : a === 0x45 ? this.tcnt & 0xff : this.read(a);
  }
}

/** SPI0 status stand-in: SPIF and SPTEF always set (transfers complete instantly). */
export class FakeSpi implements Peripheral {
  readonly name = 'fake-spi0';
  private regs = new Uint8Array(8);
  reset() {
    this.regs.fill(0);
  }
  read(a: number) {
    return a === 0xdb ? 0xa0 : this.regs[a - 0xd8];
  }
  write(a: number, v: number) {
    this.regs[a - 0xd8] = v;
  }
}

/** Port A/B stand-in: input pins read 0 (so the LCD busy flag reads 0). */
export class FakePorts implements Peripheral {
  readonly name = 'fake-portab';
  private regs = new Uint8Array(4);
  reset() {
    this.regs.fill(0);
  }
  read(a: number) {
    return a < 2 ? this.regs[a] & this.regs[a + 2] : this.regs[a];
  }
  write(a: number, v: number) {
    this.regs[a] = v;
  }
}

export function addLab3Fakes(s: S12XSystem): { crg: FakeCrg; ect: FakeEct } {
  const crg = new FakeCrg();
  const ect = new FakeEct();
  s.addPeripheral(crg, [[0x34, 0x3f]]);
  s.addPeripheral(ect, [[0x40, 0x7f]]);
  s.addPeripheral(new FakeSpi(), [[0xd8, 0xdf]]);
  s.addPeripheral(new FakePorts(), [[0x00, 0x03]]);
  return { crg, ect };
}

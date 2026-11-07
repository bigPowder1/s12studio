/**
 * Test helpers for the ME305 board models.
 * - `PortBench`: a PinNet-level stand-in for the MCU ports/SPI that drives the board chips with HD44780 / SPI
 *   register sequences and explicit cycle counts (no CPU).
 * - `FakePorts` / `FakeSpi0`: TEST-ONLY register-level fakes (the real PIM/SPI models are other modules) so code can
 *   run on an S12XSystem against the board models.
 * - `callRoutine`: call a routine with a return trap.
 * The helpers that link and read the private ME305 library are private too (s12studio-fixtures: tests/sim/lib-helpers.ts).
 */
import { addr } from '@s12/devices';
import type { BoardNets, Level, Peripheral, PeripheralContext, S12XSystem } from '@s12/sim';
export { hasFixtures, describeFx, itFx } from '../../formats/test/fixtures';

export const MODE0 = { cpol: 0 as const, cpha: 0 as const, lsbFirst: false };

/** Our own two-line text for `PortBench.initLcd()`. */
export const SPLASH_TEXT = ['S12 Studio LCD test: line 1 of 2 (40ch)', 'Second line, row $40: 0123456789 ABC'] as const;

/** Port letter -> pin prefix and register names. */
const PORT_REGS: Record<string, { data: string; ddr: string }> = {
  A: { data: 'PORTA', ddr: 'DDRA' },
  B: { data: 'PORTB', ddr: 'DDRB' },
  K: { data: 'PORTK', ddr: 'DDRK' },
  M: { data: 'PTM', ddr: 'DDRM' },
  P: { data: 'PTP', ddr: 'DDRP' },
  H: { data: 'PTH', ddr: 'DDRH' },
  J: { data: 'PTJ', ddr: 'DDRJ' },
};

/** MCU port model straight on the PinNet: drives `P<port><n>` from DDR/data like the PIM would. */
export class PortBench {
  t = 0;
  readonly ddr: Record<string, number> = {};
  readonly data: Record<string, number> = {};
  constructor(readonly nets: BoardNets) {
    nets.pins.now = () => this.t;
    for (const p of Object.keys(PORT_REGS)) {
      this.ddr[p] = 0;
      this.data[p] = 0;
    }
  }
  /** Advance time by `n` bus cycles. */
  wait(n: number): this {
    this.t += n;
    return this;
  }
  private apply(port: string): void {
    for (let i = 0; i < 8; i++) {
      const out = (this.ddr[port] >> i) & 1 ? (((this.data[port] >> i) & 1) as Level) : null;
      this.nets.pins.setMcuOutput(`P${port}${i}`, out);
    }
  }
  setDdr(port: string, v: number, cycles = 4): void {
    this.t += cycles;
    this.ddr[port] = v & 0xff;
    this.apply(port);
  }
  setData(port: string, v: number, cycles = 4): void {
    this.t += cycles;
    this.data[port] = v & 0xff;
    this.apply(port);
  }
  bset(port: string, m: number, cycles = 4): void {
    this.setData(port, this.data[port] | m, cycles);
  }
  bclr(port: string, m: number, cycles = 4): void {
    this.setData(port, this.data[port] & ~m, cycles);
  }
  /** Port read: output bits from the latch, input bits from the pins. */
  read(port: string, cycles = 3): number {
    this.t += cycles;
    const pins = this.nets.pins.readByte(`P${port}`);
    return ((this.data[port] & this.ddr[port]) | (pins & ~this.ddr[port])) & 0xff;
  }
  /** One SPI0 byte transfer (~96 bus cycles at SPI0BR=$50, i.e. bus/12). */
  spi(mosi: number): number {
    this.t += 96;
    return this.nets.spi.SPI0.exchange(mosi, this.t, MODE0);
  }

  // -------------------------------------------------- HD44780 on PORTB (data) and PM4/PM5/PM6 (RS/RW/E)
  /** Function-set reset pulse, no busy check: DDRB=$FF; RS=RW=E=0; E=1; PORTB=$30; E=0. */
  lcdReset(): void {
    this.setDdr('B', 0xff);
    this.bclr('M', 0x70);
    this.wait(1);
    this.bset('M', 0x40);
    this.wait(1);
    this.setData('B', 0x30, 5);
    this.bclr('M', 0x40);
  }
  /** Read cycle: DDRB=0; RW=1; E=1; read PORTB; E=0. */
  lcdRead(): number {
    this.setDdr('B', 0x00);
    this.bset('M', 0x20);
    this.wait(1);
    this.bset('M', 0x40);
    this.wait(1);
    const v = this.read('B');
    this.bclr('M', 0x40);
    return v;
  }
  /** Write cycle (RS set by the caller), then poll the busy flag; returns the number of BF polls. */
  lcdWrite(b: number): number {
    this.setDdr('B', 0xff);
    this.bclr('M', 0x20);
    this.wait(1);
    this.bset('M', 0x40);
    this.wait(2);
    this.setData('B', b, 3);
    this.wait(2);
    this.bclr('M', 0x40);
    let polls = 0;
    for (;;) {
      this.bclr('M', 0x10);
      polls++;
      if (polls > 100000) throw new Error('BF stuck');
      if ((this.lcdRead() & 0x80) === 0) break;
      this.wait(9); // poll loop overhead
    }
    this.wait(10 * 1 + 20); // ~1 us settle delay
    return polls;
  }
  lcdCommand(b: number): number {
    this.bclr('M', 0x10);
    return this.lcdWrite(b);
  }
  /** Write one character at the cursor ($08 = backspace: move the address back one). */
  outChar(b: number): void {
    if (b === 0x08) {
      const a = this.getAddr();
      this.setAddr(((a & 0x7f) - 1) & 0xff);
      return;
    }
    this.bset('M', 0x10);
    this.lcdWrite(b);
  }
  setAddr(a: number): void {
    this.lcdCommand((a | 0x80) & 0xff);
  }
  getAddr(): number {
    this.bclr('M', 0x10);
    return this.lcdRead();
  }
  outString(s: string): void {
    for (const ch of s) this.outChar(ch.charCodeAt(0));
  }
  /** HD44780 8-bit initialisation (3 resets 2 us apart, function set, display off, clear, display on), then the text. */
  initLcd(): void {
    this.setDdr('B', 0xff);
    this.setDdr('M', this.ddr.M | 0x70);
    this.setData('B', 0);
    this.bclr('M', 0x70);
    for (let i = 0; i < 3; i++) {
      this.lcdReset();
      this.wait(20);
    }
    this.lcdWrite(0x38);
    this.lcdCommand(0x08);
    this.lcdCommand(0x01);
    this.lcdCommand(0x0c);
    this.setAddr(0x00);
    this.outString(SPLASH_TEXT[0]);
    this.setAddr(0x40);
    this.outString(SPLASH_TEXT[1]);
  }
}

// ------------------------------------------------------------------ S12XSystem fakes (TEST ONLY)

/**
 * Register-level port fake for ports A, B, K (core $00-$03, $32-$33) and M, P, H, J ($250-$26F) driving the PinNet,
 * with Port J pin interrupts (PIEJ/PIFJ/PPSJ edge select) on vector $FFCE (offset $CE).
 */
export class FakePorts implements Peripheral {
  readonly name = 'fake-ports';
  ctx!: PeripheralContext;
  private regs = new Map<number, number>();
  private unsub: (() => void) | null = null;
  constructor(readonly nets: BoardNets) {}
  static ranges(): Array<[number, number]> {
    return [
      [addr('PORTA'), addr('DDRB')],
      [addr('PORTK'), addr('DDRK')],
      [addr('PTM'), addr('PTM') + 0x1f],
    ];
  }
  attach(ctx: PeripheralContext) {
    this.ctx = ctx;
    this.nets.pins.now = () => ctx.now;
    let last = this.nets.pins.read('PJ7');
    this.unsub = this.nets.pins.on('PJ7', (_p, st) => {
      if (st.level === last) return;
      last = st.level;
      const rising = (this.get('PPSJ') & 0x80) !== 0;
      if ((st.level === 1) === rising) {
        this.regs.set(addr('PIFJ'), this.get('PIFJ') | 0x80);
        this.irq();
      }
    });
  }
  dispose() {
    this.unsub?.();
  }
  private get(name: string): number {
    return this.regs.get(addr(name)) ?? 0;
  }
  private irq() {
    this.ctx.setInterrupt(0xce, (this.get('PIFJ') & this.get('PIEJ')) !== 0);
  }
  reset() {
    this.regs.clear();
    for (const p of Object.keys(PORT_REGS)) this.apply(p);
  }
  private apply(port: string) {
    const r = PORT_REGS[port];
    const ddr = this.regs.get(addr(r.ddr)) ?? 0;
    const data = this.regs.get(addr(r.data)) ?? 0;
    for (let i = 0; i < 8; i++)
      this.nets.pins.setMcuOutput(`P${port}${i}`, (ddr >> i) & 1 ? (((data >> i) & 1) as Level) : null);
  }
  read(a: number): number {
    for (const [p, r] of Object.entries(PORT_REGS)) {
      if (a === addr(r.data)) {
        const ddr = this.regs.get(addr(r.ddr)) ?? 0;
        return ((this.regs.get(a) ?? 0) & ddr) | (this.nets.pins.readByte(`P${p}`) & ~ddr & 0xff);
      }
    }
    return this.regs.get(a) ?? 0;
  }
  write(a: number, v: number): void {
    if (a === addr('PIFJ')) {
      this.regs.set(a, this.get('PIFJ') & ~v);
      this.irq();
      return;
    }
    this.regs.set(a, v);
    if (a === addr('PIEJ')) this.irq();
    for (const [p, r] of Object.entries(PORT_REGS)) if (a === addr(r.data) || a === addr(r.ddr)) this.apply(p);
  }
}

/** SPI0 fake: a DR write exchanges immediately on the SpiBus; SR always shows SPTEF, SPIF until DR is read. */
export class FakeSpi0 implements Peripheral {
  readonly name = 'fake-spi0';
  ctx!: PeripheralContext;
  private rx = 0xff;
  private spif = false;
  constructor(readonly nets: BoardNets) {}
  static ranges(): Array<[number, number]> {
    return [[addr('SPI0CR1'), addr('SPI0CR1') + 7]];
  }
  attach(ctx: PeripheralContext) {
    this.ctx = ctx;
  }
  reset() {
    this.spif = false;
  }
  read(a: number): number {
    if (a === addr('SPI0SR')) return 0x20 | (this.spif ? 0x80 : 0);
    if (a === addr('SPI0DR')) {
      this.spif = false;
      return this.rx;
    }
    return 0;
  }
  write(a: number, v: number): void {
    if (a === addr('SPI0DR')) {
      this.rx = this.nets.spi.SPI0.exchange(v, this.ctx.now, MODE0);
      this.spif = true;
    }
  }
}

/** Call a routine: push a return address pointing at a `BRA *` trap, run until the trap is reached. */
export function callRoutine(sys: S12XSystem, entry: number, regs: Partial<{ a: number; b: number; d: number; x: number }> = {}, maxCycles = 50_000_000): number {
  const TRAP = 0x7f00;
  sys.poke(TRAP, 0x20);
  sys.poke(TRAP + 1, 0xfe);
  const sp = 0x3f00 - 2;
  sys.poke(sp, TRAP >> 8);
  sys.poke(sp + 1, TRAP & 0xff);
  sys.setRegisters({ ...regs, sp, pc: entry });
  const c0 = sys.cycles;
  while (sys.registers.pc !== TRAP) {
    if (sys.cycles - c0 > maxCycles) throw new Error(`routine at ${entry.toString(16)} did not return`);
    const r = sys.step();
    if (r !== 'step') throw new Error(`halt ${r} at ${sys.registers.pc.toString(16)}`);
  }
  return sys.cycles - c0;
}

/**
 * S12XSystem: the MC9S12XDP512 full-chip simulator shell - memory, MMC/bus, XINT, CPU core and the
 * peripheral registry - with reset/step/run and the debug hooks used by @s12/debug.
 */
import { DEFAULT_DEVICE, type DeviceDescription } from '@s12/devices';
import { Bus, type BusOptions, type BusState } from './bus.js';
import { CPU_RUN, CPU_STOP, CPU_WAIT, Cpu, type CpuOptions, type CpuState } from './cpu.js';
import { loadAbs, loadSrec, type LoadResult, type SrecLoadOptions } from './loader.js';
import { Memory } from './memory.js';
import type {
  AccessTracer,
  HaltReason,
  Peripheral,
  RamInit,
  RegisterRange,
  ResetCause,
  SimEvent,
  WatchHit,
  WatchpointSpec,
} from './types.js';

export interface SystemOptions extends Partial<CpuOptions>, Partial<BusOptions> {
  device?: DeviceDescription;
  /** Oscillator frequency (Hz). Default 16 MHz (ME305 board, inferred). Bus clock starts at oscHz / 2. */
  oscHz?: number;
  /** Power-on RAM content. Default 'uninitialized' (reads 0, shown as `uu`). */
  ramInit?: RamInit;
  /** Seed for ramInit 'random'. */
  ramSeed?: number;
}

export interface Registers {
  a: number;
  b: number;
  d: number;
  x: number;
  y: number;
  sp: number;
  pc: number;
  /** CCRL (S X H I N Z V C). */
  ccr: number;
  /** CCRH IPL (0..7). */
  ipl: number;
  /** CCRW = IPL:CCRL. */
  ccrw: number;
  tmp2: number;
}

export interface SystemSnapshot {
  cpu: CpuState;
  bus: BusState;
  cycleBase: number;
}

export type CpuRunState = 'run' | 'wait' | 'stop';

export class S12XSystem {
  readonly device: DeviceDescription;
  readonly memory: Memory;
  readonly bus: Bus;
  readonly cpu: Cpu;
  readonly oscHz: number;
  /** Cycle-counter origin (resetCycleCounter). */
  private cycleBase = 0;

  constructor(opts: SystemOptions = {}) {
    this.device = opts.device ?? DEFAULT_DEVICE;
    this.oscHz = opts.oscHz ?? 16_000_000;
    this.memory = new Memory(this.device, opts.ramInit ?? 'uninitialized', opts.ramSeed);
    this.bus = new Bus(this.memory, this.device, this.oscHz, opts);
    this.cpu = new Cpu(this.bus, opts);
    this.cpu.systemReset = (cause) => this.reset(cause);
    this.reset('power-on');
    // Flash is still erased at construction: drop the inevitable "$FFFE not initialized" warning.
    this.bus.eventLog.length = 0;
  }

  // ------------------------------------------------------------------ reset / execution

  /**
   * System reset: MMC/XINT/register file and peripherals to reset values, CPU CCR=$D0, IPL=0, IVBR=$FF,
   * PC from the reset vector ($FFFE; $FFFA for COP, $FFFC for clock monitor). 'power-on' also
   * re-initialises RAM per `ramInit` and clears the `uu` shadow; other causes preserve RAM.
   */
  reset(cause: ResetCause = 'external'): void {
    if (cause === 'power-on') this.memory.powerOnRam();
    this.bus.clearWarnings();
    // The CRG comes out of reset with the PLL deselected: bus clock = oscillator / 2. A CRG model may
    // change it again from its reset() (called below) or later via ctx.setBusClockHz.
    if (this.bus.busHz !== this.oscHz / 2) this.bus.setBusClockHz(this.oscHz / 2);
    this.bus.resetMmc();
    this.bus.resetPeripherals(cause);
    this.cpu.reset(cause);
    if (cause !== 'power-on') {
      this.bus.emit({ kind: 'reset', message: `${cause} reset`, data: { cause } });
    }
  }

  /** Power-on reset (RAM content per `ramInit`, flash/EEPROM kept). */
  powerOn(): void {
    this.reset('power-on');
  }

  /** Run up to `maxCycles` bus cycles (Infinity allowed when a halt condition is expected). */
  run(maxCycles: number): HaltReason {
    return this.cpu.run(maxCycles);
  }

  /**
   * Execute one instruction (a pending interrupt is entered first). With `stopAfterException`, entering an
   * interrupt/reset ends the step at the handler's first instruction without executing it (debugger stepping).
   */
  step(opts?: { stopAfterException?: boolean }): HaltReason {
    return this.cpu.step(opts);
  }

  /** Stop a run after the current instruction (from a peripheral/tracer callback). */
  requestHalt(): void {
    this.cpu.requestHalt();
  }

  get runState(): CpuRunState {
    const s = this.cpu.state;
    return s === CPU_RUN ? 'run' : s === CPU_WAIT ? 'wait' : s === CPU_STOP ? 'stop' : 'run';
  }

  // ------------------------------------------------------------------ time

  /** Bus cycles since construction (absolute; scheduler time base). */
  get totalCycles(): number {
    return this.cpu.cycles;
  }

  /** Debugger cycle counter (resettable). */
  get cycles(): number {
    return this.cpu.cycles - this.cycleBase;
  }

  get cyclesBig(): bigint {
    return BigInt(this.cycles);
  }

  resetCycleCounter(): void {
    this.cycleBase = this.cpu.cycles;
  }

  get busHz(): number {
    return this.bus.busHz;
  }

  /** Simulated seconds since construction (integrates bus-clock changes). */
  get simTimeSeconds(): number {
    return this.bus.seconds(this.cpu.cycles);
  }

  // ------------------------------------------------------------------ peripherals / interrupts

  /** Register a peripheral on register-block address ranges (inclusive). Later registrations win. */
  addPeripheral(p: Peripheral, ranges: readonly RegisterRange[]): number {
    return this.bus.addPeripheral(p, ranges);
  }

  /** Assert an interrupt line from outside a peripheral (tests, board models). */
  requestInterrupt(vectorOffset: number, level?: number): void {
    this.bus.xint.request(vectorOffset, level);
  }

  clearInterrupt(vectorOffset: number): void {
    this.bus.xint.clear(vectorOffset);
  }

  /**
   * Route CPU writes to the flash/EEPROM arrays (for a future FTX/EETX controller model). The handler returns
   * true when it consumed the write; otherwise the write is ignored with a 'rom-write' warning.
   */
  setRomWriteHandler(fn: ((global: number, value: number) => boolean) | null): void {
    this.bus.romWriteHandler = fn;
  }

  // ------------------------------------------------------------------ registers

  get registers(): Registers {
    const c = this.cpu;
    return {
      a: c.a,
      b: c.b,
      d: c.d,
      x: c.x,
      y: c.y,
      sp: c.sp,
      pc: c.pc,
      ccr: c.ccr,
      ipl: c.ipl,
      ccrw: c.ccrw,
      tmp2: c.tmp2,
    };
  }

  setRegisters(r: Partial<Registers>): void {
    const c = this.cpu;
    if (r.d !== undefined) c.d = r.d & 0xffff;
    if (r.a !== undefined) c.a = r.a & 0xff;
    if (r.b !== undefined) c.b = r.b & 0xff;
    if (r.x !== undefined) c.x = r.x & 0xffff;
    if (r.y !== undefined) c.y = r.y & 0xffff;
    if (r.sp !== undefined) c.sp = r.sp & 0xffff;
    if (r.pc !== undefined) {
      // Moving PC cancels the "resume past the breakpoint we halted at" skip.
      if ((r.pc & 0xffff) !== c.pc) c.bpSkipPc = -1;
      c.pc = r.pc & 0xffff;
      c.ipc = c.pc;
    }
    if (r.ccrw !== undefined) c.ccrw = r.ccrw;
    if (r.ccr !== undefined) c.ccr = r.ccr & 0xff;
    if (r.ipl !== undefined) c.ipl = r.ipl & 7;
    if (r.tmp2 !== undefined) c.tmp2 = r.tmp2 & 0xffff;
  }

  // ------------------------------------------------------------------ memory (debugger view)

  /** Local -> global through the current MMC state. */
  toGlobal(local: number): number {
    return this.bus.toGlobal(local);
  }

  /** Side-effect-free read of a local address (registers via Peripheral.peek). -1 if unimplemented. */
  peek(local: number): number {
    return this.peekGlobal(this.bus.toGlobal(local));
  }

  /** Side-effect-free read of a global address; -1 if unimplemented. */
  peekGlobal(g: number): number {
    if (g >= 0 && g < 0x800) return this.bus.regPeek(g);
    const o = this.memory.offsetOf(g);
    return o >= 0 ? this.memory.mem[o] : -1;
  }

  /** Debugger write of a local address (flash/EEPROM written directly, registers via the peripheral). */
  poke(local: number, v: number): void {
    this.pokeGlobal(this.bus.toGlobal(local), v);
  }

  pokeGlobal(g: number, v: number): void {
    if (g >= 0 && g < 0x800) this.bus.regPoke(g, v & 0xff);
    else this.memory.load(g, v);
  }

  /** `uu` test for the memory window: false for never-written RAM. */
  isInitialized(local: number, space: 'local' | 'global' = 'local'): boolean {
    return this.memory.isInitialized(space === 'local' ? this.bus.toGlobal(local) : local);
  }

  /** Bytes from local memory (side-effect free); unimplemented bytes read -1. */
  readBlock(local: number, length: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < length; i++) out.push(this.peek((local + i) & 0xffff));
    return out;
  }

  // ------------------------------------------------------------------ debug hooks

  addBreakpoint(local: number, global?: number): void {
    this.cpu.addBreakpoint(local, global);
  }

  removeBreakpoint(local: number, global?: number): void {
    this.cpu.removeBreakpoint(local, global);
  }

  clearBreakpoints(): void {
    this.cpu.clearBreakpoints();
  }

  addWatchpoint(spec: WatchpointSpec): number {
    return this.bus.addWatchpoint(spec);
  }

  removeWatchpoint(id: number): boolean {
    return this.bus.removeWatchpoint(id);
  }

  get lastWatchHit(): WatchHit | null {
    return this.cpu.lastWatchHit;
  }

  /** Install (or remove with null) a data-access tracer. Slows execution while installed. */
  setTracer(t: AccessTracer | null): void {
    this.bus.setTracer(t);
  }

  onEvent(fn: (e: SimEvent) => void): () => void {
    return this.bus.onEvent(fn);
  }

  get events(): readonly SimEvent[] {
    return this.bus.eventLog;
  }

  snapshot(): SystemSnapshot {
    this.bus.syncAll(this.cpu.cycles);
    return { cpu: this.cpu.snapshot(), bus: this.bus.snapshot(), cycleBase: this.cycleBase };
  }

  restore(s: SystemSnapshot): void {
    this.cpu.restore(s.cpu);
    this.bus.restore(s.bus);
    this.cpu.direct = this.bus.direct;
    this.cycleBase = s.cycleBase;
  }

  // ------------------------------------------------------------------ loading

  /** Load a CodeWarrior `.abs` (ELF). Does not reset; call reset() afterwards to start from the reset vector. */
  loadAbs(abs: Uint8Array): LoadResult {
    return loadAbs(this.memory, abs);
  }

  loadSrec(text: string | Uint8Array, opts?: SrecLoadOptions): LoadResult {
    return loadSrec(this.memory, text, opts);
  }
}

/**
 * Public types of the simulator core: the peripheral plug-in interface, events, halt reasons.
 */

/** Why a power-on/system reset happened. Selects the reset vector ($FFFE / $FFFC / $FFFA). */
export type ResetCause = 'power-on' | 'external' | 'illegal-address' | 'cop' | 'clock-monitor' | 'software';

/** Services the system gives a peripheral (passed to `Peripheral.attach`). */
export interface PeripheralContext {
  /**
   * Current bus-cycle time. During a register access this is the exact cycle of the access inside the
   * executing instruction (instruction start + offset of its data-access cycle); during `tick(n)` it is
   * the time the peripheral is being advanced to; otherwise the CPU's current cycle count.
   */
  readonly now: number;
  /** Bus clock (Hz). Changes when a CRG model calls `setBusClockHz`. */
  readonly busHz: number;
  /** Oscillator clock (Hz). */
  readonly oscHz: number;
  /**
   * Assert the (level-sensitive) request line of the vector at IVBR-relative `vectorOffset`
   * ($F4 XIRQ, $F2 IRQ, $F0..$12 I-maskable). The priority level comes from INT_CFDATA unless
   * `level` (1..7) is given, which overrides it for this request.
   */
  requestInterrupt(vectorOffset: number, level?: number): void;
  /** De-assert the request line. */
  clearInterrupt(vectorOffset: number): void;
  /** Convenience: request when `asserted`, else clear. */
  setInterrupt(vectorOffset: number, asserted: boolean): void;
  /**
   * Bring this peripheral up to the current bus time (calls its `tick`). Call it BEFORE changing state from
   * outside a register access or tick (a board model driving a pin, a UI stimulus), then `reschedule()`.
   */
  sync(): void;
  /** The value returned by `nextEventCycles()` changed (call after an externally driven state change). */
  reschedule(): void;
  /** Request a system reset (COP, clock monitor...). Taken at the next instruction boundary. */
  requestReset(cause: ResetCause): void;
  /** Change the bus clock (CRG PLLSEL...). Affects `simTimeSeconds` from now on. */
  setBusClockHz(hz: number): void;
  /** Log a structured warning event. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Raw global memory access (no MMC, no protection): for flash/EEPROM controller models. */
  readGlobal(global: number): number;
  writeGlobal(global: number, value: number): void;
}

/**
 * A memory-mapped peripheral in the $0000-$07FF register block. Addresses passed to read/write are
 * register-block addresses (0..$7FF). Lazy, event-driven time: the system calls `tick(n)` to bring the
 * peripheral forward by exactly `n` bus cycles before every register access and whenever the deadline
 * from `nextEventCycles()` arrives, so a peripheral that is idle (or whose state can be computed on
 * demand) costs nothing per instruction but is still cycle-exact when observed.
 */
export interface Peripheral {
  readonly name: string;
  /** Called once when registered. */
  attach?(ctx: PeripheralContext): void;
  /** Reset to the device reset state. */
  reset(cause?: ResetCause): void;
  read(addr: number): number;
  write(addr: number, value: number): void;
  /** Side-effect-free read for the debugger (memory window). Defaults to `read` when absent. */
  peek?(addr: number): number;
  /** Advance internal time by `busCycles` (>= 1). */
  tick?(busCycles: number): void;
  /**
   * Bus cycles from the peripheral's current time until its next event that must be processed without
   * a register access (flag that raises an interrupt, a wake-up...). `Infinity` = idle.
   */
  nextEventCycles?(): number;
  snapshot?(): unknown;
  restore?(state: unknown): void;
}

/** Address range [start, end] (inclusive) in the register block. */
export type RegisterRange = readonly [number, number];

export type SimEventKind =
  | 'unimplemented-register'
  | 'illegal-access'
  | 'rom-write'
  | 'uninitialized-read'
  | 'uninitialized-vector'
  | 'illegal-opcode'
  | 'xgate-request'
  | 'reset'
  | 'peripheral';

export interface SimEvent {
  kind: SimEventKind;
  /** hiwave-style text, e.g. `FCS Warning (ID 12): reading from unimplemented register 0x0044 (TCNT)`. */
  message: string;
  /** Bus cycle of the event. */
  cycle: number;
  /** PC of the instruction that caused it (start address). */
  pc: number;
  /** Local (16-bit) address, when applicable. */
  address?: number;
  /** Global (23-bit) address, when applicable. */
  global?: number;
  access?: 'read' | 'write' | 'fetch';
  register?: string;
  value?: number;
  data?: Record<string, unknown>;
}

export type HaltReason =
  /** run(maxCycles) used up its budget. */
  | 'limit'
  /** Execution breakpoint before the instruction at PC. */
  | 'breakpoint'
  /** A watchpoint matched; the accessing instruction has completed. */
  | 'watchpoint'
  /** BGND executed with BDM enabled; PC is past the BGND. */
  | 'bgnd'
  /** CPU access to an unimplemented global address with `breakOnIllegalAccess`; PC = faulting instruction. */
  | 'illegal-access'
  /** CPU is in STOP mode (all clocks stopped) and nothing can wake it without an external event. */
  | 'stop'
  /** CPU is in WAI and no peripheral event is scheduled (needs an external stimulus). */
  | 'wait-idle'
  /** step() completed one instruction. */
  | 'step'
  /** An unprogrammed ($FFFF) vector was taken with `haltOnUninitializedVector`. */
  | 'uninitialized-vector'
  /** requestHalt() was called (debugger "Halt"). */
  | 'halt';

export type RamInit = 'uninitialized' | 'zero' | 'random';

export interface WatchpointSpec {
  /** Inclusive range. */
  start: number;
  end: number;
  kind: 'read' | 'write' | 'readwrite';
  /** Address space of start/end (default 'global'). 'local' ranges are translated with the page registers current when the watchpoint is added. */
  space?: 'global' | 'local';
}

export interface WatchHit {
  global: number;
  local: number;
  access: 'read' | 'write';
  value: number;
  pc: number;
  cycle: number;
}

/** Callback for memory access tracing (data accesses, not instruction fetches). */
export type AccessTracer = (
  access: 'read' | 'write',
  local: number,
  global: number,
  value: number,
  cycle: number,
) => void;

/**
 * The debug Target interface: what the hiwave-style debugger engine needs from a connection
 * (Full Chip Simulation, P&E Multilink, USBDM...). Everything is Promise-based so that a hardware
 * target that talks to a sidecar process fits the same interface as the in-process simulator.
 *
 * Addresses are 16-bit CPU ("local") addresses unless a `space: 'global'` is given; values above $FFFF
 * in a local context are CodeWarrior logical addresses ($PPAAAA = page PP of the window holding AAAA).
 */
import type { SimEvent } from '@s12/sim';

export type AddressSpace = 'local' | 'global';

/** Per-byte status in a MemoryBlock. */
export const MEM_OK = 0;
/** RAM never written since power-on (hiwave shows `uu`). */
export const MEM_UNINITIALIZED = 1;
/** No memory/register at this address (hiwave shows `--`). */
export const MEM_UNMAPPED = 2;
export type MemoryStatus = typeof MEM_OK | typeof MEM_UNINITIALIZED | typeof MEM_UNMAPPED;

export interface MemoryBlock {
  address: number;
  space: AddressSpace;
  /** Byte values (0 where status is MEM_UNMAPPED). */
  bytes: Uint8Array;
  /** MEM_OK / MEM_UNINITIALIZED / MEM_UNMAPPED per byte. */
  status: Uint8Array;
}

/** CPU register file as shown in the Register component. */
export interface RegisterSet {
  A: number;
  B: number;
  D: number;
  X: number;
  Y: number;
  SP: number;
  PC: number;
  /** CCR low byte (S X H I N Z V C). */
  CCR: number;
  /** S12X interrupt priority level (CCRH bits 2..0). */
  IPL: number;
  /** CCRW = CCRH:CCRL. */
  CCRW: number;
  /** MMC page registers (read from $0030/$0016/$0017/$0010) and DIRECT ($0011). */
  PPAGE: number;
  RPAGE: number;
  EPAGE: number;
  GPAGE: number;
  DIRECT: number;
}

export type RegisterName = keyof RegisterSet;
export const REGISTER_NAMES: readonly RegisterName[] = ['A', 'B', 'D', 'X', 'Y', 'SP', 'PC', 'CCR', 'IPL', 'CCRW', 'PPAGE', 'RPAGE', 'EPAGE', 'GPAGE', 'DIRECT'];
/** Accepted spellings (case-insensitive) -> canonical register name. hiwave shows IX/IY; the Ryerson listing uses IP for PC. */
export const REGISTER_ALIASES: Readonly<Record<string, RegisterName>> = {
  A: 'A',
  B: 'B',
  D: 'D',
  X: 'X',
  IX: 'X',
  Y: 'Y',
  IY: 'Y',
  SP: 'SP',
  PC: 'PC',
  IP: 'PC',
  CCR: 'CCR',
  CCRL: 'CCR',
  IPL: 'IPL',
  CCRH: 'IPL',
  CCRW: 'CCRW',
  PPAGE: 'PPAGE',
  RPAGE: 'RPAGE',
  EPAGE: 'EPAGE',
  GPAGE: 'GPAGE',
  DIRECT: 'DIRECT',
};

export function canonicalRegister(name: string): RegisterName | undefined {
  return REGISTER_ALIASES[name.toUpperCase()];
}

/** A program image to download. */
export interface LoadImage {
  kind: 'abs' | 'srec';
  /** .abs bytes, or S-record text/bytes. */
  data: Uint8Array | string;
  /** File name, for messages. */
  name?: string;
  /** S-records: address interpretation (see @s12/sim loadSrec). */
  srecAddressing?: 'auto' | 'logical' | 'global';
  /** S-records: offset added to every record address (hiwave `SREC file offset`). */
  srecOffset?: number;
}

export interface LoadOptions {
  /** Reset the target after loading (default true): PC from the reset vector. */
  reset?: boolean;
  /**
   * Where PC points after the load (default 'entry'): the ELF entry point (FCS stops at `Entry`, $C000 in Lab3),
   * or the reset vector. UNCERTAIN: hiwave sets PC to the ELF entry; for CodeWarrior projects both agree.
   */
  pcAfterLoad?: 'entry' | 'reset-vector';
}

export interface LoadInfo {
  entry?: number;
  segments: { address: number; global: number; size: number }[];
  /** Bytes that could not be placed. */
  skipped: number;
}

export type StepKind = 'instr' | 'over' | 'out' | 'srcLine' | 'srcOver' | 'srcOut';

export type DebugHaltReason =
  | 'breakpoint'
  | 'watchpoint'
  | 'step'
  | 'halt'
  | 'bgnd'
  | 'illegal-access'
  | 'stop'
  | 'wait-idle'
  | 'uninitialized-vector'
  | 'reset'
  | 'load'
  | 'error';

export interface HaltInfo {
  reason: DebugHaltReason;
  pc: number;
  /** Debugger cycle counter at the halt. */
  cycles: number;
  /** Breakpoint that stopped execution. */
  breakpoint?: Breakpoint;
  watchpoint?: Watchpoint;
  watchHit?: { address: number; global: number; access: 'read' | 'write'; value: number; pc: number };
  /** Which step finished (reason 'step'). */
  stepKind?: StepKind;
  /** Extra text (condition errors, illegal access...). */
  message?: string;
  /**
   * The stop is momentary: a control point whose command has the Continue flag stopped a go(); the session runs
   * the command and resumes. waitForHalt() does not resolve on it. UNCERTAIN: whether hiwave shows such stops.
   */
  transient?: boolean;
}

export interface BreakpointCounter {
  /** Counts down on each hit; the program halts when it reaches 0. */
  current: number;
  /** Reload value for permanent breakpoints (hiwave: max 2,147,483,647). */
  interval: number;
}

export interface BreakpointSpec {
  /** Local CPU address (or logical $PPAAAA). */
  address: number;
  /** Restrict to this global address (paged code). */
  global?: number;
  temporary?: boolean;
  enabled?: boolean;
  /** Condition expression (debugger expression syntax; registers also as $A, $PC...). */
  condition?: string;
  conditionEnabled?: boolean;
  /** One debugger command run when the breakpoint stops execution (G/GO/STOP not allowed). */
  command?: string;
  commandEnabled?: boolean;
  /** Continue running after the command ("Continue" checkbox). */
  commandContinue?: boolean;
  counter?: BreakpointCounter;
  /** How the user wrote the address (`&main`, `main+3`), kept for display and .BPT files. */
  label?: string;
  /** Code size of the enclosing function when set (.BPT `cdSz`). */
  codeSize?: number;
  /** .BPT `srSz`. */
  sourceSize?: number;
}

export interface Breakpoint extends BreakpointSpec {
  id: number;
  temporary: boolean;
  enabled: boolean;
  hits: number;
}

export type WatchKind = 'read' | 'write' | 'readwrite';

export interface WatchpointSpec {
  /** First address (inclusive). */
  start: number;
  /** Last address (inclusive). Default start. */
  end?: number;
  kind: WatchKind;
  space?: AddressSpace;
  enabled?: boolean;
  condition?: string;
  conditionEnabled?: boolean;
  command?: string;
  commandEnabled?: boolean;
  commandContinue?: boolean;
  counter?: BreakpointCounter;
  label?: string;
}

export interface Watchpoint extends WatchpointSpec {
  id: number;
  end: number;
  space: AddressSpace;
  enabled: boolean;
  hits: number;
}

export type TargetState = 'halted' | 'running';

/** Identifier meaning for expression evaluation (see expr.ts). */
export type IdentValue =
  | { kind: 'const'; value: number }
  | { kind: 'var'; address: number; size: number; signed?: boolean; array?: boolean }
  | { kind: 'label'; address: number }
  | { kind: 'register'; name: RegisterName };

/** Source line of an address (from the DWARF line table). */
export interface SourceLine {
  /** Line-table file (the `.dbg` path as stored in DWARF). */
  file: string;
  line: number;
  /** Start address of the line-table row. */
  address: number;
  /** End (exclusive) of the row; lets source stepping skip lookups inside one row. */
  endAddress?: number;
}

/**
 * Symbolic information the target uses for conditions and source-level stepping. Provided by the session
 * (symbols.ts + command-file variables). All members optional: without them, conditions only see registers
 * and numbers and source steps fall back to instruction steps.
 */
export interface TargetDebugInfo {
  lookup?(name: string): IdentValue | undefined;
  /** Row containing `address`, or undefined when the address has no line info. */
  lineAt?(address: number): SourceLine | undefined;
  /** Whether the source text for this address is available (library code without a .dbg file: false). */
  hasSource?(address: number): boolean;
}

export type TargetEvent =
  | { type: 'state'; state: TargetState }
  | { type: 'running'; kind: 'go' | StepKind }
  | { type: 'halted'; info: HaltInfo }
  | { type: 'output'; text: string; kind: 'normal' | 'warning' | 'error' }
  | { type: 'sim-event'; event: SimEvent }
  | { type: 'breakpoints' }
  | { type: 'watchpoints' }
  | { type: 'memory' }
  | { type: 'reset' }
  | { type: 'loaded'; info: LoadInfo };

export interface GoOptions {
  /** Start at this address (sets PC first). */
  from?: number;
  /** Stop at this address (temporary breakpoint, like "Run To Cursor"). */
  until?: number;
}

export interface Target {
  /** 'sim', 'icd12', 'usbdm'... */
  readonly kind: string;
  readonly state: TargetState;
  readonly lastHalt: HaltInfo | null;
  /** Debugger cycle counter (status bar). */
  readonly cycles: number;
  /** Bus clock (Hz). */
  readonly busHz: number;

  load(image: LoadImage, opts?: LoadOptions): Promise<LoadInfo>;
  reset(): Promise<HaltInfo>;
  /** Start running; resolves once running (the halt arrives as an event / via waitForHalt). */
  go(opts?: GoOptions): Promise<void>;
  /** Stop a running target; resolves with the halt. */
  halt(): Promise<HaltInfo>;
  /** Run one step; resolves when it completes (or is halted / hits a breakpoint). */
  step(kind: StepKind): Promise<HaltInfo>;
  /** Go with a temporary breakpoint and wait for the halt. */
  runUntil(address: number): Promise<HaltInfo>;
  /** Resolves with the next halt (immediately with lastHalt if already halted). Rejects after `timeoutMs`. */
  waitForHalt(timeoutMs?: number): Promise<HaltInfo>;
  resetCycleCounter(): void;

  readMemory(address: number, length: number, space?: AddressSpace): Promise<MemoryBlock>;
  writeMemory(address: number, bytes: ArrayLike<number>, space?: AddressSpace): Promise<void>;
  readRegisters(): Promise<RegisterSet>;
  writeRegister(name: RegisterName, value: number): Promise<void>;

  addBreakpoint(spec: BreakpointSpec): Promise<Breakpoint>;
  updateBreakpoint(id: number, patch: Partial<BreakpointSpec>): Promise<Breakpoint>;
  removeBreakpoint(id: number): Promise<boolean>;
  clearBreakpoints(): Promise<void>;
  breakpoints(): Breakpoint[];

  addWatchpoint(spec: WatchpointSpec): Promise<Watchpoint>;
  updateWatchpoint(id: number, patch: Partial<WatchpointSpec>): Promise<Watchpoint>;
  removeWatchpoint(id: number): Promise<boolean>;
  clearWatchpoints(): Promise<void>;
  watchpoints(): Watchpoint[];

  setDebugInfo(info: TargetDebugInfo | null): void;
  onEvent(fn: (e: TargetEvent) => void): () => void;
  dispose(): Promise<void>;
}

/** hiwave status-bar run-state text for a halt. UNCERTAIN: exact strings per step kind. */
export function haltStatusText(h: HaltInfo): string {
  switch (h.reason) {
    case 'breakpoint':
      return 'Breakpoint';
    case 'watchpoint':
      return 'Watchpoint';
    case 'step':
      switch (h.stepKind) {
        case 'instr':
          return 'TRACED';
        case 'out':
        case 'srcOut':
          return 'STEP OUT';
        case 'srcLine':
          return 'STEP INTO';
        default:
          return 'STEPPED';
      }
    case 'halt':
      return 'HALTED';
    case 'reset':
    case 'load':
      return 'STOPPED';
    case 'bgnd':
      return 'BGND';
    case 'illegal-access':
      return 'Illegal access';
    case 'stop':
      return 'STOP';
    case 'wait-idle':
      return 'WAIT';
    case 'uninitialized-vector':
      return 'Uninitialized vector';
    case 'error':
      return 'Error';
  }
}

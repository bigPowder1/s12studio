/**
 * Debug API (debugger window, "S12 Studio Debugger").
 *
 * The DebugSession + SimTarget + MCU model run in a worker thread (src/worker/); main forwards these calls to it
 * and relays its events. While the target runs, the worker pushes a `snapshot` event at ~30 Hz (registers, cycles,
 * run state, every watched memory range); on every halt it pushes `halted` followed by a fresh snapshot.
 *
 * Renderer components should not poll: use the hooks in src/renderer/common/s12/hooks.ts (useDebugSnapshot,
 * useMemoryWatch, useS12Event...).
 *
 * Addresses: 16-bit CPU ("local") addresses unless `space: 'global'`; values above $FFFF in local context are
 * CodeWarrior logical addresses ($PPAAAA).
 */

// ------------------------------------------------------------------------------------------------ core DTOs

export type AddressSpace = 'local' | 'global';

/** Per-byte status values in MemoryBlockInfo.status. */
export const MEM_OK = 0;
/** Never written since power-on: hiwave shows `uu`. */
export const MEM_UNINITIALIZED = 1;
/** No memory here: hiwave shows `--`. */
export const MEM_UNMAPPED = 2;

export interface MemoryBlockInfo {
  address: number;
  space: AddressSpace;
  bytes: Uint8Array;
  /** MEM_OK / MEM_UNINITIALIZED / MEM_UNMAPPED per byte. */
  status: Uint8Array;
}

export interface MemoryRange {
  address: number;
  length: number;
  space?: AddressSpace;
}

export interface RegisterSetInfo {
  A: number;
  B: number;
  D: number;
  X: number;
  Y: number;
  SP: number;
  PC: number;
  /** CCR low byte (S X H I N Z V C). */
  CCR: number;
  IPL: number;
  CCRW: number;
  PPAGE: number;
  RPAGE: number;
  EPAGE: number;
  GPAGE: number;
  DIRECT: number;
}
export type RegisterName = keyof RegisterSetInfo;
export const REGISTER_NAMES: readonly RegisterName[] = ['A', 'B', 'D', 'X', 'Y', 'SP', 'PC', 'CCR', 'IPL', 'CCRW', 'PPAGE', 'RPAGE', 'EPAGE', 'GPAGE', 'DIRECT'];

export type StepKind = 'instr' | 'over' | 'out' | 'srcLine' | 'srcOver' | 'srcOut';

export type HaltReason =
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

export interface BreakpointCounterInfo {
  current: number;
  interval: number;
}

export interface BreakpointSpecInfo {
  address: number;
  global?: number;
  temporary?: boolean;
  enabled?: boolean;
  condition?: string;
  conditionEnabled?: boolean;
  command?: string;
  commandEnabled?: boolean;
  commandContinue?: boolean;
  counter?: BreakpointCounterInfo;
  label?: string;
  codeSize?: number;
  sourceSize?: number;
}

export interface BreakpointInfo extends BreakpointSpecInfo {
  id: number;
  temporary: boolean;
  enabled: boolean;
  hits: number;
}

export type WatchKind = 'read' | 'write' | 'readwrite';

export interface WatchpointSpecInfo {
  start: number;
  end?: number;
  kind: WatchKind;
  space?: AddressSpace;
  enabled?: boolean;
  condition?: string;
  conditionEnabled?: boolean;
  command?: string;
  commandEnabled?: boolean;
  commandContinue?: boolean;
  counter?: BreakpointCounterInfo;
  label?: string;
}

export interface WatchpointInfo extends WatchpointSpecInfo {
  id: number;
  end: number;
  space: AddressSpace;
  enabled: boolean;
  hits: number;
}

export interface HaltInfoDTO {
  reason: HaltReason;
  pc: number;
  cycles: number;
  breakpoint?: BreakpointInfo;
  watchpoint?: WatchpointInfo;
  watchHit?: { address: number; global: number; access: 'read' | 'write'; value: number; pc: number };
  stepKind?: StepKind;
  message?: string;
  transient?: boolean;
}

export interface SourceLocationInfo {
  /** DWARF file path (`...\bin\main.dbg`). */
  file: string;
  line: number;
  /** Resolved on-disk path, when found. */
  path?: string;
}

/** 'none' = no session/application loaded. */
export type RunState = 'none' | 'halted' | 'running';

/** Pushed at ~30 Hz while running, and once after every halt / state change / memory write. */
export interface DebugSnapshot {
  /** Increases with every snapshot. */
  seq: number;
  state: RunState;
  /** Status-bar run-state text (RUNNING, HALTED, Breakpoint, STEPPED, TRACED...). */
  statusText: string;
  /** 64-bit cycle counter (exact up to 2^53). */
  cycles: number;
  /** Bus clock (Hz) for the status bar. */
  busHz: number;
  /** Simulated time (s). */
  simSeconds: number;
  /** Null when no session. */
  registers: RegisterSetInfo | null;
  /** Watched ranges by watch id (see watchMemory). */
  memory: Record<string, MemoryBlockInfo[]>;
  /** Last halt (absent while running). */
  halt?: HaltInfoDTO;
  /** Source location of PC when halted. */
  source?: SourceLocationInfo;
  /** Pacing of the session ('true-time' = simulated time tracks the wall clock). */ // added-by: engine
  pacing?: PacingMode; // added-by: engine
  /** True-time speed factor (simulated s per wall s requested). */ // added-by: engine
  speedFactor?: number; // added-by: engine
  /** Achieved simulated-seconds per wall-second over the last snapshot interval while running (absent when halted). */ // added-by: engine
  realTimeRatio?: number; // added-by: engine
  /** Registers whose value differs from the previous halt (red in the Register component); halted snapshots only. */ // added-by: engine
  changedRegisters?: RegisterName[]; // added-by: engine
}

// ------------------------------------------------------------------------------------------------ session

export interface LaunchRequest {
  /** Project target to debug (default: current target). Ignored with `absPath`/`iniPath`. */
  target?: string;
  /** Connection .ini; default: the project's connection, falling back to Full_Chip_Simulation.ini. */
  iniPath?: string;
  /** Application to load; default: the target's .abs. */
  absPath?: string;
  /** Load the application after opening (default true). */
  load?: boolean;
}

export interface SessionInfo {
  iniPath?: string;
  projectDir: string;
  /** [HI-WAVE] Target= (sim, icd12...). */
  connection: string;
  /** Menu title of the connection menu (e.g. "HCS12X FCS"). */
  connectionMenu: string;
  /** Layout file from the ini ([HI-WAVE] Layout=), resolved path when found. */
  layoutPath?: string;
  absPath?: string;
  derivative: string;
  /** Window title: "S12 Studio Debugger  <ini path>". */
  title: string;
  /**
   * The project's selected connection when it was replaced by Full Chip Simulation (hardware connections such as
   * P&E Multilink, Target=icd12, are not supported yet: M8). Absent when the requested connection was used.
   */ // added-by: engine
  fallbackFrom?: { name: string; target: string; iniPath?: string }; // added-by: engine
  /** Pacing the session runs with. */ // added-by: engine
  pacing?: PacingMode; // added-by: engine
}

export interface LoadRequest {
  path: string;
  /** LOAD command options (CODEONLY, SYMBOLSONLY, NOBPT, NOXPR, NOPRELOADCMD, NOPOSTLOADCMD, RUNAFTERLOAD...). */
  options?: string[];
}

export interface GoRequest {
  from?: number;
  until?: number;
}

export type PacingMode = 'true-time' | 'max';

// ------------------------------------------------------------------------------------------------ code views

export interface DisasmRequest {
  /** Start address (or the address to centre on with `before`). */
  address: number;
  /** Instructions after (and including) `address`. */
  count: number;
  /** Also decode up to this many instructions before `address` (best effort, line-table aligned). */
  before?: number;
  /** Symbolic operands ("Display Symbolic"). */
  symbolic?: boolean;
}

export interface DisasmLine {
  address: number;
  bytes: number[];
  mnemonic: string;
  operands: string;
  comment?: string;
  /** Branch/jump target when known (ABSADR column). */
  target?: number;
  /** Label at this address, if any. */
  label?: string;
  illegal?: boolean;
}

export interface SourceFileInfo {
  /** DWARF path as stored. */
  file: string;
  /** Resolved path or undefined (library modules have no source). */
  path?: string;
  module: string;
}

export interface SourceText {
  file: string;
  path: string;
  text: string;
}

export interface LineAddress {
  line: number;
  address: number;
}

export interface SymbolEntry {
  name: string;
  address: number;
  size: number;
  kind: 'func' | 'object' | 'notype';
  global: boolean;
  section?: string;
  module?: string;
}

// ------------------------------------------------------------------------------------------------ data / procedure

export interface ExpressionItem {
  expression: string;
  /** Data component the expression belongs to ('Data', 'Data:2'...). */
  component: string;
}

export interface EvalResult {
  expression: string;
  value?: number;
  error?: string;
}

export interface VariableEntry {
  name: string;
  address: number;
  byteSize: number;
  typeName: string;
  signed: boolean;
  arrayLength?: number;
  module?: string;
}

export interface FrameInfo {
  level: number;
  /** Procedure name (label) or hex address. */
  name: string;
  pc: number;
  source?: SourceLocationInfo;
}

// ------------------------------------------------------------------------------------------------ command / UI

export type OutputKind = 'echo' | 'normal' | 'error' | 'warning';

export interface OutputLineInfo {
  text: string;
  kind: OutputKind;
}

/** A window/layout command from the interpreter (OPEN, ACTIVATE, ATTRIBUTES, SPC, SMEM...). */
export interface UiCommandInfo {
  component?: string;
  keyword: string;
  argText: string;
  raw: string;
}

export interface PromptRequest {
  id: number;
  title: string;
  variable: string;
  defaultValue: number;
  text: string;
}

// ------------------------------------------------------------------------------------------------ API

export interface DebugApi {
  /**
   * Project > Debug (IDE window) or File > Open Configuration: open the debugger window (or focus it), start a
   * session for the connection .ini and load the application.
   */
  launch(req?: LaunchRequest): Promise<SessionInfo>;
  /** Current session or null. */
  session(): Promise<SessionInfo | null>;
  /** End the session (debugger window closing). */
  closeSession(): Promise<void>;
  loadApplication(req: LoadRequest): Promise<void>;
  /** One status snapshot now (also pushed as events). */
  snapshot(): Promise<DebugSnapshot>;

  // run control
  go(req?: GoRequest): Promise<void>;
  halt(): Promise<HaltInfoDTO | null>;
  step(kind: StepKind): Promise<HaltInfoDTO>;
  /** Target reset + RESET hook (Connection menu > Reset). */
  reset(): Promise<void>;
  /** Run > Restart: reload/reset and run from the entry. */
  restart(): Promise<void>;
  runTo(address: number): Promise<HaltInfoDTO>;
  resetCycles(): Promise<void>;
  setPacing(mode: PacingMode, speedFactor?: number): Promise<void>;

  // registers
  readRegisters(): Promise<RegisterSetInfo>;
  writeRegister(name: RegisterName, value: number): Promise<void>;

  // memory
  readMemory(range: MemoryRange): Promise<MemoryBlockInfo>;
  writeMemory(address: number, bytes: number[] | Uint8Array, space?: AddressSpace): Promise<void>;
  fillMemory(start: number, end: number, value: number, space?: AddressSpace): Promise<void>;
  /** Include these ranges in every snapshot under `memory[watchId]` (replaces the watch's ranges). */
  watchMemory(watchId: string, ranges: MemoryRange[]): Promise<void>;
  unwatchMemory(watchId: string): Promise<void>;

  // code / symbols
  disassemble(req: DisasmRequest): Promise<DisasmLine[]>;
  sourceFiles(): Promise<SourceFileInfo[]>;
  readSource(file: string): Promise<SourceText>;
  /** Lines of a source file that have code (breakpoint marks), with their first address. */
  lineAddresses(file: string): Promise<LineAddress[]>;
  sourceLocation(address: number): Promise<SourceLocationInfo | null>;
  symbols(): Promise<SymbolEntry[]>;
  /** Address of a symbol or expression, or null. */
  resolve(expression: string): Promise<number | null>;

  // control points
  breakpoints(): Promise<BreakpointInfo[]>;
  setBreakpoint(spec: BreakpointSpecInfo): Promise<BreakpointInfo>;
  updateBreakpoint(id: number, patch: Partial<BreakpointSpecInfo>): Promise<BreakpointInfo>;
  removeBreakpoint(id: number): Promise<boolean>;
  clearBreakpoints(): Promise<void>;
  watchpoints(): Promise<WatchpointInfo[]>;
  setWatchpoint(spec: WatchpointSpecInfo): Promise<WatchpointInfo>;
  updateWatchpoint(id: number, patch: Partial<WatchpointSpecInfo>): Promise<WatchpointInfo>;
  removeWatchpoint(id: number): Promise<boolean>;
  clearWatchpoints(): Promise<void>;

  // command window
  /** Execute a command line as typed at `in>`; resolves false on error. */
  exec(line: string, opts?: { echo?: boolean }): Promise<boolean>;
  /** Execute a command file (Command > Execute File...). */
  execFile(path: string): Promise<boolean>;
  /** Answer a `prompt` event (DEFINEVALUEDLG). undefined keeps the default. */
  answerPrompt(id: number, value?: number): Promise<void>;

  // data / procedure
  expressions(): Promise<ExpressionItem[]>;
  addExpression(expression: string, component?: string): Promise<void>;
  removeExpression(expression: string): Promise<void>;
  saveExpressions(): Promise<void>;
  evaluate(expressions: string[]): Promise<EvalResult[]>;
  globals(): Promise<VariableEntry[]>;
  callStack(): Promise<FrameInfo[]>;

  // terminal (SCI)
  sciSend(channel: number, data: number[] | string): Promise<void>;
}

export interface DebugEvents {
  /** Session opened/changed (title, connection). null = closed. */
  session: SessionInfo | null;
  /** Throttled status/registers/watched memory. */
  snapshot: DebugSnapshot;
  running: { kind: 'go' | StepKind };
  halted: { info: HaltInfoDTO; source?: SourceLocationInfo };
  /** Application loaded (symbols changed: reload source/assembly/data). */
  loaded: { absPath: string };
  /** Command window output (batched). */
  output: OutputLineInfo[];
  /** CLR command. */
  clearOutput: Record<string, never>;
  breakpoints: BreakpointInfo[];
  watchpoints: WatchpointInfo[];
  expressions: ExpressionItem[];
  /** Layout/window command for the shell (OPEN, ACTIVATE...) or a component (`Memory < SMEM ...`). */
  uiCommand: UiCommandInfo;
  /** DEFINEVALUEDLG: answer with answerPrompt(). */
  prompt: PromptRequest;
  /** Bytes transmitted by an SCI (Terminal component). */
  sciOutput: { channel: number; data: number[] };
  /** The engine host crashed or exited unexpectedly. */
  engineError: { message: string };
  /** User-facing notice from the engine/host (e.g. hardware connection replaced by Full Chip Simulation). */ // added-by: engine
  notice: { kind: 'hardware-fallback' | 'info' | 'warning'; message: string }; // added-by: engine
  /**
   * The application loaded in the session was rebuilt by Make while debugging: offer "reload" (call
   * loadApplication({ path: absPath })). Sent to the debugger window.
   */ // added-by: engine
  applicationRebuilt: { absPath: string; target: string }; // added-by: engine
}

export const DEBUG_METHODS = [
  'launch',
  'session',
  'closeSession',
  'loadApplication',
  'snapshot',
  'go',
  'halt',
  'step',
  'reset',
  'restart',
  'runTo',
  'resetCycles',
  'setPacing',
  'readRegisters',
  'writeRegister',
  'readMemory',
  'writeMemory',
  'fillMemory',
  'watchMemory',
  'unwatchMemory',
  'disassemble',
  'sourceFiles',
  'readSource',
  'lineAddresses',
  'sourceLocation',
  'symbols',
  'resolve',
  'breakpoints',
  'setBreakpoint',
  'updateBreakpoint',
  'removeBreakpoint',
  'clearBreakpoints',
  'watchpoints',
  'setWatchpoint',
  'updateWatchpoint',
  'removeWatchpoint',
  'clearWatchpoints',
  'exec',
  'execFile',
  'answerPrompt',
  'expressions',
  'addExpression',
  'removeExpression',
  'saveExpressions',
  'evaluate',
  'globals',
  'callStack',
  'sciSend',
] as const;

/** Methods main handles itself; every other DEBUG_METHODS entry is forwarded to the engine worker. */
export const DEBUG_MAIN_METHODS = ['launch'] as const;

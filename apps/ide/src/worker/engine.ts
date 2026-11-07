/**
 * DebugEngine: the debugger back end hosted in the worker thread. Owns one DebugSession over a SimTarget on the full
 * MC9S12XDP512 + ME305 model, implements the DebugApi/BoardApi methods (minus main-only ones) and pushes events.
 *
 * Transport-agnostic: `call(method, args)` + an `emit` callback, so it is unit-tested directly (no thread).
 * Snapshot policy: while running (go or any step), a timer emits `debug.snapshot` + `board.state` at `snapshotHz`; every halt,
 * load, reset, register/memory write and watch change emits one immediately.
 */
import { DebugSession, SimTarget, haltStatusText, type RegisterSet, mcuSystemFactory, nodeFileSystem, resolvePathCI, type HaltInfo, type McuSystemFactory, type SessionEvent, type TargetEvent, type UiHandler } from '@s12/debug';
import { parseIni } from '@s12/formats';
import { bufferReader, decode } from '@s12/isa';
import { ApiError } from '../shared/api/common';
import type {
  BreakpointSpecInfo,
  DebugSnapshot,
  DisasmLine,
  DisasmRequest,
  FrameInfo,
  HaltInfoDTO,
  MemoryBlockInfo,
  MemoryRange,
  OutputLineInfo,
  PacingMode,
  RegisterName,
  RegisterSetInfo,
  RunState,
  SessionInfo,
  SourceLocationInfo,
  StepKind,
  WatchpointSpecInfo,
} from '../shared/api/debug';
import type { BoardState, KeyDef } from '../shared/api/board';
import type { OpenSessionRequest } from './protocol';
import { unwindStack } from './call-stack';

export type EmitFn = (domain: 'debug' | 'board', event: string, payload: unknown) => void;

export interface DebugEngineOptions {
  /** Timer functions (tests). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  /** Use 'max' pacing regardless of the request (tests). */
  forcePacing?: 'max' | 'true-time';
  /** Wall clock in ms (tests; real-time ratio). */
  now?: () => number;
}

const TITLE = 'S12 Studio Debugger';
// UNCERTAIN: hiwave's FCS menu title for S12X derivatives ("HCS12X FCS" by analogy with "HCS12 FCS").
const CONNECTION_MENUS: Record<string, string> = { sim: 'HCS12X FCS', icd12: 'MultilinkCyclonePro', hcs12serialmon: 'MONITOR-HCS12' };
const DERIVATIVE = 'MC9S12XDP512';
/** End of the notice shown when a hardware connection is replaced by Full Chip Simulation. */
export const HARDWARE_FALLBACK_MESSAGE = 'S12 Studio runs it in Full Chip Simulation.';
/**
 * Shown (command window + `debug.notice`) the first time a project's hardware connection (P&E Multilink, Target=icd12)
 * is replaced by Full Chip Simulation in this app run. Information, not a warning: course projects select the real
 * board and nothing is wrong with them.
 */
export function hardwareFallbackMessage(name: string): string {
  return `Note: this project's connection is ${name.replace(/_/g, ' ')} (real board). ${HARDWARE_FALLBACK_MESSAGE}`;
}
/** ATD analog input pins per module (see @s12/sim atdDefaultPins): ATD0 AN0-7 = PAD00-07, ATD1 AN0-15 = PAD08-23. */
const ATD_CHANNELS = [8, 16] as const;
const atdPin = (atd: 0 | 1, ch: number): string => `PAD${String((atd === 0 ? 0 : 8) + ch).padStart(2, '0')}`;
const stemOf = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.ini$/i, '');
const REG_KEYS: readonly RegisterName[] = ['A', 'B', 'D', 'X', 'Y', 'SP', 'PC', 'CCR', 'IPL', 'CCRW', 'PPAGE', 'RPAGE', 'EPAGE', 'GPAGE', 'DIRECT'];

type Handler = (...args: never[]) => unknown;

export class DebugEngine {
  session: DebugSession | null = null;
  private target: SimTarget | null = null;
  private factory: McuSystemFactory | null = null;
  private info: SessionInfo | null = null;
  private watches = new Map<string, MemoryRange[]>();
  private seq = 0;
  /** Projects (dir|connection) whose hardware-fallback notice was already shown. */
  private readonly fallbackNoticed = new Set<string>();
  private boardSeq = 0;
  private timer: unknown = null;
  private snapshotHz = 30;
  private outBuf: OutputLineInfo[] = [];
  private outScheduled = false;
  private prompts = new Map<number, (v: number | undefined) => void>();
  private promptSeq = 0;
  private sciUnsubs: (() => void)[] = [];
  /** SCI bytes transmitted since the last flush, per channel (batched like command output). */
  private sciBuf = new Map<number, number[]>();
  private sciScheduled = false;
  /** Sources that could not be found (`<abs>|<file>`), cleared with each session and load. */
  private missingSources = new Set<string>();
  /** Registers at the last and the previous halt (changed-since-last-halt highlighting). */
  private haltRegs: RegisterSet | null = null;
  private prevHaltRegs: RegisterSet | null = null;
  /** Nothing ran since the last reset/load: the stack holds the previous run's leftovers (reset keeps SP and RAM). */
  private noRunSinceReset = true;
  /** Real-time ratio measurement while running. */
  private rate: { sim: number; wall: number; ratio?: number } | null = null;
  private readonly now: () => number;
  private readonly handlers: Record<string, Handler>;

  constructor(
    private readonly emit: EmitFn,
    private readonly opts: DebugEngineOptions = {},
  ) {
    this.handlers = this.buildHandlers();
    this.now = opts.now ?? (() => performance.now());
  }

  /** The simulated MCU of the session (tests, stimulus). */
  get mcu() {
    return this.factory?.mcu ?? null;
  }

  get simTarget(): SimTarget | null {
    return this.target;
  }

  /** Dispatch `<domain>.<method>`. Unknown methods reject with 'not-implemented'. */
  async call(method: string, args: unknown[]): Promise<unknown> {
    const h = this.handlers[method];
    if (!h) throw new ApiError('not-implemented', `${method} is not implemented in the debug engine yet`);
    return await (h as (...a: unknown[]) => unknown)(...args);
  }

  has(method: string): boolean {
    return method in this.handlers;
  }

  // ------------------------------------------------------------------------------------------ session

  /** Session open/close run one at a time (the worker handles messages concurrently: Debug pressed twice). */
  private lifecycle: Promise<unknown> = Promise.resolve();
  /** The open in flight; an identical request (a double click) joins it instead of opening a second session. */
  private pendingOpen: { key: string; p: Promise<SessionInfo> } | null = null;

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.catch(() => undefined).then(fn);
    this.lifecycle = next;
    return next;
  }

  openSession(req: OpenSessionRequest): Promise<SessionInfo> {
    const key = JSON.stringify(req);
    if (this.pendingOpen?.key === key) return this.pendingOpen.p;
    const entry = { key, p: this.serial(() => this.doOpenSession(req)) };
    this.pendingOpen = entry;
    const clear = () => {
      if (this.pendingOpen === entry) this.pendingOpen = null;
    };
    entry.p.then(clear, clear);
    return entry.p;
  }

  private async doOpenSession(req: OpenSessionRequest): Promise<SessionInfo> {
    await this.doCloseSession();
    this.snapshotHz = Math.min(120, Math.max(1, req.snapshotHz ?? 30));
    const factory = mcuSystemFactory({}, (mcu) => {
      for (const u of this.sciUnsubs) u();
      this.sciUnsubs = [];
      const scis = [mcu.periph.sci0, mcu.periph.sci1, mcu.periph.sci2, mcu.periph.sci3, mcu.periph.sci4, mcu.periph.sci5];
      scis.forEach((sci, channel) => this.sciUnsubs.push(sci.onTransmit((byte) => this.queueSci(channel, byte))));
    });
    const target = new SimTarget({ createSystem: factory.createSystem, pacing: this.opts.forcePacing ?? req.pacing ?? 'true-time', speedFactor: req.speedFactor ?? 1 });
    const ui: UiHandler = {
      command: (c) => this.emit('debug', 'uiCommand', { component: c.component, keyword: c.keyword, argText: c.argText, raw: c.raw }),
      clear: () => this.emit('debug', 'clearOutput', {}),
      defineValueDialog: (title, variable, defaultValue, text) =>
        new Promise<number | undefined>((resolve) => {
          const id = ++this.promptSeq;
          this.prompts.set(id, resolve);
          this.emit('debug', 'prompt', { id, title, variable, defaultValue, text });
        }),
    };
    const common = { fs: nodeFileSystem, createTarget: () => target, ui, compilerDir: req.compilerDir };
    let session: DebugSession;
    if (req.iniPath) {
      const ini = parseIni(new TextDecoder('latin1').decode(await nodeFileSystem.readFile(req.iniPath)));
      session = new DebugSession({ ...common, ini, iniPath: req.iniPath, projectDir: req.projectDir });
    } else session = new DebugSession({ ...common, projectDir: req.projectDir });
    this.session = session;
    this.target = target;
    this.factory = factory;
    this.haltRegs = this.prevHaltRegs = null;
    session.onEvent((e) => this.onSessionEvent(e));
    // UNCERTAIN/TEMPORARY (until M8 hardware): a hardware connection runs as Full Chip Simulation - either replaced
    // by the project's FCS .ini in main (fallbackFrom), or (no project) its own .ini on the simulator.
    const fallback = req.fallbackFrom ?? (session.connection.toLowerCase() !== 'sim' ? { name: stemOf(req.iniPath ?? session.connection), target: session.connection } : undefined);
    for (const note of req.notes ?? []) session.print(note);
    // once per project and connection while this engine (the app run) lives; SessionInfo.fallbackFrom says it every time
    const noticeKey = fallback ? `${req.projectDir.replace(/\\/g, '/').toLowerCase()}|${fallback.name.toLowerCase()}` : undefined;
    if (fallback && noticeKey && !this.fallbackNoticed.has(noticeKey)) {
      this.fallbackNoticed.add(noticeKey);
      const message = hardwareFallbackMessage(fallback.name);
      session.print(message);
      this.emit('debug', 'notice', { kind: 'hardware-fallback', message });
    }
    await session.connect();
    const layoutPath = session.layout ? await this.resolveInProject(session.layout) : undefined;
    this.info = {
      iniPath: req.iniPath,
      projectDir: req.projectDir,
      connection: session.connection,
      connectionMenu: CONNECTION_MENUS[session.connection.toLowerCase()] ?? session.connection,
      layoutPath,
      derivative: DERIVATIVE,
      title: req.iniPath ? `${TITLE}  ${req.iniPath}` : TITLE,
      fallbackFrom: fallback ? { ...fallback } : undefined,
      pacing: target.pacing,
    };
    const info = this.info;
    this.emit('debug', 'session', info);
    if (req.absPath && req.load !== false) await this.loadApplication({ path: req.absPath }, session);
    else this.pushSnapshot();
    return info;
  }

  private async resolveInProject(rel: string): Promise<string | undefined> {
    return resolvePathCI(nodeFileSystem, this.session!.projectDir, rel);
  }

  closeSession(): Promise<void> {
    return this.serial(() => this.doCloseSession());
  }

  private async doCloseSession(): Promise<void> {
    this.stopTimer();
    this.missingSources.clear();
    this.flushSci();
    for (const u of this.sciUnsubs) u();
    this.sciUnsubs = [];
    for (const r of this.prompts.values()) r(undefined);
    this.prompts.clear();
    const s = this.session;
    this.session = null;
    this.target = null;
    this.factory = null;
    this.info = null;
    if (s) {
      await s.dispose().catch(() => undefined);
      this.emit('debug', 'session', null);
    }
  }

  private requireSession(): DebugSession {
    if (!this.session) throw new ApiError('no-session', 'no debug session');
    return this.session;
  }

  private requireTarget(): SimTarget {
    if (!this.target) throw new ApiError('no-session', 'no debug session');
    return this.target;
  }

  async loadApplication(req: { path: string; options?: string[] }, session?: DebugSession): Promise<void> {
    const s = session ?? this.requireSession();
    this.missingSources.clear();
    if (req.options?.length) await s.load(req.path, req.options);
    else await s.loadApplication(req.path);
    if (s !== this.session) return; // replaced meanwhile
    if (this.info) {
      this.info.absPath = s.absPath;
      this.emit('debug', 'session', { ...this.info });
    }
    this.haltRegs = this.prevHaltRegs = this.target ? { ...this.target.registersSync() } : null;
    this.pushSnapshot();
  }

  // ------------------------------------------------------------------------------------------ events

  private onSessionEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'output':
        this.queueOutput({ text: e.line.text, kind: e.line.kind });
        break;
      case 'loaded':
        this.emit('debug', 'loaded', { absPath: e.absPath });
        break;
      case 'halted':
        if (e.info.transient) break;
        this.stopTimer();
        this.rate = null;
        this.prevHaltRegs = this.haltRegs;
        this.haltRegs = this.target ? { ...this.target.registersSync() } : null;
        this.flushOutput();
        this.flushSci();
        this.emit('debug', 'halted', { info: haltDto(e.info), source: e.source ? { ...e.source } : undefined });
        this.pushSnapshot();
        break;
      case 'breakpoints':
        this.emit('debug', 'breakpoints', this.target?.breakpoints().map((b) => ({ ...b })) ?? []);
        break;
      case 'expressions':
        this.emit('debug', 'expressions', e.expressions.map((x) => ({ ...x })));
        break;
      case 'target':
        this.onTargetEvent(e.event);
        break;
      default:
        break;
    }
  }

  private onTargetEvent(e: TargetEvent): void {
    switch (e.type) {
      case 'running':
        this.noRunSinceReset = false;
        this.emit('debug', 'running', { kind: e.kind });
        // Every run (go, and steps/run-to that can take long: Step Over a delay, Step Out of a routine that never
        // returns) gets periodic snapshots + the real-time ratio. Steps get their first one a period later, so a
        // short step (halted within the period) pushes nothing extra and the views do not flicker.
        this.rate = { sim: this.target?.system.simTimeSeconds ?? 0, wall: this.now() };
        this.startTimer();
        if (e.kind === 'go') this.pushSnapshot();
        break;
      case 'watchpoints':
        this.emit('debug', 'watchpoints', this.target?.watchpoints().map((w) => ({ ...w })) ?? []);
        break;
      case 'reset':
      case 'loaded':
        this.noRunSinceReset = true;
        if (this.target?.state === 'halted') this.pushSnapshot();
        break;
      case 'memory':
        if (this.target?.state === 'halted') this.pushSnapshot();
        break;
      default:
        break;
    }
  }

  private queueOutput(line: OutputLineInfo): void {
    this.outBuf.push(line);
    if (this.outScheduled) return;
    this.outScheduled = true;
    setTimeout(() => this.flushOutput(), 15);
  }

  private queueSci(channel: number, byte: number): void {
    let buf = this.sciBuf.get(channel);
    if (!buf) this.sciBuf.set(channel, (buf = []));
    buf.push(byte & 0xff);
    if (this.sciScheduled) return;
    this.sciScheduled = true;
    setTimeout(() => this.flushSci(), 15);
  }

  private flushSci(): void {
    this.sciScheduled = false;
    if (!this.sciBuf.size) return;
    const bufs = [...this.sciBuf];
    this.sciBuf.clear();
    for (const [channel, data] of bufs) this.emit('debug', 'sciOutput', { channel, data });
  }

  private flushOutput(): void {
    this.outScheduled = false;
    if (!this.outBuf.length) return;
    const lines = this.outBuf;
    this.outBuf = [];
    this.emit('debug', 'output', lines);
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    const si = this.opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.timer = si(() => this.pushSnapshot(), Math.round(1000 / this.snapshotHz));
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    const ci = this.opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    ci(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------------------------------ snapshots

  snapshot(): DebugSnapshot {
    const t = this.target;
    const s = this.session;
    if (!t || !s) return { seq: ++this.seq, state: 'none', statusText: '', cycles: 0, busHz: 0, simSeconds: 0, registers: null, memory: {} };
    const state: RunState = t.state;
    const memory: Record<string, MemoryBlockInfo[]> = {};
    for (const [id, ranges] of this.watches) memory[id] = ranges.map((r) => blockDto(t.readMemorySync(r.address, r.length, r.space ?? 'local')));
    const halt = state === 'halted' && t.lastHalt ? haltDto(t.lastHalt) : undefined;
    const registers = { ...t.registersSync() };
    let realTimeRatio: number | undefined;
    if (state === 'running' && this.rate) {
      const wall = this.now();
      const sim = t.system.simTimeSeconds;
      const dw = (wall - this.rate.wall) / 1000;
      // measured over >= 0.25 s windows, smoothed, so the status bar does not flicker
      if (dw >= 0.25) {
        const r = (sim - this.rate.sim) / dw;
        this.rate = { sim, wall, ratio: this.rate.ratio === undefined ? r : this.rate.ratio * 0.5 + r * 0.5 };
      }
      realTimeRatio = this.rate.ratio;
    }
    const base = this.prevHaltRegs;
    const changedRegisters = state === 'halted' && base ? REG_KEYS.filter((k) => registers[k] !== base[k]) : undefined;
    return {
      seq: ++this.seq,
      state,
      statusText: state === 'running' ? 'RUNNING' : t.lastHalt ? haltStatusText(t.lastHalt) : 'HALTED',
      cycles: t.cycles,
      busHz: t.busHz,
      simSeconds: t.system.simTimeSeconds,
      registers,
      memory,
      halt,
      source: halt ? (s.sourceLocation(halt.pc) ?? undefined) : undefined,
      pacing: t.pacing,
      speedFactor: t.speedFactor,
      realTimeRatio,
      changedRegisters,
    };
  }

  private pushSnapshot(): void {
    this.emit('debug', 'snapshot', this.snapshot());
    this.emit('board', 'state', this.boardState());
  }

  boardState(): BoardState {
    const board = this.factory?.mcu?.board ?? null;
    const t = this.target;
    const empty: BoardState = { present: false, seq: ++this.boardSeq, simSeconds: 0, lcd: null, leds: [], keysDown: [], encoderCount: 0, dac: { a: 0, b: 0 }, motor: null };
    if (!board || !t) return empty;
    const v = board.lcd.view();
    const held = board.keypad.snapshot().held;
    const m = board.motor.state();
    return {
      present: true,
      seq: empty.seq,
      simSeconds: t.system.simTimeSeconds,
      lcd: { lines: [...v.lines], cursor: v.cursor ? { ...v.cursor } : null, cursorVisible: v.cursorVisible, cursorOn: v.cursorOn, blinkOn: v.blinkOn, displayOn: v.displayOn, cgram: v.cgram.map((r) => [...r]) },
      leds: board.leds.states().map((l) => ({ pin: l.pin, color: l.color, pair: l.pair, on: l.on })),
      keysDown: held.map((code) => board.keypad.key({ code }).label),
      encoderCount: board.encoder.counter(),
      dac: { a: board.dac.voltA, b: board.dac.voltB },
      motor: { current: m.current, omega: m.omega, rpm: m.rpm, angle: m.angle, volts: m.volts, duty: m.duty, direction: m.direction, enabled: m.enabled, encoderEdges: m.encoderEdges, senseVolts: m.senseVolts },
    };
  }

  // ------------------------------------------------------------------------------------------ code views

  async disassemble(req: DisasmRequest): Promise<DisasmLine[]> {
    const t = this.requireTarget();
    const syms = this.session?.symbols ?? null;
    const count = Math.min(Math.max(1, req.count | 0), 2000);
    let start = req.address & 0xffff;
    if (req.before && req.before > 0) start = this.findStartBefore(t, start, Math.min(req.before, 200));
    const span = count * 6 + 8;
    const block = t.readMemorySync(start, span, 'local');
    const read = bufferReader(block.bytes, start);
    const out: DisasmLine[] = [];
    let pc = start;
    for (let i = 0; i < count && pc < start + span - 6; i++) {
      const insn = decode(read, pc & 0xffff, { symbols: req.symbolic && syms ? (a) => syms.labelAt(a) : undefined });
      out.push({
        address: insn.address,
        bytes: [...insn.bytes],
        mnemonic: insn.mnemonic,
        operands: insn.operandsText,
        comment: insn.comment,
        target: insn.targetAddress,
        label: syms?.labelAt(insn.address),
        illegal: insn.illegal || insn.mode === 'ILLEGAL' || undefined,
      });
      pc += Math.max(1, insn.length);
    }
    return out;
  }

  /** Earliest start in [address - 5*before, address) whose decode lands exactly on `address` (line starts first). */
  private findStartBefore(t: SimTarget, address: number, before: number): number {
    const lo = Math.max(0, address - before * 5);
    const block = t.readMemorySync(lo, address - lo + 8, 'local');
    const read = bufferReader(block.bytes, lo);
    const syms = this.session?.symbols;
    const lands = (s: number): number => {
      let pc = s;
      let n = 0;
      while (pc < address) {
        pc += Math.max(1, decode(read, pc).length);
        n++;
      }
      return pc === address ? n : -1;
    };
    for (let s = lo; s < address; s++) if (syms?.isLineStart(s) && lands(s) > 0) return s;
    for (let s = lo; s < address; s++) if (lands(s) > 0) return s;
    return address;
  }

  // ------------------------------------------------------------------------------------------ method table

  private buildHandlers(): Record<string, Handler> {
    const t = () => this.requireTarget();
    const s = () => this.requireSession();
    return {
      'engine.ping': () => 'pong',
      'engine.openSession': (req: OpenSessionRequest) => this.openSession(req),

      'debug.session': () => this.info,
      'debug.closeSession': () => this.closeSession(),
      'debug.loadApplication': (req: { path: string; options?: string[] }) => this.loadApplication(req),
      'debug.snapshot': () => this.snapshot(),

      'debug.go': async (req?: { from?: number; until?: number }) => {
        await t().go(req ?? {});
      },
      'debug.halt': async () => (t().state === 'running' ? haltDto(await t().halt()) : null),
      'debug.step': async (kind: StepKind) => haltDto(await t().step(kind)),
      'debug.reset': async () => {
        await s().reset();
        this.pushSnapshot();
      },
      'debug.restart': async () => {
        // UNCERTAIN: hiwave Restart = reload the application's code and start it (RESTART command).
        await s().execute('restart', { echo: false });
      },
      'debug.runTo': async (address: number) => haltDto(await t().runUntil(address)),
      'debug.resetCycles': () => {
        t().resetCycleCounter();
        this.pushSnapshot();
      },
      'debug.setPacing': (mode: PacingMode, speedFactor?: number) => {
        t().pacing = this.opts.forcePacing ?? mode;
        if (speedFactor !== undefined) t().speedFactor = speedFactor;
        if (this.rate) this.rate = { sim: t().system.simTimeSeconds, wall: this.now() };
        if (this.info) {
          this.info.pacing = t().pacing;
          this.emit('debug', 'session', { ...this.info });
        }
        this.pushSnapshot();
      },

      'debug.readRegisters': async () => ({ ...(await t().readRegisters()) }) as RegisterSetInfo,
      'debug.writeRegister': async (name: RegisterName, value: number) => {
        await t().writeRegister(name, value);
        this.pushSnapshot();
      },
      'debug.readMemory': async (r: MemoryRange) => blockDto(await t().readMemory(r.address, r.length, r.space ?? 'local')),
      'debug.writeMemory': async (address: number, bytes: Uint8Array | number[], space?: 'local' | 'global') => {
        await t().writeMemory(address, bytes, space ?? 'local');
        this.pushSnapshot();
      },
      'debug.fillMemory': async (start: number, end: number, value: number, space?: 'local' | 'global') => {
        if (end < start) throw new ApiError('invalid-argument', 'fill: end < start');
        await t().writeMemory(start, new Uint8Array(end - start + 1).fill(value & 0xff), space ?? 'local');
        this.pushSnapshot();
      },
      'debug.watchMemory': (id: string, ranges: MemoryRange[]) => {
        this.watches.set(id, ranges);
        if (this.target && this.target.state === 'halted') this.pushSnapshot();
      },
      'debug.unwatchMemory': (id: string) => {
        this.watches.delete(id);
      },

      'debug.disassemble': (req: DisasmRequest) => this.disassemble(req),
      'debug.sourceFiles': () => {
        const sess = s();
        return (sess.symbols?.sourceFiles() ?? []).map((file) => ({ file, path: sess.sources.resolvedSync(file) ?? undefined, module: file.split(/[\\/]/).pop() ?? file }));
      },
      'debug.readSource': async (file: string) => {
        const sess = s();
        // a source that is not on this PC (e.g. a library built on the lab PC) is looked up once per load
        const key = `${sess.absPath ?? ''}|${file.toLowerCase()}`;
        if (this.missingSources.has(key)) throw new ApiError('not-found', `source ${file} not found`);
        const path = sess.sources.resolvedSync(file) ?? (await sess.sources.resolve(file));
        if (!path) {
          if (sess === this.session) this.missingSources.add(key);
          throw new ApiError('not-found', `source ${file} not found`);
        }
        const bytes = await sess.fs.readFile(path);
        return { file, path, text: new TextDecoder('latin1').decode(bytes).replace(/\r\n?/g, '\n') };
      },
      'debug.lineAddresses': (file: string) => {
        const seen = new Map<number, number>();
        const norm = (f: string) => f.replace(/\\/g, '/').toLowerCase();
        for (const l of s().symbols?.lines ?? []) if (norm(l.file) === norm(file) && !seen.has(l.line)) seen.set(l.line, l.address);
        return [...seen].map(([line, address]) => ({ line, address })).sort((a, b) => a.line - b.line);
      },
      'debug.sourceLocation': (address: number) => s().sourceLocation(address) ?? null,
      'debug.symbols': () =>
        (s().symbols?.symbols ?? []).map((x) => ({ name: x.name, address: x.address, size: x.size, kind: x.kind, global: x.global, section: x.section, module: x.module })),
      'debug.resolve': async (expression: string) => {
        try {
          return await s().interp.evaluate(expression, { address: true });
        } catch {
          return null;
        }
      },

      'debug.breakpoints': () => t().breakpoints().map((b) => ({ ...b })),
      'debug.setBreakpoint': async (spec: BreakpointSpecInfo) => ({ ...(await t().addBreakpoint(spec)) }),
      'debug.updateBreakpoint': async (id: number, patch: Partial<BreakpointSpecInfo>) => ({ ...(await t().updateBreakpoint(id, patch)) }),
      'debug.removeBreakpoint': (id: number) => t().removeBreakpoint(id),
      'debug.clearBreakpoints': () => t().clearBreakpoints(),
      'debug.watchpoints': () => t().watchpoints().map((w) => ({ ...w })),
      'debug.setWatchpoint': async (spec: WatchpointSpecInfo) => ({ ...(await t().addWatchpoint(spec)) }),
      'debug.updateWatchpoint': async (id: number, patch: Partial<WatchpointSpecInfo>) => ({ ...(await t().updateWatchpoint(id, patch)) }),
      'debug.removeWatchpoint': (id: number) => t().removeWatchpoint(id),
      'debug.clearWatchpoints': () => t().clearWatchpoints(),

      'debug.exec': async (line: string, opts?: { echo?: boolean }) => {
        const ok = await s().execute(line, opts);
        this.flushOutput();
        return ok;
      },
      'debug.execFile': async (path: string) => {
        const ok = await s().execute(`cf "${path}"`);
        this.flushOutput();
        return ok;
      },
      'debug.answerPrompt': (id: number, value?: number) => {
        const r = this.prompts.get(id);
        this.prompts.delete(id);
        r?.(value);
      },

      'debug.expressions': () => s().expressions.map((e) => ({ ...e })),
      'debug.addExpression': (expression: string, component?: string) => s().addExpression(expression, false, component ?? 'Data'),
      'debug.removeExpression': (expression: string) => s().removeExpression(expression),
      'debug.saveExpressions': () => s().saveExpressions(),
      'debug.evaluate': async (exprs: string[]) => Promise.all(exprs.map(async (expression) => ({ expression, ...(await s().evaluateExpression(expression)) }))),
      'debug.globals': () =>
        (s().symbols?.globalVariables() ?? []).map((x) => ({
          name: x.name,
          address: x.address,
          byteSize: x.variable?.byteSize ?? x.size,
          typeName: x.variable?.typeName ?? '',
          signed: x.variable?.signed ?? false,
          arrayLength: x.variable?.arrayLength,
          module: x.module,
        })),
      'debug.callStack': (): FrameInfo[] => this.callStack(),
      'debug.sciSend': (channel: number, data: number[] | string) => {
        const mcu = this.factory?.mcu;
        if (!mcu) throw new ApiError('no-session', 'no debug session');
        const sci = [mcu.periph.sci0, mcu.periph.sci1, mcu.periph.sci2, mcu.periph.sci3, mcu.periph.sci4, mcu.periph.sci5][channel];
        if (!sci) throw new ApiError('invalid-argument', `no SCI${channel}`);
        sci.receive(data);
      },

      'board.state': () => this.boardState(),
      'board.keys': (): KeyDef[] => {
        const kp = this.factory?.mcu?.board?.keypad;
        if (!kp) return [];
        return kp.keys.map((k) => ({ label: k.label, code: k.code, row: k.row, col: k.col, pcKeys: [...k.pcKeys] }));
      },
      'board.pressKey': (label: string) => {
        this.board().keypad.press(label);
        this.pushBoardIfHalted();
      },
      'board.releaseKey': (label: string) => {
        this.board().keypad.release(label);
        this.pushBoardIfHalted();
      },
      'board.tapKey': (label: string, hold?: number) => {
        this.board().keypad.tap(label, hold ?? 0.1);
        this.pushBoardIfHalted();
      },
      'board.setMotorParams': (patch: Record<string, number>) => this.board().motor.configure(patch),
      'board.setLoadTorque': (nm: number) => this.board().motor.setLoadTorque(nm),
      'board.setAnalogInput': (atd: 0 | 1, channel: number, volts: number) => {
        const mcu = this.mcu;
        if (!mcu) throw new ApiError('no-session', 'no debug session');
        if (!(channel >= 0 && channel < ATD_CHANNELS[atd])) throw new ApiError('invalid-argument', `ATD${atd} has no channel ${channel}`);
        mcu.syncAll();
        mcu.nets.analog.set(atdPin(atd, channel), volts);
        (atd === 0 ? mcu.periph.atd0 : mcu.periph.atd1).analogInputChanged();
        mcu.rescheduleAll();
      },
      'board.setPin': (pin: string, level: 0 | 1 | null) => {
        const mcu = this.mcu;
        if (!mcu) throw new ApiError('no-session', 'no debug session');
        const name = pin.toUpperCase();
        if (!mcu.nets.pins.names().includes(name)) throw new ApiError('invalid-argument', `unknown pin ${pin}`);
        mcu.nets.pins.externalChange([[name, level]]);
        this.pushBoardIfHalted();
      },
      'board.powerCycle': () => {
        this.board().powerOn();
        this.pushBoardIfHalted();
      },
    };
  }

  /** Current procedure + callers found on the stack (see call-stack.ts). */
  callStack(): FrameInfo[] {
    const sess = this.requireSession();
    const t = this.requireTarget();
    const regs = t.registersSync();
    const syms = sess.symbols;
    const read = (a: number) => t.peekAny(a & 0xffff);
    const name = (pc: number): string => syms?.subprogramAt(pc)?.name ?? syms?.symbolFor(pc)?.symbol.name ?? `0x${pc.toString(16).toUpperCase().padStart(4, '0')}`;
    // UNCERTAIN: assembly programs have no frame info; callers come from return addresses found on the stack.
    const isCode = (a: number) => a >= 0x4000 && (!syms || !!syms.symbolFor(a));
    // the linker's stack-end symbol bounds the scan (RAM variables above the stack are not frames)
    const stackEnd = syms?.symbols.find((x) => /^__SEG_END_SSTACK$/i.test(x.name))?.address;
    // Right after a reset (or load) nothing has called anything yet: the return addresses still on the stack belong
    // to the previous run (reset keeps SP and RAM), so only the current procedure is shown until the program runs.
    // UNCERTAIN: whether hiwave's Procedure window shows such leftovers.
    const frames = unwindStack(read, regs.PC, regs.SP, { isCode, stackTop: stackEnd && stackEnd > regs.SP ? stackEnd : undefined, maxFrames: this.noRunSinceReset ? 1 : undefined });
    return frames.map((f) => ({ level: f.level, name: name(f.pc), pc: f.pc, source: sess.sourceLocation(f.pc) }));
  }

  private board() {
    const b = this.factory?.mcu?.board;
    if (!b) throw new ApiError('no-session', 'no simulated board');
    return b;
  }

  private pushBoardIfHalted(): void {
    if (this.target?.state !== 'running') this.emit('board', 'state', this.boardState());
  }

  async dispose(): Promise<void> {
    await this.closeSession();
  }
}

export function haltDto(h: HaltInfo): HaltInfoDTO {
  return {
    ...h,
    breakpoint: h.breakpoint ? { ...h.breakpoint } : undefined,
    watchpoint: h.watchpoint ? { ...h.watchpoint } : undefined,
    watchHit: h.watchHit ? { ...h.watchHit } : undefined,
  };
}

export function blockDto(b: { address: number; space: 'local' | 'global'; bytes: Uint8Array; status: Uint8Array }): MemoryBlockInfo {
  return { address: b.address, space: b.space, bytes: new Uint8Array(b.bytes), status: new Uint8Array(b.status) };
}

export type { SourceLocationInfo };

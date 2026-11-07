/**
 * SimTarget: the Target interface over the @s12/sim S12XSystem (hiwave "Full Chip Simulation" connection).
 *
 * Execution runs in slices (configurable bus cycles per slice) on the event loop, so halts, UI refreshes and
 * breakpoint edits are serviced while the program runs. Pacing: 'max' runs as fast as possible; 'true-time'
 * keeps simulated time in step with wall-clock time (times `speedFactor`).
 *
 * Breakpoints map to S12XSystem execution breakpoints, watchpoints to bus watchpoints. Conditions, counters and
 * temporary breakpoints are evaluated here when the system stops at one; if the breakpoint should not stop,
 * the run continues transparently. Conditions are evaluated with the expression language of expr.ts, with
 * names resolved through the TargetDebugInfo the session provides.
 */
import { logicalToGlobal } from '@s12/devices';
import { readSRecords } from '@s12/formats';
import { S12XSystem, type HaltReason, type ResetCause } from '@s12/sim';
import { evaluateSync, type SyncExprEnv } from './expr';
import { callAt, isReturnAt } from './stepping';
import {
  canonicalRegister,
  MEM_OK,
  MEM_UNINITIALIZED,
  MEM_UNMAPPED,
  type AddressSpace,
  type Breakpoint,
  type BreakpointSpec,
  type DebugHaltReason,
  type GoOptions,
  type HaltInfo,
  type IdentValue,
  type LoadImage,
  type LoadInfo,
  type LoadOptions,
  type MemoryBlock,
  type RegisterName,
  type RegisterSet,
  type StepKind,
  type Target,
  type TargetDebugInfo,
  type TargetEvent,
  type TargetState,
  type Watchpoint,
  type WatchpointSpec,
} from './target';

export interface SimTargetOptions {
  /**
   * Builds the simulated system (the integrator supplies one with peripherals and the ME305 board; peripherals
   * must already be registered and the system reset). Default: a bare S12XSystem.
   */
  createSystem?: () => S12XSystem;
  /** Bus cycles per run slice in 'max' pacing (default 200 000). */
  sliceCycles?: number;
  /** 'max' (default) or 'true-time'. */
  pacing?: 'max' | 'true-time';
  /** true-time: simulated seconds per wall-clock second (default 1). */
  speedFactor?: number;
  /** Instructions per slice in instruction-by-instruction stepping (default 20 000). */
  stepSliceInstructions?: number;
  /** Reset cause used by reset() and after load (default 'external': RAM content kept). */
  resetCause?: ResetCause;
  /** Assembly step over treats SWI/TRAP as calls (default true). */
  overSwi?: boolean;
  /** Wall clock in ms (tests). */
  now?: () => number;
  /** Sleep (true-time pacing) and yield implementations (tests). */
  sleep?: (ms: number) => Promise<void>;
  yieldNow?: () => Promise<void>;
}

/** Result of a unit of job work: a halt, 'temp' (the job's temporary breakpoint was satisfied) or null (continue). */
type SliceResult = HaltInfo | 'temp' | null;

interface Job {
  kind: 'go' | StepKind;
  slice(): HaltInfo | null;
  /** Started by go(): a breakpoint whose command has the Continue flag gives a transient halt. */
  continuable?: boolean;
}

const defaultYield = (): Promise<void> =>
  new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PAGE_REGS: Partial<Record<RegisterName, number>> = { PPAGE: 0x30, RPAGE: 0x16, EPAGE: 0x17, GPAGE: 0x10, DIRECT: 0x11 };

export class SimTarget implements Target {
  readonly kind = 'sim';
  readonly system: S12XSystem;
  private opts: Required<Omit<SimTargetOptions, 'createSystem'>>;
  private _state: TargetState = 'halted';
  private _lastHalt: HaltInfo | null = null;
  private listeners = new Set<(e: TargetEvent) => void>();
  private haltWaiters: ((h: HaltInfo) => void)[] = [];
  private bps: Breakpoint[] = [];
  private wps: Watchpoint[] = [];
  private nextBpId = 1;
  private nextWpId = 1;
  private bpLocal = new Set<number>();
  private jobTemps = new Set<number>();
  /** Control points or job temporaries changed since the system tables were last built. */
  private cpDirty = true;
  /** The job being driven (null when halted). */
  private job: Job | null = null;
  private sysWatchIds: number[] = [];
  private debugInfo: TargetDebugInfo | null = null;
  private haltRequested = false;
  private current: Promise<HaltInfo> | null = null;
  /** True-time pacing anchor (simulated s, wall ms) of the running job; null = re-anchor on the next slice. */
  private paceBase: { sim: number; wall: number } | null = null;
  private unsubscribeSim: () => void;
  private readonly peekFn = (a: number) => {
    const v = this.system.peek(a & 0xffff);
    return v < 0 ? 0xff : v;
  };

  constructor(opts: SimTargetOptions = {}) {
    this.system = opts.createSystem ? opts.createSystem() : new S12XSystem();
    this.opts = {
      sliceCycles: opts.sliceCycles ?? 200_000,
      pacing: opts.pacing ?? 'max',
      speedFactor: opts.speedFactor ?? 1,
      stepSliceInstructions: opts.stepSliceInstructions ?? 20_000,
      resetCause: opts.resetCause ?? 'external',
      overSwi: opts.overSwi ?? true,
      now: opts.now ?? (() => (globalThis.performance ? globalThis.performance.now() : Date.now())),
      sleep: opts.sleep ?? defaultSleep,
      yieldNow: opts.yieldNow ?? defaultYield,
    };
    this.unsubscribeSim = this.system.onEvent((event) => this.emit({ type: 'sim-event', event }));
  }

  // ------------------------------------------------------------------------------------------ status

  get state(): TargetState {
    return this._state;
  }
  get lastHalt(): HaltInfo | null {
    return this._lastHalt;
  }
  get cycles(): number {
    return this.system.cycles;
  }
  get busHz(): number {
    return this.system.busHz;
  }
  get pacing(): 'max' | 'true-time' {
    return this.opts.pacing;
  }
  set pacing(p: 'max' | 'true-time') {
    this.opts.pacing = p;
    this.paceBase = null; // a change while running re-anchors true-time pacing at the current instant
  }
  get speedFactor(): number {
    return this.opts.speedFactor;
  }
  set speedFactor(f: number) {
    this.opts.speedFactor = f > 0 ? f : 1;
    this.paceBase = null;
  }
  set sliceCycles(n: number) {
    this.opts.sliceCycles = Math.max(1, Math.floor(n));
  }

  resetCycleCounter(): void {
    this.system.resetCycleCounter();
  }

  onEvent(fn: (e: TargetEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: TargetEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // a listener's failure must not break the run loop
      }
    }
  }

  setDebugInfo(info: TargetDebugInfo | null): void {
    this.debugInfo = info;
  }

  private mk(reason: DebugHaltReason, extra: Partial<HaltInfo> = {}): HaltInfo {
    return { reason, pc: this.system.registers.pc, cycles: this.system.cycles, ...extra };
  }

  private setState(s: TargetState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit({ type: 'state', state: s });
  }

  private publishHalt(h: HaltInfo): void {
    this._lastHalt = h;
    this.setState('halted');
    this.emit({ type: 'halted', info: h });
    // a transient halt (breakpoint command with Continue) is not the end of the run for waitForHalt()
    if (h.transient) return;
    const w = this.haltWaiters;
    this.haltWaiters = [];
    for (const f of w) f(h);
  }

  // ------------------------------------------------------------------------------------------ loading / reset

  async load(image: LoadImage, opts: LoadOptions = {}): Promise<LoadInfo> {
    await this.stopIfRunning();
    const sys = this.system;
    let info: LoadInfo;
    if (image.kind === 'abs') {
      if (typeof image.data === 'string') throw new Error('an .abs image must be binary');
      const r = sys.loadAbs(image.data);
      info = { entry: r.entry, segments: r.segments, skipped: r.skipped };
    } else if (image.srecOffset) {
      info = this.loadSrecWithOffset(image.data, image.srecOffset);
    } else {
      const r = sys.loadSrec(image.data, { addressing: image.srecAddressing });
      info = { entry: r.entry, segments: r.segments, skipped: r.skipped };
    }
    if (opts.reset !== false) {
      sys.reset(this.opts.resetCause);
      if ((opts.pcAfterLoad ?? 'entry') === 'entry' && info.entry !== undefined && image.kind === 'abs') sys.setRegisters({ pc: info.entry & 0xffff });
    }
    this.emit({ type: 'loaded', info });
    this.emit({ type: 'memory' });
    this.publishHalt(this.mk('load'));
    return info;
  }

  private loadSrecWithOffset(data: Uint8Array | string, offset: number): LoadInfo {
    const f = readSRecords(data);
    if (f.errors.length) throw new Error(`S-record errors: ${f.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
    const segments: LoadInfo['segments'] = [];
    let skipped = 0;
    for (const r of f.records) {
      if (r.type < 1 || r.type > 3) continue;
      const a = r.address + offset;
      let first = -1;
      for (let i = 0; i < r.data.length; i++) {
        try {
          const g = logicalToGlobal(a + i <= 0xffff ? a + i : (a & 0xff0000) | ((a + i) & 0xffff));
          if (this.system.peekGlobal(g) < 0) skipped++;
          else {
            this.system.pokeGlobal(g, r.data[i]);
            if (first < 0) first = g;
          }
        } catch {
          skipped++;
        }
      }
      segments.push({ address: a, global: first, size: r.data.length });
    }
    return { entry: f.terminator?.address, segments, skipped };
  }

  async reset(): Promise<HaltInfo> {
    await this.stopIfRunning();
    this.system.reset(this.opts.resetCause);
    this.emit({ type: 'reset' });
    this.emit({ type: 'memory' });
    const h = this.mk('reset');
    this.publishHalt(h);
    return h;
  }

  // ------------------------------------------------------------------------------------------ execution

  async go(opts: GoOptions = {}): Promise<void> {
    if (this._state === 'running') return;
    if (opts.from !== undefined) this.system.setRegisters({ pc: opts.from & 0xffff });
    const job = this.goJob(opts.until);
    job.continuable = true;
    void this.drive(job);
  }

  async runUntil(address: number): Promise<HaltInfo> {
    await this.stopIfRunning();
    return this.drive(this.goJob(address));
  }

  async halt(): Promise<HaltInfo> {
    if (this._state !== 'running' || !this.current) return this._lastHalt ?? this.mk('halt');
    this.haltRequested = true;
    return this.current;
  }

  async step(kind: StepKind): Promise<HaltInfo> {
    await this.stopIfRunning();
    return this.drive(this.stepJob(kind));
  }

  waitForHalt(timeoutMs?: number): Promise<HaltInfo> {
    if (this._state !== 'running' && !this._lastHalt?.transient) return Promise.resolve(this._lastHalt ?? this.mk('halt'));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const f = (h: HaltInfo) => {
        if (timer) clearTimeout(timer);
        resolve(h);
      };
      this.haltWaiters.push(f);
      if (timeoutMs !== undefined && timeoutMs !== Infinity)
        timer = setTimeout(() => {
          this.haltWaiters = this.haltWaiters.filter((x) => x !== f);
          reject(new Error(`target did not halt within ${timeoutMs} ms`));
        }, timeoutMs);
    });
  }

  private async stopIfRunning(): Promise<void> {
    if (this._state === 'running') await this.halt();
  }

  /** Run a job to completion on the event loop. */
  private drive(job: Job): Promise<HaltInfo> {
    const p = (async (): Promise<HaltInfo> => {
      this.haltRequested = false;
      this.job = job;
      this.applyBreakpoints();
      this.setState('running');
      this.emit({ type: 'running', kind: job.kind });
      let info: HaltInfo;
      const sys = this.system;
      this.paceBase = null;
      try {
        // go() returns with the target running; the first slice runs on the next turn of the event loop
        if (job.kind === 'go') await this.opts.yieldNow();
        for (;;) {
          if (this.haltRequested) {
            info = this.mk('halt');
            break;
          }
          const r = job.slice();
          if (r) {
            info = r;
            break;
          }
          if (this.opts.pacing === 'true-time') {
            // anchored at the job start (or the last pacing/speed change: switching from 'max' must not stall)
            const base = (this.paceBase ??= { sim: sys.simTimeSeconds, wall: this.opts.now() });
            const ahead = ((sys.simTimeSeconds - base.sim) / this.opts.speedFactor) * 1000 - (this.opts.now() - base.wall);
            if (ahead > 1) await this.opts.sleep(Math.min(ahead, 50));
            else await this.opts.yieldNow();
          } else await this.opts.yieldNow();
        }
      } catch (e) {
        info = this.mk('error', { message: e instanceof Error ? e.message : String(e) });
      }
      this.haltRequested = false;
      if (this.jobTemps.size) {
        this.jobTemps.clear();
        this.touch();
      }
      this.applyBreakpoints();
      this.job = null;
      this.current = null;
      this.emit({ type: 'memory' });
      this.publishHalt(info);
      return info;
    })();
    this.current = p;
    return p;
  }

  /** Bus cycles per fast slice. */
  private budget(): number {
    if (this.opts.pacing === 'true-time') return Math.max(1000, Math.floor((this.system.busHz * this.opts.speedFactor) / 200));
    return this.opts.sliceCycles;
  }

  private mapReason(r: HaltReason): DebugHaltReason {
    switch (r) {
      case 'bgnd':
      case 'illegal-access':
      case 'stop':
      case 'wait-idle':
      case 'uninitialized-vector':
      case 'halt':
      case 'breakpoint':
      case 'watchpoint':
        return r;
      default:
        return 'step';
    }
  }

  /**
   * Run up to `budget` cycles with the system breakpoints installed. `onTemp(pc)` decides whether a stop at
   * one of the job's temporary addresses completes the job.
   */
  private fastSlice(onTemp: ((pc: number) => boolean) | null): SliceResult {
    const sys = this.system;
    const r = sys.run(this.budget());
    switch (r) {
      case 'limit':
        return null;
      case 'breakpoint': {
        const pc = sys.registers.pc;
        if (this.jobTemps.has(pc) && onTemp?.(pc)) return 'temp';
        if (this.bpLocal.has(pc)) return this.checkBreakpoint(pc);
        return null; // a temporary address whose condition (stack depth) does not hold: keep going
      }
      case 'watchpoint':
        return this.checkWatch();
      default:
        return this.haltFromSim(r);
    }
  }

  private haltFromSim(r: HaltReason): HaltInfo {
    const reason = this.mapReason(r);
    let message: string | undefined;
    if (r === 'illegal-access') message = `illegal access at PC=0x${this.system.registers.pc.toString(16).toUpperCase().padStart(4, '0')}`;
    return this.mk(reason, message ? { message } : {});
  }

  /**
   * Execute one instruction. Returns a halt for abnormal stops (a stopping watchpoint, BGND...), else null.
   * Entering an interrupt ends the step at the handler's first instruction (not executed), so the breakpoint
   * check before the next instruction sees ISR entry points and an Assembly Step lands on the ISR's first line.
   */
  private stepInstr(): HaltInfo | null {
    const r = this.system.step({ stopAfterException: true });
    if (r === 'step') return null;
    if (r === 'watchpoint') return this.checkWatch();
    return this.haltFromSim(r);
  }

  private goJob(until?: number): Job {
    const sys = this.system;
    if (until !== undefined) {
      this.jobTemps.add(until & 0xffff);
      this.touch();
    }
    sys.cpu.bpSkipPc = sys.registers.pc; // resume past a breakpoint at the current PC
    return {
      kind: 'go',
      slice: () => {
        const r = this.fastSlice(() => true);
        if (r === 'temp') return this.mk('breakpoint', { message: 'temporary breakpoint' });
        return r;
      },
    };
  }

  private instrJob(kind: StepKind): Job {
    return { kind, slice: () => this.stepInstr() ?? this.mk('step', { stepKind: kind }) };
  }

  private overJob(kind: StepKind): Job {
    const sys = this.system;
    const pc = sys.registers.pc;
    const call = callAt(this.peekFn, pc, { overSwi: this.opts.overSwi });
    if (!call) return this.instrJob(kind);
    const sp0 = sys.registers.sp;
    this.jobTemps.add(call.returnAddress);
    this.touch();
    sys.cpu.bpSkipPc = pc;
    return {
      kind,
      slice: () => {
        const r = this.fastSlice(() => this.system.registers.sp >= sp0);
        if (r === 'temp') return this.mk('step', { stepKind: kind });
        return r;
      },
    };
  }

  private outJob(kind: StepKind, then?: () => HaltInfo | null): Job {
    const sys = this.system;
    const sp0 = sys.registers.sp;
    let first = true;
    let done = false;
    return {
      kind,
      slice: () => {
        for (let n = 0; n < this.opts.stepSliceInstructions; n++) {
          if (done) return then ? then() : this.mk('step', { stepKind: kind });
          const pc = sys.registers.pc;
          if (!first && this.bpLocal.has(pc)) {
            const h = this.checkBreakpoint(pc);
            if (h) return h;
          }
          first = false;
          const ret = isReturnAt(this.peekFn, pc);
          const h = this.stepInstr();
          if (h) return h;
          if (ret && sys.registers.sp > sp0) {
            done = true;
            if (!then) return this.mk('step', { stepKind: kind });
            return then();
          }
        }
        return null;
      },
    };
  }

  private hasSourceAt(addr: number): boolean {
    const d = this.debugInfo;
    if (!d?.lineAt) return false;
    if (d.hasSource) return d.hasSource(addr);
    return !!d.lineAt(addr);
  }

  /** Source-level step (srcLine / srcOver / srcOut). */
  private srcJob(kind: 'srcLine' | 'srcOver' | 'srcOut'): Job {
    const sys = this.system;
    const d = this.debugInfo;
    const pc0 = sys.registers.pc;
    const row0 = d?.lineAt?.(pc0);
    if (!row0 || !this.hasSourceAt(pc0)) {
      // no source here: assembly-level fallback
      if (kind === 'srcLine') return this.instrJob(kind);
      if (kind === 'srcOver') return this.overJob(kind);
      return this.outJob(kind);
    }
    const startKey = kind === 'srcOut' ? null : `${row0.file}\u0000${row0.line}`;
    // the last row seen and whether its start is a stop (a tight loop stays inside one row: no lookups)
    let cached: { address: number; endAddress: number; stop: boolean } | undefined;
    const atStop = (): boolean => {
      const pc = sys.registers.pc;
      if (cached && pc >= cached.address && pc < cached.endAddress) return pc === cached.address && cached.stop;
      const row = d!.lineAt!(pc);
      if (!row) {
        cached = undefined;
        return false;
      }
      cached = { address: row.address, endAddress: row.endAddress ?? pc + 1, stop: this.hasSourceAt(row.address) && `${row.file}\u0000${row.line}` !== startKey };
      return row.address === pc && cached.stop;
    };
    let mode: 'instr' | 'over' = 'instr';
    let overSp = 0;
    let first = true;
    const lineSlice = (): HaltInfo | null => {
      for (let n = 0; n < this.opts.stepSliceInstructions; n++) {
        if (mode === 'over') {
          const r = this.fastSlice(() => sys.registers.sp >= overSp);
          if (r === 'temp') {
            mode = 'instr';
            this.jobTemps.clear();
            this.touch();
            this.applyBreakpoints();
            if (atStop()) return this.mk('step', { stepKind: kind });
            continue;
          }
          return r;
        }
        const pc = sys.registers.pc;
        if (!first && this.bpLocal.has(pc)) {
          const h = this.checkBreakpoint(pc);
          if (h) return h;
        }
        first = false;
        const call = callAt(this.peekFn, pc, { overSwi: this.opts.overSwi });
        const sp = sys.registers.sp;
        const h = this.stepInstr();
        if (h) return h;
        if (call) {
          const npc = sys.registers.pc;
          if (npc !== call.returnAddress && (kind === 'srcOver' || !this.hasSourceAt(npc))) {
            mode = 'over';
            overSp = sp;
            this.jobTemps.add(call.returnAddress);
            this.touch();
            this.applyBreakpoints();
            if (this.bpLocal.has(npc)) {
              const hb = this.checkBreakpoint(npc);
              if (hb) return hb;
            }
            sys.cpu.bpSkipPc = npc;
            continue;
          }
        }
        if (atStop()) return this.mk('step', { stepKind: kind });
      }
      return null;
    };
    if (kind === 'srcOut') {
      let phase: 'out' | 'line' = 'out';
      const out = this.outJob(kind, () => {
        phase = 'line';
        first = true;
        return atStop() ? this.mk('step', { stepKind: kind }) : null;
      });
      return { kind, slice: () => (phase === 'out' ? out.slice() : lineSlice()) };
    }
    return { kind, slice: lineSlice };
  }

  private stepJob(kind: StepKind): Job {
    switch (kind) {
      case 'instr':
        return this.instrJob(kind);
      case 'over':
        return this.overJob(kind);
      case 'out':
        return this.outJob(kind);
      default:
        return this.srcJob(kind);
    }
  }

  // ------------------------------------------------------------------------------------------ control points

  /** Mark the system breakpoint/watchpoint tables stale (rebuilt lazily by applyBreakpoints). */
  private touch(): void {
    this.cpDirty = true;
  }

  /** Rebuild the system breakpoint/watchpoint tables if anything changed. */
  private applyBreakpoints(): void {
    if (!this.cpDirty) return;
    this.cpDirty = false;
    const sys = this.system;
    sys.clearBreakpoints();
    this.bpLocal.clear();
    for (const bp of this.bps) {
      if (!bp.enabled) continue;
      const local = bp.address & 0xffff;
      sys.addBreakpoint(local, bp.global);
      this.bpLocal.add(local);
    }
    for (const a of this.jobTemps) sys.addBreakpoint(a);
    for (const id of this.sysWatchIds) sys.removeWatchpoint(id);
    this.sysWatchIds = [];
    for (const wp of this.wps) {
      if (!wp.enabled) continue;
      this.sysWatchIds.push(sys.addWatchpoint({ start: wp.start, end: wp.end, kind: wp.kind, space: wp.space }));
    }
  }

  /** Breakpoint hit at `pc`: conditions, counters, temporaries. Returns the halt or null to continue. */
  private checkBreakpoint(pc: number): HaltInfo | null {
    const g = this.system.toGlobal(pc);
    const here = this.bps.filter((b) => b.enabled && (b.address & 0xffff) === pc && (b.global === undefined || b.global === g));
    let stop: Breakpoint | undefined;
    let message: string | undefined;
    for (const bp of here) {
      bp.hits++;
      if (bp.condition && bp.conditionEnabled !== false) {
        try {
          if (!this.evalCondition(bp.condition)) continue;
        } catch (e) {
          message = `Incorrect Condition "${bp.condition}": ${(e as Error).message}`;
          stop ??= bp;
          continue;
        }
      }
      if (bp.counter) {
        bp.counter.current--;
        if (bp.counter.current > 0) continue;
        bp.counter.current = bp.counter.interval > 0 ? bp.counter.interval : 0;
      }
      stop ??= bp;
    }
    if (!stop) return null;
    const snapshot = { ...stop, counter: stop.counter ? { ...stop.counter } : undefined };
    const temps = here.filter((b) => b.temporary && (b === stop || !b.condition));
    if (stop.temporary || temps.length) {
      this.bps = this.bps.filter((b) => !(b.temporary && (b === stop || temps.includes(b))));
      this.touch();
      this.applyBreakpoints();
      this.emit({ type: 'breakpoints' });
    } else this.emit({ type: 'breakpoints' });
    return this.mk('breakpoint', { breakpoint: snapshot, ...(message ? { message } : {}), ...(this.isTransient(stop, message) ? { transient: true } : {}) });
  }

  private checkWatch(): HaltInfo | null {
    const hit = this.system.lastWatchHit;
    if (!hit) return this.mk('watchpoint');
    const matches = this.wps.filter(
      (w) =>
        w.enabled &&
        (w.kind === 'readwrite' || w.kind === hit.access) &&
        (w.space === 'global' ? hit.global >= w.start && hit.global <= w.end : hit.local >= (w.start & 0xffff) && hit.local <= (w.end & 0xffff)),
    );
    let stop: Watchpoint | undefined;
    let message: string | undefined;
    for (const w of matches) {
      w.hits++;
      if (w.condition && w.conditionEnabled !== false) {
        try {
          if (!this.evalCondition(w.condition)) continue;
        } catch (e) {
          message = `Incorrect Condition "${w.condition}": ${(e as Error).message}`;
          stop ??= w;
          continue;
        }
      }
      if (w.counter) {
        w.counter.current--;
        if (w.counter.current > 0) continue;
        w.counter.current = w.counter.interval > 0 ? w.counter.interval : 0;
      }
      stop ??= w;
    }
    if (!stop) return null;
    this.emit({ type: 'watchpoints' });
    return this.mk('watchpoint', {
      ...(this.isTransient(stop, message) ? { transient: true } : {}),
      watchpoint: { ...stop, counter: stop.counter ? { ...stop.counter } : undefined },
      watchHit: { address: hit.local, global: hit.global, access: hit.access, value: hit.value, pc: hit.pc },
      ...(message ? { message } : {}),
    });
  }

  /** A stop at `cp` during go() whose command has the Continue flag (and no condition error) is transient. */
  private isTransient(cp: { command?: string; commandEnabled?: boolean; commandContinue?: boolean }, message?: string): boolean {
    return !!this.job?.continuable && !message && !!cp.command && cp.commandEnabled !== false && !!cp.commandContinue;
  }

  /** Global address a breakpoint is restricted to: explicit, or from a logical $PPAAAA address. */
  private breakpointGlobal(address: number, global: number | undefined): number | undefined {
    if (global !== undefined || address <= 0xffff) return global;
    try {
      return logicalToGlobal(address);
    } catch {
      return undefined;
    }
  }

  /** Synchronous expression environment over the simulator (conditions). */
  exprEnv(): SyncExprEnv {
    const lookup = (name: string): IdentValue | undefined => {
      const v = this.debugInfo?.lookup?.(name);
      if (v) return v;
      const r = canonicalRegister(name);
      return r ? { kind: 'register', name: r } : undefined;
    };
    return {
      lookup,
      readMemory: (address, size) => {
        let v = 0;
        for (let i = 0; i < size; i++) {
          const b = this.peekAny(address + i, 'local');
          v = v * 256 + (b < 0 ? 0 : b);
        }
        return v;
      },
      readRegister: (name) => this.registersSync()[name],
    };
  }

  private evalCondition(cond: string): boolean {
    return evaluateSync(cond, this.exprEnv(), { dollarRegisters: true }) !== 0;
  }

  async addBreakpoint(spec: BreakpointSpec): Promise<Breakpoint> {
    const bp: Breakpoint = {
      ...spec,
      counter: spec.counter ? { ...spec.counter } : undefined,
      id: this.nextBpId++,
      temporary: spec.temporary ?? false,
      enabled: spec.enabled ?? true,
      hits: 0,
    };
    bp.global = this.breakpointGlobal(bp.address, spec.global);
    // hiwave keeps one breakpoint per address: a new one replaces the old
    this.bps = this.bps.filter((b) => !(b.address === bp.address && b.global === bp.global));
    this.bps.push(bp);
    this.touch();
    this.applyBreakpoints();
    this.emit({ type: 'breakpoints' });
    return { ...bp };
  }

  async updateBreakpoint(id: number, patch: Partial<BreakpointSpec>): Promise<Breakpoint> {
    const bp = this.bps.find((b) => b.id === id);
    if (!bp) throw new Error(`no breakpoint #${id}`);
    Object.assign(bp, patch);
    if (patch.counter) bp.counter = { ...patch.counter };
    if (patch.address !== undefined && patch.global === undefined) bp.global = this.breakpointGlobal(bp.address, undefined);
    this.touch();
    this.applyBreakpoints();
    this.emit({ type: 'breakpoints' });
    return { ...bp };
  }

  async removeBreakpoint(id: number): Promise<boolean> {
    const n = this.bps.length;
    this.bps = this.bps.filter((b) => b.id !== id);
    if (this.bps.length === n) return false;
    this.touch();
    this.applyBreakpoints();
    this.emit({ type: 'breakpoints' });
    return true;
  }

  async clearBreakpoints(): Promise<void> {
    this.bps = [];
    this.touch();
    this.applyBreakpoints();
    this.emit({ type: 'breakpoints' });
  }

  breakpoints(): Breakpoint[] {
    return this.bps.map((b) => ({ ...b, counter: b.counter ? { ...b.counter } : undefined }));
  }

  async addWatchpoint(spec: WatchpointSpec): Promise<Watchpoint> {
    const wp: Watchpoint = {
      ...spec,
      counter: spec.counter ? { ...spec.counter } : undefined,
      id: this.nextWpId++,
      end: spec.end ?? spec.start,
      space: spec.space ?? 'local',
      enabled: spec.enabled ?? true,
      hits: 0,
    };
    this.wps.push(wp);
    this.touch();
    this.applyBreakpoints();
    this.emit({ type: 'watchpoints' });
    return { ...wp };
  }

  async updateWatchpoint(id: number, patch: Partial<WatchpointSpec>): Promise<Watchpoint> {
    const wp = this.wps.find((w) => w.id === id);
    if (!wp) throw new Error(`no watchpoint #${id}`);
    Object.assign(wp, patch);
    if (patch.counter) wp.counter = { ...patch.counter };
    this.touch();
    this.applyBreakpoints();
    this.emit({ type: 'watchpoints' });
    return { ...wp };
  }

  async removeWatchpoint(id: number): Promise<boolean> {
    const n = this.wps.length;
    this.wps = this.wps.filter((w) => w.id !== id);
    if (this.wps.length === n) return false;
    this.touch();
    this.applyBreakpoints();
    this.emit({ type: 'watchpoints' });
    return true;
  }

  async clearWatchpoints(): Promise<void> {
    this.wps = [];
    this.touch();
    this.applyBreakpoints();
    this.emit({ type: 'watchpoints' });
  }

  watchpoints(): Watchpoint[] {
    return this.wps.map((w) => ({ ...w, counter: w.counter ? { ...w.counter } : undefined }));
  }

  // ------------------------------------------------------------------------------------------ memory / registers

  /** Global address of a local/logical/global address, or -1 if it cannot be mapped. */
  private toGlobalAddr(address: number, space: AddressSpace): number {
    if (space === 'global') return address;
    if (address <= 0xffff) return this.system.toGlobal(address);
    try {
      return logicalToGlobal(address);
    } catch {
      return -1;
    }
  }

  /** Side-effect-free byte read; -1 = unmapped. */
  peekAny(address: number, space: AddressSpace = 'local'): number {
    const g = this.toGlobalAddr(address, space);
    return g < 0 ? -1 : this.system.peekGlobal(g);
  }

  async readMemory(address: number, length: number, space: AddressSpace = 'local'): Promise<MemoryBlock> {
    return this.readMemorySync(address, length, space);
  }

  readMemorySync(address: number, length: number, space: AddressSpace = 'local'): MemoryBlock {
    const bytes = new Uint8Array(length);
    const status = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const a = space === 'local' && address <= 0xffff ? (address + i) & 0xffff : address + i;
      const g = this.toGlobalAddr(a, space);
      const v = g < 0 ? -1 : this.system.peekGlobal(g);
      if (v < 0) status[i] = MEM_UNMAPPED;
      else {
        bytes[i] = v;
        status[i] = this.system.isInitialized(g, 'global') ? MEM_OK : MEM_UNINITIALIZED;
      }
    }
    return { address, space, bytes, status };
  }

  async writeMemory(address: number, data: ArrayLike<number>, space: AddressSpace = 'local'): Promise<void> {
    for (let i = 0; i < data.length; i++) {
      const a = space === 'local' && address <= 0xffff ? (address + i) & 0xffff : address + i;
      const g = this.toGlobalAddr(a, space);
      if (g < 0 || this.system.peekGlobal(g) < 0) throw new Error(`cannot write to unmapped address 0x${a.toString(16).toUpperCase()}`);
      this.system.pokeGlobal(g, data[i] & 0xff);
    }
    this.emit({ type: 'memory' });
  }

  registersSync(): RegisterSet {
    const r = this.system.registers;
    const page = (a: number) => Math.max(0, this.system.peek(a));
    return {
      A: r.a,
      B: r.b,
      D: r.d,
      X: r.x,
      Y: r.y,
      SP: r.sp,
      PC: r.pc,
      CCR: r.ccr,
      IPL: r.ipl,
      CCRW: r.ccrw,
      PPAGE: page(0x30),
      RPAGE: page(0x16),
      EPAGE: page(0x17),
      GPAGE: page(0x10),
      DIRECT: page(0x11),
    };
  }

  async readRegisters(): Promise<RegisterSet> {
    return this.registersSync();
  }

  async writeRegister(name: RegisterName, value: number): Promise<void> {
    const sys = this.system;
    const pageAddr = PAGE_REGS[name];
    if (pageAddr !== undefined) sys.poke(pageAddr, value & 0xff);
    else {
      const key = ({ A: 'a', B: 'b', D: 'd', X: 'x', Y: 'y', SP: 'sp', PC: 'pc', CCR: 'ccr', IPL: 'ipl', CCRW: 'ccrw' } as const)[name as 'A'];
      if (!key) throw new Error(`unknown register ${name}`);
      sys.setRegisters({ [key]: value });
    }
    this.emit({ type: 'memory' });
  }

  async dispose(): Promise<void> {
    await this.stopIfRunning();
    this.unsubscribeSim();
    this.listeners.clear();
  }
}


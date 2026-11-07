/**
 * DebugSession: one hiwave debugger instance. Ties together the connection's project file (`<Connection>.ini`),
 * the Target, symbols of the loaded `.abs`, the command interpreter, command-file hooks (STARTUP / RESET /
 * PRELOAD / POSTLOAD / SETCPU), Data-window expressions (`<app>.xpr`) and breakpoint persistence (`<app>.bpt`).
 *
 * Post-load behaviour follows the files (critique G5): Full Chip Simulation has a comment-only postload and
 * `LoadDialogOptions=... NORUNAFTERLOAD`, so it stops at the entry ($C000); the P&E postload runs `bs &main t` + `g`,
 * so it stops at `main`. `RUNANDSTOPAFTERLOAD="main"` sets a temporary breakpoint and runs.
 */
import { parseIni, parseXpr, writeXpr, type IniDocument } from '@s12/formats';
import { writeBpt } from './bpt';
import { CommandInterpreter, type CommandHost, type InterpreterOptions, type OutputKind, type OutputLine, type UiHandler } from './commands';
import { baseName, dirName, joinPath, nodeFileSystem, readText, resolvePathCI, stripExtension, findInPaths, type DebugFileSystem } from './fs';
import { SimTarget, type SimTargetOptions } from './sim-target';
import { DebugSymbols, SourceResolver } from './symbols';
import { haltStatusText, type HaltInfo, type Target, type TargetDebugInfo, type TargetEvent } from './target';

export type HookKind = 'STARTUP' | 'RESET' | 'PRELOAD' | 'POSTLOAD' | 'SETCPU' | 'VPPON' | 'VPPOFF' | 'UNSECURE';

const HOOK_NAMES: Record<string, string> = {
  STARTUP: 'Startup',
  RESET: 'Reset',
  PRELOAD: 'Preload',
  POSTLOAD: 'Postload',
  SETCPU: 'SetCPU',
  VPPON: 'Vppon',
  VPPOFF: 'Vppoff',
  UNSECURE: 'Unsecure',
};

export interface LoadDialogOptions {
  autoEraseAndFlash: boolean;
  /** 'stop' (NORUNAFTERLOAD), 'run' (RUNAFTERLOAD), 'run-and-stop' (RUNANDSTOPAFTERLOAD="fn"). */
  run: 'stop' | 'run' | 'run-and-stop';
  stopAt?: string;
  codeOnly: boolean;
  symbolsOnly: boolean;
  noBpt: boolean;
  noXpr: boolean;
  noPreload: boolean;
  noPostload: boolean;
  verify: boolean;
}

/**
 * Parse `LoadDialogOptions` / LOAD command options. UNCERTAIN: with neither NORUNAFTERLOAD nor a RUN option the
 * load dialog's "Run after successful load" default is unknown; we stop.
 */
export function parseLoadOptions(words: string | readonly string[]): LoadDialogOptions {
  const list = typeof words === 'string' ? (words.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) : [...words];
  const o: LoadDialogOptions = {
    autoEraseAndFlash: false,
    run: 'stop',
    codeOnly: false,
    symbolsOnly: false,
    noBpt: false,
    noXpr: false,
    noPreload: false,
    noPostload: false,
    verify: false,
  };
  for (const w of list) {
    const [k, v] = w.split('=');
    switch (k.toUpperCase()) {
      case 'AUTOERASEANDFLASH':
        o.autoEraseAndFlash = true;
        break;
      case 'NORUNAFTERLOAD':
        o.run = 'stop';
        break;
      case 'RUNAFTERLOAD':
        o.run = 'run';
        break;
      case 'RUNANDSTOPAFTERLOAD':
        o.run = 'run-and-stop';
        o.stopAt = v?.replace(/^"|"$/g, '') || 'main';
        break;
      case 'CODEONLY':
        o.codeOnly = true;
        break;
      case 'SYMBOLSONLY':
        o.symbolsOnly = true;
        break;
      case 'NOBPT':
        o.noBpt = true;
        break;
      case 'NOXPR':
        o.noXpr = true;
        break;
      case 'NOPRELOADCMD':
        o.noPreload = true;
        break;
      case 'NOPOSTLOADCMD':
        o.noPostload = true;
        break;
      default:
        if (k.toUpperCase().startsWith('VERIFY')) o.verify = true;
    }
  }
  return o;
}

export interface XprItem {
  expression: string;
  component: string;
}

export interface DebugSessionOptions {
  fs?: DebugFileSystem;
  /** Project directory (the ini's directory). */
  projectDir?: string;
  ini?: IniDocument;
  iniPath?: string;
  /** Use this target instead of creating one. */
  target?: Target;
  /** Create the target for the ini's `Target=` (sim, icd12...). Default: SimTarget for every connection named 'sim'. */
  createTarget?: (kind: string) => Target;
  /** Options for the default SimTarget. */
  sim?: SimTargetOptions;
  ui?: UiHandler;
  /** CodeWarrior install directory for `{Compiler}` in environment paths (usually absent). */
  compilerDir?: string;
  interpreter?: InterpreterOptions;
  /** Print simulator warnings (FCS Warning ...) in the command window (default true). */
  showSimWarnings?: boolean;
  /** Write the .bpt file whenever breakpoints change while SAVEBP is on (default true). */
  autoSaveBpt?: boolean;
  /**
   * Keep the target's breakpoints/watchpoints when code is (re)loaded. Default false: a code load clears them and
   * only the `.bpt` restores breakpoints (UNCERTAIN: hiwave's exact behaviour), so stale addresses from a previous
   * build do not survive.
   */
  keepControlPointsOnLoad?: boolean;
  /** Echo the `.bpt` script's commands into the Command window when it is restored (default false). */
  echoBpt?: boolean;
}

export type SessionEvent =
  | { type: 'output'; line: OutputLine }
  | { type: 'loaded'; absPath: string; symbols: DebugSymbols }
  | { type: 'halted'; info: HaltInfo; source?: SourceLocation }
  | { type: 'running' }
  | { type: 'breakpoints' }
  | { type: 'expressions'; expressions: XprItem[] }
  | { type: 'hooks' }
  | { type: 'target'; event: TargetEvent };

export interface SourceLocation {
  /** DWARF file path (`...\bin\main.dbg`). */
  file: string;
  line: number;
  /** Resolved on-disk path, when found. */
  path?: string;
}

export class DebugSession implements CommandHost {
  readonly fs: DebugFileSystem;
  readonly target: Target;
  readonly interp: CommandInterpreter;
  readonly projectDir: string;
  readonly ini: IniDocument | null;
  readonly iniPath?: string;
  /** `Target=` of [HI-WAVE] (sim, icd12...). */
  readonly connection: string;
  readonly layout?: string;
  loadOptions: LoadDialogOptions;
  /** Environment variables (paths expanded). */
  readonly env = new Map<string, string>();
  readonly hooks = new Map<string, { enabled: boolean; file: string }>();
  symbols: DebugSymbols | null = null;
  absPath?: string;
  expressions: XprItem[] = [];
  saveBp = false;
  readonly sources: SourceResolver;
  private listeners = new Set<(e: SessionEvent) => void>();
  private opts: DebugSessionOptions;
  private lastRunKind: string | null = null;
  private bptDirty = false;
  private loadingBpt = false;

  constructor(opts: DebugSessionOptions = {}) {
    this.opts = opts;
    this.fs = opts.fs ?? nodeFileSystem;
    this.projectDir = opts.projectDir ?? (opts.iniPath ? dirName(opts.iniPath) : '.');
    this.ini = opts.ini ?? null;
    this.iniPath = opts.iniPath;
    this.connection = (this.ini?.get('HI-WAVE', 'Target') ?? 'sim').trim();
    this.layout = this.ini?.get('HI-WAVE', 'Layout')?.trim() || undefined;
    this.loadOptions = parseLoadOptions(this.ini?.get('HI-WAVE', 'LoadDialogOptions') ?? '');
    this.readEnvironment();
    this.target = opts.target ?? (opts.createTarget ? opts.createTarget(this.connection) : this.defaultTarget());
    this.sources = new SourceResolver(this.fs, this.searchPaths());
    this.interp = new CommandInterpreter(this, { ...opts.interpreter, ui: opts.ui ?? opts.interpreter?.ui });
    this.interp.onOutput((line) => this.emit({ type: 'output', line }));
    this.target.onEvent((e) => this.onTargetEvent(e));
  }

  /** Open a connection project file (`Full_Chip_Simulation.ini`...), configure hooks, run STARTUP (and SETCPU). */
  static async open(iniPath: string, opts: Omit<DebugSessionOptions, 'ini' | 'iniPath'> = {}): Promise<DebugSession> {
    const fs = opts.fs ?? nodeFileSystem;
    const ini = parseIni(await readText(fs, iniPath));
    const s = new DebugSession({ ...opts, fs, ini, iniPath, projectDir: opts.projectDir ?? dirName(iniPath) });
    await s.connect();
    return s;
  }

  private defaultTarget(): Target {
    if (this.connection.toLowerCase() !== 'sim')
      throw new Error(`connection '${this.connection}' needs a hardware target (pass createTarget); only 'sim' is built in`);
    return new SimTarget(this.opts.sim);
  }

  get baseDir(): string {
    return this.projectDir;
  }

  onEvent(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  print(text: string, kind: OutputKind = 'normal'): void {
    this.interp.print(text, kind);
  }

  /** Run a command line as typed in the Command window. */
  execute(line: string, opts?: { echo?: boolean }): Promise<boolean> {
    return this.interp.execute(line, opts);
  }

  // ------------------------------------------------------------------------------------------ ini / environment

  private readEnvironment(): void {
    if (!this.ini) return;
    const proj = this.projectDir.replace(/[\\/]$/, '') + '/';
    const comp = this.opts.compilerDir ? this.opts.compilerDir.replace(/[\\/]$/, '') + '/' : '';
    for (const [k, v] of this.ini.entries('Environment Variables')) {
      const parts = v
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => comp || !/\{Compiler\}/i.test(p))
        .map((p) => p.replace(/\{Project\}/gi, proj).replace(/\{Compiler\}/gi, comp).replace(/\\/g, '/'));
      this.env.set(k.toUpperCase(), parts.join(';'));
    }
  }

  /** Directories searched for sources (.dbg) and applications. */
  searchPaths(): string[] {
    const out: string[] = [];
    for (const k of ['OBJPATH', 'TEXTPATH', 'ABSPATH', 'GENPATH'])
      for (const p of (this.env.get(k) ?? '').split(';')) if (p && !out.includes(p)) out.push(p);
    for (const p of [joinPath(this.projectDir, 'bin'), joinPath(this.projectDir, 'Sources'), this.projectDir]) if (!out.includes(p)) out.push(p);
    return out;
  }

  /** Register the ini's `CMDFILEn=CMDFILE <kind> ON|OFF "file"` entries (all sections), then run STARTUP and SETCPU. */
  async connect(): Promise<void> {
    if (this.ini) {
      for (const section of this.ini.sections())
        for (const [k, v] of this.ini.entries(section)) if (/^CMDFILE\d+$/i.test(k)) await this.interp.execute(v, { echo: false });
    }
    await this.runHook('STARTUP');
    // UNCERTAIN: SETCPU runs when the FCS CPU is set; at connection time it is set once, after STARTUP.
    if (this.connection.toLowerCase() === 'sim') await this.runHook('SETCPU');
  }

  setCommandFile(kind: string, enabled: boolean, file: string): void {
    this.hooks.set(kind.toUpperCase(), { enabled, file });
    this.emit({ type: 'hooks' });
  }

  /** Run a hook command file if configured and enabled. Returns false if it failed. */
  async runHook(kind: HookKind | string): Promise<boolean> {
    const h = this.hooks.get(kind.toUpperCase());
    if (!h || !h.enabled || !h.file) return true;
    const path = await resolvePathCI(this.fs, this.projectDir, h.file);
    const name = HOOK_NAMES[kind.toUpperCase()] ?? kind;
    if (!path) {
      // UNCERTAIN: hiwave's text for a missing hook file
      this.print(`${name} command file ${h.file} not found`, 'warning');
      return false;
    }
    const r = await this.interp.executeScript(await readText(this.fs, path), { name: path, baseDir: this.projectDir });
    if (r.ok) this.print(`${name} command file correctly executed.`);
    return r.ok;
  }

  // ------------------------------------------------------------------------------------------ loading

  private async resolveApp(file: string): Promise<string | undefined> {
    return (await resolvePathCI(this.fs, this.projectDir, file)) ?? (await findInPaths(this.fs, baseName(file), this.searchPaths()));
  }

  /** CommandHost.load (LOAD command). */
  async load(file: string | undefined, options: string[] = []): Promise<void> {
    const f = file ?? this.absPath;
    if (!f) throw new Error('LOAD: no application to load');
    await this.loadApplication(f, options.length ? parseLoadOptions([...options]) : undefined);
  }

  /**
   * Load an application: PRELOAD hook, code (ELF PT_LOAD, so the EEPROM library is included), symbols, .xpr,
   * .bpt, POSTLOAD hook, then the load dialog's run option.
   */
  async loadApplication(file: string, options?: Partial<LoadDialogOptions>): Promise<void> {
    const o: LoadDialogOptions = { ...this.loadOptions, ...options };
    const path = await this.resolveApp(file);
    if (!path) throw new Error(`Could not open ${file}`);
    if (!o.noPreload) await this.runHook('PRELOAD');
    const bytes = await this.fs.readFile(path);
    if (!o.symbolsOnly) {
      await this.target.load({ kind: 'abs', data: bytes, name: baseName(path) });
      if (!this.opts.keepControlPointsOnLoad) {
        // UNCERTAIN: hiwave drops control points on a code load; the .bpt (below) restores breakpoints.
        // loadingBpt suppresses the .bpt auto-save, which would otherwise overwrite the file with an empty list.
        this.loadingBpt = true;
        try {
          await this.target.clearBreakpoints();
          await this.target.clearWatchpoints();
        } finally {
          this.loadingBpt = false;
        }
      }
    }
    if (!o.codeOnly) {
      this.symbols = DebugSymbols.fromAbs(bytes);
      for (const w of this.symbols.warnings) this.print(w, 'warning');
      this.sources.searchPaths = [dirName(path), ...this.searchPaths()];
      this.sources.clear();
      for (const src of this.symbols.sourceFiles()) await this.sources.resolve(src);
      this.target.setDebugInfo(this.debugInfo());
    }
    this.absPath = path;
    if (!o.noXpr) await this.loadExpressions();
    if (!o.noBpt) await this.loadBreakpoints();
    this.emit({ type: 'loaded', absPath: path, symbols: this.symbols ?? DebugSymbols.empty() });
    if (!o.noPostload) await this.runHook('POSTLOAD');
    if (this.target.state === 'halted' && o.run !== 'stop') {
      if (o.run === 'run-and-stop' && o.stopAt) {
        const a = await this.interp.evaluate(o.stopAt, { address: true });
        await this.target.addBreakpoint({ address: a, temporary: true, label: o.stopAt });
      }
      await this.target.go();
    }
  }

  /** CommandHost.loadSrec (SREC command). */
  async loadSrec(file: string, offset: number): Promise<void> {
    const path = await this.resolveApp(file);
    if (!path) throw new Error(`Could not open ${file}`);
    await this.target.load({ kind: 'srec', data: await this.fs.readFile(path), srecOffset: offset, name: baseName(path) }, { reset: false });
  }

  /** CommandHost.reset: target reset + RESET hook. */
  async reset(): Promise<void> {
    await this.target.reset();
    await this.runHook('RESET');
  }

  /** TargetDebugInfo for conditions and source stepping. */
  debugInfo(): TargetDebugInfo {
    return {
      lookup: (n) => this.interp.lookupIdent(n),
      lineAt: (a) => this.symbols?.lineAt(a),
      hasSource: (a) => {
        const r = this.symbols?.lineAt(a);
        return !!r && !!this.sources.resolvedSync(r.file);
      },
    };
  }

  /** Source file/line of an address. */
  sourceLocation(address: number): SourceLocation | undefined {
    const r = this.symbols?.lineAt(address);
    if (!r) return undefined;
    return { file: r.file, line: r.line, path: this.sources.resolvedSync(r.file) ?? undefined };
  }

  private appFile(ext: string): string | undefined {
    if (!this.absPath) return undefined;
    return joinPath(dirName(this.absPath), stripExtension(baseName(this.absPath)) + ext);
  }

  /** Existing companion file (case-insensitive extension), else the default name. */
  private async companion(ext: string): Promise<{ path: string; exists: boolean } | undefined> {
    const p = this.appFile(ext);
    if (!p) return undefined;
    const hit = await resolvePathCI(this.fs, dirName(p), baseName(p));
    return hit ? { path: hit, exists: true } : { path: p, exists: false };
  }

  // ------------------------------------------------------------------------------------------ .xpr

  async loadExpressions(): Promise<void> {
    const c = await this.companion('.xpr');
    this.expressions = [];
    if (c?.exists) {
      const x = parseXpr(await readText(this.fs, c.path));
      for (const w of x.warnings) this.print(`${baseName(c.path)}: ${w}`, 'warning');
      for (const e of x.entries) this.addExpression(e.expression, e.onlyIfNew, e.component, false);
    }
    this.emit({ type: 'expressions', expressions: [...this.expressions] });
  }

  addExpression(expression: string, onlyIfNew: boolean, component = 'Data', notify = true): void {
    if (onlyIfNew && this.expressions.some((e) => e.expression === expression && e.component === component)) return;
    this.expressions.push({ expression, component });
    if (notify) this.emit({ type: 'expressions', expressions: [...this.expressions] });
  }

  removeExpression(expression: string): void {
    this.expressions = this.expressions.filter((e) => e.expression !== expression);
    this.emit({ type: 'expressions', expressions: [...this.expressions] });
  }

  async saveExpressions(): Promise<void> {
    const c = await this.companion('.xpr');
    if (!c) return;
    await this.fs.writeFile(c.path, writeXpr(this.expressions.map((e) => ({ expression: e.expression, component: e.component, onlyIfNew: true }))));
  }

  /** Evaluate a Data-window expression. */
  async evaluateExpression(expression: string): Promise<{ value?: number; error?: string }> {
    try {
      return { value: await this.interp.evaluate(expression) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  // ------------------------------------------------------------------------------------------ .bpt

  setSaveBp(on: boolean): void {
    this.saveBp = on;
  }

  async loadBreakpoints(): Promise<void> {
    const c = await this.companion('.bpt');
    if (!c?.exists) return;
    this.loadingBpt = true;
    try {
      // UNCERTAIN: whether hiwave echoes the restored .bpt commands; default off
      await this.interp.executeScript(await readText(this.fs, c.path), { name: c.path, echo: this.opts.echoBpt ?? false });
    } finally {
      this.loadingBpt = false;
      this.bptDirty = false;
    }
  }

  /** Write `<app>.bpt` (savebp state + permanent breakpoints). */
  async saveBreakpoints(): Promise<string | undefined> {
    const c = await this.companion('.bpt');
    if (!c) return undefined;
    await this.fs.writeFile(c.path, writeBpt(this.target.breakpoints(), this.symbols, this.saveBp));
    return c.path;
  }

  private scheduleBptSave(): void {
    if (this.loadingBpt || !this.saveBp || this.opts.autoSaveBpt === false || !this.absPath || this.bptDirty) return;
    this.bptDirty = true;
    queueMicrotask(() => {
      this.bptDirty = false;
      this.saveBreakpoints().catch((e) => this.print(`could not save breakpoints: ${(e as Error).message}`, 'error'));
    });
  }

  // ------------------------------------------------------------------------------------------ layout

  /** Execute the `.hwl` layout script (OPEN/ATTRIBUTES/... go to the UI handler). */
  async runLayout(file = this.layout): Promise<boolean> {
    if (!file) return false;
    const path = await resolvePathCI(this.fs, this.projectDir, file);
    if (!path) {
      this.print(`Layout file ${file} not found`, 'warning');
      return false;
    }
    const r = await this.interp.executeScript(await readText(this.fs, path), { name: path });
    return r.ok;
  }

  // ------------------------------------------------------------------------------------------ target events

  private onTargetEvent(e: TargetEvent): void {
    this.emit({ type: 'target', event: e });
    switch (e.type) {
      case 'running':
        this.lastRunKind = e.kind;
        this.emit({ type: 'running' });
        break;
      case 'halted': {
        const info = e.info;
        const wasGo = this.lastRunKind === 'go';
        this.lastRunKind = null;
        const cp = info.breakpoint ?? info.watchpoint;
        if (info.transient) {
          // breakpoint command with Continue: run it and resume, without reporting a stop
          this.emit({ type: 'halted', info, source: this.sourceLocation(info.pc) });
          if (cp?.command) void this.runControlPointCommand(cp.command, true);
          break;
        }
        if (wasGo || info.reason === 'error' || info.reason === 'illegal-access') this.print(haltStatusText(info), info.reason === 'error' ? 'error' : 'normal');
        if (info.message && info.reason !== 'breakpoint') this.print(info.message, info.reason === 'error' ? 'error' : 'warning');
        else if (info.message && info.breakpoint) this.print(info.message, /Incorrect/.test(info.message) ? 'error' : 'normal');
        this.emit({ type: 'halted', info, source: this.sourceLocation(info.pc) });
        // a non-transient stop (a step, or a condition error) runs the command but does not resume
        if (cp?.command && cp.commandEnabled !== false) void this.runControlPointCommand(cp.command, false);
        break;
      }
      case 'breakpoints':
        this.emit({ type: 'breakpoints' });
        this.scheduleBptSave();
        break;
      case 'output':
        this.print(e.text, e.kind);
        break;
      case 'sim-event':
        if (this.opts.showSimWarnings !== false && e.event.kind !== 'reset') this.print(e.event.message, 'warning');
        break;
    }
  }

  private async runControlPointCommand(command: string, cont: boolean): Promise<void> {
    try {
      if (/^\s*(G|GO|S|STOP)\b/i.test(command)) this.print(`Command "${command}" is not allowed in a breakpoint`, 'error');
      else await this.interp.execute(command);
    } finally {
      // a transient halt must always resume, or waitForHalt() callers would wait for a stop that never comes
      if (cont && this.target.state === 'halted') await this.target.go();
    }
  }

  async dispose(): Promise<void> {
    await this.target.dispose();
    this.listeners.clear();
  }
}

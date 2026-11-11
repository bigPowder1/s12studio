/**
 * ProjectService: the IDE's open project (one at a time, like a single project window) over @s12/project.
 * Every edit is persisted to the sidecar by @s12/project; this service converts to DTOs and emits `project.changed`.
 */
import { readElf } from '@s12/formats';
import { buildStatus, createNodeFs, installCompilerRoot, newMinimalProject, newProjectFromTemplate, objectPathOf, openProject, type Project, type ProjectFs } from '@s12/project';
import { watch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';
import { ApiError } from '../../shared/api/common';
import type { DebuggerConfigInfo, NewProjectRequest, ProjectFileInfo, ProjectInfo, TargetInfo, ToolKey } from '../../shared/api/project';
import type { FileBuildInfoDTO } from '../../shared/api/build';
import type { EventBus } from '../events';

export interface ProjectServiceOptions {
  fs?: ProjectFs;
  /** CodeWarrior-like compiler root ({Compiler}); generated on first use when `ensureCompilerRoot` is set. */
  compilerDir?: string;
  ensureCompilerRoot?: boolean;
  /** Directory holding a user-supplied CodeWarrior `blank_project/` copy (New Project; templates-dir.ts). */
  templatesDir?: string;
  /** Watch the open project's .mcp and sidecar for changes by other programs (`project.externalChange`). */
  watchExternal?: boolean;
  /** Debounce of external-change checks (ms, default 250). */
  watchDebounceMs?: number;
}

export class ProjectService {
  readonly fs: ProjectFs;
  private project: Project | null = null;
  /** Code/Data columns from the last build, by lower-case file name. */
  private fileStats = new Map<string, { code: number; data: number }>();
  /** Touch column state (out of date), by lower-case file name. */
  private touched = new Map<string, boolean>();
  /** Files the user touched (Touch column click): reassembled by the next Make even when up to date. */
  private userTouched = new Set<string>();
  private compilerReady: Promise<void> | null = null;
  private dirWatcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly opts: ProjectServiceOptions = {},
  ) {
    this.fs = opts.fs ?? createNodeFs();
  }

  get compilerDir(): string | undefined {
    return this.opts.compilerDir;
  }

  private async ensureCompiler(): Promise<void> {
    if (!this.opts.compilerDir || !this.opts.ensureCompilerRoot) return;
    this.compilerReady ??= installCompilerRoot(this.fs, this.opts.compilerDir).then(() => undefined);
    await this.compilerReady;
  }

  /** The open project or an ApiError('no-project'). */
  require(): Project {
    if (!this.project) throw new ApiError('no-project', 'no project is open');
    return this.project;
  }

  get current(): Project | null {
    return this.project;
  }

  async open(path: string): Promise<ProjectInfo> {
    await this.ensureCompiler();
    let p: Project;
    try {
      p = await openProject(this.fs, path, { compilerDir: this.opts.compilerDir });
    } catch (e) {
      throw new ApiError('not-found', (e as Error).message);
    }
    this.project = p;
    this.fileStats.clear();
    this.touched.clear();
    this.userTouched.clear();
    this.startWatching(p);
    await this.refreshStatus();
    return await this.changed();
  }

  get templatesDir(): string | undefined {
    return this.opts.templatesDir;
  }

  /** Watch the project directory for writes to the .mcp / sidecar by other programs (CodeWarrior, an editor). */
  private startWatching(p: Project): void {
    this.stopWatching();
    if (!this.opts.watchExternal) return;
    const names = new Set([p.sidecarPath, p.mcpPath].filter((x): x is string => !!x).map((x) => basename(x).toLowerCase()));
    try {
      this.dirWatcher = watch(p.dir, { persistent: false }, (_ev, file) => {
        if (file && !names.has(String(file).toLowerCase())) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => void this.checkExternal(p), this.opts.watchDebounceMs ?? 250);
      });
      this.dirWatcher.on('error', () => this.stopWatching());
    } catch {
      this.dirWatcher = null; // unwatchable directory: no external-change events
    }
  }

  private stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.dirWatcher?.close();
    this.dirWatcher = null;
  }

  /** Compare the files with what we loaded/saved (content hashes: our own sidecar saves never count). */
  async checkExternal(p: Project | null = this.project): Promise<{ mcp: boolean; sidecar: boolean } | null> {
    if (!p || p !== this.project) return null;
    const r = await p.checkExternalChanges().catch(() => null);
    if (r && (r.mcp || r.sidecar) && p === this.project) this.bus.emit('project', 'externalChange', r, 'ide');
    return r;
  }

  async close(): Promise<void> {
    if (!this.project) return;
    this.stopWatching();
    this.project = null;
    this.fileStats.clear();
    this.touched.clear();
    this.userTouched.clear();
    this.bus.emit('project', 'closed', {});
  }

  async reload(): Promise<ProjectInfo> {
    const p = this.require();
    await p.load();
    await this.refreshStatus();
    return await this.changed();
  }

  async newProject(req: NewProjectRequest): Promise<ProjectInfo> {
    await this.ensureCompiler();
    const dest = `${req.dir.replace(/[\\/]+$/, '')}/${req.name}`;
    if (req.template === 'blank_project' && !this.opts.templatesDir)
      throw new ApiError('not-found', "no ME 3305 blank_project found in the templates folder: open a copy of the course's blank_project with File > Open... (or choose the generic project)");
    let r;
    try {
      r =
        req.template === 'blank_project'
          ? await newProjectFromTemplate(this.fs, `${this.opts.templatesDir}/blank_project`, dest, req.name)
          : await newMinimalProject(this.fs, dest, req.name);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const err = e as NodeJS.ErrnoException;
      // I/O failures keep their errno meaning; @s12/project's own checks (bad name, non-empty folder) are argument errors
      if (err?.code === 'ENOENT') throw new ApiError('not-found', err.message);
      if (typeof err?.code === 'string') throw new ApiError('io', err.message);
      throw new ApiError('invalid-argument', (e as Error).message);
    }
    return this.open(r.projectPath);
  }

  /** Run an edit on the open project and emit the new state. */
  async edit(fn: (p: Project) => Promise<unknown>): Promise<ProjectInfo> {
    const p = this.require();
    try {
      await fn(p);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('invalid-argument', (e as Error).message);
    }
    return await this.changed();
  }

  async setTouched(name: string, touched: boolean): Promise<ProjectInfo> {
    const f = this.require().file(name);
    if (!f) throw new ApiError('not-found', `"${name}" is not in the project`);
    // A touched file is reassembled by the next Make/Bring Up To Date (BuildOptions.forceFiles).
    // UNCERTAIN: untouching a file whose source really changed only clears the mark; the build still decides by content.
    const k = f.name.toLowerCase();
    if (touched) this.userTouched.add(k);
    else this.userTouched.delete(k);
    this.touched.set(k, touched);
    return await this.changed();
  }

  /** Names of the files the user touched (passed to the build as forceFiles). */
  userTouchedFiles(): string[] {
    const p = this.project;
    if (!p) return [];
    return p.files.filter((f) => this.userTouched.has(f.name.toLowerCase())).map((f) => f.name);
  }

  /** Record per-file build results (Code/Data columns; a touch mark is cleared only when that file assembled). */
  applyBuildFiles(files: FileBuildInfoDTO[]): void {
    for (const f of files) {
      const k = f.name.toLowerCase();
      this.fileStats.set(k, { code: f.code, data: f.data });
      if (f.ok) {
        this.touched.set(k, false);
        this.userTouched.delete(k);
      } else if (f.compiled) this.touched.set(k, true);
    }
  }

  /** Touch marks + Code/Data from @s12/project's read-only build status. */
  async refreshStatus(): Promise<void> {
    const p = this.project;
    if (!p) return;
    try {
      const st = await buildStatus(p);
      for (const f of st.files) {
        let { outOfDate, code, data } = f;
        // A project built by CodeWarrior (or copied from a lab PC) has no S12 Studio build cache: "never built".
        // Its own outputs tell the truth (final fidelity F5).
        if (outOfDate && f.reason === 'never built' && f.path) {
          const prior = await this.priorBuild(p, f.name, f.path);
          if (prior) ({ outOfDate, code, data } = { outOfDate: false, ...prior });
        }
        this.touched.set(f.name.toLowerCase(), outOfDate || this.userTouched.has(f.name.toLowerCase()));
        if (!outOfDate || code || data) this.fileStats.set(f.name.toLowerCase(), { code, data });
      }
    } catch {
      // status is cosmetic: a broken project still opens
    }
  }

  /**
   * Code/Data of an object CodeWarrior (or an earlier S12 Studio without cache) left behind, when that object and the
   * target's .abs are not older than the source. UNCERTAIN: CodeWarrior's own up-to-date test also covers includes and
   * options (kept in its binary .mcp/.tdt data); this only compares modification times, with 2 s slack for FAT/zip
   * timestamps. Make still reassembles such files (no cache), which gives byte-identical outputs.
   * Sizes: allocated PROGBITS sections count as Code, NOBITS (DS) as Data, as the assembler reports them.
   */
  private async priorBuild(p: Project, name: string, source: string): Promise<{ code: number; data: number } | null> {
    try {
      const fs = this.fs;
      const obj = objectPathOf(p, name, p.currentTarget.name);
      const [src, o] = await Promise.all([fs.stat(source), fs.stat(obj)]);
      if (!src || !o || o.isDirectory || o.mtime + 2000 < src.mtime) return null;
      const abs = p.currentTarget.absPath ? await fs.stat(p.currentTarget.absPath) : undefined;
      if (!abs || abs.mtime + 2000 < src.mtime) return null;
      const bytes = await fs.readFile(obj);
      if (!bytes) return null;
      let code = 0;
      let data = 0;
      for (const sec of readElf(bytes).sections) {
        if (!(sec.flags & 2)) continue; // SHF_ALLOC
        if (sec.type === 8) data += sec.size; // SHT_NOBITS
        else if (sec.type === 1) code += sec.size; // SHT_PROGBITS
      }
      return { code, data };
    } catch {
      return null;
    }
  }

  async debuggerConfig(target?: string): Promise<DebuggerConfigInfo> {
    return await this.require().debuggerConfig(target);
  }

  /** Emit `project.changed` with the full current state and return it. */
  async changed(): Promise<ProjectInfo> {
    const info = await this.fullInfo();
    this.bus.emit('project', 'changed', info);
    return info;
  }

  info(): ProjectInfo {
    const p = this.require();
    const files: ProjectFileInfo[] = p.files.map((f) => {
      const st = this.fileStats.get(f.name.toLowerCase());
      return {
        name: f.name,
        kind: f.kind,
        tool: f.tool,
        ignoredByMake: f.ignoredByMake,
        debug: f.debug,
        targets: [...f.targets],
        origin: f.origin,
        path: f.path,
        foundIn: f.foundIn,
        code: st?.code,
        data: st?.data,
        touched: this.touched.get(f.name.toLowerCase()),
      };
    });
    const targets: TargetInfo[] = p.targets.map((t) => ({
      name: t.name,
      linker: t.linker,
      outputDir: t.outputDir,
      outputDirPath: t.outputDirPath,
      outputFile: t.outputFile,
      absPath: t.absPath,
      accessPaths: { user: t.accessPaths.user.map((a) => ({ ...a })), system: t.accessPaths.system.map((a) => ({ ...a })) },
      options: { ...t.options } as Partial<Record<ToolKey, string>>,
      files: [...t.files],
      linkOrder: [...t.linkOrder],
      debugger: t.debugger ? { ...t.debugger } : undefined,
    }));
    return {
      path: p.mcpPath ?? p.sidecarPath,
      mcpPath: p.mcpPath,
      sidecarPath: p.sidecarPath,
      dir: p.dir,
      name: p.name,
      currentTarget: p.currentTarget.name,
      targets,
      files,
      groups: structuredClone(p.groups),
      connection: p.sidecar.connection,
      connections: [],
      warnings: [...p.warnings],
      mcpChangedExternally: p.mcpChangedExternally,
    };
  }

  /** ProjectInfo including the connection list (async: reads the .ini files). */
  async fullInfo(): Promise<ProjectInfo> {
    const info = this.info();
    info.connections = await this.require().listConnections();
    return info;
  }
}

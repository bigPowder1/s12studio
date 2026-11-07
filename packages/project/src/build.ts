/**
 * Build ("Make") orchestration: assembler -> SmartLinker -> Burner, the way the CodeWarrior IDE drives them.
 *
 * Verified against the golden .note sections of fixtures/Lab3 and fixtures/blank_project:
 *  - assembler command line = "<Assembler panel options> -env\"GENPATH=<access paths>\" -env\"OBJPATH=<out>\"
 *    -env\"TEXTPATH=<out>\" -objn\"<proj>_Data\\<Target>\\ObjectCode\\<file>.o\" "; GENPATH lists the target's
 *    access paths that exist (user, then system, not recursive), OBJPATH = TEXTPATH = the output directory;
 *  - linker command line = linkerCommandLine(<link-order inputs>, <abs>, [GENPATH, OBJPATH, TEXTPATH]);
 *  - the burner runs the project's .bbl on the .abs (%ABS_FILE% = the .abs path).
 * Paths that end up inside outputs are "tool paths" (paths.ts PathMapper): pass `toolRoots` to reproduce a lab PC.
 *
 * Up-to-date tracking ('<name>_Data/<Target>/s12studio-build.json', never CodeWarrior's TargetDataWindows.tdt):
 * every file a tool read is recorded with mtime, size and a content hash taken from the bytes the tool actually saw
 * (so an edit within the file system's mtime resolution, or during the build, is still noticed), and every path a
 * tool probed without finding a file is recorded too (a new include that would now be found earlier on GENPATH
 * triggers a rebuild). Output paths are stored relative to the project and validated on load: Clean and Remove
 * Object Code only ever delete regular files inside the project (or the target's output directory).
 */
import { assemble, formatMessage, type AsmMessage, type AssembleResult } from '@s12/asm';
import { latin1BestFitBytes } from '@s12/formats';
import { burn, burnFull, ctime, formatLinkMessage, link, linkerCommandLine, type LinkInputEntry, type LinkMessage, type LinkOptions } from '@s12/link';
import { bytesToLatin1, resolveCase, utf8Bytes, utf8Text, type ProjectFs } from './fs';
import { hashBytes, hashText } from './hash';
import type { Project, ProjectFile, ProjectTarget } from './model';
import { baseName, dirName, isAbsolutePath, isUnder, joinPath, normPath, PathMapper, relativePath, stemOf, type ToolRoots } from './paths';

export type BuildSeverity = 'error' | 'warning' | 'information';

export interface BuildMessage {
  severity: BuildSeverity;
  tool: 'assembler' | 'linker' | 'burner' | 'project';
  code?: string;
  text: string;
  /** real path of the file the message is about */
  file?: string;
  /** 1-based line (0/undefined when not tied to a line) */
  line?: number;
  column?: number;
  /** for messages inside a macro expansion: the outermost call site (real path) */
  callFile?: string;
  callLine?: number;
  /** CodeWarrior "Errors & Warnings" rendering, e.g. "Error   : A1104: Undeclared user defined symbol: FOO\nmain.asm line 42\n" */
  display: string;
}

export interface BuildProgress {
  step: 'check' | 'assemble' | 'link' | 'burn' | 'done';
  file?: string;
  done: number;
  total: number;
}

export interface BuildOptions {
  /** target name (default: the project's current target) */
  target?: string;
  onMessage?: (m: BuildMessage) => void;
  onProgress?: (p: BuildProgress) => void;
  /** tool-side {Project}/{Compiler} directories (golden builds use the lab PC's paths) */
  toolRoots?: ToolRoots;
  /** user name recorded in the .note sections (CodeWarrior: the Windows login). Default "user" */
  user?: string;
  /** .note time stamp per tool: ctime() text (no newline) or a Date. Default: now */
  stamp?: (tool: 'assembler' | 'linker') => string | Date;
  /** rebuild everything */
  force?: boolean;
  /**
   * Reassemble these sources (project file names, case-insensitive) even when up to date: the project window's
   * Touch mark. Make then relinks as for any recompiled file.
   */
  forceFiles?: readonly string[];
  /** also write our complete-image S19 '<abs>.full.s19' (default true) */
  fullS19?: boolean;
  /** cancels the build between files (the result then carries a "Build cancelled" error) */
  signal?: AbortSignal;
}

export interface FileBuildInfo {
  name: string;
  path?: string;
  object?: string;
  /** code + constant bytes (project window "Code" column) */
  code: number;
  /** variable bytes ("Data" column) */
  data: number;
  compiled: boolean;
  ok: boolean;
  /** real paths of the INCLUDEd files */
  includes: string[];
}

export interface BuildResult {
  ok: boolean;
  target: string;
  errors: number;
  warnings: number;
  messages: BuildMessage[];
  /** nothing had to be rebuilt */
  upToDate: boolean;
  compiled: string[];
  skipped: string[];
  linked: boolean;
  burned: boolean;
  /** real paths written */
  outputs: string[];
  /** the linked application; undefined when the link failed (stale outputs on disk must not be debugged) */
  absPath?: string;
  mapPath?: string;
  files: FileBuildInfo[];
  /** true when opts.signal aborted the build */
  cancelled?: boolean;
}

// ------------------------------------------------------------------------------------------------ build cache

interface Sig {
  mtime: number;
  size: number;
  /** content hash of the bytes the tool read */
  hash?: string;
}
interface CachedObject {
  /** dependency keys (see BuildContext.key): project-relative inside the project, absolute outside */
  source: string;
  /** every file the assembler read (source + includes) */
  deps: Record<string, Sig>;
  /** paths the assembler probed that did not exist */
  absent: string[];
  /** INCLUDEd files in include order (FileBuildInfo.includes) */
  includes: string[];
  cmd: string;
  /** output keys (validated on load: inside the project or the output directory) */
  object: string;
  outputs: string[];
  code: number;
  data: number;
}
interface CachedLink {
  cmd: string;
  /** the link inputs + PRM + BBL keys, in order */
  base: string[];
  /** every file read (base + PRM INCLUDEs) */
  deps: Record<string, Sig>;
  absent: string[];
  outputs: string[];
}
interface BuildCache {
  format: 's12studio-build';
  version: 2;
  target: string;
  objects: Record<string, CachedObject>;
  link?: CachedLink;
}

export const BUILD_CACHE_NAME = 's12studio-build.json';

const emptyCache = (target: string): BuildCache => ({ format: 's12studio-build', version: 2, target, objects: {} });

/** Locations a cache may name as build outputs (anything else is dropped, so Clean cannot be steered elsewhere). */
interface CacheScope {
  dir: string;
  /** directories outside the project where outputs are allowed (the target's output directory) */
  extraRoots: string[];
}

function cacheScope(project: Project, t: ProjectTarget): CacheScope {
  return { dir: project.dir, extraRoots: t.outputDirPath && !isUnder(t.outputDirPath, project.dir) ? [t.outputDirPath] : [] };
}

/** Cache key of a real path: project-relative ('/' separators) inside the project, absolute outside. */
function keyOf(scope: CacheScope, real: string): string {
  return isUnder(real, scope.dir) ? relativePath(scope.dir, real) : normPath(real);
}
function realOfKey(scope: CacheScope, key: string): string {
  return isAbsolutePath(key) ? normPath(key) : joinPath(scope.dir, key);
}
/** Real path of an output key, or undefined when it points outside the project/output directory. */
function outputOfKey(scope: CacheScope, key: unknown): string | undefined {
  if (typeof key !== 'string' || !key) return undefined;
  const p = realOfKey(scope, key);
  if (!isAbsolutePath(key)) return isUnder(p, scope.dir) && normPath(p) !== normPath(scope.dir) ? p : undefined;
  return scope.extraRoots.some((r) => isUnder(p, r) && normPath(p) !== normPath(r)) ? p : undefined;
}

const isSig = (s: unknown): s is Sig => !!s && typeof (s as Sig).mtime === 'number' && typeof (s as Sig).size === 'number';
const isStrArr = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string');
const isSigRec = (r: unknown): r is Record<string, Sig> => !!r && typeof r === 'object' && Object.values(r).every(isSig);

/** Load and validate the build cache: malformed entries are dropped; output paths outside the scope are dropped. */
async function loadCache(fs: ProjectFs, path: string, target: string, scope: CacheScope): Promise<BuildCache> {
  const b = await fs.readFile(path);
  if (!b) return emptyCache(target);
  let c: BuildCache;
  try {
    c = JSON.parse(utf8Text(b)) as BuildCache;
  } catch {
    return emptyCache(target);
  }
  if (!c || c.format !== 's12studio-build' || c.version !== 2 || !c.objects || typeof c.objects !== 'object') return emptyCache(target);
  const out = emptyCache(target);
  for (const [name, o] of Object.entries(c.objects)) {
    if (!o || typeof o.source !== 'string' || typeof o.cmd !== 'string' || !isSigRec(o.deps) || !isStrArr(o.absent) || !isStrArr(o.includes) || !isStrArr(o.outputs)) continue;
    if (!outputOfKey(scope, o.object) || !o.outputs.every((k) => outputOfKey(scope, k))) continue;
    out.objects[name] = { ...o, code: Number(o.code) || 0, data: Number(o.data) || 0 };
  }
  const l = c.link;
  if (l && typeof l.cmd === 'string' && isStrArr(l.base) && isSigRec(l.deps) && isStrArr(l.absent) && isStrArr(l.outputs) && l.outputs.every((k) => outputOfKey(scope, k))) out.link = l;
  return out;
}

/** Has a dependency changed since `s` was recorded? (mtime/size first; equal ones are confirmed by content hash) */
async function depChanged(fs: ProjectFs, real: string, s: Sig): Promise<boolean> {
  const st = await fs.stat(real);
  if (!st || st.isDirectory || st.mtime !== s.mtime || st.size !== s.size) return true;
  if (s.hash === undefined) return false;
  const b = await fs.readFile(real);
  return !b || hashBytes(b) !== s.hash;
}

// ------------------------------------------------------------------------------------------------ context

class BuildContext {
  readonly mapper: PathMapper;
  readonly target: ProjectTarget;
  readonly messages: BuildMessage[] = [];
  readonly outputs: string[] = [];
  /** real path (as requested) -> bytes (null = missing) */
  private readonly fileCache = new Map<string, Uint8Array | null>();
  /** requested real path -> real path that exists (case-resolved) */
  readonly resolved = new Map<string, string>();
  /** resolved real path -> signature at the time the bytes were read */
  private readonly readSigs = new Map<string, Sig>();
  readonly dirCache = new Map<string, string[] | undefined>();
  env: { GENPATH: string; OBJPATH: string; TEXTPATH: string } = { GENPATH: '', OBJPATH: '', TEXTPATH: '' };
  cache!: BuildCache;
  cacheDirty = false;
  readonly cachePath: string;
  scope!: CacheScope;

  constructor(readonly project: Project, readonly opts: BuildOptions) {
    this.target = project.target(opts.target);
    this.mapper = new PathMapper(project.dir, project.compilerDir, opts.toolRoots);
    this.cachePath = joinPath(project.targetDataDir(this.target.name), BUILD_CACHE_NAME);
  }

  get fs(): ProjectFs {
    return this.project.fs;
  }

  async init(opts: { mkdir?: boolean } = {}): Promise<void> {
    // The output directory must exist before GENPATH is computed: CodeWarrior's GENPATH lists {Project}bin.
    if (this.target.outputDirPath && opts.mkdir !== false) await this.fs.mkdirp(this.target.outputDirPath);
    await this.project.refresh();
    const t = this.project.target(this.target.name);
    Object.assign(this.target, t);
    const gen = [...t.accessPaths.user, ...t.accessPaths.system].filter((a) => a.exists && a.path).map((a) => this.mapper.toTool(a.path!));
    const out = t.outputDirPath ? this.mapper.toTool(t.outputDirPath) : this.mapper.toTool(this.project.dir);
    this.env = { GENPATH: gen.join(';'), OBJPATH: out, TEXTPATH: out };
    this.scope = cacheScope(this.project, t);
    this.cache = await loadCache(this.fs, this.cachePath, t.name, this.scope);
  }

  key(real: string): string {
    return keyOf(this.scope, real);
  }
  real(key: string): string {
    return realOfKey(this.scope, key);
  }

  cancelled(): boolean {
    if (!this.opts.signal?.aborted) return false;
    if (!this.messages.some((m) => m.text === 'Build cancelled')) this.message({ severity: 'error', tool: 'project', text: 'Build cancelled' });
    return true;
  }

  message(m: Omit<BuildMessage, 'display'> & { display?: string }): void {
    const full: BuildMessage = { ...m, display: m.display ?? defaultDisplay(m) };
    this.messages.push(full);
    this.opts.onMessage?.(full);
  }

  hasErrors(): boolean {
    return this.messages.some((m) => m.severity === 'error');
  }

  async write(real: string, bytes: Uint8Array): Promise<void> {
    await this.fs.writeFile(real, bytes);
    this.outputs.push(real);
    this.fileCache.delete(real);
    this.dirCache.delete(dirName(real));
  }

  /** Real path of a tool path, case-resolved when the file exists. */
  realOf(tool: string): string {
    const r = this.mapper.toReal(tool);
    return this.resolved.get(r) ?? r;
  }

  /** Read a file for a tool (case-insensitive), recording its signature from the bytes read. */
  async load(real: string): Promise<{ path: string; bytes: Uint8Array } | undefined> {
    const hit = await resolveCase(this.fs, real, this.dirCache);
    const st = hit ? await this.fs.stat(hit) : undefined;
    const bytes = hit && st && !st.isDirectory ? await this.fs.readFile(hit) : undefined;
    if (!hit || !st || !bytes) return undefined;
    // The stat is taken before the read: a save racing the build leaves a newer mtime and so a rebuild next time.
    if (!this.readSigs.has(hit)) this.readSigs.set(hit, { mtime: st.mtime, size: st.size, hash: hashBytes(bytes) });
    return { path: hit, bytes };
  }

  sigOfRead(resolved: string): Sig | undefined {
    return this.readSigs.get(resolved);
  }

  /**
   * Run a synchronous tool whose file reads go through `read(toolPath)`, loading missing files asynchronously and
   * re-running until every file the tool asked for is known (tools are pure, so a re-run is exact). Returns the
   * result plus the files read (resolved real paths) and the paths probed that do not exist.
   */
  async withFiles<T>(run: (read: (toolPath: string) => Uint8Array | undefined) => T): Promise<{ value: T; read: string[]; absent: string[] }> {
    for (let iter = 0; ; iter++) {
      const misses = new Set<string>();
      const requested = new Set<string>();
      const read = (tp: string) => {
        const real = this.mapper.toReal(tp);
        requested.add(real);
        const hit = this.fileCache.get(real);
        if (hit !== undefined) return hit ?? undefined;
        misses.add(real);
        return undefined;
      };
      const value = run(read);
      if (misses.size === 0 || iter >= 64) {
        const readFiles: string[] = [];
        const absent: string[] = [];
        for (const r of requested) {
          if (this.fileCache.get(r)) readFiles.push(this.resolved.get(r) ?? r);
          else absent.push(r);
        }
        return { value, read: readFiles, absent };
      }
      for (const real of misses) {
        const f = await this.load(real);
        this.fileCache.set(real, f?.bytes ?? null);
        if (f) this.resolved.set(real, f.path);
      }
    }
  }

  /** Signatures of the files a tool read, keyed for the cache. */
  depsOf(read: string[]): Record<string, Sig> {
    const deps: Record<string, Sig> = {};
    for (const p of read) {
      const s = this.readSigs.get(p);
      if (s) deps[this.key(p)] = s;
    }
    return deps;
  }

  /** True when every recorded dependency is unchanged and every recorded absent path is still absent. */
  async depsUnchanged(deps: Record<string, Sig>, absent: string[]): Promise<boolean> {
    for (const [k, s] of Object.entries(deps)) if (await depChanged(this.fs, this.real(k), s)) return false;
    for (const k of absent) {
      const hit = await resolveCase(this.fs, this.real(k), this.dirCache);
      if (hit && !(await this.fs.stat(hit))?.isDirectory) return false;
    }
    return true;
  }

  async saveCache(): Promise<void> {
    if (!this.cacheDirty) return;
    await this.fs.writeFile(this.cachePath, utf8Bytes(JSON.stringify(this.cache, null, 1) + '\n'));
    this.cacheDirty = false;
  }

  stamp(tool: 'assembler' | 'linker'): string {
    const s = this.opts.stamp?.(tool) ?? new Date();
    return typeof s === 'string' ? s.replace(/\n$/, '') : ctime(s);
  }

  get user(): string {
    return this.opts.user ?? 'user';
  }
}

function defaultDisplay(m: Omit<BuildMessage, 'display'>): string {
  const k = m.severity === 'error' ? 'Error' : m.severity === 'warning' ? 'Warning' : 'Information';
  const where = m.file ? (m.line ? `${baseName(m.file)} line ${m.line}\n` : `${baseName(m.file)}\n`) : '';
  return `${k.padEnd(8)}: ${m.code ? m.code + ': ' : ''}${m.text}\n${where}`;
}

/**
 * Bytes of a tool's text output (.lst, .dbg, .map: one char per byte). Sources are read as Latin-1, so a character
 * above U+00FF can only come from a path or the user name; it is written as '?' like CodeWarrior's 8-bit tools would.
 */
const textBytes = (text: string): Uint8Array => latin1BestFitBytes(text);
const sevOfAsm = (s: AsmMessage['severity']): BuildSeverity => (s === 'ERROR' || s === 'FATAL' ? 'error' : s === 'WARNING' ? 'warning' : 'information');
const sevOfLink = (s: LinkMessage['severity']): BuildSeverity => (s === 'error' || s === 'fatal' ? 'error' : s === 'warning' ? 'warning' : 'information');

// ------------------------------------------------------------------------------------------------ assembler step

/** Object file of a source: '<proj>_Data/<Target>/ObjectCode/<file>.o' (e.g. main.asm.o). */
export function objectPathOf(project: Project, file: string, target?: string): string {
  return joinPath(project.objectDir(target), baseName(file) + '.o');
}

/** The assembler command line the IDE would use (also recorded in the object's .note). */
export function assemblerCommandLine(options: string, env: { GENPATH: string; OBJPATH: string; TEXTPATH: string }, objectToolPath: string): string {
  let s = options ? options + ' ' : '';
  for (const [k, v] of Object.entries(env)) s += `-env"${k}=${v}" `;
  return s + `-objn"${objectToolPath}" `;
}

function assemblerCmdOf(ctx: BuildContext, f: ProjectFile): { cmd: string; objReal: string; objTool: string } {
  const objReal = objectPathOf(ctx.project, f.name, ctx.target.name);
  const objTool = ctx.mapper.toTool(objReal);
  return { cmd: assemblerCommandLine(ctx.target.options.assembler ?? '', ctx.env, objTool), objReal, objTool };
}

/** Why a source must be reassembled (undefined = up to date, with its cache entry). */
async function staleReason(ctx: BuildContext, f: ProjectFile, cmd: string): Promise<{ reason?: string; cached?: CachedObject }> {
  if (!f.path) return { reason: 'missing' };
  const c = ctx.cache.objects[f.name.toLowerCase()];
  if (!c) return { reason: 'never built' };
  if (c.cmd !== hashText(cmd)) return { reason: 'options changed' };
  if (normPath(ctx.real(c.source)) !== normPath(f.path)) return { reason: 'source moved' };
  if (!(await ctx.depsUnchanged(c.deps, c.absent))) return { reason: 'source or include changed' };
  for (const o of [c.object, ...c.outputs]) {
    const p = outputOfKey(ctx.scope, o);
    if (!p || !(await ctx.fs.exists(p))) return { reason: 'output missing' };
  }
  return { cached: c };
}

async function assembleFile(ctx: BuildContext, f: ProjectFile, force: boolean): Promise<FileBuildInfo> {
  const info: FileBuildInfo = { name: f.name, path: f.path, code: 0, data: 0, compiled: false, ok: false, includes: [] };
  if (!f.path) {
    // UNCERTAIN: CodeWarrior's wording for a project file missing from every access path.
    ctx.message({ severity: 'error', tool: 'project', text: `Could not find file "${f.name}" in the access paths of target "${ctx.target.name}"` });
    return info;
  }
  const { cmd } = assemblerCmdOf(ctx, f);
  if (!force) {
    const { cached: c } = await staleReason(ctx, f, cmd);
    if (c) {
      Object.assign(info, { object: ctx.real(c.object), code: c.code, data: c.data, ok: true, includes: c.includes.map((k) => ctx.real(k)) });
      return info;
    }
  }
  info.compiled = true;
  const srcTool = ctx.mapper.toTool(f.path);
  const time = ctx.stamp('assembler');
  const { value: r, read, absent } = await ctx.withFiles(
    (rd): AssembleResult => assemble({ sourcePath: srcTool, readFile: rd, options: cmd, noteMeta: { user: ctx.user, time, commandLine: cmd } }),
  );
  for (const m of r.messages) {
    ctx.message({
      severity: sevOfAsm(m.severity),
      tool: 'assembler',
      code: m.code,
      text: m.text,
      file: m.file ? ctx.realOf(m.file) : undefined,
      line: m.line || undefined,
      column: m.column || undefined,
      callFile: m.callFile ? ctx.realOf(m.callFile) : undefined,
      callLine: m.callLine,
      display: formatMessage(m, 'ide'),
    });
  }
  delete ctx.cache.objects[f.name.toLowerCase()];
  ctx.cacheDirty = true;
  if (!r.ok || !r.objectBytes) return info;
  const objPath = ctx.realOf(r.objectPath);
  await ctx.write(objPath, r.objectBytes);
  const outs: string[] = [];
  if (r.listing) {
    const p = ctx.realOf(r.listing.path);
    await ctx.write(p, textBytes(r.listing.text));
    outs.push(p);
  }
  // UNCERTAIN: the .dbg is written only for a successful assembly (like the listing).
  const dbgPath = ctx.realOf(r.dbg.path);
  await ctx.write(dbgPath, textBytes(r.dbg.text));
  outs.push(dbgPath);
  const includes = r.includes.map((inc) => ctx.realOf(inc));
  for (const s of r.sections) {
    if (s.type === 'data') info.data += s.size;
    else info.code += s.size;
  }
  const deps = ctx.depsOf(read);
  const srcKey = ctx.key(ctx.resolved.get(f.path) ?? f.path);
  const object = ctx.key(objPath);
  const outputs = outs.map((p) => ctx.key(p));
  // Outputs the tool was told to write outside the project/output directory are not cached (Clean never deletes them).
  if (deps[srcKey] && outputOfKey(ctx.scope, object) && outputs.every((k) => outputOfKey(ctx.scope, k))) {
    ctx.cache.objects[f.name.toLowerCase()] = {
      source: ctx.key(f.path),
      deps,
      absent: absent.map((p) => ctx.key(p)),
      includes: includes.map((p) => ctx.key(p)),
      cmd: hashText(cmd),
      object,
      outputs,
      code: info.code,
      data: info.data,
    };
  }
  Object.assign(info, { ok: true, object: objPath, includes });
  return info;
}

/** Sources the assembler builds for a target, in link order. */
export function sourcesOf(project: Project, target?: string): ProjectFile[] {
  return project.filesOf(target).filter((f) => f.kind === 'asm' && !f.ignoredByMake);
}

/** Files Make would hand to a tool we do not have (C sources): reported, never silently dropped. */
function unbuildableOf(project: Project, target?: string): ProjectFile[] {
  return project.filesOf(target).filter((f) => !f.ignoredByMake && (f.kind === 'c' || (f.kind !== 'asm' && /^Compiler\b/.test(f.tool))));
}

function reportUnbuildable(ctx: BuildContext): void {
  for (const f of unbuildableOf(ctx.project, ctx.target.name)) {
    ctx.message({ severity: 'warning', tool: 'project', text: `No C compiler in S12 Studio: "${f.name}" was not compiled and is not linked`, file: f.path });
  }
}

// ------------------------------------------------------------------------------------------------ link + burn step

function mapPathOf(absReal: string): string {
  // UNCERTAIN: SmartLinker writes the map next to the .abs with the .map extension (no MAPFILE name in the PRM).
  return joinPath(dirName(absReal), stemOf(absReal) + '.map');
}

/** Split an option string into tokens (double quotes group, as CodeWarrior's option parser does). */
function optionTokens(s: string): string[] {
  return [...s.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map((m) => m[0]);
}

/**
 * Linker panel options. Only -Alloc{First|Next|Change} changes our SmartLinker clone's behaviour; every other option
 * is reported as ignored. UNCERTAIN: CodeWarrior places the panel options before "-add(...)" on the command line.
 */
export function parseLinkerOptions(s: string): { options: LinkOptions; ignored: string[] } {
  const options: LinkOptions = {};
  const ignored: string[] = [];
  for (const tok of optionTokens(s)) {
    const m = /^-Alloc(First|Next|Change)$/i.exec(tok);
    if (m) options.alloc = m[1].toLowerCase() as LinkOptions['alloc'];
    else ignored.push(tok);
  }
  return { options, ignored };
}

interface LinkPlan {
  inputs: { entry: Omit<LinkInputEntry, 'bytes'>; real: string }[];
  prm: ProjectFile;
  bbl?: ProjectFile;
  absReal: string;
  absTool: string;
  mapReal: string;
  cmdLine: string;
  cmdHash: string;
  base: string[];
  linkOptions: LinkOptions;
}

/** Inputs and command line of the link; reports missing files (undefined = cannot link). */
function planLink(ctx: BuildContext, report: boolean): LinkPlan | undefined {
  const t = ctx.target;
  const project = ctx.project;
  const msg = (text: string) => report && ctx.message({ severity: 'error', tool: 'project', text });
  if (!t.absPath) {
    msg(`Target "${t.name}" has no output directory`);
    return undefined;
  }
  const files = project.filesOf(t.name);
  const inputs: LinkPlan['inputs'] = [];
  let ok = true;
  for (const f of files) {
    if (f.ignoredByMake) continue;
    if (f.kind === 'asm') {
      const real = objectPathOf(project, f.name, t.name);
      inputs.push({ entry: { name: f.name + '.o', kind: 'object', path: ctx.mapper.toTool(real) }, real });
    } else if (f.kind === 'lib' || f.kind === 'o') {
      if (!f.path) {
        msg(`Could not find file "${f.name}" in the access paths of target "${t.name}"`);
        ok = false;
        continue;
      }
      inputs.push({ entry: { name: f.name, kind: f.kind === 'lib' ? 'library' : 'object', path: ctx.mapper.toTool(f.path) }, real: f.path });
    }
  }
  const prm = files.find((f) => f.kind === 'prm' && f.path) ?? files.find((f) => f.kind === 'prm');
  if (!prm?.path) {
    // UNCERTAIN: wording.
    msg(prm ? `Could not find file "${prm.name}"` : `Target "${t.name}" has no linker parameter (.prm) file`);
    return undefined;
  }
  if (!ok) return undefined;
  const bbl = files.find((f) => f.kind === 'bbl' && f.path);
  const absReal = t.absPath;
  const absTool = ctx.mapper.toTool(absReal);
  const linkerOpts = (t.options.linker ?? '').trim();
  const { options: linkOptions, ignored } = parseLinkerOptions(linkerOpts);
  const cmdLine = (linkerOpts ? linkerOpts + ' ' : '') + linkerCommandLine(inputs.map((i) => i.entry.path!), absTool, Object.entries(ctx.env));
  if (report) {
    for (const o of ignored) ctx.message({ severity: 'warning', tool: 'linker', text: `Linker option "${o}" is not supported by S12 Studio and was ignored` });
    for (const o of optionTokens((t.options.burner ?? '').trim())) ctx.message({ severity: 'warning', tool: 'burner', text: `Burner option "${o}" is not supported by S12 Studio and was ignored` });
  }
  const base = [...inputs.map((i) => i.real), prm.path, ...(bbl?.path ? [bbl.path] : [])].map((p) => ctx.key(p));
  const cmdHash = hashText(JSON.stringify([cmdLine, t.options.burner ?? '', prm.path, bbl?.path ?? '', ctx.opts.fullS19 !== false]));
  return { inputs, prm, bbl, absReal, absTool, mapReal: mapPathOf(absReal), cmdLine, cmdHash, base, linkOptions };
}

async function linkIsUpToDate(ctx: BuildContext, plan: LinkPlan): Promise<boolean> {
  const prev = ctx.cache.link;
  if (!prev || prev.cmd !== plan.cmdHash || prev.base.length !== plan.base.length || prev.base.some((k, i) => k !== plan.base[i])) return false;
  for (const k of plan.base) if (!prev.deps[k]) return false;
  if (!(await ctx.depsUnchanged(prev.deps, prev.absent))) return false;
  for (const o of prev.outputs) {
    const p = outputOfKey(ctx.scope, o);
    if (!p || !(await ctx.fs.exists(p))) return false;
  }
  return true;
}

async function linkStep(ctx: BuildContext, compiledAny: boolean, force: boolean): Promise<{ linked: boolean; burned: boolean; absPath?: string; mapPath?: string }> {
  const plan = planLink(ctx, true);
  if (!plan || ctx.hasErrors()) return { linked: false, burned: false };
  const { prm, bbl, absReal, absTool, mapReal } = plan;
  if (!force && !compiledAny && (await linkIsUpToDate(ctx, plan))) {
    return { linked: false, burned: false, absPath: absReal, mapPath: (await ctx.fs.exists(mapReal)) ? mapReal : undefined };
  }
  if (ctx.cancelled()) return { linked: false, burned: false };

  ctx.opts.onProgress?.({ step: 'link', file: baseName(absReal), done: 0, total: 1 });
  const entries: LinkInputEntry[] = [];
  const baseRead: string[] = [];
  for (const i of plan.inputs) {
    const f = await ctx.load(i.real);
    if (!f) {
      ctx.message({ severity: 'error', tool: 'linker', text: `File not found: ${i.entry.name}`, file: i.real });
      continue;
    }
    baseRead.push(f.path);
    entries.push({ ...i.entry, bytes: f.bytes });
  }
  const prmFile = await ctx.load(prm.path!);
  if (!prmFile) ctx.message({ severity: 'error', tool: 'project', text: `Could not read "${prm.name}"`, file: prm.path });
  if (ctx.hasErrors() || !prmFile) return { linked: false, burned: false };
  baseRead.push(prmFile.path);
  const prmText = bytesToLatin1(prmFile.bytes);
  const created = ctx.stamp('linker') + '\n';
  const prmTool = ctx.mapper.toTool(prm.path!);
  const prmDirTool = ctx.mapper.toTool(dirName(prm.path!));
  /** PRM INCLUDE name as written -> tool path it was found at (messages inside it name the file as written) */
  const prmIncludes = new Map<string, string>();
  const { value: lr, read: incRead, absent } = await ctx.withFiles((read) =>
    link({
      inputs: entries,
      prmText,
      prmPath: prmTool,
      prmInclude: (file) => {
        // UNCERTAIN: PRM INCLUDE is searched in the PRM's directory, then GENPATH.
        for (const d of [prmDirTool, ...ctx.env.GENPATH.split(';').filter(Boolean)]) {
          const tp = d.endsWith('\\') || d.endsWith('/') ? d + file : `${d}${d.includes('\\') ? '\\' : '/'}${file}`;
          const b = read(tp);
          if (b) {
            prmIncludes.set(file, tp);
            return bytesToLatin1(b);
          }
        }
        return undefined;
      },
      outputPath: absTool,
      options: plan.linkOptions,
      noteMeta: { user: ctx.user, created, commandLine: plan.cmdLine },
    }),
  );
  for (const m of lr.messages) {
    // Messages name the PRM, a PRM INCLUDE file, an object or a library (tool paths or bare names).
    const inc = m.file !== undefined ? prmIncludes.get(m.file) : undefined;
    const file = !m.file ? undefined : m.file === prmTool ? prm.path : inc ? ctx.realOf(inc) : /[\\/]/.test(m.file) ? ctx.realOf(m.file) : undefined;
    ctx.message({ severity: sevOfLink(m.severity), tool: 'linker', code: m.code, text: m.text, file, line: m.line, display: formatLinkMessage(m) + '\n' + (file ? (m.line ? `${baseName(file)} line ${m.line}\n` : `${baseName(file)}\n`) : '') });
  }
  ctx.cache.link = undefined;
  ctx.cacheDirty = true;
  if (!lr.ok || !lr.absBytes) return { linked: false, burned: false };
  const outs: string[] = [];
  await ctx.write(absReal, lr.absBytes);
  outs.push(absReal);
  let mapPath: string | undefined;
  if (lr.mapText !== undefined) {
    await ctx.write(mapReal, textBytes(lr.mapText));
    outs.push(mapReal);
    mapPath = mapReal;
  }

  let burned = false;
  if (bbl?.path) {
    ctx.opts.onProgress?.({ step: 'burn', file: bbl.name, done: 0, total: 1 });
    const bf = await ctx.load(bbl.path);
    if (bf) baseRead.push(bf.path);
    const br = burn({ absBytes: lr.absBytes, bblText: bytesToLatin1(bf?.bytes ?? new Uint8Array()), bblPath: ctx.mapper.toTool(bbl.path), absPath: absTool });
    for (const w of br.warnings) ctx.message({ severity: 'warning', tool: 'burner', text: w, file: bbl.path });
    if (!br.ok) for (const m of br.messages) ctx.message({ severity: 'error', tool: 'burner', text: m, file: bbl.path });
    for (const o of br.outputs) {
      const p = ctx.realOf(o.path);
      await ctx.write(p, o.bytes);
      outs.push(p);
    }
    burned = br.ok;
  }
  if (ctx.opts.fullS19 !== false) {
    const full = burnFull(lr.absBytes, { absPath: absTool });
    const p = ctx.realOf(full.path);
    await ctx.write(p, full.bytes);
    outs.push(p);
  }
  const outputs = outs.map((p) => ctx.key(p)).filter((k) => outputOfKey(ctx.scope, k));
  if (!ctx.hasErrors()) {
    ctx.cache.link = { cmd: plan.cmdHash, base: plan.base, deps: ctx.depsOf([...baseRead, ...incRead]), absent: absent.map((p) => ctx.key(p)), outputs };
  }
  return { linked: true, burned, absPath: absReal, mapPath };
}

// ------------------------------------------------------------------------------------------------ public operations

function finish(ctx: BuildContext, r: Omit<BuildResult, 'ok' | 'errors' | 'warnings' | 'messages' | 'outputs' | 'target'>): BuildResult {
  const errors = ctx.messages.filter((m) => m.severity === 'error').length;
  const warnings = ctx.messages.filter((m) => m.severity === 'warning').length;
  ctx.opts.onProgress?.({ step: 'done', done: 1, total: 1 });
  const cancelled = !!ctx.opts.signal?.aborted && ctx.messages.some((m) => m.text === 'Build cancelled');
  return { ok: errors === 0, target: ctx.target.name, errors, warnings, messages: ctx.messages, outputs: ctx.outputs, ...r, ...(cancelled ? { cancelled } : {}) };
}

/** Build operations on one project run one at a time (Make is not re-entrant: it shares outputs and the cache). */
const queues = new WeakMap<Project, Promise<unknown>>();
function serialized<T>(project: Project, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(project) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(project, next);
  return next;
}

async function assembleAll(ctx: BuildContext, sources: ProjectFile[], force: boolean): Promise<FileBuildInfo[]> {
  const files: FileBuildInfo[] = [];
  const touched = new Set((ctx.opts.forceFiles ?? []).map((n) => n.toLowerCase()));
  for (let i = 0; i < sources.length; i++) {
    if (ctx.cancelled()) break;
    ctx.opts.onProgress?.({ step: 'assemble', file: sources[i].name, done: i, total: sources.length });
    files.push(await assembleFile(ctx, sources[i], force || touched.has(sources[i].name.toLowerCase())));
  }
  return files;
}

/** Project > Make: assemble out-of-date sources, then link and burn when anything changed. */
export function make(project: Project, opts: BuildOptions = {}): Promise<BuildResult> {
  return serialized(project, async () => {
    const ctx = new BuildContext(project, opts);
    await ctx.init();
    const force = !!opts.force;
    const sources = sourcesOf(project, ctx.target.name);
    opts.onProgress?.({ step: 'check', done: 0, total: sources.length });
    reportUnbuildable(ctx);
    const files = await assembleAll(ctx, sources, force);
    const compiled = files.filter((f) => f.compiled).map((f) => f.name);
    let link: Awaited<ReturnType<typeof linkStep>> = { linked: false, burned: false };
    if (!ctx.hasErrors() && !ctx.cancelled()) link = await linkStep(ctx, compiled.length > 0, force);
    await ctx.saveCache();
    return finish(ctx, {
      upToDate: compiled.length === 0 && !link.linked && !ctx.hasErrors(),
      compiled,
      skipped: files.filter((f) => !f.compiled).map((f) => f.name),
      linked: link.linked,
      burned: link.burned,
      absPath: link.absPath,
      mapPath: link.mapPath,
      files,
    });
  });
}

/** Project > Bring Up To Date: assemble out-of-date sources without linking. */
export function bringUpToDate(project: Project, opts: BuildOptions = {}): Promise<BuildResult> {
  return serialized(project, async () => {
    const ctx = new BuildContext(project, opts);
    await ctx.init();
    reportUnbuildable(ctx);
    const files = await assembleAll(ctx, sourcesOf(project, ctx.target.name), !!opts.force);
    await ctx.saveCache();
    const compiled = files.filter((f) => f.compiled).map((f) => f.name);
    return finish(ctx, { upToDate: compiled.length === 0, compiled, skipped: files.filter((f) => !f.compiled).map((f) => f.name), linked: false, burned: false, files });
  });
}

/** Project > Compile: assemble one source unconditionally (no link). */
export function compileFile(project: Project, name: string, opts: BuildOptions = {}): Promise<BuildResult> {
  return serialized(project, async () => {
    const ctx = new BuildContext(project, opts);
    await ctx.init();
    const f = project.file(name);
    const files: FileBuildInfo[] = [];
    if (!f) ctx.message({ severity: 'error', tool: 'project', text: `"${name}" is not in the project` });
    else if (f.kind === 'c') ctx.message({ severity: 'error', tool: 'project', text: `No C compiler in S12 Studio: "${f.name}" cannot be compiled`, file: f.path });
    else if (f.kind !== 'asm') ctx.message({ severity: 'error', tool: 'project', text: `"${f.name}" is not an assembler source file` });
    else files.push(await assembleFile(ctx, f, true));
    await ctx.saveCache();
    return finish(ctx, { upToDate: false, compiled: files.filter((x) => x.compiled).map((x) => x.name), skipped: [], linked: false, burned: false, files });
  });
}

/** Project > Preprocess: the HC12 assembler has no preprocessor; reports that and does nothing. */
export async function preprocessFile(project: Project, name: string): Promise<BuildMessage[]> {
  const f = project.file(name);
  const text = `Preprocess is not available for ${f?.name ?? name}: the HC12 assembler has no separate preprocessor`;
  return [{ severity: 'information', tool: 'project', text, file: f?.path, display: defaultDisplay({ severity: 'information', tool: 'project', text }) }];
}

export interface FileBuildStatus {
  name: string;
  path?: string;
  /** Make would reassemble the file (the project window's "touch" check mark) */
  outOfDate: boolean;
  /** 'never built' | 'options changed' | 'source moved' | 'source or include changed' | 'output missing' | 'missing' */
  reason?: string;
  /** Code/Data columns from the last successful assembly (0 when unknown) */
  code: number;
  data: number;
  includes: string[];
}

export interface BuildStatus {
  target: string;
  files: FileBuildStatus[];
  /** Make would relink */
  linkOutOfDate: boolean;
  /** the linked application when it is current */
  absPath?: string;
}

/**
 * Read-only build status for the project window (touch marks, Code/Data columns): nothing is assembled, linked or
 * written (not even the output directory).
 */
export function buildStatus(project: Project, opts: Pick<BuildOptions, 'target' | 'toolRoots' | 'fullS19'> = {}): Promise<BuildStatus> {
  return serialized(project, async () => {
    const ctx = new BuildContext(project, opts);
    await ctx.init({ mkdir: false });
    const files: FileBuildStatus[] = [];
    for (const f of sourcesOf(project, ctx.target.name)) {
      const { cmd } = assemblerCmdOf(ctx, f);
      const { reason, cached } = await staleReason(ctx, f, cmd);
      const c = cached ?? ctx.cache.objects[f.name.toLowerCase()];
      files.push({ name: f.name, path: f.path, outOfDate: !cached, reason, code: c?.code ?? 0, data: c?.data ?? 0, includes: c ? c.includes.map((k) => ctx.real(k)) : [] });
    }
    const plan = planLink(ctx, false);
    const linkOutOfDate = files.some((f) => f.outOfDate) || !plan || !(await linkIsUpToDate(ctx, plan));
    return { target: ctx.target.name, files, linkOutOfDate, absPath: !linkOutOfDate ? plan?.absReal : undefined };
  });
}

/** Delete one file when it is a regular file inside one of `roots`; returns whether it was deleted. */
async function removeFileSafely(fs: ProjectFs, p: string, roots: string[]): Promise<boolean> {
  if (!roots.some((r) => isUnder(p, r) && normPath(p) !== normPath(r))) return false;
  const st = await fs.stat(p);
  if (!st || st.isDirectory) return false;
  await fs.remove(p);
  return true;
}

async function removeObjectCodeOf(project: Project, targets: ProjectTarget[]): Promise<string[]> {
  const removed: string[] = [];
  for (const t of targets) {
    const objDir = project.objectDir(t.name);
    const scope = cacheScope(project, t);
    const cachePath = joinPath(project.targetDataDir(t.name), BUILD_CACHE_NAME);
    const cache = await loadCache(project.fs, cachePath, t.name, scope);
    const objects = new Set(sourcesOf(project, t.name).map((f) => objectPathOf(project, f.name, t.name)));
    // objects of files no longer in the project, as recorded in the cache (only those inside ObjectCode)
    for (const o of Object.values(cache.objects)) {
      const p = outputOfKey(scope, o.object);
      if (p) objects.add(p);
    }
    for (const o of objects) if (!removed.includes(o) && (await removeFileSafely(project.fs, o, [objDir]))) removed.push(o);
    if (await removeFileSafely(project.fs, cachePath, [project.targetDataDir(t.name)])) removed.push(cachePath);
  }
  return removed;
}

/**
 * Project > Remove Object Code: delete the objects we produce for the target(s) and our build cache. CodeWarrior's
 * TargetDataWindows.tdt, ObjectCode/project.ini and other foreign files are kept.
 */
export function removeObjectCode(project: Project, opts: { target?: string; allTargets?: boolean } = {}): Promise<string[]> {
  return serialized(project, () => removeObjectCodeOf(project, opts.allTargets ? project.targets : [project.target(opts.target)]));
}

/**
 * Remove Object Code plus every build output (listings, .dbg, .abs, .map, S-records). Only regular files inside the
 * project directory or the target's output directory are ever deleted, whatever the build cache says.
 */
export function clean(project: Project, opts: { target?: string; allTargets?: boolean } = {}): Promise<string[]> {
  return serialized(project, async () => {
    const targets = opts.allTargets ? project.targets : [project.target(opts.target)];
    const victims: { path: string; roots: string[] }[] = [];
    for (const t of targets) {
      const scope = cacheScope(project, t);
      const roots = [project.dir, ...scope.extraRoots];
      const cache = await loadCache(project.fs, joinPath(project.targetDataDir(t.name), BUILD_CACHE_NAME), t.name, scope);
      const add = (p: string | undefined) => p && victims.push({ path: p, roots });
      for (const o of Object.values(cache.objects)) o.outputs.forEach((k) => add(outputOfKey(scope, k)));
      cache.link?.outputs.forEach((k) => add(outputOfKey(scope, k)));
      if (t.absPath) {
        // the application files themselves may also live in an output directory outside the project
        const outRoots = t.outputDirPath ? [...roots, t.outputDirPath] : roots;
        for (const s of ['', '.s19', '.glo', '.full.s19']) victims.push({ path: t.absPath + s, roots: outRoots });
        victims.push({ path: mapPathOf(t.absPath), roots: outRoots });
      }
    }
    const removed = await removeObjectCodeOf(project, targets);
    for (const v of victims) if (!removed.includes(v.path) && (await removeFileSafely(project.fs, v.path, v.roots))) removed.push(v.path);
    return removed;
  });
}

/** Re-export for hosts that format messages themselves. */
export { formatMessage as formatAsmMessage, formatLinkMessage };

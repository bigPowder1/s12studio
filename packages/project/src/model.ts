/**
 * Project model: the decoded .mcp (read-only, @s12/formats readMcp) merged with the S12 Studio sidecar
 * '<name>.s12studio.json'. Specs: PLAN.md M6, docs/research/r2/mcp-format.md §2, §5, r1/ide.md §3-4.
 *
 * Files are stored in the .mcp by leaf name and found through the target's access paths (user paths, then system
 * paths); {Project} is the .mcp directory and {Compiler} our bundled tool root (compiler-root.ts).
 */
import { parseIni, readMcp, type McpGroupChild, type McpProject } from '@s12/formats';
import { bytesToLatin1, resolveCase, utf8Bytes, utf8Text, walkFiles, type ProjectFs } from './fs';
import { hashBytes } from './hash';
import { defaultGroupFor, defaultToolFor, fileKindOf, type FileKind } from './kinds';
import { baseName, dirName, extOf, isAbsolutePath, isUnder, joinPath, normPath, relativePath, stemOf, toSlash } from './paths';
import {
  emptySidecar,
  parseSidecar,
  stringifySidecar,
  type BaseFile,
  type BaseProject,
  type BaseTarget,
  type DebuggerSettings,
  type GroupChild,
  type GroupNode,
  type Sidecar,
  type SidecarTarget,
  type ToolKey,
  type ToolOptions,
} from './sidecar';

export const SIDECAR_SUFFIX = '.s12studio.json';

export interface AccessPathInfo {
  /** display form, e.g. "{Project}Sources" */
  display: string;
  /** real directory (undefined when the root is unknown, e.g. {Compiler} without a tool root) */
  path?: string;
  exists: boolean;
}

export interface ProjectTarget {
  name: string;
  linker: string;
  /** display form, e.g. "{Project}bin" */
  outputDir: string;
  /** real output directory */
  outputDirPath?: string;
  outputFile: string;
  /** real path of the linked application, e.g. "<dir>/bin/Project.abs" */
  absPath?: string;
  accessPaths: { user: AccessPathInfo[]; system: AccessPathInfo[] };
  /** effective tool options (.mcp panel field0, overridden by the sidecar) */
  options: ToolOptions;
  /** leaf names of the target's files */
  files: string[];
  /** effective link order (leaf names, every target file exactly once) */
  linkOrder: string[];
  debugger?: DebuggerSettings;
}

export interface ProjectFile {
  name: string;
  kind: FileKind;
  tool: string;
  ignoredByMake: boolean;
  debug: boolean;
  /** targets containing the file */
  targets: string[];
  /** where the file definition came from */
  origin: 'mcp' | 'sidecar' | 'base';
  /** resolved real path (undefined when not found) */
  path?: string;
  /** display form of the access path the file was found in */
  foundIn?: string;
}

export interface ConnectionInfo {
  /** .ini stem, e.g. "Full_Chip_Simulation", "P&E_Multilink_USB" */
  name: string;
  iniPath: string;
  /** [HI-WAVE] Target= value: "sim", "icd12", ... */
  target?: string;
}

export interface DebuggerConfig {
  /** "{Compiler}prog\\hiwave.exe" */
  app: string;
  appPath?: string;
  /** Build Extras arguments before expansion (after the connection override) */
  argsTemplate: string;
  /**
   * arguments with %targetFilePath / %projectFileDir expanded to normalised real paths, joined with spaces; tokens
   * containing white space are double-quoted (Windows command-line style). Prefer `argv`.
   */
  args: string;
  /** the expanded arguments as separate tokens (unquoted), ready for child_process.spawn */
  argv: string[];
  connection?: string;
  iniPath?: string;
  /** -instance= value */
  instance?: string;
  connections: ConnectionInfo[];
}

export interface OpenProjectOptions {
  /** real directory of our bundled {Compiler} root (see installCompilerRoot) */
  compilerDir?: string;
  /**
   * Access-path search: CodeWarrior's per-path Recursive flag is not decoded (mcp-format.md §2.5, UNCERTAIN).
   * 'fallback' (default) searches every path flat first, then recursively; 'never' / 'always' as named.
   */
  recursiveSearch?: 'never' | 'fallback' | 'always';
}

const TOOL_KEYS: ToolKey[] = ['assembler', 'compiler', 'linker', 'burner', 'importer', 'libmaker'];
const lc = (s: string) => s.toLowerCase();
const sameName = (a: string, b: string) => lc(a) === lc(b);

// ------------------------------------------------------------------------------------------------ .mcp -> base model

function convertGroups(children: McpGroupChild[]): GroupChild[] {
  const out: GroupChild[] = [];
  for (const c of children) {
    if (c.type === 'group') out.push({ type: 'group', name: c.name, children: convertGroups(c.children) });
    else if (c.name) out.push({ type: 'file', name: c.name });
  }
  return out;
}

export function baseFromMcp(mcp: McpProject): BaseProject {
  const targets: BaseTarget[] = mcp.targets.map((t) => {
    const options: ToolOptions = {};
    for (const k of TOOL_KEYS) if (t.toolOptions[k] !== undefined) options[k] = t.toolOptions[k];
    return {
      name: t.name,
      linker: t.settings.linker,
      outputDir: t.settings.outputDirPath?.display ?? (t.settings.outputDir ? `{Project}${t.settings.outputDir}` : '{Project}'),
      outputFile: t.settings.outputFile || baseName(t.settings.outputPath) || 'Project.abs',
      accessPaths: { user: [...t.accessPaths.user], system: [...t.accessPaths.system] },
      options,
      files: t.files.map((f) => f.name),
      linkOrder: [...t.linkOrder],
      debugger: t.buildExtras && { app: t.buildExtras.debuggerApp, args: t.buildExtras.args, initialDir: t.buildExtras.initialDir },
    };
  });
  const files: BaseFile[] = mcp.files.map((f) => {
    let kind = fileKindOf(f.name, f.tool);
    if (f.kind === 'asm' && kind !== 'asm') kind = 'asm';
    return { name: f.name, kind, tool: f.tool, ignoredByMake: f.ignoredByMake, debug: f.debug };
  });
  const wiz = mcp.wizard?.elements;
  const term = (n: string) => wiz?.find((e) => e.name === n)?.term;
  return {
    targets,
    files,
    groups: convertGroups(mcp.groups),
    wizard: mcp.wizard ? { chip: term('Chip'), language: term('Language'), connection: term('Target') } : undefined,
  };
}

// ------------------------------------------------------------------------------------------------ path expansion

/** Expand a CodeWarrior display path ("{Project}bin", "{Compiler}lib\\HC12c\\include", "E:\\x", "rel") to a real path. */
export function expandRootedPath(display: string, projectDir: string, compilerDir?: string): string | undefined {
  const m = /^\{(\w+)\}(.*)$/.exec(display);
  if (m) {
    const rest = toSlash(m[2]);
    switch (m[1].toLowerCase()) {
      case 'project':
        return joinPath(projectDir, rest);
      case 'compiler':
        return compilerDir ? joinPath(compilerDir, rest) : undefined;
      default:
        return undefined; // {System} and source trees are not supported. UNCERTAIN
    }
  }
  if (isAbsolutePath(display)) return normPath(display);
  return joinPath(projectDir, display);
}

/** Expand the HIWARE "{Project}" / "{Compiler}" macros inside a value (e.g. an .ini environment variable). */
export function expandIdeRoots(value: string, projectDir: string, compilerDir?: string): string {
  return value
    .replace(/\{Project\}/gi, normPath(projectDir) + '/')
    .replace(/\{Compiler\}/gi, compilerDir ? normPath(compilerDir) + '/' : '');
}

// ------------------------------------------------------------------------------------------------ Project

export class Project {
  /** real path of the .mcp (undefined for a standalone sidecar project) */
  readonly mcpPath?: string;
  readonly sidecarPath: string;
  readonly dir: string;
  /** project name = .mcp (or sidecar) stem; the .mcp does not store its own name */
  readonly name: string;
  readonly compilerDir?: string;
  readonly recursiveSearch: 'never' | 'fallback' | 'always';

  mcp?: McpProject;
  /** hash of the .mcp bytes at open time */
  mcpHash?: string;
  sidecar: Sidecar = emptySidecar();
  base: BaseProject = { targets: [], files: [], groups: [] };
  /** true when the .mcp hash differs from the one recorded in the sidecar (CodeWarrior changed it) */
  mcpChangedExternally = false;
  /** hash of the sidecar text as last read or written */
  private sidecarHash?: string;

  /** real path of '<name>_Data' (existing spelling kept when it differs in case) */
  dataDir: string;
  targets: ProjectTarget[] = [];
  files: ProjectFile[] = [];
  groups: GroupChild[] = [];
  warnings: string[] = [];

  constructor(readonly fs: ProjectFs, projectPath: string, opts: OpenProjectOptions = {}) {
    const p = normPath(projectPath);
    this.dir = dirName(p);
    if (p.toLowerCase().endsWith(SIDECAR_SUFFIX)) {
      this.name = baseName(p).slice(0, -SIDECAR_SUFFIX.length);
      this.sidecarPath = p;
    } else {
      this.name = stemOf(p);
      this.mcpPath = p;
      this.sidecarPath = joinPath(this.dir, this.name + SIDECAR_SUFFIX);
    }
    this.compilerDir = opts.compilerDir ? normPath(opts.compilerDir) : undefined;
    this.recursiveSearch = opts.recursiveSearch ?? 'fallback';
    this.dataDir = joinPath(this.dir, `${this.name}_Data`);
  }

  // ---------------------------------------------------------------- loading

  /** (Re)read the .mcp and the sidecar and rebuild the effective model. */
  async load(): Promise<void> {
    this.warnings = [];
    this.mcp = undefined;
    this.mcpHash = undefined;
    const sideBytes = await this.fs.readFile(this.sidecarPath);
    if (sideBytes) {
      const text = utf8Text(sideBytes);
      const { sidecar, warnings } = parseSidecar(text);
      this.sidecar = sidecar;
      this.sidecarHash = hashBytes(sideBytes);
      this.warnings.push(...warnings);
    } else {
      this.sidecar = emptySidecar();
      this.sidecarHash = undefined;
    }
    if (this.mcpPath) {
      const bytes = await this.fs.readFile(this.mcpPath);
      if (!bytes) throw new Error(`project file not found: ${this.mcpPath}`);
      this.mcp = readMcp(bytes);
      this.mcpHash = hashBytes(bytes);
      this.warnings.push(...this.mcp.warnings.map((w) => `${baseName(this.mcpPath!)}: ${w}`));
      this.base = baseFromMcp(this.mcp);
      this.mcpChangedExternally = !!this.sidecar.mcpHash && this.sidecar.mcpHash !== this.mcpHash;
      if (this.mcpChangedExternally) this.warnings.push(`${baseName(this.mcpPath)} was changed outside S12 Studio; settings re-imported and sidecar edits re-applied`);
    } else {
      if (!sideBytes) throw new Error(`project file not found: ${this.sidecarPath}`);
      if (!this.sidecar.base) throw new Error(`${this.sidecarPath} has no project definition ("base") and there is no .mcp`);
      this.base = this.sidecar.base;
    }
    const dataName = `${this.name}_Data`;
    const names = (await this.fs.readdir(this.dir)) ?? [];
    const hit = names.find((n) => n === dataName) ?? names.find((n) => sameName(n, dataName));
    this.dataDir = joinPath(this.dir, hit ?? dataName);
    await this.refresh();
  }

  /** Recompute targets, files and groups from base + sidecar, resolving file locations. */
  async refresh(): Promise<void> {
    const sc = this.sidecar;
    const removed = new Set(sc.removedFiles.map(lc));
    const files: ProjectFile[] = [];
    const byName = new Map<string, ProjectFile>();
    const allTargets = this.base.targets.map((t) => t.name);
    const addFile = (f: ProjectFile) => {
      if (byName.has(lc(f.name))) return;
      byName.set(lc(f.name), f);
      files.push(f);
    };
    for (const f of this.base.files) {
      if (removed.has(lc(f.name))) continue;
      const targets = this.base.targets.filter((t) => t.files.some((n) => sameName(n, f.name))).map((t) => t.name);
      addFile({ ...f, targets, origin: this.mcp ? 'mcp' : 'base', path: undefined });
    }
    const explicitPath = new Map<string, string>();
    for (const f of this.base.files) if (f.path) explicitPath.set(lc(f.name), f.path);
    for (const a of sc.addedFiles) {
      if (a.path) explicitPath.set(lc(a.name), a.path);
      const existing = byName.get(lc(a.name));
      if (existing) continue;
      const kind = fileKindOf(a.name);
      const t = defaultToolFor(kind);
      addFile({ name: a.name, kind, tool: t.tool, ignoredByMake: t.ignoredByMake, debug: kind === 'asm', targets: a.targets ?? [...allTargets], origin: 'sidecar' });
    }

    for (const [n, d] of Object.entries(sc.fileDebug ?? {})) {
      const f = byName.get(lc(n));
      if (f) f.debug = d;
    }

    // ---- targets
    const targets: ProjectTarget[] = [];
    for (const bt of this.base.targets) {
      const o: SidecarTarget = sc.targets[bt.name] ?? {};
      const tFiles = files.filter((f) => f.targets.includes(bt.name)).map((f) => f.name);
      const order: string[] = [];
      const push = (n: string) => {
        const real = tFiles.find((x) => sameName(x, n));
        if (real && !order.includes(real)) order.push(real);
      };
      for (const n of o.linkOrder ?? bt.linkOrder) push(n);
      for (const n of bt.files) push(n);
      for (const n of tFiles) push(n);
      const ap = o.accessPaths ?? bt.accessPaths;
      const info = async (d: string): Promise<AccessPathInfo> => {
        const p = expandRootedPath(d, this.dir, this.compilerDir);
        const real = p ? await resolveCase(this.fs, p) : undefined;
        const st = real ? await this.fs.stat(real) : undefined;
        return { display: d, path: real ?? p, exists: !!st?.isDirectory };
      };
      const outputDir = o.outputDir ?? bt.outputDir;
      const outputFile = o.outputFile ?? bt.outputFile;
      const outputDirPath = expandRootedPath(outputDir, this.dir, this.compilerDir);
      const dbg = bt.debugger && { ...bt.debugger, args: o.debuggerArgs ?? bt.debugger.args };
      targets.push({
        name: bt.name,
        linker: bt.linker,
        outputDir,
        outputDirPath,
        outputFile,
        absPath: outputDirPath ? joinPath(outputDirPath, outputFile) : undefined,
        accessPaths: { user: await Promise.all(ap.user.map(info)), system: await Promise.all(ap.system.map(info)) },
        options: { ...bt.options, ...(o.options ?? {}) },
        files: tFiles,
        linkOrder: order,
        debugger: dbg,
      });
    }
    this.targets = targets;
    this.files = files;

    // ---- resolve file locations (target of the file's first target's access paths)
    const dirCache = new Map<string, string[] | undefined>();
    for (const f of files) {
      const ex = explicitPath.get(lc(f.name));
      if (ex) {
        const p = isAbsolutePath(ex) ? normPath(ex) : joinPath(this.dir, ex);
        f.path = await resolveCase(this.fs, p, dirCache);
        continue;
      }
      const t = targets.find((x) => f.targets.includes(x.name)) ?? targets[0];
      if (!t) continue;
      const r = await this.searchAccessPaths(t, f.name, dirCache);
      if (r) {
        f.path = r.path;
        f.foundIn = r.foundIn;
      }
    }

    // ---- groups
    this.groups = this.effectiveGroups();
  }

  /** Find a file through a target's access paths (user, then system; flat, then recursive per `recursiveSearch`). */
  async searchAccessPaths(t: ProjectTarget, name: string, dirCache = new Map<string, string[] | undefined>()): Promise<{ path: string; foundIn: string } | undefined> {
    const paths = [...t.accessPaths.user, ...t.accessPaths.system].filter((a) => a.exists && a.path);
    if (this.recursiveSearch !== 'always') {
      for (const a of paths) {
        const hit = await resolveCase(this.fs, joinPath(a.path!, name), dirCache);
        if (hit && !(await this.fs.stat(hit))?.isDirectory) return { path: hit, foundIn: a.display };
      }
    }
    if (this.recursiveSearch !== 'never') {
      for (const a of paths) {
        // UNCERTAIN: recursion depth and order; CodeWarrior's per-path Recursive flag is not decoded.
        const all = await walkFiles(this.fs, a.path!, 6);
        const hit = all.find((p) => sameName(baseName(p), name));
        if (hit) return { path: hit, foundIn: a.display };
      }
    }
    return undefined;
  }

  private effectiveGroups(): GroupChild[] {
    const known = new Map(this.files.map((f) => [lc(f.name), f.name]));
    const placed = new Set<string>();
    const filter = (children: GroupChild[]): GroupChild[] => {
      const out: GroupChild[] = [];
      for (const c of children) {
        if (c.type === 'group') out.push({ type: 'group', name: c.name, children: filter(c.children ?? []) });
        else {
          const n = known.get(lc(c.name));
          if (!n || placed.has(lc(n))) continue;
          placed.add(lc(n));
          out.push({ type: 'file', name: n });
        }
      }
      return out;
    };
    const tree = filter(clone(this.sidecar.groups ?? this.base.groups));
    for (const f of this.files) {
      if (placed.has(lc(f.name))) continue;
      ensureGroup(tree, defaultGroupFor(f.kind)).children.push({ type: 'file', name: f.name });
      placed.add(lc(f.name));
    }
    return tree;
  }

  // ---------------------------------------------------------------- queries

  get currentTarget(): ProjectTarget {
    const t = this.targets.find((x) => x.name === this.sidecar.currentTarget) ?? this.targets[0];
    if (!t) throw new Error('project has no targets');
    return t;
  }

  target(name?: string): ProjectTarget {
    if (name === undefined) return this.currentTarget;
    const t = this.targets.find((x) => x.name === name);
    if (!t) throw new Error(`no target "${name}"`);
    return t;
  }

  file(name: string): ProjectFile | undefined {
    return this.files.find((f) => sameName(f.name, name));
  }

  /** The files of a target in link order. */
  filesOf(target?: string): ProjectFile[] {
    const t = this.target(target);
    return t.linkOrder.map((n) => this.file(n)!).filter(Boolean);
  }

  /** '<name>_Data/<Target>' (build cache and ObjectCode live here). */
  targetDataDir(target?: string): string {
    return joinPath(this.dataDir, this.target(target).name);
  }

  objectDir(target?: string): string {
    return joinPath(this.targetDataDir(target), 'ObjectCode');
  }

  /** Debugger launch configuration of a target (Build Extras + connection .ini). */
  async debuggerConfig(target?: string): Promise<DebuggerConfig> {
    const t = this.target(target);
    const connections = await this.listConnections();
    const dbg = t.debugger ?? { app: '{Compiler}prog\\hiwave.exe', args: '%targetFilePath', initialDir: '{Project}' };
    let args = dbg.args;
    const prodRe = /-Prod=(%projectFileDir[\\/])?("?)([^"\s]+?\.ini)\2(?=\s|$)/i;
    let connection: string | undefined;
    const m = prodRe.exec(args);
    if (m) connection = stemOf(m[3]);
    if (this.sidecar.connection && (!connection || !sameName(connection, this.sidecar.connection))) {
      const c = connections.find((x) => sameName(x.name, this.sidecar.connection!));
      const name = c?.name ?? this.sidecar.connection;
      args = m ? args.replace(prodRe, `-Prod=%projectFileDir\\${name}.ini`) : `${args} -Prod=%projectFileDir\\${name}.ini`;
      // UNCERTAIN: -instance follows the connection's [HI-WAVE] Target= value (sim, icd12, ...).
      if (c?.target) args = /-instance=\S+/i.test(args) ? args.replace(/-instance=\S+/i, `-instance=${c.target}`) : `${args} -instance=${c.target}`;
      connection = name;
    }
    const conn = connection ? connections.find((x) => sameName(x.name, connection!)) : undefined;
    const iniPath = conn?.iniPath ?? (connection ? joinPath(this.dir, connection + '.ini') : undefined);
    const argv = expandIdeArgv(args, { targetFilePath: t.absPath ?? '', projectFileDir: this.dir });
    if (iniPath) {
      // the -Prod= file in its real spelling (the .mcp may differ in case from the file on disk)
      const i = argv.findIndex((a) => /^-Prod=/i.test(a) && sameName(baseName(a.slice(6)), baseName(iniPath)));
      if (i >= 0) argv[i] = `${argv[i].slice(0, 6)}${iniPath}`;
    }
    return {
      app: dbg.app,
      appPath: expandRootedPath(dbg.app, this.dir, this.compilerDir),
      argsTemplate: args,
      args: argv.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' '),
      argv,
      connection,
      iniPath,
      instance: /-instance=(\S+)/i.exec(args)?.[1],
      connections,
    };
  }

  /** Connection .ini files in the project directory (those with a [HI-WAVE] section). */
  async listConnections(): Promise<ConnectionInfo[]> {
    const out: ConnectionInfo[] = [];
    for (const n of ((await this.fs.readdir(this.dir)) ?? []).sort()) {
      if (extOf(n) !== '.ini') continue;
      const p = joinPath(this.dir, n);
      const b = await this.fs.readFile(p);
      if (!b) continue;
      const ini = parseIni(bytesToLatin1(b));
      if (!ini.hasSection('HI-WAVE')) continue;
      out.push({ name: stemOf(n), iniPath: p, target: ini.get('HI-WAVE', 'Target') });
    }
    return out;
  }

  /**
   * [Environment Variables] of a connection .ini for the debugger: each ';'-separated entry that uses {Project} or
   * {Compiler} is expanded to a normalised real path ('/' separators), in its on-disk spelling when it exists
   * ("{Compiler}lib\\hc12c\\include" -> "<compilerDir>/lib/HC12c/include"). Other values are kept as written.
   */
  async debuggerEnvironment(iniPath: string): Promise<Record<string, string>> {
    const real = await resolveCase(this.fs, iniPath);
    const b = real ? await this.fs.readFile(real) : undefined;
    if (!b) return {};
    const ini = parseIni(bytesToLatin1(b));
    const env: Record<string, string> = {};
    const dirCache = new Map<string, string[] | undefined>();
    for (const [k, v] of ini.entries('Environment Variables')) {
      const parts: string[] = [];
      for (const part of v.split(';')) {
        if (!/\{(project|compiler)\}/i.test(part)) {
          parts.push(part);
          continue;
        }
        const p = normPath(expandIdeRoots(part.trim(), this.dir, this.compilerDir));
        parts.push((await resolveCase(this.fs, p, dirCache)) ?? p);
      }
      env[k] = parts.join(';');
    }
    return env;
  }

  // ---------------------------------------------------------------- persistence

  async save(): Promise<void> {
    if (this.mcpHash) this.sidecar.mcpHash = this.mcpHash;
    const bytes = utf8Bytes(stringifySidecar(this.sidecar));
    await this.fs.writeFile(this.sidecarPath, bytes);
    this.sidecarHash = hashBytes(bytes);
  }

  /** Has the .mcp or the sidecar changed on disk since it was loaded/saved? */
  async checkExternalChanges(): Promise<{ mcp: boolean; sidecar: boolean }> {
    let mcp = false;
    if (this.mcpPath) {
      const b = await this.fs.readFile(this.mcpPath);
      mcp = !b || hashBytes(b) !== this.mcpHash;
    }
    const s = await this.fs.readFile(this.sidecarPath);
    const sidecar = (s ? hashBytes(s) : undefined) !== this.sidecarHash;
    return { mcp, sidecar };
  }

  private async commit(): Promise<void> {
    await this.refresh();
    await this.save();
  }

  /** Freeze the current effective group tree into the sidecar (before a group edit). */
  private materializeGroups(): GroupChild[] {
    if (!this.sidecar.groups) this.sidecar.groups = clone(this.groups);
    return this.sidecar.groups;
  }

  private materializeLinkOrder(target: string): string[] {
    const o = (this.sidecar.targets[target] ??= {});
    if (!o.linkOrder) o.linkOrder = [...this.target(target).linkOrder];
    return o.linkOrder;
  }

  // ---------------------------------------------------------------- edits (persisted only to the sidecar)

  /**
   * Add a file (real path) to the project. `group` is a group path (created when missing; default by kind),
   * `targets` defaults to every target. Returns the leaf name.
   */
  async addFile(path: string, opts: { group?: string[]; targets?: string[]; index?: number } = {}): Promise<string> {
    const name = baseName(path);
    if (this.file(name)) throw new Error(`"${name}" is already in the project`);
    const rel = isUnder(path, this.dir) ? relativePath(this.dir, path) : normPath(path);
    const sc = this.sidecar;
    const wasRemoved = sc.removedFiles.findIndex((n) => sameName(n, name));
    const targets = opts.targets ?? this.targets.map((t) => t.name);
    for (const t of targets) this.target(t);
    // Re-adding a removed .mcp file just un-removes it (its .mcp target membership applies); the explicit path is kept.
    if (wasRemoved >= 0) sc.removedFiles.splice(wasRemoved, 1);
    sc.addedFiles.push({ name, path: rel, ...(opts.targets ? { targets: opts.targets } : {}) });
    const groups = this.materializeGroups();
    const g = ensureGroup(groups, opts.group ?? defaultGroupFor(fileKindOf(name)));
    const node = { type: 'file' as const, name };
    if (opts.index !== undefined) g.children.splice(opts.index, 0, node);
    else g.children.push(node);
    for (const t of targets) {
      const lo = this.sidecar.targets[t]?.linkOrder;
      if (lo && !lo.some((n) => sameName(n, name))) lo.push(name);
    }
    await this.commit();
    return name;
  }

  /** Remove a file from the project (never deletes it from disk). */
  async removeFile(name: string): Promise<void> {
    const f = this.file(name);
    if (!f) throw new Error(`"${name}" is not in the project`);
    const sc = this.sidecar;
    const ai = sc.addedFiles.findIndex((a) => sameName(a.name, name));
    if (ai >= 0) sc.addedFiles.splice(ai, 1);
    if (this.base.files.some((b) => sameName(b.name, name)) && !sc.removedFiles.some((n) => sameName(n, name))) sc.removedFiles.push(f.name);
    if (sc.groups) removeFileNode(sc.groups, name);
    for (const o of Object.values(sc.targets)) if (o.linkOrder) o.linkOrder = o.linkOrder.filter((n) => !sameName(n, name));
    await this.commit();
  }

  /** Move a file to another group (created when missing) at `index` (default: end). */
  async moveFile(name: string, group: string[], index?: number): Promise<void> {
    const f = this.file(name);
    if (!f) throw new Error(`"${name}" is not in the project`);
    const groups = this.materializeGroups();
    removeFileNode(groups, name);
    const g = ensureGroup(groups, group);
    const node = { type: 'file' as const, name: f.name };
    if (index === undefined || index >= g.children.length) g.children.push(node);
    else g.children.splice(Math.max(0, index), 0, node);
    await this.commit();
  }

  async addGroup(group: string[]): Promise<void> {
    ensureGroup(this.materializeGroups(), group);
    await this.commit();
  }

  async renameGroup(group: string[], newName: string): Promise<void> {
    const g = findGroup(this.materializeGroups(), group);
    if (!g) throw new Error(`no group ${group.join('/')}`);
    g.name = newName;
    await this.commit();
  }

  /** Remove a group; its files are removed from the project too (as CodeWarrior does). */
  async removeGroup(group: string[]): Promise<void> {
    const groups = this.materializeGroups();
    const parent = group.length > 1 ? findGroup(groups, group.slice(0, -1)) : undefined;
    const list = group.length > 1 ? parent?.children : groups;
    const i = list?.findIndex((c) => c.type === 'group' && c.name === group[group.length - 1]) ?? -1;
    if (!list || i < 0) throw new Error(`no group ${group.join('/')}`);
    const [g] = list.splice(i, 1) as GroupNode[];
    const names: string[] = [];
    const collect = (n: GroupNode) => n.children.forEach((c) => (c.type === 'group' ? collect(c) : names.push(c.name)));
    collect(g);
    const sc = this.sidecar;
    for (const name of names) {
      const ai = sc.addedFiles.findIndex((a) => sameName(a.name, name));
      if (ai >= 0) sc.addedFiles.splice(ai, 1);
      if (this.base.files.some((b) => sameName(b.name, name)) && !sc.removedFiles.some((n) => sameName(n, name))) sc.removedFiles.push(name);
      for (const o of Object.values(sc.targets)) if (o.linkOrder) o.linkOrder = o.linkOrder.filter((n) => !sameName(n, name));
    }
    await this.commit();
  }

  /** Replace a target's link order (names not in the target are ignored, missing ones appended). */
  async setLinkOrder(target: string, names: string[]): Promise<void> {
    this.target(target);
    (this.sidecar.targets[target] ??= {}).linkOrder = [...names];
    await this.commit();
  }

  /** Move one file within a target's link order. */
  async moveInLinkOrder(target: string, name: string, index: number): Promise<void> {
    const lo = this.materializeLinkOrder(target);
    const i = lo.findIndex((n) => sameName(n, name));
    if (i < 0) throw new Error(`"${name}" is not in the link order of ${target}`);
    const [n] = lo.splice(i, 1);
    lo.splice(Math.max(0, Math.min(index, lo.length)), 0, n);
    await this.commit();
  }

  /** Override a tool's option string for a target (undefined restores the .mcp value). */
  async setOption(target: string, tool: ToolKey, value: string | undefined): Promise<void> {
    this.target(target);
    const o = (this.sidecar.targets[target] ??= {});
    o.options ??= {};
    if (value === undefined) delete o.options[tool];
    else o.options[tool] = value;
    await this.commit();
  }

  async setAccessPaths(target: string, paths: { user: string[]; system: string[] } | undefined): Promise<void> {
    this.target(target);
    const o = (this.sidecar.targets[target] ??= {});
    if (paths) o.accessPaths = { user: [...paths.user], system: [...paths.system] };
    else delete o.accessPaths;
    await this.commit();
  }

  async setOutput(target: string, out: { dir?: string; file?: string }): Promise<void> {
    this.target(target);
    const o = (this.sidecar.targets[target] ??= {});
    if (out.dir !== undefined) o.outputDir = out.dir;
    if (out.file !== undefined) o.outputFile = out.file;
    await this.commit();
  }

  async setDebuggerArgs(target: string, args: string | undefined): Promise<void> {
    this.target(target);
    const o = (this.sidecar.targets[target] ??= {});
    if (args === undefined) delete o.debuggerArgs;
    else o.debuggerArgs = args;
    await this.commit();
  }

  async setCurrentTarget(name: string): Promise<void> {
    this.target(name);
    this.sidecar.currentTarget = name;
    await this.save();
  }

  /**
   * Choose the debugger connection by .ini stem ("Full_Chip_Simulation"; case-insensitive, one of listConnections());
   * undefined = the .mcp's Build Extras. Throws for an unknown connection.
   */
  async setConnection(name: string | undefined): Promise<void> {
    if (name === undefined) delete this.sidecar.connection;
    else {
      const all = await this.listConnections();
      const c = all.find((x) => sameName(x.name, name));
      if (!c) throw new Error(`no connection "${name}" in ${this.dir} (available: ${all.map((x) => x.name).join(', ') || 'none'})`);
      this.sidecar.connection = c.name;
    }
    await this.save();
  }

  /** Set a file's Debug flag (project window debug column); persisted to the sidecar. */
  async setDebug(name: string, debug: boolean): Promise<void> {
    const f = this.file(name);
    if (!f) throw new Error(`"${name}" is not in the project`);
    const fd = (this.sidecar.fileDebug ??= {});
    for (const k of Object.keys(fd)) if (sameName(k, f.name)) delete fd[k];
    const base = this.base.files.find((b) => sameName(b.name, f.name));
    if (!base || base.debug !== debug) fd[f.name] = debug;
    if (!Object.keys(fd).length) delete this.sidecar.fileDebug;
    await this.commit();
  }
}

/** Expand the CodeWarrior IDE macros of Build Extras arguments. */
export function expandIdeMacros(args: string, v: { targetFilePath: string; projectFileDir: string }): string {
  return args.replace(/%targetFilePath/g, v.targetFilePath).replace(/%projectFileDir/g, v.projectFileDir);
}

/**
 * Expand Build Extras arguments into argv tokens: the template is split on white space (double quotes group and are
 * removed), and in each token a %targetFilePath / %projectFileDir macro plus the rest of the token is turned into a
 * normalised real path ("%projectFileDir\\P&E_Multilink_USB.ini" -> "<dir>/P&E_Multilink_USB.ini").
 */
export function expandIdeArgv(args: string, v: { targetFilePath: string; projectFileDir: string }): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/(?:[^\s"]+|"[^"]*")+/g)) {
    const tok = m[0].replace(/"/g, '');
    const mm = /%(targetFilePath|projectFileDir)/.exec(tok);
    if (!mm) {
      out.push(tok);
      continue;
    }
    const value = mm[1] === 'targetFilePath' ? v.targetFilePath : v.projectFileDir;
    const rest = expandIdeMacros(tok.slice(mm.index + mm[0].length), v);
    out.push(tok.slice(0, mm.index) + (value || rest ? normPath(toSlash(value + rest)) : ''));
  }
  return out;
}

/** Open a project: a .mcp (merged with its sidecar) or a standalone '<name>.s12studio.json'. */
export async function openProject(fs: ProjectFs, path: string, opts: OpenProjectOptions = {}): Promise<Project> {
  let p = normPath(path);
  const real = await resolveCase(fs, p);
  if (real) p = real;
  const proj = new Project(fs, p, opts);
  await proj.load();
  return proj;
}

// ------------------------------------------------------------------------------------------------ group tree helpers

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function findGroup(tree: GroupChild[], path: string[]): GroupNode | undefined {
  let list = tree;
  let g: GroupNode | undefined;
  for (const n of path) {
    g = list.find((c): c is GroupNode => c.type === 'group' && c.name === n);
    if (!g) return undefined;
    list = g.children;
  }
  return g;
}

function ensureGroup(tree: GroupChild[], path: string[]): GroupNode {
  let list = tree;
  let g: GroupNode | undefined;
  for (const n of path) {
    g = list.find((c): c is GroupNode => c.type === 'group' && c.name === n);
    if (!g) {
      g = { type: 'group', name: n, children: [] };
      list.push(g);
    }
    list = g.children;
  }
  if (!g) throw new Error('empty group path');
  return g;
}

function removeFileNode(tree: GroupChild[], name: string): boolean {
  for (let i = 0; i < tree.length; i++) {
    const c = tree[i];
    if (c.type === 'file' && sameName(c.name, name)) {
      tree.splice(i, 1);
      return true;
    }
    if (c.type === 'group' && removeFileNode(c.children, name)) return true;
  }
  return false;
}

/** Group path of a file in a tree, e.g. ['Project Settings', 'Linker Files']. */
export function groupPathOf(tree: GroupChild[], name: string, prefix: string[] = []): string[] | undefined {
  for (const c of tree) {
    if (c.type === 'file' && sameName(c.name, name)) return prefix;
    if (c.type === 'group') {
      const r = groupPathOf(c.children, name, [...prefix, c.name]);
      if (r) return r;
    }
  }
  return undefined;
}

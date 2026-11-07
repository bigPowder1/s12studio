/**
 * The S12 Studio sidecar '<name>.s12studio.json' next to the .mcp. The .mcp is never written (PLAN.md M6,
 * mcp-format.md §6): every IDE edit is a delta stored here and merged over the decoded .mcp on open. A project made
 * from our generic template has no .mcp at all; its sidecar then carries the whole definition in `base`.
 */
import type { FileKind } from './kinds';

export type ToolKey = 'assembler' | 'compiler' | 'linker' | 'burner' | 'importer' | 'libmaker';
export type ToolOptions = Partial<Record<ToolKey, string>>;

export interface GroupFileNode {
  type: 'file';
  name: string;
}
export interface GroupNode {
  type: 'group';
  name: string;
  children: GroupChild[];
}
export type GroupChild = GroupNode | GroupFileNode;

export interface DebuggerSettings {
  /** "{Compiler}prog\\hiwave.exe" */
  app: string;
  /** "%targetFilePath -Prod=%projectFileDir\\P&E_Multilink_USB.ini -instance=icd12" */
  args: string;
  /** "{Project}" */
  initialDir: string;
}

/** A build target as the model needs it (decoded from the .mcp or stored in a standalone sidecar). */
export interface BaseTarget {
  name: string;
  /** "Linker for HC12" */
  linker: string;
  /** output directory in CodeWarrior display form, e.g. "{Project}bin" */
  outputDir: string;
  /** application file name, e.g. "Project.abs" */
  outputFile: string;
  /** access paths in display form ("{Project}Sources", "{Compiler}lib\\HC12c\\include", "E:\\abs") */
  accessPaths: { user: string[]; system: string[] };
  options: ToolOptions;
  /** leaf names of the files in this target */
  files: string[];
  linkOrder: string[];
  debugger?: DebuggerSettings;
}

export interface BaseFile {
  name: string;
  kind: FileKind;
  /** file-mapping tool ("Assembler for HC12", "Importer for HC12", '') */
  tool: string;
  ignoredByMake: boolean;
  debug: boolean;
  /** explicit location (project-relative with '/' or absolute); otherwise found through the access paths */
  path?: string;
}

export interface BaseProject {
  targets: BaseTarget[];
  files: BaseFile[];
  groups: GroupChild[];
  wizard?: { chip?: string; language?: string; connection?: string };
}

export interface SidecarFile {
  name: string;
  /** project-relative ('/' separators) or absolute path */
  path?: string;
  /** targets containing the file (default: all) */
  targets?: string[];
}

export interface SidecarTarget {
  /** tool option overrides (replace the .mcp panel's field0) */
  options?: ToolOptions;
  linkOrder?: string[];
  accessPaths?: { user: string[]; system: string[] };
  outputDir?: string;
  outputFile?: string;
  debuggerArgs?: string;
}

export interface Sidecar {
  format: 's12studio-project';
  version: 1;
  /** hash of the .mcp when the sidecar was last saved (external-change detection) */
  mcpHash?: string;
  currentTarget?: string;
  /** debugger connection = stem of the connection .ini, e.g. "Full_Chip_Simulation" */
  connection?: string;
  addedFiles: SidecarFile[];
  /** leaf names of .mcp files removed from the project */
  removedFiles: string[];
  /** per-file Debug flag overrides (project window debug column), by leaf name */
  fileDebug?: Record<string, boolean>;
  /** full group tree once the user edited groups */
  groups?: GroupChild[];
  targets: Record<string, SidecarTarget>;
  /** whole project definition for projects without a .mcp */
  base?: BaseProject;
}

export function emptySidecar(): Sidecar {
  return { format: 's12studio-project', version: 1, addedFiles: [], removedFiles: [], targets: {} };
}

/** Parse sidecar JSON tolerantly (unknown keys are dropped, missing ones defaulted). */
export function parseSidecar(text: string): { sidecar: Sidecar; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { sidecar: emptySidecar(), warnings: [`sidecar is not valid JSON (${(e as Error).message}); ignored`] };
  }
  const s = emptySidecar();
  if (!raw || typeof raw !== 'object') return { sidecar: s, warnings: ['sidecar is not an object; ignored'] };
  const r = raw as Record<string, unknown>;
  if (r.version !== undefined && r.version !== 1) warnings.push(`sidecar version ${String(r.version)} not understood; reading as version 1`);
  if (typeof r.mcpHash === 'string') s.mcpHash = r.mcpHash;
  if (typeof r.currentTarget === 'string') s.currentTarget = r.currentTarget;
  if (typeof r.connection === 'string') s.connection = r.connection;
  if (Array.isArray(r.addedFiles)) s.addedFiles = r.addedFiles.filter((f): f is SidecarFile => !!f && typeof (f as SidecarFile).name === 'string');
  if (Array.isArray(r.removedFiles)) s.removedFiles = r.removedFiles.filter((f): f is string => typeof f === 'string');
  if (r.fileDebug && typeof r.fileDebug === 'object') {
    const fd: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(r.fileDebug as Record<string, unknown>)) if (typeof v === 'boolean') fd[k] = v;
    s.fileDebug = fd;
  }
  if (Array.isArray(r.groups)) s.groups = r.groups as GroupChild[];
  if (r.targets && typeof r.targets === 'object') s.targets = r.targets as Record<string, SidecarTarget>;
  if (r.base && typeof r.base === 'object') s.base = r.base as BaseProject;
  return { sidecar: s, warnings };
}

export function stringifySidecar(s: Sidecar): string {
  return JSON.stringify(s, null, 2) + '\n';
}

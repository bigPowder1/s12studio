/**
 * Project API (IDE window): open a .mcp (+ '<name>.s12studio.json' sidecar) through @s12/project, inspect and edit
 * it. The .mcp itself is never written; every edit lands in the sidecar.
 *
 * DTOs mirror @s12/project's model (ProjectTarget, ProjectFile, GroupChild...) but are declared here so the renderer
 * never type-checks engine sources; main asserts compatibility at compile time.
 */

export type ProjectFileKind = 'asm' | 'inc' | 'c' | 'h' | 'lib' | 'o' | 'prm' | 'bbl' | 'map' | 'abs' | 'ini' | 'cmd' | 'hwl' | 'txt' | 'other' | (string & {});

export type ToolKey = 'assembler' | 'compiler' | 'linker' | 'burner' | 'importer' | 'libmaker';

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

export interface AccessPathInfo {
  /** CodeWarrior display form, e.g. "{Project}Sources". */
  display: string;
  path?: string;
  exists: boolean;
}

export interface ProjectFileInfo {
  name: string;
  kind: ProjectFileKind;
  /** File-mapping tool ("Assembler for HC12", ''). */
  tool: string;
  ignoredByMake: boolean;
  /** Project-window debug dot. */
  debug: boolean;
  targets: string[];
  origin: 'mcp' | 'sidecar' | 'base';
  /** Resolved real path (absent when not found). */
  path?: string;
  /** Access path it was found in. */
  foundIn?: string;
  /** Code/Data columns from the last build (undefined: never built / 'n/a'). */
  code?: number;
  data?: number;
  /** Touch column: needs compiling. */
  touched?: boolean;
}

export interface DebuggerSettingsInfo {
  app: string;
  args: string;
  initialDir: string;
}

export interface TargetInfo {
  name: string;
  linker: string;
  outputDir: string;
  outputDirPath?: string;
  outputFile: string;
  absPath?: string;
  accessPaths: { user: AccessPathInfo[]; system: AccessPathInfo[] };
  options: Partial<Record<ToolKey, string>>;
  files: string[];
  linkOrder: string[];
  debugger?: DebuggerSettingsInfo;
}

export interface ConnectionInfo {
  /** Stem of the connection .ini ("Full_Chip_Simulation"). */
  name: string;
  iniPath: string;
  /** [HI-WAVE] Target= (sim, icd12...). */
  target?: string;
}

export interface ProjectInfo {
  /** Path the project was opened from (.mcp or .s12studio.json). */
  path: string;
  mcpPath?: string;
  sidecarPath: string;
  dir: string;
  name: string;
  currentTarget: string;
  targets: TargetInfo[];
  files: ProjectFileInfo[];
  groups: GroupChild[];
  /** Selected debugger connection (sidecar), if any. */
  connection?: string;
  connections: ConnectionInfo[];
  warnings: string[];
  mcpChangedExternally: boolean;
}

export interface DebuggerConfigInfo {
  app: string;
  appPath?: string;
  argsTemplate: string;
  args: string;
  argv: string[];
  connection?: string;
  iniPath?: string;
  instance?: string;
  connections: ConnectionInfo[];
}

export type ProjectTemplate = 'blank_project' | 'minimal';

export interface NewProjectRequest {
  template: ProjectTemplate;
  /** Parent directory; the project folder <dir>/<name> is created. */
  dir: string;
  name: string;
}

export interface ProjectApi {
  /** Open a .mcp or .s12studio.json; replaces the current project. */
  open(path: string): Promise<ProjectInfo>;
  close(): Promise<void>;
  current(): Promise<ProjectInfo | null>;
  /** Re-read .mcp + sidecar from disk. */
  reload(): Promise<ProjectInfo>;
  newProject(req: NewProjectRequest): Promise<ProjectInfo>;

  addFiles(paths: string[], group?: string[]): Promise<ProjectInfo>;
  removeFile(name: string): Promise<ProjectInfo>;
  moveFile(name: string, group: string[], index?: number): Promise<ProjectInfo>;
  addGroup(group: string[]): Promise<ProjectInfo>;
  renameGroup(group: string[], newName: string): Promise<ProjectInfo>;
  removeGroup(group: string[]): Promise<ProjectInfo>;
  setLinkOrder(target: string, names: string[]): Promise<ProjectInfo>;
  setCurrentTarget(name: string): Promise<ProjectInfo>;
  setConnection(name: string | null): Promise<ProjectInfo>;
  setDebugFlag(name: string, debug: boolean): Promise<ProjectInfo>;
  /** Touch column toggle (forces/clears recompile). */
  setTouched(name: string, touched: boolean): Promise<ProjectInfo>;

  setOption(target: string, tool: ToolKey, value: string | null): Promise<ProjectInfo>;
  setAccessPaths(target: string, paths: { user: string[]; system: string[] } | null): Promise<ProjectInfo>;
  setOutput(target: string, out: { dir?: string; file?: string }): Promise<ProjectInfo>;
  setDebuggerArgs(target: string, args: string | null): Promise<ProjectInfo>;

  debuggerConfig(target?: string): Promise<DebuggerConfigInfo>;
}

export interface ProjectEvents {
  /** The project was opened, reloaded or edited (full new state). */
  changed: ProjectInfo;
  closed: Record<string, never>;
  /** The .mcp or sidecar changed on disk. */
  externalChange: { mcp: boolean; sidecar: boolean };
}

export const PROJECT_METHODS = [
  'open',
  'close',
  'current',
  'reload',
  'newProject',
  'addFiles',
  'removeFile',
  'moveFile',
  'addGroup',
  'renameGroup',
  'removeGroup',
  'setLinkOrder',
  'setCurrentTarget',
  'setConnection',
  'setDebugFlag',
  'setTouched',
  'setOption',
  'setAccessPaths',
  'setOutput',
  'setDebuggerArgs',
  'debuggerConfig',
] as const;

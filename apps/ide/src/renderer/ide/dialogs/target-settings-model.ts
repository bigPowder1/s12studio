/**
 * Target Settings dialog model (docs/research/r1/ide.md §4): the editable draft of one build target, the panel tree,
 * per-panel factory values, and the diff of a draft into ProjectApi calls (everything lands in the sidecar; the .mcp
 * is never written).
 */
import type { ProjectApi, ProjectInfo, TargetInfo, ToolKey } from '../../../shared/api';

export interface TargetDraft {
  /** Output Directory in CodeWarrior display form ("{Project}bin"). */
  outputDir: string;
  /** Linker panel "Application Filename" ("Project.abs"). */
  outputFile: string;
  userPaths: string[];
  systemPaths: string[];
  /** Tool option strings (Assembler/Linker/Burner/Importer/Compiler panels). */
  options: Record<ToolKey, string>;
  /** Build Extras > Arguments of the external debugger. */
  debuggerArgs: string;
}

export const TOOL_KEYS: ToolKey[] = ['assembler', 'compiler', 'linker', 'burner', 'importer', 'libmaker'];

export function draftFromTarget(t: TargetInfo): TargetDraft {
  const options = {} as Record<ToolKey, string>;
  for (const k of TOOL_KEYS) options[k] = t.options[k] ?? '';
  return {
    outputDir: t.outputDir,
    outputFile: t.outputFile,
    userPaths: t.accessPaths.user.map((p) => p.display),
    systemPaths: t.accessPaths.system.map((p) => p.display),
    options,
    debuggerArgs: t.debugger?.args ?? '',
  };
}

// ------------------------------------------------------------------------------------------------ panels

export type PanelId =
  | 'targetSettings'
  | 'accessPaths'
  | 'buildExtras'
  | 'runtimeSettings'
  | 'fileMappings'
  | 'sourceTrees'
  | 'assembler'
  | 'burner'
  | 'compiler'
  | 'importer'
  | 'linker'
  | 'globalOptimizations'
  | 'customKeywords'
  | 'debuggerSettings';

export interface PanelGroup {
  label: string;
  panels: { id: PanelId; label: string }[];
}

/** Left-hand panel tree ("Target Settings Panels"). */
export const PANEL_TREE: PanelGroup[] = [
  {
    label: 'Target',
    panels: [
      { id: 'targetSettings', label: 'Target Settings' },
      { id: 'accessPaths', label: 'Access Paths' },
      { id: 'buildExtras', label: 'Build Extras' },
      { id: 'runtimeSettings', label: 'Runtime Settings' },
      { id: 'fileMappings', label: 'File Mappings' },
      { id: 'sourceTrees', label: 'Source Trees' },
      { id: 'assembler', label: 'Assembler for HC12' },
      { id: 'burner', label: 'Burner for HC12' },
      { id: 'compiler', label: 'Compiler for HC12' },
      { id: 'importer', label: 'Importer for HC12' },
      { id: 'linker', label: 'Linker for HC12' },
    ],
  },
  { label: 'Code Generation', panels: [{ id: 'globalOptimizations', label: 'Global Optimizations' }] },
  { label: 'Editor', panels: [{ id: 'customKeywords', label: 'Custom Keywords' }] },
  { label: 'Debugger', panels: [{ id: 'debuggerSettings', label: 'Debugger Settings' }] },
];

export function panelLabel(id: PanelId): string {
  for (const g of PANEL_TREE) for (const p of g.panels) if (p.id === id) return p.label;
  return id;
}

/** Which draft fields each editable panel owns (Factory Settings / Revert Panel act on these). */
type DraftField = keyof TargetDraft | `options.${ToolKey}`;
export const PANEL_FIELDS: Partial<Record<PanelId, DraftField[]>> = {
  targetSettings: ['outputDir'],
  accessPaths: ['userPaths', 'systemPaths'],
  buildExtras: ['debuggerArgs'],
  assembler: ['options.assembler'],
  burner: ['options.burner'],
  compiler: ['options.compiler'],
  importer: ['options.importer'],
  linker: ['options.linker', 'outputFile'],
};

export const isEditablePanel = (id: PanelId) => !!PANEL_FIELDS[id];

/**
 * "Factory Settings" values (stationery defaults of a new CW 5.1 HCS12X absolute-assembly project).
 * UNCERTAIN: taken from the Lab3/blank_project .mcp files (the wizard output), not from the plug-ins' own defaults.
 */
/** Access Paths > Add Default: append the default paths that are not in the list yet (user paths are kept). */
export function mergeDefaultPaths(list: readonly string[], defaults: readonly string[]): string[] {
  const have = new Set(list.map((p) => p.toLowerCase()));
  return [...list, ...defaults.filter((p) => !have.has(p.toLowerCase()))];
}

export function factoryDraft(): Omit<TargetDraft, 'debuggerArgs'> & { debuggerArgs: string } {
  return {
    outputDir: '{Project}bin',
    outputFile: 'Project.abs',
    userPaths: ['{Project}', '{Project}bin', '{Project}prm', '{Project}cmd', '{Project}Sources', '{Compiler}lib\\HC12c\\lib', '{Compiler}lib\\HC12c\\src'],
    systemPaths: ['{Compiler}lib\\HC12c\\include'],
    options: { assembler: '-CPUHCS12X', compiler: ' -CpuHCS12X ', linker: '', burner: '', importer: '', libmaker: '' },
    debuggerArgs: '%targetFilePath -Prod=%projectFileDir\\Full_Chip_Simulation.ini -instance=sim',
  };
}

function getField(d: TargetDraft, f: DraftField): unknown {
  return f.startsWith('options.') ? d.options[f.slice(8) as ToolKey] : d[f as keyof TargetDraft];
}

function withField(d: TargetDraft, f: DraftField, v: unknown): TargetDraft {
  if (f.startsWith('options.')) return { ...d, options: { ...d.options, [f.slice(8)]: v as string } };
  return { ...d, [f]: v };
}

/** Copy the fields of one panel from `from` into `d` (Revert Panel: from = base; Factory Settings: from = factory). */
export function resetPanel(d: TargetDraft, panel: PanelId, from: TargetDraft): TargetDraft {
  let out = d;
  for (const f of PANEL_FIELDS[panel] ?? []) {
    const v = getField(from, f);
    out = withField(out, f, Array.isArray(v) ? [...v] : v);
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a panel's fields differ between two drafts. */
export function panelDirty(base: TargetDraft, d: TargetDraft, panel: PanelId): boolean {
  return (PANEL_FIELDS[panel] ?? []).some((f) => !same(getField(base, f), getField(d, f)));
}

export function draftDirty(base: TargetDraft, d: TargetDraft): boolean {
  return !same(base, d);
}

// ------------------------------------------------------------------------------------------------ contract calls

export type SettingsCall =
  | { method: 'setOption'; args: [target: string, tool: ToolKey, value: string | null] }
  | { method: 'setAccessPaths'; args: [target: string, paths: { user: string[]; system: string[] } | null] }
  | { method: 'setOutput'; args: [target: string, out: { dir?: string; file?: string }] }
  | { method: 'setDebuggerArgs'; args: [target: string, args: string | null] };

/** The ProjectApi calls that turn `base` into `draft` for `target` (Apply / OK). Empty when nothing changed. */
export function diffDraft(target: string, base: TargetDraft, draft: TargetDraft): SettingsCall[] {
  const calls: SettingsCall[] = [];
  const out: { dir?: string; file?: string } = {};
  if (draft.outputDir !== base.outputDir) out.dir = draft.outputDir;
  if (draft.outputFile !== base.outputFile) out.file = draft.outputFile;
  if (out.dir !== undefined || out.file !== undefined) calls.push({ method: 'setOutput', args: [target, out] });
  if (!same(draft.userPaths, base.userPaths) || !same(draft.systemPaths, base.systemPaths)) {
    calls.push({ method: 'setAccessPaths', args: [target, { user: [...draft.userPaths], system: [...draft.systemPaths] }] });
  }
  for (const k of TOOL_KEYS) if (draft.options[k] !== base.options[k]) calls.push({ method: 'setOption', args: [target, k, draft.options[k]] });
  if (draft.debuggerArgs !== base.debuggerArgs) calls.push({ method: 'setDebuggerArgs', args: [target, draft.debuggerArgs] });
  return calls;
}

/** Run the calls in order; resolves to the last ProjectInfo (or null when there was nothing to do). */
export async function applyCalls(api: ProjectApi, calls: SettingsCall[]): Promise<ProjectInfo | null> {
  let last: ProjectInfo | null = null;
  for (const c of calls) {
    const fn = api[c.method] as (...a: unknown[]) => Promise<ProjectInfo>;
    last = await fn(...c.args);
  }
  return last;
}

/** Validation of a draft before Apply; returns error messages (empty = OK). */
export function validateDraft(d: TargetDraft): string[] {
  const errs: string[] = [];
  if (!d.outputDir.trim()) errs.push('The Output Directory must not be empty.');
  if (!d.outputFile.trim()) errs.push('The Application Filename must not be empty.');
  else if (/[\\/:*?"<>|]/.test(d.outputFile)) errs.push('The Application Filename must be a plain file name.');
  return errs;
}

// ------------------------------------------------------------------------------------------------ access path display

/**
 * CodeWarrior display form of a chosen directory: "{Project}rel\\path" inside the project folder, otherwise the
 * absolute path (Windows separators, as CW stores them).
 */
export function toAccessPath(projectDir: string, abs: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const pd = norm(projectDir);
  const a = norm(abs);
  if (a === pd) return '{Project}';
  if (a.toLowerCase().startsWith(`${pd.toLowerCase()}/`)) return `{Project}${a.slice(pd.length + 1).replace(/\//g, '\\')}`;
  return abs;
}

/** Output Directory display form (same rules as access paths). */
export const toOutputDir = toAccessPath;

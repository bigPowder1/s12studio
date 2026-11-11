/**
 * "<Target> Settings" window (Edit > <target> Settings..., Alt+F7; docs/research/r1/ide.md §4): panel tree on the
 * left, the selected panel on the right, Factory Settings / Revert Panel and OK / Cancel / Apply below. Edits are
 * kept in a draft and saved through ProjectApi (sidecar) on Apply/OK.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Checkbox, Dialog, GroupBox } from '../../common/controls';
import { useProject, useS12 } from '../../common/s12';
import { ListView, TreeView, type TreeNode } from '../../common/views';
import { parseApiError, type ProjectInfo, type TargetInfo, type ToolKey } from '../../../shared/api';
import { runIdeCommand } from '../commands';
import { AsmOptionsDialog } from './AsmOptionsDialog';
import {
  PANEL_TREE,
  applyCalls,
  diffDraft,
  draftDirty,
  draftFromTarget,
  factoryDraft,
  mergeDefaultPaths,
  isEditablePanel,
  panelDirty,
  panelLabel,
  resetPanel,
  toAccessPath,
  validateDraft,
  type PanelId,
  type TargetDraft,
} from './target-settings-model';

export interface TargetSettingsDialogProps {
  open: boolean;
  /** Target to edit (default: the current target). */
  target?: string;
  onClose: () => void;
  /** Initially selected panel. */
  initialPanel?: PanelId;
}

export function TargetSettingsDialog({ open, target, onClose, initialPanel = 'targetSettings' }: TargetSettingsDialogProps) {
  const project = useProject();
  const s12 = useS12();
  const t = project?.targets.find((x) => x.name === (target ?? project.currentTarget)) ?? null;
  const base = useMemo(() => (t ? draftFromTarget(t) : null), [t]);
  const [draft, setDraft] = useState<TargetDraft | null>(base);
  const [panel, setPanel] = useState<PanelId>(initialPanel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // a fresh draft every time the dialog opens (or switches target)
  useEffect(() => {
    if (open) {
      setDraft(base);
      setError(null);
      setPanel(initialPanel);
    }
  }, [open, t?.name]);

  const dirty = !!base && !!draft && draftDirty(base, draft);

  const apply = useCallback(async (): Promise<boolean> => {
    if (!t || !base || !draft) return false;
    const errs = validateDraft(draft);
    if (errs.length) {
      setError(errs.join(' '));
      return false;
    }
    const calls = diffDraft(t.name, base, draft);
    if (!calls.length) return true;
    setBusy(true);
    try {
      const info = await applyCalls(s12.project, calls);
      const nt = info?.targets.find((x) => x.name === t.name);
      if (nt) setDraft(draftFromTarget(nt));
      setError(null);
      return true;
    } catch (e) {
      setError(parseApiError(e).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [t, base, draft, s12]);

  if (!open) return null;
  const title = `${t?.name ?? 'Target'} Settings`;
  if (!project || !t || !draft || !base) {
    return (
      <Dialog title={title} open onClose={onClose} testId="target-settings">
        <div className="cw-placeholder">No project is open.</div>
      </Dialog>
    );
  }

  const nodes: TreeNode<PanelId | null>[] = PANEL_TREE.map((g) => ({
    key: `group:${g.label}`,
    label: g.label,
    data: null,
    children: g.panels.map((p) => ({ key: p.id, label: p.label, data: p.id })),
  }));

  return (
    <Dialog
      title={title}
      open
      onClose={onClose}
      width={780}
      testId="target-settings"
      buttons={
        <div className="ide-settings-buttons">
          <Button onClick={() => setDraft(resetPanel(draft, panel, { ...factoryDraft() }))} disabled={!isEditablePanel(panel)} testId="ts-factory">
            Factory Settings
          </Button>
          <Button onClick={() => setDraft(resetPanel(draft, panel, base))} disabled={!panelDirty(base, draft, panel)} testId="ts-revert">
            Revert Panel
          </Button>
          <span style={{ flex: 1 }} />
          <Button
            isDefault
            disabled={busy}
            testId="ts-ok"
            onClick={() =>
              void apply().then((ok) => {
                if (ok) onClose();
              })
            }
          >
            OK
          </Button>
          <Button onClick={onClose} testId="ts-cancel">
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={!dirty || busy} testId="ts-apply">
            Apply
          </Button>
        </div>
      }
    >
      <div className="ide-settings">
        <div className="ide-settings-tree">
          <div className="ide-settings-tree-title">Target Settings Panels</div>
          <TreeView
            testId="ts-panels"
            nodes={nodes}
            selected={panel}
            onSelect={(n) => n.data && setPanel(n.data)}
            onActivate={(n) => n.data && setPanel(n.data)}
          />
        </div>
        <div className="ide-settings-panel" data-testid={`ts-panel-${panel}`}>
          <div className="ide-settings-panel-title">{panelLabel(panel)}</div>
          <div className="ide-settings-panel-body">
            <PanelView panel={panel} project={project} target={t} draft={draft} setDraft={setDraft} />
          </div>
          {error && (
            <div className="ide-error" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ panels

interface PanelProps {
  project: ProjectInfo;
  target: TargetInfo;
  draft: TargetDraft;
  setDraft: (d: TargetDraft) => void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ide-form-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function PanelView({ panel, ...p }: PanelProps & { panel: PanelId }) {
  switch (panel) {
    case 'targetSettings':
      return <TargetSettingsPanel {...p} />;
    case 'accessPaths':
      return <AccessPathsPanel {...p} />;
    case 'buildExtras':
      return <BuildExtrasPanel {...p} />;
    case 'fileMappings':
      return <FileMappingsPanel />;
    case 'assembler':
      return <AssemblerPanel {...p} />;
    case 'burner':
      return <BurnerPanel {...p} />;
    case 'linker':
      return <LinkerPanel {...p} />;
    case 'compiler':
      return <ToolOptionsPanel {...p} tool="compiler" label="Compiler command line arguments:" note="S12 Studio builds assembly-only projects; the compiler options are kept for the .mcp but not used." />;
    case 'importer':
      return <ToolOptionsPanel {...p} tool="importer" label="Importer command line arguments:" note="The importer converts .abs/.lib files added to the project (used for ME3305 libraries)." />;
    case 'runtimeSettings':
      return (
        <NotUsed text="Runtime Settings (host application, working directory, program arguments, environment) are not used by the HC12 tools: the debugger is started through Build Extras." />
      );
    case 'sourceTrees':
      return (
        <>
          <ListView columns={[{ id: 'n', header: 'Name', render: (r: { n: string; p: string }) => r.n }, { id: 'p', header: 'Path', render: (r) => r.p }]} rows={[{ n: 'Compiler', p: 'S12 Studio compiler root (bundled lib\\HC12c\\include)' }]} rowKey={(r) => r.n} />
          <div className="ide-hint">Source trees are predefined; {'{Compiler}'} resolves to S12 Studio&apos;s generated compiler root.</div>
        </>
      );
    default:
      // UNCERTAIN: these panels exist in CW but have no effect on an assembly-only HC12 project
      return <NotUsed text={`The ${panelLabel(panel)} panel has no settings that affect HC12 assembly projects in S12 Studio.`} />;
  }
}

const NotUsed = ({ text }: { text: string }) => <div className="cw-placeholder">{text}</div>;

function TargetSettingsPanel({ project, target, draft, setDraft }: PanelProps) {
  const s12 = useS12();
  const choose = async () => {
    const [dir] = await s12.files.openDialog({ title: 'Choose Output Directory', directory: true, defaultPath: target.outputDirPath ?? project.dir });
    if (dir) setDraft({ ...draft, outputDir: toAccessPath(project.dir, dir) });
  };
  return (
    <>
      <Row label="Target Name:">
        {/* UNCERTAIN/gap: renaming a target is not supported by the project contract (read-only here) */}
        <input className="cw-field" readOnly value={target.name} aria-label="Target Name" title="Renaming targets is not supported" />
      </Row>
      <Row label="Linker:">
        <select className="cw-field" disabled value={target.linker || 'None'} aria-label="Linker">
          <option>{target.linker || 'None'}</option>
        </select>
      </Row>
      <Row label="Pre-linker:">
        <select className="cw-field" disabled value="None" aria-label="Pre-linker">
          <option>None</option>
        </select>
      </Row>
      <Row label="Post-linker:">
        {/* UNCERTAIN: CW HC12 projects run the burner through the .bbl in the project, not as a post-linker */}
        <select className="cw-field" disabled value="None" aria-label="Post-linker">
          <option>None</option>
        </select>
      </Row>
      <Row label="Output Directory:">
        <span className="ide-inline">
          <input className="cw-field" style={{ flex: 1 }} value={draft.outputDir} aria-label="Output Directory" onChange={(e) => setDraft({ ...draft, outputDir: e.target.value })} data-testid="ts-output-dir" />
          <Button onClick={() => void choose()}>Choose...</Button>
          <Button onClick={() => setDraft({ ...draft, outputDir: '{Project}' })}>Clear</Button>
        </span>
      </Row>
      <Checkbox label="Save project entries using relative paths" checked disabled />
    </>
  );
}

function AccessPathsPanel({ project, target, draft, setDraft }: PanelProps) {
  const s12 = useS12();
  const [which, setWhich] = useState<'user' | 'system'>('user');
  const [sel, setSel] = useState<number | null>(null);
  const key = which === 'user' ? 'userPaths' : 'systemPaths';
  const list = draft[key];
  const known = new Map([...target.accessPaths.user, ...target.accessPaths.system].map((p) => [p.display, p.exists]));
  const set = (l: string[]) => setDraft({ ...draft, [key]: l });
  const pick = async (title: string) => {
    const [dir] = await s12.files.openDialog({ title, directory: true, defaultPath: project.dir });
    return dir ? toAccessPath(project.dir, dir) : null;
  };
  const rows = list.map((p, i) => ({ p, i }));
  return (
    <>
      <div className="ide-inline">
        <Checkbox label="Always Search User Paths" checked={false} disabled />
        <Checkbox label="Source relative includes" checked={false} disabled />
      </div>
      <div className="ide-inline" role="radiogroup" aria-label="Path list" style={{ margin: '6px 0' }}>
        <label className="cw-check">
          <input type="radio" name="ts-paths" checked={which === 'user'} onChange={() => (setWhich('user'), setSel(null))} data-testid="ts-user-paths" />
          <span>User Paths</span>
        </label>
        <label className="cw-check">
          <input type="radio" name="ts-paths" checked={which === 'system'} onChange={() => (setWhich('system'), setSel(null))} data-testid="ts-system-paths" />
          <span>System Paths</span>
        </label>
      </div>
      <div style={{ height: 200, display: 'flex' }}>
        <ListView
          testId="ts-path-list"
          columns={[
            { id: 'p', header: 'Path', render: (r: { p: string; i: number }) => r.p },
            { id: 's', header: '', width: 70, render: (r) => (known.get(r.p) === false ? 'not found' : '') },
          ]}
          rows={rows}
          rowKey={(r) => String(r.i)}
          selected={sel === null ? null : String(sel)}
          onSelect={(_k, r) => setSel(r.i)}
          rowStyle={(r) => (known.get(r.p) === false ? { color: 'var(--cw-gray-text)' } : undefined)}
        />
      </div>
      <div className="ide-inline" style={{ marginTop: 6 }}>
        <Button
          testId="ts-path-add"
          onClick={() =>
            void pick('Add Access Path').then((p) => {
              if (p && !list.includes(p)) set([...list, p]);
            })
          }
        >
          Add...
        </Button>
        <Button
          onClick={() => {
            const f = factoryDraft();
            set(mergeDefaultPaths(list, which === 'user' ? f.userPaths : f.systemPaths));
          }}
        >
          Add Default
        </Button>
        <Button
          disabled={sel === null}
          onClick={() =>
            void pick('Change Access Path').then((p) => {
              if (p && sel !== null) set(list.map((x, i) => (i === sel ? p : x)));
            })
          }
        >
          Change...
        </Button>
        <Button
          disabled={sel === null}
          testId="ts-path-remove"
          onClick={() => {
            if (sel === null) return;
            set(list.filter((_, i) => i !== sel));
            setSel(null);
          }}
        >
          Remove
        </Button>
        <Button disabled={sel === null || sel === 0} onClick={() => sel !== null && (set(move(list, sel, sel - 1)), setSel(sel - 1))}>
          Up
        </Button>
        <Button disabled={sel === null || sel >= list.length - 1} onClick={() => sel !== null && (set(move(list, sel, sel + 1)), setSel(sel + 1))}>
          Down
        </Button>
      </div>
    </>
  );
}

function move<T>(l: T[], from: number, to: number): T[] {
  const c = [...l];
  const [x] = c.splice(from, 1);
  c.splice(to, 0, x);
  return c;
}

function BuildExtrasPanel({ target, draft, setDraft }: PanelProps) {
  return (
    <>
      <Checkbox label="Use modification date caching" checked disabled />
      <Checkbox label="Cache Subprojects" checked={false} disabled />
      <GroupBox label="Debugger">
        <Checkbox label="Use External Debugger" checked disabled />
        <Row label="Application:">
          <input className="cw-field" readOnly value={target.debugger?.app ?? '{Compiler}prog\\hiwave.exe'} aria-label="Application" />
        </Row>
        <Row label="Arguments:">
          <input className="cw-field cw-mono" value={draft.debuggerArgs} aria-label="Arguments" onChange={(e) => setDraft({ ...draft, debuggerArgs: e.target.value })} data-testid="ts-debugger-args" />
        </Row>
        <Row label="Initial directory:">
          <input className="cw-field" readOnly value={target.debugger?.initialDir ?? '{Project}'} aria-label="Initial directory" />
        </Row>
        <div className="ide-hint">%targetFilePath = the target&apos;s .abs; -Prod= selects the connection .ini; -instance= the hiwave instance.</div>
      </GroupBox>
    </>
  );
}

/** File Mappings (ide.md §4); read-only. */
const FILE_MAPPINGS: { type: string; ext: string; flags: string; tool: string }[] = [
  { type: 'TEXT', ext: '.asm', flags: '', tool: 'Assembler for HC12' },
  { type: 'TEXT', ext: '.s', flags: '', tool: 'Assembler for HC12' },
  { type: 'TEXT', ext: '.inc', flags: 'Ignored by Make', tool: 'Assembler for HC12' },
  { type: 'TEXT', ext: '.dbg', flags: 'Ignored by Make', tool: 'Assembler for HC12' },
  { type: 'TEXT', ext: '.c', flags: '', tool: 'Compiler for HC12' },
  { type: 'TEXT', ext: '.h', flags: 'Ignored by Make', tool: 'Compiler for HC12' },
  { type: 'TEXT', ext: '.prm', flags: '', tool: 'Linker for HC12' },
  { type: 'TEXT', ext: '.bbl', flags: '', tool: 'Burner for HC12' },
  { type: '', ext: '.abs', flags: '', tool: 'Importer for HC12' },
  { type: '', ext: '.elf', flags: '', tool: 'Importer for HC12' },
  { type: '', ext: '.lib', flags: '', tool: 'Importer for HC12' },
  { type: '', ext: '.o', flags: '', tool: 'Importer for HC12' },
  { type: 'TEXT', ext: '.ini', flags: 'Ignored by Make', tool: 'None' },
  { type: 'TEXT', ext: '.cmd', flags: 'Ignored by Make', tool: 'None' },
  { type: 'TEXT', ext: '.map', flags: 'Ignored by Make', tool: 'None' },
  { type: 'TEXT', ext: '.s19', flags: 'Ignored by Make', tool: 'None' },
  { type: 'TEXT', ext: '.txt', flags: 'Ignored by Make', tool: 'None' },
];

function FileMappingsPanel() {
  return (
    <div style={{ height: 300, display: 'flex' }}>
      <ListView
        testId="ts-file-mappings"
        columns={[
          { id: 't', header: 'File Type', width: 70, render: (r: (typeof FILE_MAPPINGS)[number]) => r.type },
          { id: 'e', header: 'Extension', width: 80, render: (r) => r.ext },
          { id: 'f', header: 'Flags', width: 110, render: (r) => r.flags },
          { id: 'c', header: 'Compiler', render: (r) => r.tool },
        ]}
        rows={FILE_MAPPINGS}
        rowKey={(r) => r.ext}
      />
    </div>
  );
}

function OptionField({ draft, setDraft, tool, label, testId }: Pick<PanelProps, 'draft' | 'setDraft'> & { tool: ToolKey; label: string; testId?: string }) {
  return (
    <Row label={label}>
      <input className="cw-field cw-mono" value={draft.options[tool]} aria-label={label} onChange={(e) => setDraft({ ...draft, options: { ...draft.options, [tool]: e.target.value } })} data-testid={testId ?? `ts-opt-${tool}`} />
    </Row>
  );
}

function AssemblerPanel({ draft, setDraft }: PanelProps) {
  const [opts, setOpts] = useState(false);
  return (
    <>
      <OptionField draft={draft} setDraft={setDraft} tool="assembler" label="Command Line Arguments:" />
      <div className="ide-inline">
        <Button onClick={() => setOpts(true)} testId="ts-asm-options">
          Options...
        </Button>
        <Button disabled>Messages...</Button>
      </div>
      <Checkbox label="Display generated command lines in message window" checked={false} disabled />
      <div className="ide-hint">-CPUHCS12X selects the MC9S12XDP512 instruction set; -L=%(TEXTPATH)\%n.lst writes main.lst next to the object code; -Li leaves included files out of the listing.</div>
      <AsmOptionsDialog
        open={opts}
        value={draft.options.assembler}
        onCancel={() => setOpts(false)}
        onOk={(v) => {
          setDraft({ ...draft, options: { ...draft.options, assembler: v } });
          setOpts(false);
        }}
      />
    </>
  );
}

function filesOfKind(project: ProjectInfo, target: TargetInfo, kind: string) {
  return project.files.filter((f) => f.kind === kind && target.files.includes(f.name));
}

function FileList({ files }: { files: ProjectInfo['files'] }) {
  return (
    <div style={{ height: 90, display: 'flex' }}>
      <ListView
        columns={[
          { id: 'n', header: 'File', render: (f: ProjectInfo['files'][number]) => f.name },
          { id: 'p', header: 'Found in', render: (f) => f.foundIn ?? (f.path ? '' : 'not found') },
        ]}
        rows={files}
        rowKey={(f) => f.name}
        onActivate={(_k, f) => f.path && runIdeCommand('editor.open', { path: f.path })}
      />
    </div>
  );
}

function LinkerPanel({ project, target, draft, setDraft }: PanelProps) {
  const prms = filesOfKind(project, target, 'prm');
  return (
    <>
      <GroupBox label="PRM File">
        <label className="cw-check">
          <input type="radio" checked readOnly />
          <span>Use custom PRM file (the project&apos;s .prm)</span>
        </label>
        <label className="cw-check">
          <input type="radio" checked={false} disabled readOnly />
          <span>Use template PRM file</span>
        </label>
        <FileList files={prms} />
        {!prms.length && <div className="ide-error">The target has no .prm file.</div>}
      </GroupBox>
      <Row label="Application Filename:">
        <input className="cw-field" value={draft.outputFile} aria-label="Application Filename" onChange={(e) => setDraft({ ...draft, outputFile: e.target.value })} data-testid="ts-output-file" />
      </Row>
      <OptionField draft={draft} setDraft={setDraft} tool="linker" label="Linker command line arguments:" />
      <div className="ide-hint">The linker writes the application and its .map file to the Output Directory ({draft.outputDir}).</div>
    </>
  );
}

function BurnerPanel({ project, target, draft, setDraft }: PanelProps) {
  const bbls = filesOfKind(project, target, 'bbl');
  return (
    <>
      <GroupBox label="Burner command files (.bbl)">
        <FileList files={bbls} />
      </GroupBox>
      <OptionField draft={draft} setDraft={setDraft} tool="burner" label="Burner command line arguments:" />
      <div className="ide-hint">burner.bbl turns %ABS_FILE% into the S-record file (%ABS_FILE%.s19). Double-click a .bbl to edit it.</div>
    </>
  );
}

function ToolOptionsPanel({ draft, setDraft, tool, label, note }: PanelProps & { tool: ToolKey; label: string; note: string }) {
  return (
    <>
      <OptionField draft={draft} setDraft={setDraft} tool={tool} label={label} />
      <div className="ide-hint">{note}</div>
    </>
  );
}

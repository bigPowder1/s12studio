/**
 * Smaller IDE dialogs: About, Remove Object Code, Project Inspector, Preferences, the startup dialog, Find and Open
 * File, Keyboard Shortcuts.
 */
import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, GroupBox, PromptDialog } from '../../common/controls';
import { isSeparator, normalizeShortcut, parseMnemonic, type MenuEntry, type TopMenu } from '../../common/menu/model';
import { useProject, useS12, useS12Store } from '../../common/s12';
import { ListView } from '../../common/views';
import { parseApiError, type AppInfo, type AppSettings, type FileBuildInfoDTO, type S12Api } from '../../../shared/api';
import { runIdeCommand, useIdeCommand } from '../commands';
import { openDemoProject, openPath } from '../shell/open-dispatch';
import { setIdeStatus, useIdeActions } from '../shell/actions';
import { projectFileName } from '../project/project-file-name';

// ------------------------------------------------------------------------------------------------ About

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s12 = useS12();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (open) void s12.app.info().then(setInfo, () => undefined);
  }, [open, s12]);
  return (
    <Dialog title="About S12 Studio" open={open} onClose={onClose} width={440} testId="about-dialog">
      <div className="ide-about">
        <div className="ide-about-title">S12 Studio</div>
        <div>Version {info?.version ?? '-'}</div>
        <p>
          An IDE, full-chip simulator and debugger compatible with CodeWarrior for S12(X) v5.1 projects, made for Cal Poly
          ME 305 (MC9S12XDP512, assembly language).
        </p>
        <p className="ide-about-legal" data-testid="about-not-affiliated">
          S12 Studio is an independent project. It is not affiliated with, endorsed by, or sponsored by NXP
          Semiconductors or Freescale Semiconductor. CodeWarrior is a trademark of its owner; it is used here only to
          describe compatibility. S12 Studio contains no NXP software or files.
        </p>
        {info && (
          <div className="ide-hint">
            Electron {info.electron} on {info.platform}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ Remove Object Code

export function RemoveObjectCodeDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const s12 = useS12();
  const project = useProject();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const run = async (allTargets: boolean) => {
    try {
      const removed = await s12.build.removeObjectCode({ allTargets, target: allTargets ? undefined : project?.currentTarget });
      onDone(`Removed ${removed.length} object file${removed.length === 1 ? '' : 's'}`);
      onClose();
    } catch (e) {
      setError(parseApiError(e).message);
    }
  };
  return (
    <Dialog
      title="Remove Object Code"
      open={open}
      onClose={onClose}
      width={380}
      testId="remove-object-code"
      buttons={
        <>
          <Button onClick={() => void run(true)} testId="roc-all">
            All Targets
          </Button>
          <Button isDefault onClick={() => void run(false)} testId="roc-current">
            Current Target
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p>Remove object code and the build outputs of {project ? `"${projectFileName(project)}"` : 'the project'}?</p>
      <Checkbox label="Recurse subprojects" checked={false} disabled />
      <Checkbox label="Compact targets" checked={false} disabled />
      {error && <div className="ide-error">{error}</div>}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ Project Inspector

export function ProjectInspectorDialog({ open, name, onClose }: { open: boolean; name: string | null; onClose: () => void }) {
  const s12 = useS12();
  const project = useProject();
  const [build, setBuild] = useState<FileBuildInfoDTO | null>(null);
  const f = project?.files.find((x) => x.name === name) ?? null;
  useEffect(() => {
    if (!open || !name) return;
    let live = true;
    void s12.build.lastResult().then(
      (r) => live && setBuild(r?.files.find((x) => x.name === name) ?? null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, name, s12]);
  const rows: [string, string][] = f
    ? [
        ['Name', f.name],
        ['Path', f.path ?? '(not found)'],
        ['Found in access path', f.foundIn ?? '-'],
        ['File kind', f.kind],
        ['Compiler (file mapping)', f.tool || 'None'],
        ['Ignored by Make', f.ignoredByMake ? 'yes' : 'no'],
        ['Generate debug info', f.debug ? 'yes' : 'no'],
        ['Needs compiling (touched)', f.touched ? 'yes' : 'no'],
        ['Targets', f.targets.join(', ')],
        ['Code size', f.code === undefined ? 'n/a' : String(f.code)],
        ['Data size', f.data === undefined ? 'n/a' : String(f.data)],
        ['Stored in', f.origin === 'mcp' ? 'project file (.mcp)' : f.origin === 'sidecar' ? 'S12 Studio sidecar' : 'base'],
        ...(build ? ([['Object file', build.object ?? '-'], ['Included files', build.includes.join(', ') || '-']] as [string, string][]) : []),
      ]
    : [];
  return (
    <Dialog title="Project Inspector" open={open} onClose={onClose} width={560} testId="project-inspector">
      {!f ? (
        <div className="cw-placeholder">Select a file in the project window.</div>
      ) : (
        <GroupBox label="Attributes">
          <div style={{ height: 260, display: 'flex' }}>
            <ListView
              columns={[
                { id: 'k', header: 'Attribute', width: 170, render: (r: [string, string]) => r[0] },
                { id: 'v', header: 'Value', render: (r) => <span title={r[1]}>{r[1]}</span> },
              ]}
              rows={rows}
              rowKey={(r) => r[0]}
            />
          </div>
        </GroupBox>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ Preferences

export function PreferencesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s12 = useS12();
  const [st, setSt] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) void s12.settings.get().then(setSt, (e) => setError(parseApiError(e).message));
  }, [open, s12]);
  const save = async () => {
    if (!st) return onClose();
    try {
      await s12.settings.update({ editor: st.editor, showStartupDialog: st.showStartupDialog, debugger: { pacing: st.debugger.pacing } });
      onClose();
    } catch (e) {
      setError(parseApiError(e).message);
    }
  };
  const ed = st?.editor;
  return (
    <Dialog
      title="IDE Preferences"
      open={open}
      onClose={onClose}
      width={460}
      testId="preferences-dialog"
      buttons={
        <>
          <Button isDefault onClick={() => void save()} testId="prefs-ok">
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {!st || !ed ? (
        <div className="cw-placeholder">{error ?? 'Loading...'}</div>
      ) : (
        <>
          <GroupBox label="Font & Tabs">
            <label className="ide-form-row">
              <span>Font size:</span>
              <input className="cw-field" type="number" min={8} max={32} value={ed.fontSize} aria-label="Font size" onChange={(e) => setSt({ ...st, editor: { ...ed, fontSize: Number(e.target.value) || ed.fontSize } })} />
            </label>
            <label className="ide-form-row">
              <span>Tab size:</span>
              <input className="cw-field" type="number" min={1} max={16} value={ed.tabSize} aria-label="Tab size" onChange={(e) => setSt({ ...st, editor: { ...ed, tabSize: Number(e.target.value) || ed.tabSize } })} />
            </label>
            <Checkbox label="Tab inserts spaces" checked={ed.insertSpaces} onChange={(v) => setSt({ ...st, editor: { ...ed, insertSpaces: v } })} />
          </GroupBox>
          <GroupBox label="Text Colors">
            <Checkbox label="Activate Syntax Coloring" checked={ed.syntaxColoring} onChange={(v) => setSt({ ...st, editor: { ...ed, syntaxColoring: v } })} />
          </GroupBox>
          <GroupBox label="IDE Extras">
            <Checkbox label="Display startup dialog" checked={st.showStartupDialog} onChange={(v) => setSt({ ...st, showStartupDialog: v })} testId="prefs-startup" />
          </GroupBox>
          {error && <div className="ide-error">{error}</div>}
        </>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ Startup dialog

/**
 * Open the blinky demo (a writable copy in Documents, see openDemoProject). Failures go to the status bar and a
 * message box (the click came from a dialog that is gone by then).
 */
export async function loadDemoProject(s12: S12Api): Promise<void> {
  try {
    await openDemoProject(s12);
    setIdeStatus('Opened the demo project');
  } catch (e) {
    const msg = parseApiError(e).message;
    setIdeStatus(msg);
    void s12.app.showMessage({ type: 'error', message: 'The demo project could not be opened.', detail: msg }).catch(() => undefined);
  }
}

export function StartupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s12 = useS12();
  const store = useS12Store();
  const actions = useIdeActions(store.project.get);
  // Help > Open Demo Project (registered here: this dialog's host is mounted for the IDE window's lifetime)
  useIdeCommand('help.openDemo', () => loadDemoProject(s12));
  const [show, setShow] = useState(true);
  const [previous, setPrevious] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void s12.settings.get().then((st) => {
      setShow(st.showStartupDialog);
      setPrevious(st.recentProjects[0] ?? null);
    }, () => undefined);
    void s12.files.recent().then((r) => {
      const p = r.find((x) => /\.mcp$/i.test(x));
      if (p) setPrevious((cur) => cur ?? p);
    }, () => undefined);
  }, [open, s12]);
  const done = (then?: () => void) => {
    onClose();
    then?.();
  };
  const toggle = (v: boolean) => {
    setShow(v);
    void s12.settings.update({ showStartupDialog: v }).catch(() => undefined);
  };
  return (
    <Dialog title="Startup" open={open} onClose={onClose} width={380} testId="startup-dialog" buttons={<></>}>
      <div className="ide-startup">
        <div className="ide-about-title">S12 Studio</div>
        <Button onClick={() => done(() => runIdeCommand('project.new'))} testId="startup-new">
          Create New Project
        </Button>
        {/* S12 Studio addition: students open the blank_project folder their course gives them (its .mcp) */}
        <Button onClick={() => done(() => void actions.open())} testId="startup-open">
          Open Project...
        </Button>
        <Button disabled={!previous} onClick={() => done(() => previous && void openPath(s12, previous).catch((e) => setIdeStatus(parseApiError(e).message)))} testId="startup-previous">
          Load Previous Project
        </Button>
        <Button onClick={() => done(() => void loadDemoProject(s12))} testId="startup-example">
          Load Example Project
        </Button>
        <Button disabled>Run Getting Started Tutorial</Button>
        <Button isDefault onClick={() => done()} testId="startup-start">
          Start Using S12 Studio
        </Button>
        <Checkbox label="Display on Startup" checked={show} onChange={toggle} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ Find and Open File

export function FindAndOpenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s12 = useS12();
  const project = useProject();
  return (
    <PromptDialog
      title="Find and Open File"
      label="File name (a project file, or a full path):"
      open={open}
      onCancel={onClose}
      testId="find-open-dialog"
      validate={(v) => {
        const n = v.trim();
        if (!n) return 'Enter a file name.';
        if (/^([a-z]:)?[\\/]/i.test(n)) return null;
        return project?.files.some((f) => f.name.toLowerCase() === n.toLowerCase() && f.path) ? null : `"${n}" was not found in the project.`;
      }}
      onOk={(v) => {
        const n = v.trim();
        const f = project?.files.find((x) => x.name.toLowerCase() === n.toLowerCase() && x.path);
        onClose();
        void openPath(s12, f?.path ?? n).catch((e) => setIdeStatus(parseApiError(e).message));
      }}
    />
  );
}

// ------------------------------------------------------------------------------------------------ Keyboard Shortcuts

export interface ShortcutRow {
  k: string;
  label: string;
  menu: string;
}

/** Every shortcut in the menus, enabled or not (F7/F5/Alt+F7 are listed even with no project open). */
export function shortcutRows(menus: readonly TopMenu[]): ShortcutRow[] {
  const out: ShortcutRow[] = [];
  const seen = new Set<string>();
  const walk = (items: readonly MenuEntry[], menu: string) => {
    for (const e of items) {
      if (isSeparator(e)) continue;
      if (e.shortcut) {
        const k = normalizeShortcut(e.shortcut);
        const label = parseMnemonic(e.label).plain;
        if (!seen.has(`${k}\n${label}`)) {
          seen.add(`${k}\n${label}`);
          out.push({ k, label, menu });
        }
      }
      if (e.submenu) walk(e.submenu, menu);
    }
  };
  for (const m of menus) walk(m.items, parseMnemonic(m.label).plain);
  return out;
}

export function ShortcutsDialog({ open, onClose, menus }: { open: boolean; onClose: () => void; menus: readonly TopMenu[] }) {
  const rows = shortcutRows(menus);
  return (
    <Dialog title="Keyboard Shortcuts" open={open} onClose={onClose} width={420} testId="shortcuts-dialog">
      <div style={{ height: 320, display: 'flex' }}>
        <ListView
          columns={[
            { id: 'c', header: 'Command', render: (r: ShortcutRow) => r.label },
            { id: 'm', header: 'Menu', width: 90, render: (r) => r.menu },
            { id: 'k', header: 'Shortcut', width: 110, render: (r) => r.k },
          ]}
          rows={rows}
          rowKey={(r) => `${r.k}\n${r.label}`}
        />
      </div>
    </Dialog>
  );
}

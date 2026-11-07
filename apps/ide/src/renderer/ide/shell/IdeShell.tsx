/**
 * IDE window frame, CodeWarrior 5.1 style (docs/research/r1/ide.md §1): menu bar, main toolbar, MDI-like body with the
 * project window docked left and the editor documents (editor track's <EditorArea/>) plus the Errors & Warnings
 * window (editor track's <ErrorsWindow/>) on the right, status bar. Window title "S12 Studio — <project>.mcp".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MenuBar, useMenuShortcuts } from '../../common/menu/MenuBar';
import { StatusBar, Splitter, ToolButton, Toolbar, ToolSeparator } from '../../common/controls';
import { Icons } from '../../common/icons';
import { useProject, useS12, useS12Event, useS12Store } from '../../common/s12';
import type { BuildResultInfo, ProjectInfo } from '../../../shared/api';
import { projectFileName } from '../project/project-file-name';
import { getIdeContext, runIdeCommand, setIdeContext, useIdeContext, type IdeCommand, type IdeCommandMap } from '../commands';
import { EditorArea, getEditorArea } from '../editor';
import { IdeDialogs, ShortcutsDialog } from '../dialogs';
import { ErrorsWindow } from '../errors';
import { ProjectWindow } from '../project';
import { setIdeStatus, useIdeActions, useIdeStatus } from './actions';
import { compileNames, ideMenus, type IdeMenuActions } from './menus';
import { updatePane, useUpdateNotice } from './update-notice';
import '../ide.css';

/**
 * Window title, CodeWarrior's MDI-frame pattern "<Product> - [<document>]" ("Freescale CodeWarrior - [Lab3.mcp]").
 * Naming policy (owner decision for the public release): no NXP/Freescale product names (ide.md §8 risk); the IDE is
 * "S12 Studio" and the debugger window "S12 Studio Debugger" (hiwave's own title is a Freescale product name).
 */
export const ideTitle = (project: Pick<ProjectInfo, 'name' | 'mcpPath' | 'path'> | null | undefined) => (project ? `S12 Studio - [${projectFileName(project)}]` : 'S12 Studio');

/**
 * Mirror the editor area's documents into the IDE context (menus: Compile/Add Window/Window list). The editor track
 * exposes getEditorArea() without change events, so this runs on input events and on a slow timer.
 */
export function syncIdeContextFromEditor(): void {
  const ed = getEditorArea();
  if (!ed) return;
  const next = { activeFile: ed.activePath(), openFiles: ed.openPaths(), dirtyCount: ed.dirtyPaths().length };
  const cur = getIdeContext();
  if (cur.activeFile !== next.activeFile || cur.dirtyCount !== next.dirtyCount || cur.openFiles.join('\n') !== next.openFiles.join('\n')) setIdeContext(next);
}

const STEP_TEXT: Record<string, string> = { check: 'Checking', assemble: 'Assembling', link: 'Linking', burn: 'Burning', done: 'Done' };

export function IdeShell() {
  const s12 = useS12();
  const store = useS12Store();
  const project = useProject();
  const ctx = useIdeContext();
  const status = useIdeStatus();
  const update = updatePane(useUpdateNotice(), s12);
  const actions = useIdeActions(store.project.get);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [toolbar, setToolbar] = useState(true);
  const [statusBar, setStatusBar] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedFile;

  useEffect(() => {
    // document.title drives the native title too (Electron follows page-title-updated)
    document.title = ideTitle(project);
  }, [project?.name, project?.mcpPath, project?.path]);

  useEffect(() => {
    let live = true;
    void s12.files.recent().then((r) => live && setRecent(r ?? []), () => undefined);
    return () => {
      live = false;
    };
  }, [s12, project?.path]);

  // CodeWarrior's startup dialog, when no project was opened from the command line
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void Promise.all([s12.app.info(), s12.settings.get()]).then(([info, st]) => {
        if (live && !info.e2e && st?.showStartupDialog && !store.project.get()) runIdeCommand('app.startup');
      }, () => undefined);
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [s12, store]);

  useEffect(() => {
    // clicks/keys in the editor and a slow timer keep the menus' enabled state (Compile, Add Window...) current
    const sync = () => syncIdeContextFromEditor();
    window.addEventListener('keydown', sync, true);
    window.addEventListener('mousedown', sync, true);
    const t = setInterval(sync, 500);
    return () => {
      window.removeEventListener('keydown', sync, true);
      window.removeEventListener('mousedown', sync, true);
      clearInterval(t);
    };
  }, []);

  useS12Event('build', 'started', ({ kind }) => {
    setBuilding(true);
    setProgress('');
    setIdeStatus(kind === 'make' ? 'Making...' : kind === 'clean' ? 'Removing object code...' : kind === 'compile' ? 'Compiling...' : 'Updating...');
  });
  useS12Event('build', 'progress', (p) => {
    setProgress(p.step === 'done' ? '' : `${STEP_TEXT[p.step] ?? p.step}${p.file ? ` ${p.file}` : ''} (${p.done}/${p.total})`);
  });
  useS12Event('build', 'finished', (r: BuildResultInfo) => {
    setBuilding(false);
    setProgress('');
    const sum = `${r.errors} error(s), ${r.warnings} warning(s)`;
    setIdeStatus(r.cancelled ? 'Build stopped' : r.ok ? (r.upToDate ? 'Everything is up to date' : `Build done: ${sum} (${(r.elapsedMs / 1000).toFixed(2)} s)`) : `Build failed: ${sum}`);
    if (r.errors || r.warnings) runIdeCommand('errors.show');
  });
  useS12Event('project', 'externalChange', ({ mcp }) => setIdeStatus(mcp ? 'The project file changed on disk (Project > Re-search for Files to reload)' : 'The project settings changed on disk'));

  const menuActions = useMemo<IdeMenuActions>(
    () => ({
      cmd: <C extends IdeCommand>(c: C, arg?: IdeCommandMap[C]) => (runIdeCommand as (c: IdeCommand, a?: unknown) => void)(c, arg),
      open: () => void actions.open(),
      openPath: (p) => void actions.openPath(p),
      closeProject: () => void actions.closeProject(),
      quit: () => void actions.quit(),
      make: () => void actions.make(),
      bringUpToDate: () => void actions.bringUpToDate(),
      compile: () => void actions.compile(compileNames(store.project.get(), getIdeContext().activeFile, selectedRef.current)),
      checkSyntax: () => void actions.checkSyntax(compileNames(store.project.get(), getIdeContext().activeFile, selectedRef.current)),
      stopBuild: () => void actions.stopBuild(),
      debug: () => void actions.debug(),
      run: () => void actions.run(),
      addWindow: () => void actions.addWindow(),
      synchronize: () => void actions.synchronize(),
      setTarget: (n) => void actions.setTarget(n),
      setConnection: (n) => void actions.setConnection(n),
      toggleToolbar: () => setToolbar((v) => !v),
      toggleStatusBar: () => setStatusBar((v) => !v),
      focusDebugger: () => void actions.focusDebugger(),
      showShortcuts: () => setShortcuts(true),
    }),
    [actions, store],
  );

  const menus = useMemo(
    () => ideMenus(menuActions, { project, building, activeFile: ctx.activeFile, openFiles: ctx.openFiles, dirtyCount: ctx.dirtyCount, recent, toolbarVisible: toolbar, statusBarVisible: statusBar, selectedFile }),
    [menuActions, project, building, ctx, recent, toolbar, statusBar, selectedFile],
  );
  useMenuShortcuts(menus);

  return (
    <div className="cw-frame ide-frame" data-testid="ide-frame">
      <MenuBar menus={menus} />
      {toolbar && (
        <Toolbar testId="ide-toolbar">
          <ToolButton title="New Text File (Ctrl+N)" icon={Icons.newFile} testId="tb-new" onClick={() => runIdeCommand('editor.new')} />
          <ToolButton title="Open (Ctrl+O)" icon={Icons.open} testId="tb-open" onClick={menuActions.open} />
          <ToolButton title="Save (Ctrl+S)" icon={Icons.save} testId="tb-save" onClick={() => runIdeCommand('editor.save')} />
          <ToolButton title="Save All (Ctrl+Shift+S)" icon={Icons.saveAll} testId="tb-saveall" onClick={() => runIdeCommand('editor.saveAll')} />
          <ToolSeparator />
          <ToolButton title="Undo (Ctrl+Z)" icon={Icons.undo} onClick={() => runIdeCommand('editor.undo')} />
          <ToolButton title="Redo (Ctrl+Shift+Z)" icon={Icons.redo} onClick={() => runIdeCommand('editor.redo')} />
          <ToolSeparator />
          <ToolButton title="Cut (Ctrl+X)" icon={Icons.cut} onClick={() => runIdeCommand('editor.cut')} />
          <ToolButton title="Copy (Ctrl+C)" icon={Icons.copy} onClick={() => runIdeCommand('editor.copy')} />
          <ToolButton title="Paste (Ctrl+V)" icon={Icons.paste} onClick={() => runIdeCommand('editor.paste')} />
          <ToolSeparator />
          <ToolButton title="Find (Ctrl+F)" icon={Icons.find} onClick={() => runIdeCommand('editor.find')} />
          <ToolButton title="Find in Files (Ctrl+Shift+F)" icon={Icons.findInFiles} onClick={() => runIdeCommand('editor.findInFiles')} />
          {/* Target, Make, Debug and Run live in the project window's toolbar (ide.md §3), not here (final fidelity F7).
              UNCERTAIN: CW 5.1's main toolbar content beyond the standard file/edit/search buttons. */}
        </Toolbar>
      )}
      <div className="cw-frame-body ide-mdi">
        <Splitter
          direction="horizontal"
          initial={350}
          min={180}
          first={<ProjectWindow onSelectFile={setSelectedFile} actions={actions} building={building} />}
          second={
            <div className="ide-docs">
              <div className="ide-editor-host">
                <EditorArea />
              </div>
              <ErrorsWindow />
            </div>
          }
        />
      </div>
      {statusBar && (
        <StatusBar
          testId="ide-status"
          panes={[
            { id: 'status', content: status },
            // build progress only: the connection and target are shown in the project window (final fidelity F7)
            { id: 'progress', width: 220, content: progress || (building ? 'Building...' : '') },
            ...(update ? [update] : []),
          ]}
        />
      )}
      <IdeDialogs onStatus={setIdeStatus} selectedFile={selectedFile} />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} menus={menus} />
    </div>
  );
}

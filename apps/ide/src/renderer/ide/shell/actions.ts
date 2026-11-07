/**
 * IDE actions shared by the menu bar, the main toolbar and the project window's toolbar, plus the status-bar
 * message store any IDE component can write to.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { useS12 } from '../../common/s12';
import { parseApiError, type BuildResultInfo, type ProjectInfo, type S12Api } from '../../../shared/api';
import { getIdeContext } from '../commands';
import { getEditorArea } from '../editor/bridge';
import { OPEN_FILTERS, openPath } from './open-dispatch';

// ------------------------------------------------------------------------------------------------ status message

let status = 'Ready';
const statusListeners = new Set<() => void>();

export function setIdeStatus(msg: string): void {
  status = msg;
  for (const l of [...statusListeners]) l();
}

export function useIdeStatus(): string {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    () => status,
    () => status,
  );
}

const report = (e: unknown) => setIdeStatus(parseApiError(e).message);

// ------------------------------------------------------------------------------------------------ actions

export interface IdeActions {
  open(): Promise<void>;
  openPath(path: string): Promise<void>;
  closeProject(): Promise<void>;
  make(): Promise<BuildResultInfo | null>;
  bringUpToDate(): Promise<BuildResultInfo | null>;
  /** Compile project files (default: the active editor document). */
  compile(names?: string[]): Promise<BuildResultInfo | null>;
  checkSyntax(names?: string[]): Promise<BuildResultInfo | null>;
  stopBuild(): Promise<void>;
  /** Project > Debug: Make the target (assemble and link what is out of date), then start the debugger on it. True
   *  once the debugger is launched on the fresh build; false when the build failed or the launch did not succeed. */
  debug(): Promise<boolean>;
  /** Project > Run: Debug, then Start/Continue. */
  run(): Promise<void>;
  /** Project > Add Window (the active editor document). */
  addWindow(): Promise<void>;
  /** Synchronize Modification Dates / Re-search for Files: re-read the project and its files. */
  synchronize(): Promise<void>;
  setTarget(name: string): Promise<void>;
  setConnection(name: string | null): Promise<void>;
  focusDebugger(): Promise<void>;
  quit(): Promise<void>;
}

/** Project file names of the active editor document (empty when it is not in the project). */
export function activeProjectFiles(project: ProjectInfo | null): string[] {
  const p = getIdeContext().activeFile;
  if (!project || !p) return [];
  const f = project.files.find((x) => x.path === p);
  return f ? [f.name] : [];
}


export function createIdeActions(s12: S12Api, getProject: () => ProjectInfo | null): IdeActions {
  const build = async (fn: () => Promise<BuildResultInfo>): Promise<BuildResultInfo | null> => {
    try {
      return await fn(); // the shell shows Errors & Warnings on build.finished
    } catch (e) {
      report(e);
      return null;
    }
  };
  const a: IdeActions = {
    async open() {
      const paths = await s12.files.openDialog({ title: 'Open', filters: OPEN_FILTERS, multi: true, defaultPath: getProject()?.dir });
      for (const p of paths) await a.openPath(p);
    },
    async openPath(path) {
      try {
        const kind = await openPath(s12, path);
        if (kind === 'debugger') setIdeStatus('Debugger started');
      } catch (e) {
        report(e);
      }
    },
    closeProject: () => s12.project.close().catch(report),
    make: () => build(() => s12.build.make()),
    bringUpToDate: () => build(() => s12.build.bringUpToDate()),
    compile: async (names) => {
      const n = names ?? activeProjectFiles(getProject());
      if (!n.length) {
        setIdeStatus('The active file is not part of the current target');
        return null;
      }
      return build(() => s12.build.compile(n));
    },
    // UNCERTAIN: Check Syntax assembles without keeping outputs in CW; here it runs the same compile
    checkSyntax: (names) => a.compile(names),
    stopBuild: () => s12.build.stop().catch(report),
    async debug() {
      // CodeWarrior's Debug command makes the target first (assemble + link) so the debugger never loads a stale
      // .abs; an up-to-date target makes nothing and launches at once. Errors show in Errors & Warnings as for Make.
      const r = await a.make();
      if (!r || !r.ok) {
        if (r) setIdeStatus(`Debug cancelled: ${r.errors} error(s)`);
        return false;
      }
      setIdeStatus('Starting the debugger...');
      try {
        await s12.debug.launch();
        setIdeStatus('Debugger started');
        return true;
      } catch (e) {
        report(e);
        return false;
      }
    },
    async run() {
      // a failed build or launch must not resume a debug session left over from an earlier Debug (it would run the
      // old binary)
      if (!(await a.debug())) return;
      // UNCERTAIN: Project > Run with an external debugger = start hiwave and run (Start/Continue)
      await s12.debug.go().catch(report);
    },
    async addWindow() {
      const p = getIdeContext().activeFile;
      if (!p) return;
      await s12.project.addFiles([p]).then(() => setIdeStatus(`Added ${p}`), report);
    },
    async synchronize() {
      await s12.project.reload().then(() => setIdeStatus('Project files re-read'), report);
    },
    setTarget: (name) => s12.project.setCurrentTarget(name).then(() => undefined, report),
    setConnection: (name) => s12.project.setConnection(name).then(() => setIdeStatus(name ? `Connection: ${name.replace(/_/g, ' ')}` : 'Connection cleared'), report),
    focusDebugger: () => s12.app.focusWindow('debugger').catch(report),
    async quit() {
      // CodeWarrior's File > Exit asks "save changes?" for each modified document first; Cancel keeps everything
      // (the IDE, the debugger window and its session) as it was. Main then closes the IDE window before the others.
      const editor = getEditorArea();
      if (editor && !(await editor.closeAll())) return;
      await s12.app.quit().catch(report);
    },
  };
  return a;
}

/** React: actions bound to the window's API (stable). `getProject` must be a stable getter. */
export function useIdeActions(getProject: () => ProjectInfo | null): IdeActions {
  const s12 = useS12();
  return useMemo(() => createIdeActions(s12, getProject), [s12, getProject]);
}

/**
 * IDE-window command bus: decouples the shell (menus/toolbar), the project window, the editor and the Errors &
 * Warnings window, which are built by different tracks. A component that implements a command registers a handler;
 * anyone can run it. Unhandled commands are reported once on the console and ignored.
 *
 *   useIdeCommand('editor.open', ({ path, line }) => ...);     // editor track
 *   runIdeCommand('editor.open', { path, line: 42 });          // errors window double-click
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface IdeCommandMap {
  /** Open a file in an editor window (and go to a line). */
  'editor.open': { path: string; line?: number; column?: number };
  'editor.save': undefined;
  'editor.saveAs': undefined;
  'editor.saveAll': undefined;
  'editor.close': undefined;
  'editor.revert': undefined;
  'editor.find': undefined;
  'editor.findNext': undefined;
  'editor.replace': undefined;
  'editor.findInFiles': undefined;
  'editor.gotoLine': undefined;
  'editor.undo': undefined;
  'editor.redo': undefined;
  'editor.cut': undefined;
  'editor.copy': undefined;
  'editor.paste': undefined;
  'editor.selectAll': undefined;
  'editor.balance': undefined;
  'editor.shiftLeft': undefined;
  'editor.shiftRight': undefined;
  /** Show the Errors & Warnings window. */
  'errors.show': undefined;
  /** Open the "<Target> Settings" dialog. */
  'project.settings': { target?: string } | undefined;
  /** File > New (project wizard / blank_project). */
  'project.new': undefined;
  /** Window > Cascade/Tile... */
  'window.arrange': { mode: 'cascade' | 'tileHorizontal' | 'tileVertical' };
  'help.about': undefined;
  /** Help > Open Demo Project (copy the blinky demo to Documents once and open the copy). */
  'help.openDemo': undefined;
  // ---- added by the IDE shell track ----
  /** File > New Text File (an untitled editor document). */
  'editor.new': undefined;
  /** Window > Close All. */
  'editor.closeAll': undefined;
  /** Search > Find Previous. */
  'editor.findPrevious': undefined;
  /** Project > Add Files... (into a group path of the Files tab; default: the selected group or the top level). */
  'project.addFiles': { group?: string[] } | undefined;
  /** Project > Create Group... (prompts for the name). */
  'project.createGroup': { parent?: string[] } | undefined;
  /** View > Project Inspector (about a project file; default: the selected file). */
  'project.inspect': { name?: string } | undefined;
  /** Project > Remove Object Code... (confirmation dialog: current target / all targets). */
  'project.removeObjectCode': undefined;
  /** File > Find and Open File... */
  'file.findAndOpen': undefined;
  /** Edit > Preferences... */
  'app.preferences': undefined;
  /** The CodeWarrior startup dialog (Create New Project / Load Previous Project...). */
  'app.startup': undefined;
  /** Window > "0 <project>.mcp": bring the project window forward (focus its Files list). */
  'project.focus': undefined;
}

export type IdeCommand = keyof IdeCommandMap;
type Handler<C extends IdeCommand> = (arg: IdeCommandMap[C]) => void | Promise<void>;

const handlers = new Map<IdeCommand, Handler<IdeCommand>[]>();
const warned = new Set<string>();

/** Register a handler; returns an unregister function. The most recently registered handler wins. */
export function registerIdeCommand<C extends IdeCommand>(cmd: C, fn: Handler<C>): () => void {
  const list = handlers.get(cmd) ?? [];
  list.push(fn as Handler<IdeCommand>);
  handlers.set(cmd, list);
  return () => {
    const l = handlers.get(cmd);
    if (!l) return;
    const i = l.indexOf(fn as Handler<IdeCommand>);
    if (i >= 0) l.splice(i, 1);
  };
}

export function hasIdeCommand(cmd: IdeCommand): boolean {
  return (handlers.get(cmd)?.length ?? 0) > 0;
}

export function runIdeCommand<C extends IdeCommand>(cmd: C, ...arg: undefined extends IdeCommandMap[C] ? [] | [IdeCommandMap[C]] : [IdeCommandMap[C]]): void {
  const l = handlers.get(cmd);
  const fn = l?.[l.length - 1];
  if (!fn) {
    if (!warned.has(cmd)) {
      warned.add(cmd);
      console.warn(`IDE command ${cmd} has no handler yet`);
    }
    return;
  }
  void Promise.resolve(fn(arg[0] as IdeCommandMap[C])).catch((e) => console.error(`IDE command ${cmd} failed`, e));
}

/** React helper: register while mounted. */
export function useIdeCommand<C extends IdeCommand>(cmd: C, fn: Handler<C>): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => registerIdeCommand(cmd, ((a: IdeCommandMap[C]) => ref.current(a)) as Handler<C>), [cmd]);
}

// ------------------------------------------------------------------------------------------------ IDE context
// added by the IDE shell track: shared state the menus need from other tracks.

export interface IdeContextState {
  /** Path of the active editor document (null: none / untitled). The editor track keeps this current. */
  activeFile: string | null;
  /** Paths of the open editor documents in Window-menu order (untitled ones omitted). */
  openFiles: string[];
  /** Number of unsaved editor documents (enables Save All). */
  dirtyCount: number;
  /** An editor document is active, untitled ones included (enables Save, Undo, Cut/Copy/Paste, Find Next...). */
  hasDocument?: boolean;
}

let ideContext: IdeContextState = { activeFile: null, openFiles: [], dirtyCount: 0, hasDocument: false };
const ideContextListeners = new Set<() => void>();

/** Merge a patch into the IDE context (editor track: call on activate/open/close/dirty changes). */
export function setIdeContext(patch: Partial<IdeContextState>): void {
  ideContext = { ...ideContext, ...patch };
  for (const l of [...ideContextListeners]) l();
}

export function getIdeContext(): IdeContextState {
  return ideContext;
}

export function subscribeIdeContext(fn: () => void): () => void {
  ideContextListeners.add(fn);
  return () => ideContextListeners.delete(fn);
}

/** React: the IDE context, re-rendering on change. */
export function useIdeContext(): IdeContextState {
  return useSyncExternalStore(subscribeIdeContext, getIdeContext, getIdeContext);
}

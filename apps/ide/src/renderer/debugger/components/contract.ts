/**
 * Contract between the debugger shell (src/renderer/debugger/shell) and the hiwave components
 * (src/renderer/debugger/components/<name>). Components are plain React components registered by hiwave name in
 * registry.ts; the shell mounts them in its MDI child windows and passes DebuggerComponentProps.
 *
 * Component <-> shell interaction goes through `ComponentHost` (useComponentHost()):
 *   - setMenu(items)      the component's own menu, shown as the <component> menu in the menu bar while active
 *   - setHeadline(text)   Object Info Bar text under the title ("Line: 42", "HC12  CPU Cycles: 42")
 *   - open / activate     open another component (Component > Open) or bring one to front
 *   - onUiCommand         `Comp < cmd` commands from the Command window / .hwl (ATTRIBUTES, SMEM, SPC...)
 * Data: use the hooks in src/renderer/common/s12 (useDebugSnapshot, useMemoryWatch, useSession...).
 */
import { createContext, useContext, useEffect, useRef } from 'react';
import type { MenuEntry } from '../../common/menu/model';
import type { HwlAttributeInfo, UiCommandInfo } from '../../../shared/api';

/** hiwave component names (Component > Open list; `OPEN <name>` in .hwl, case-insensitive). */
export type HiwaveComponentName = 'Source' | 'Assembly' | 'Register' | 'Procedure' | 'Memory' | 'Data' | 'Command' | 'Terminal' | 'ME305 Board' | 'VisualizationTool';

export interface DebuggerComponentProps {
  /** Unique panel id ("Data:2"). */
  instanceId: string;
  /** Window title ("Source", "Data:1"). */
  title: string;
  /** Instance number when several of a kind are open (1-based). */
  instance: number;
  /** Attributes from the layout (`Memory < attributes FORMAT hex,WORD 1,...`). */
  attributes: HwlAttributeInfo[];
  /** Whether this component is the active one (its menu is in the menu bar). */
  active: boolean;
}

export interface ComponentHost {
  setMenu(items: MenuEntry[] | null): void;
  setHeadline(text: string): void;
  /** Open (or focus) a component by hiwave name. */
  open(name: HiwaveComponentName, opts?: { attributes?: HwlAttributeInfo[] }): void;
  /** Bring a window to front by title ("Memory", "Data:2"). */
  activate(title: string): void;
  /** Subscribe to `<thisTitle> < cmd` / `<kind> < cmd` UI commands addressed to this component. */
  onUiCommand(fn: (cmd: UiCommandInfo) => void): () => void;
}

const noop: ComponentHost = {
  setMenu: () => undefined,
  setHeadline: () => undefined,
  open: () => undefined,
  activate: () => undefined,
  onUiCommand: () => () => undefined,
};

export const ComponentHostContext = createContext<ComponentHost>(noop);

export function useComponentHost(): ComponentHost {
  return useContext(ComponentHostContext);
}

/** Register the component's menu while it is mounted (the shell shows it when the component is active). */
export function useComponentMenu(items: MenuEntry[] | null): void {
  const host = useComponentHost();
  useEffect(() => {
    host.setMenu(items);
  }, [host, items]);
  useEffect(() => () => host.setMenu(null), [host]);
}

/** Listen for UI commands addressed to this component (ATTRIBUTES, SMEM, SPC, ...). */
export function useUiCommands(fn: (cmd: UiCommandInfo) => void): void {
  const host = useComponentHost();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => host.onUiCommand((c) => ref.current(c)), [host]);
}

// ------------------------------------------------------------------------------------------------ drag and drop

/** MIME type of hiwave drag-and-drop payloads between components (register -> memory, assembly -> register...). */
export const DND_MIME = 'application/x-s12-dnd';

export type DndPayload =
  | { kind: 'address'; address: number; space?: 'local' | 'global'; source: HiwaveComponentName }
  | { kind: 'range'; start: number; end: number; source: HiwaveComponentName }
  | { kind: 'register'; name: string; value: number; source: HiwaveComponentName }
  | { kind: 'expression'; expression: string; address?: number; source: HiwaveComponentName };

export function setDnd(e: React.DragEvent, p: DndPayload): void {
  e.dataTransfer.setData(DND_MIME, JSON.stringify(p));
  e.dataTransfer.effectAllowed = 'copy';
}

export function getDnd(e: React.DragEvent): DndPayload | null {
  const raw = e.dataTransfer.getData(DND_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DndPayload;
  } catch {
    return null;
  }
}

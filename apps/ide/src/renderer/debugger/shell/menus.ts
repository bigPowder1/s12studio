/**
 * hiwave menu bar: File, View, Run, <Connection>, Component, <active component's menu>, Window, Help
 * (docs/research/r1/ide.md §6 "Menu bar"). Every command has a stable id; the shell executes them through one
 * `run(id)` dispatcher, and the toolbar buttons mirror the enabled state of the command with the same id.
 * Run shortcuts per ide.md: F5, Ctrl+Shift+F5, F6, F11, F10, Shift+F11, Ctrl+F11, Ctrl+F10, Ctrl+Shift+F11.
 */
import { SEP, type MenuCommand, type MenuEntry, type TopMenu } from '../../common/menu/model';
import type { RunState } from '../../../shared/api';

export interface DebuggerMenuState {
  state: RunState;
  hasSession: boolean;
  /** Connection menu title from the session ("HCS12X FCS"). */
  connectionMenu: string;
  showToolbar: boolean;
  showStatusBar: boolean;
  hideHeadline: boolean;
  componentMenuOn: boolean;
  autosize: boolean;
  /** Open windows in Window-menu order. */
  windows: readonly { id: string; title: string }[];
  activeId: string | null;
  /** Active component title and its own menu. */
  componentTitle: string | null;
  componentMenu: MenuEntry[] | null;
  /** Recently loaded applications (File menu list), newest first. */
  recentApps?: readonly string[];
}

/** Ids handled by the shell's dispatcher; `window.select.<id>` activates a window. */
export function debuggerMenus(s: DebuggerMenuState, run: (id: string) => void): TopMenu[] {
  const halted = s.state === 'halted';
  const running = s.state === 'running';
  const loaded = s.state !== 'none';
  const cmd = (id: string, label: string, extra: Partial<MenuCommand> = {}): MenuCommand => ({ id, label, onSelect: () => run(id), ...extra });
  // File > recent application list (hiwave lists recently loaded .abs files under Load Application)
  const recentApps: MenuEntry[] = (s.recentApps ?? []).slice(0, 4).map((p, i) => ({
    id: `file.recentApp.${i}`,
    label: `&${i + 1} ${p.replace(/&/g, '&&')}`,
    disabled: !s.hasSession || running,
    onSelect: () => run(`file.recentApp.${i}`),
  }));

  const menus: TopMenu[] = [
    {
      label: '&File',
      items: [
        // UNCERTAIN: hiwave File > New starts an empty configuration; we re-apply the default layout.
        cmd('file.new', '&New'),
        cmd('file.load', '&Load Application...', { disabled: !s.hasSession || running }),
        ...recentApps,
        SEP,
        cmd('file.openConfig', '&Open Configuration...'),
        cmd('file.saveConfig', '&Save Configuration'),
        cmd('file.saveConfigAs', 'Save Configuration &As...'),
        SEP,
        // hiwave's Preferences dialog (environment variables): not implemented
        cmd('file.configuration', '&Configuration...', { disabled: true }),
        SEP,
        cmd('file.exit', 'E&xit'),
      ],
    },
    {
      label: '&View',
      items: [
        cmd('view.toolbar', '&Toolbar', { checked: s.showToolbar }),
        cmd('view.statusbar', '&Status Bar', { checked: s.showStatusBar }),
        cmd('view.hideTitle', 'Hide T&itle', { disabled: true }),
        cmd('view.headline', 'Hide &Headline', { checked: s.hideHeadline }),
        cmd('view.smallBorders', 'S&mall Borders', { disabled: true }),
        SEP,
        cmd('view.customize', '&Customize...', { disabled: true }),
      ],
    },
    {
      label: '&Run',
      items: [
        cmd('run.go', '&Start/Continue', { shortcut: 'F5', disabled: !halted }),
        cmd('run.restart', '&Restart', { shortcut: 'Ctrl+Shift+F5', disabled: !loaded || running }),
        cmd('run.halt', '&Halt', { shortcut: 'F6', disabled: !running }),
        SEP,
        cmd('run.srcLine', 'Single &Step', { shortcut: 'F11', disabled: !halted }),
        cmd('run.srcOver', 'Step &Over', { shortcut: 'F10', disabled: !halted }),
        cmd('run.srcOut', 'Step O&ut', { shortcut: 'Shift+F11', disabled: !halted }),
        cmd('run.instr', '&Assembly Step', { shortcut: 'Ctrl+F11', disabled: !halted }),
        cmd('run.over', 'Assembly Step O&ver', { shortcut: 'Ctrl+F10', disabled: !halted }),
        cmd('run.out', 'Assembly Step Ou&t', { shortcut: 'Ctrl+Shift+F11', disabled: !halted }),
        SEP,
        cmd('run.controlPoints', '&Control Points...', { disabled: !s.hasSession }),
      ],
    },
    {
      label: s.connectionMenu || 'Connection',
      id: 'connection',
      items: [
        cmd('conn.load', '&Load...', { disabled: !s.hasSession || running }),
        // Reset Target lives in the connection menu (ide.md §6 FCS menu: Load, Reset, ...); the toolbar's red Reset
        // button runs it. UNCERTAIN: the shortcut is unconfirmed (ide.md "Key risks" 3); Ctrl+R chosen.
        cmd('conn.reset', '&Reset', { shortcut: 'Ctrl+R', disabled: !s.hasSession }),
        SEP,
        cmd('conn.setDerivative', 'Set &Derivative...', { disabled: true }),
        cmd('conn.configure', 'Con&figure...', { disabled: true }),
        cmd('conn.resetRam', 'Reset R&am', { disabled: true }),
        cmd('conn.resetMem', 'Reset &Mem', { disabled: true }),
        cmd('conn.resetStatistic', 'Reset S&tatistic', { disabled: true }),
        cmd('conn.loadIos', 'Load &I/Os...', { disabled: true }),
        cmd('conn.closeIos', 'Cl&ose I/Os', { disabled: true }),
        cmd('conn.clock', 'Clock &Frequency...', { disabled: true }),
        cmd('conn.commandFiles', '&Command Files...', { disabled: true }),
        cmd('conn.busTrace', '&Bus Trace', { disabled: true }),
      ],
    },
    {
      label: '&Component',
      items: [cmd('component.open', '&Open...'), cmd('component.setConnection', 'Set &Connection...', { disabled: running }), SEP, cmd('component.fonts', '&Fonts...'), cmd('component.background', '&Background Color...')],
    },
  ];
  if (s.componentMenuOn && s.componentTitle && s.componentMenu?.length) {
    menus.push({ label: s.componentTitle.replace(/:\d+$/, ''), id: 'component-menu', items: s.componentMenu });
  }
  const windowList: MenuEntry[] = s.windows.map((w, i) => ({
    id: `window.select.${w.id}`,
    label: i < 9 ? `&${i + 1} ${w.title}` : w.title,
    checked: w.id === s.activeId,
    onSelect: () => run(`window.select.${w.id}`),
  }));
  menus.push(
    {
      label: '&Window',
      items: [
        cmd('window.cascade', '&Cascade'),
        cmd('window.tile', '&Tile'),
        cmd('window.arrangeIcons', '&Arrange Icons'),
        SEP,
        { id: 'window.options', label: '&Options', submenu: [cmd('window.autosize', '&Autosize', { checked: s.autosize }), cmd('window.componentMenu', '&Component Menu', { checked: s.componentMenuOn })] },
        { id: 'window.layout', label: '&Layout', submenu: [cmd('window.layoutLoad', '&Load...'), cmd('window.layoutStore', '&Store...')] },
        ...(windowList.length ? [SEP, ...windowList] : []),
      ],
    },
    { label: '&Help', items: [cmd('help.topics', '&Help Topics', { shortcut: 'F1', disabled: true }), SEP, cmd('help.about', '&About...')] },
  );
  return menus;
}

/** Map a Run-menu id to the debug.step kind. */
export const STEP_COMMANDS = { 'run.srcLine': 'srcLine', 'run.srcOver': 'srcOver', 'run.srcOut': 'srcOut', 'run.instr': 'instr', 'run.over': 'over', 'run.out': 'out' } as const;

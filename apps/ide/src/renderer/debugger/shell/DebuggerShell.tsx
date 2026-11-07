/**
 * Debugger window frame, "S12 Studio Debugger" (styled as hiwave, docs/research/r1/ide.md §6-7):
 * menu bar (File, View, Run, <Connection>, Component, <active component>, Window, Help), toolbar from the
 * connection .ini's TOOLBAR= key, MDI area laid out from the session's .hwl (percent geometry), status bar
 * (message | frequency | cycles | derivative | run state). Owned by the debugger shell track.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { parseApiError, type HwlAttributeInfo, type HwlLayoutInfo, type UiCommandInfo } from '../../../shared/api';
import { StatusBar, ToolButton, Toolbar, ToolSeparator } from '../../common/controls';
import { MenuBar, useMenuShortcuts } from '../../common/menu/MenuBar';
import { findCommand, type MenuEntry } from '../../common/menu/model';
import { useDebugSnapshot, useS12, useS12Event, useSession } from '../../common/s12';
import type { HiwaveComponentName } from '../components/contract';
import { rebuiltNotice } from '../components/command/outputBuffer';
import { findComponent } from '../components/registry';
import { ControlpointsDialog } from '../dialogs';
import { AboutDialog, BackgroundDialog, ComponentOpenDialog, FontDialog } from './dialogs';
import { loadDialogOptionsFromIni, loadDialogPreset, loadOptionsOf, LoadExecutableDialog, SetConnectionDialog } from './hiwave-dialogs';
import { colorrefToCss, cssToColorref, EMPTY_MDI, findWindow, mdiReducer, mdiToHwl, parseOpenArgs, pointsToPx, windowsForCommand, type MdiState, type Rect } from './layout';
import { MdiArea, type MdiServices } from './MdiArea';
import { debuggerMenus, STEP_COMMANDS } from './menus';
import { clockText, cyclesText, HELP_MESSAGE, runStateText } from './status';
import { parseToolbar, toolbarFromIni } from './toolbar';
import { ToolbarIcons } from './toolbar-icons';

export const DEBUGGER_TITLE = 'S12 Studio Debugger';

type DialogKind = null | 'open' | 'fonts' | 'background' | 'about' | 'controlpoints' | 'load' | 'setConnection';

const isLayout = (l: unknown): l is HwlLayoutInfo => !!l && Array.isArray((l as HwlLayoutInfo).windows);

/** Tokens of a command argument text: quoted strings or whitespace-separated words. */
const tokens = (s: string): string[] => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));

export function DebuggerShell() {
  const s12 = useS12();
  const session = useSession();
  const snap = useDebugSnapshot();
  const [mdi, dispatch] = useReducer(mdiReducer, EMPTY_MDI);
  const mdiRef = useRef<MdiState>(mdi);
  mdiRef.current = mdi;
  const [menusByWin, setMenusByWin] = useState<Record<string, MenuEntry[] | null>>({});
  const listeners = useRef(new Map<string, Set<(c: UiCommandInfo) => void>>());
  const [message, setMessage] = useState(HELP_MESSAGE);
  const [view, setView] = useState({ toolbar: true, status: true, hideHeadline: false, componentMenu: true });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [toolbarSpec, setToolbarSpec] = useState<string | undefined>(undefined);
  /** `[HI-WAVE] LoadDialogOptions=` of the connection .ini (presets the Load Executable File dialog). */
  const [loadOptions, setLoadOptions] = useState<string | undefined>(undefined);
  const [recentApps, setRecentApps] = useState<string[]>([]);
  const [cycleBase, setCycleBase] = useState(0);
  const [version, setVersion] = useState('');
  const layoutFor = useRef<string | null | undefined>(undefined);
  /** Number of layout loads started by the session layout effect (each one replaces every window). */
  const layoutLoads = useRef(0);
  /** The layout load whose windows are in place (its number; 0 before the first). */
  const [layoutLoaded, setLayoutLoaded] = useState(0);

  const report = useCallback((e: unknown) => setMessage(parseApiError(e).message), []);

  const applyLayout = useCallback((l: unknown) => {
    if (isLayout(l)) {
      dispatch({ type: 'load', layout: l });
      setMenusByWin({});
    }
  }, []);

  // (Re)build the windows when the session's layout file changes (built-in default layout without one).
  useEffect(() => {
    const path = session?.layoutPath ?? null;
    if (layoutFor.current === path) return;
    layoutFor.current = path;
    const gen = ++layoutLoads.current;
    const load = path ? s12.layout.read(path) : s12.layout.defaultLayout();
    // a newer load (e.g. the null session of a relaunch, then the new session) supersedes this one
    const current = () => layoutLoads.current === gen;
    const apply = (l: unknown) => {
      if (current()) applyLayout(l);
    };
    const loaded = () => {
      if (current()) setLayoutLoaded(gen);
    };
    void Promise.resolve(load).then(
      (l) => {
        apply(l);
        loaded();
      },
      (e) => {
        if (current()) report(e);
        void Promise.resolve(s12.layout.defaultLayout()).then(apply, () => undefined).finally(loaded);
      },
    );
  }, [s12, session?.layoutPath, report, applyLayout]);

  // ME305 board: a session whose simulated system has the board (every ME305 project) gets the ME305 Board window,
  // docked on the right, when its .hwl has none (course .hwl files predate S12 Studio's board). Once per applied
  // layout, after it is in place: closing the board afterwards is respected until the layout is loaded again (another
  // project, or a relaunch, whose null session reloads the windows).
  const sessionKey = session ? `${session.projectDir}\n${session.iniPath ?? ''}\n${session.layoutPath ?? ''}` : null;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const boardDockedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionKey || layoutLoaded !== layoutLoads.current || layoutFor.current !== (session?.layoutPath ?? null)) return;
    const key = `${sessionKey}\n${layoutLoaded}`;
    if (boardDockedFor.current === key) return;
    boardDockedFor.current = key;
    void Promise.resolve(s12.board.state()).then(
      (b) => {
        if (b?.present && sessionKeyRef.current === sessionKey && layoutLoads.current === layoutLoaded) dispatch({ type: 'dockBoard' });
      },
      () => undefined,
    );
  }, [s12, sessionKey, session?.layoutPath, layoutLoaded]);

  // Toolbar from the connection .ini ([HI-WAVE] TOOLBAR=); the default toolbar without one.
  useEffect(() => {
    const ini = session?.iniPath;
    if (!ini) {
      setToolbarSpec(undefined);
      setLoadOptions(undefined);
      return;
    }
    let live = true;
    void Promise.resolve(s12.files.readText(ini)).then(
      (f) => {
        if (!live) return;
        const text = f && typeof f.text === 'string' ? f.text : undefined;
        setToolbarSpec(text !== undefined ? toolbarFromIni(text) : undefined);
        setLoadOptions(text !== undefined ? loadDialogOptionsFromIni(text) : undefined);
      },
      () => {
        if (!live) return;
        setToolbarSpec(undefined);
        setLoadOptions(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [s12, session?.iniPath]);

  useEffect(() => {
    // main sets the native title verbatim from the session (document.title would collapse the double space)
    document.title = session?.title || DEBUGGER_TITLE;
  }, [session?.title]);

  // File menu recent-application list
  useEffect(() => {
    const p = session?.absPath;
    if (p) setRecentApps((r) => [p, ...r.filter((x) => x !== p)].slice(0, 4));
  }, [session?.absPath]);

  useEffect(() => {
    void Promise.resolve(s12.app.info()).then((i) => setVersion(i?.version ?? ''), () => undefined);
  }, [s12]);

  // ------------------------------------------------------------------------------------------ UI commands

  const deliver = useCallback((cmd: UiCommandInfo) => {
    for (const w of windowsForCommand(mdiRef.current, cmd.component ?? '')) for (const l of [...(listeners.current.get(w.id) ?? [])]) l(cmd);
  }, []);

  const openComponent = useCallback((name: string, attributes?: HwlAttributeInfo[], rect?: Rect, flags?: { minimized?: boolean; maximized?: boolean }) => {
    const entry = findComponent(name);
    if (!entry) {
      setMessage(`Component "${name}" not found`);
      return;
    }
    dispatch({ type: 'open', component: entry.name, attributes, rect, kind: name.toLowerCase() === entry.name.toLowerCase() ? undefined : name, ...flags });
  }, []);

  const loadLayoutFile = useCallback(
    (path: string) => void Promise.resolve(s12.layout.read(path)).then(applyLayout, report),
    [s12, applyLayout, report],
  );

  const onWindowCommand = useCallback(
    (c: UiCommandInfo) => {
      const args = tokens(c.argText);
      switch (c.keyword.toUpperCase()) {
        case 'OPEN': {
          const o = parseOpenArgs(c.argText);
          if (!o) return;
          openComponent(o.name, undefined, o.rect, { minimized: o.minimized, maximized: o.maximized });
          break;
        }
        case 'ACTIVATE':
          for (const t of args) {
            const w = findWindow(mdiRef.current, t);
            if (w) dispatch({ type: 'activate', id: w.id });
          }
          break;
        case 'CLOSE':
          for (const t of args.length ? args : []) {
            const w = findWindow(mdiRef.current, t);
            if (w) dispatch({ type: 'close', id: w.id });
          }
          break;
        case 'SLAY':
          if (args[0]) loadLayoutFile(args[0]);
          break;
        case 'BCKCOLOR':
          if (args[0] && Number.isFinite(Number(args[0]))) dispatch({ type: 'bckcolor', color: Number(args[0]) });
          break;
        case 'FONT':
          if (args.length >= 2 && Number.isFinite(Number(args[1]))) dispatch({ type: 'font', font: { face: args[0], size: Number(args[1]), color: args[2] ?? 'BLACK' } });
          break;
        case 'AUTOSIZE':
          dispatch({ type: 'autosize', on: (args[0] ?? 'on').toLowerCase() !== 'off' });
          break;
        default:
          // component commands without a target (SPC, SMEM...): hiwave sends them to the matching component kind
          if (['SPC', 'SLINE'].includes(c.keyword.toUpperCase())) {
            deliver({ ...c, component: 'Source' });
            deliver({ ...c, component: 'Assembly' });
          } else if (c.keyword.toUpperCase() === 'SMEM') deliver({ ...c, component: 'Memory' });
          else if (c.keyword.toUpperCase() === 'SPROC') deliver({ ...c, component: 'Procedure' });
      }
    },
    [openComponent, loadLayoutFile, deliver],
  );

  useS12Event('debug', 'uiCommand', (c) => {
    if (c.component) deliver(c);
    else onWindowCommand(c);
  });
  useS12Event('debug', 'engineError', ({ message: m }) => setMessage(m));
  useS12Event('debug', 'applicationRebuilt', ({ absPath }) => setMessage(rebuiltNotice(absPath)));
  useS12Event('debug', 'halted', ({ info }) => setMessage(info.message || HELP_MESSAGE));

  const services = useMemo<MdiServices>(
    () => ({
      setMenu: (id, items) => setMenusByWin((m) => (m[id] === items ? m : { ...m, [id]: items })),
      onUiCommand: (id, fn) => {
        let set = listeners.current.get(id);
        if (!set) listeners.current.set(id, (set = new Set()));
        set.add(fn);
        return () => {
          listeners.current.get(id)?.delete(fn);
        };
      },
      send: (c) => (c.component ? deliver(c) : onWindowCommand(c)),
      status: (t) => setMessage(t || HELP_MESSAGE),
      open: (name, attributes) => openComponent(name, attributes),
      activateTitle: (t) => {
        const w = findWindow(mdiRef.current, t);
        if (w) dispatch({ type: 'activate', id: w.id });
      },
    }),
    [deliver, onWindowCommand, openComponent],
  );

  // ------------------------------------------------------------------------------------------ commands

  const saveLayout = useCallback(
    async (path: string) => {
      await s12.layout.write(path, mdiToHwl(mdiRef.current));
      setMessage(`Configuration saved: ${path}`);
    },
    [s12],
  );

  const saveLayoutAs = useCallback(
    async (title: string) => {
      const p = await s12.files.saveDialog({ title, defaultPath: session?.layoutPath, filters: [{ name: 'Layout (*.hwl)', extensions: ['hwl'] }] });
      if (p) await saveLayout(p);
    },
    [s12, session?.layoutPath, saveLayout],
  );

  const run = useCallback(
    (id: string) => {
      const d = s12.debug;
      const step = STEP_COMMANDS[id as keyof typeof STEP_COMMANDS];
      if (step) {
        void d.step(step).catch(report);
        return;
      }
      if (id.startsWith('window.select.')) {
        dispatch({ type: 'activate', id: id.slice('window.select.'.length) });
        return;
      }
      if (id.startsWith('file.recentApp.')) {
        const p = recentApps[Number(id.slice('file.recentApp.'.length))];
        if (p) void d.loadApplication({ path: p, options: loadOptionsOf(loadDialogPreset(loadOptions, p)) }).catch(report);
        return;
      }
      switch (id) {
        case 'file.new':
          void Promise.resolve(s12.layout.defaultLayout()).then(applyLayout, report);
          break;
        case 'file.load':
        case 'conn.load':
          setDialog('load');
          break;
        case 'file.openConfig':
          void (async () => {
            const [p] = (await s12.files.openDialog({ title: 'Open Configuration', defaultPath: session?.iniPath, filters: [{ name: 'Configuration (*.ini)', extensions: ['ini', 'pjt', 'hwc'] }] })) ?? [];
            if (p) await d.launch({ iniPath: p });
          })().catch(report);
          break;
        case 'file.saveConfig':
          void (session?.layoutPath ? saveLayout(session.layoutPath) : saveLayoutAs('Save Configuration')).catch(report);
          break;
        case 'file.saveConfigAs':
          void saveLayoutAs('Save Configuration As').catch(report);
          break;
        case 'file.exit':
          void s12.app.closeWindow();
          break;
        case 'view.toolbar':
          setView((v) => ({ ...v, toolbar: !v.toolbar }));
          break;
        case 'view.statusbar':
          setView((v) => ({ ...v, status: !v.status }));
          break;
        case 'view.headline':
          setView((v) => ({ ...v, hideHeadline: !v.hideHeadline }));
          break;
        case 'run.go':
          void d.go().catch(report);
          break;
        case 'run.halt':
          void d.halt().catch(report);
          break;
        case 'run.restart':
          void d.restart().catch(report);
          break;
        case 'conn.reset':
          void d.reset().catch(report);
          break;
        case 'run.controlPoints':
          setDialog('controlpoints');
          break;
        case 'component.open':
          setDialog('open');
          break;
        case 'component.setConnection':
          setDialog('setConnection');
          break;
        case 'component.fonts':
          setDialog('fonts');
          break;
        case 'component.background':
          setDialog('background');
          break;
        case 'window.cascade':
          dispatch({ type: 'cascade' });
          break;
        case 'window.tile':
          dispatch({ type: 'tile' });
          break;
        case 'window.arrangeIcons':
          dispatch({ type: 'arrangeIcons' });
          break;
        case 'window.autosize':
          dispatch({ type: 'autosize', on: !mdiRef.current.autosize });
          break;
        case 'window.componentMenu':
          setView((v) => ({ ...v, componentMenu: !v.componentMenu }));
          break;
        case 'window.layoutLoad':
          void (async () => {
            const [p] = (await s12.files.openDialog({ title: 'Load Layout', defaultPath: session?.layoutPath, filters: [{ name: 'Layout (*.hwl)', extensions: ['hwl'] }] })) ?? [];
            if (p) loadLayoutFile(p);
          })().catch(report);
          break;
        case 'window.layoutStore':
          void saveLayoutAs('Store Layout').catch(report);
          break;
        case 'edit.copy':
          document.execCommand('copy');
          break;
        case 'edit.cut':
          document.execCommand('cut');
          break;
        case 'edit.paste':
          document.execCommand('paste');
          break;
        case 'help.about':
          setDialog('about');
          break;
        case 'help.context':
          setMessage('Context help is not available');
          break;
        default:
          setMessage(`${id}: not available`);
      }
    },
    [s12, session?.iniPath, session?.layoutPath, report, applyLayout, saveLayout, saveLayoutAs, loadLayoutFile, recentApps, loadOptions],
  );

  // ------------------------------------------------------------------------------------------ menus / toolbar

  const activeWin = mdi.windows.find((w) => w.id === mdi.active) ?? null;
  const menus = useMemo(
    () =>
      debuggerMenus(
        {
          state: snap.state,
          hasSession: !!session,
          connectionMenu: session?.connectionMenu ?? '',
          showToolbar: view.toolbar,
          showStatusBar: view.status,
          hideHeadline: view.hideHeadline,
          componentMenuOn: view.componentMenu,
          autosize: mdi.autosize !== false,
          windows: mdi.windows,
          activeId: mdi.active,
          componentTitle: activeWin?.title ?? null,
          componentMenu: activeWin ? (menusByWin[activeWin.id] ?? null) : null,
          recentApps,
        },
        run,
      ),
    [snap.state, session, view, mdi.autosize, mdi.windows, mdi.active, activeWin, menusByWin, run, recentApps],
  );
  useMenuShortcuts(menus);

  const toolbar = useMemo(() => parseToolbar(toolbarSpec), [toolbarSpec]);

  const mdiStyle = useMemo(() => {
    const st: Record<string, string> = {};
    if (mdi.font?.face) st['--cw-mono-font'] = `'${mdi.font.face}', 'Courier New', Courier, monospace`;
    if (mdi.font?.size) st['--cw-mono-font-size'] = `${pointsToPx(mdi.font.size)}px`;
    if (mdi.bckcolor !== undefined) st['--cw-window'] = colorrefToCss(mdi.bckcolor);
    return st as React.CSSProperties;
  }, [mdi.font, mdi.bckcolor]);

  const resetCycles = () => {
    const at = snap.cycles;
    void Promise.resolve(s12.debug.resetCycles()).then(
      () => setCycleBase(0),
      () => setCycleBase(at),
    );
  };

  return (
    <div className="cw-frame" data-testid="debugger-shell">
      <MenuBar menus={menus} />
      {view.toolbar && (
        <Toolbar testId="debugger-toolbar">
          {toolbar.map((t, i) => {
            if ('separator' in t) return <ToolSeparator key={`sep${i}`} />;
            const c = findCommand(menus, t.command);
            return <ToolButton key={t.cmdId} title={t.title} icon={ToolbarIcons[t.icon] ?? t.title} disabled={!!c?.disabled} onClick={() => run(t.command)} testId={t.testId} />;
          })}
        </Toolbar>
      )}
      <div className="cw-frame-body">
        <MdiArea state={mdi} dispatch={dispatch} services={services} hideHeadline={view.hideHeadline} style={mdiStyle} />
      </div>
      {view.status && (
        <StatusBar
          testId="debugger-status"
          panes={[
            { id: 'help', content: message },
            { id: 'clock', content: clockText(snap), width: 110, title: 'Bus clock frequency' },
            { id: 'cycles', content: cyclesText(snap, cycleBase), width: 130, title: 'CPU cycles (double-click resets)', onDoubleClick: resetCycles },
            { id: 'derivative', content: session?.derivative ?? '', width: 110 },
            { id: 'state', content: runStateText(snap), width: 110 },
          ]}
        />
      )}
      <ComponentOpenDialog open={dialog === 'open'} onClose={() => setDialog(null)} onOpen={(names: HiwaveComponentName[]) => names.forEach((n) => openComponent(n))} />
      <FontDialog open={dialog === 'fonts'} onClose={() => setDialog(null)} font={mdi.font ?? { face: 'Courier New', size: 9, color: 'BLACK' }} onApply={(font) => dispatch({ type: 'font', font })} />
      <BackgroundDialog open={dialog === 'background'} onClose={() => setDialog(null)} color={colorrefToCss(mdi.bckcolor ?? 0x02ffffff)} onApply={(css) => dispatch({ type: 'bckcolor', color: cssToColorref(css) })} />
      <ControlpointsDialog open={dialog === 'controlpoints'} onClose={() => setDialog(null)} />
      <LoadExecutableDialog
        open={dialog === 'load'}
        initial={loadDialogPreset(loadOptions, session?.absPath ?? '')}
        onClose={() => setDialog(null)}
        onBrowse={async (cur) => {
          const [p] = (await s12.files.openDialog({ title: 'Load Executable File', defaultPath: cur || session?.absPath, filters: [{ name: 'Applications (*.abs, *.elf, *.s19)', extensions: ['abs', 'elf', 's19'] }] })) ?? [];
          return p;
        }}
        onLoad={(st) => void Promise.resolve(s12.debug.loadApplication({ path: st.path, options: loadOptionsOf(st) })).catch(report)}
      />
      <SetConnectionDialog
        open={dialog === 'setConnection'}
        current={session?.connection.toLowerCase() === 'sim' ? 'Full Chip Simulation' : ''}
        onClose={() => setDialog(null)}
        onOk={() => {
          // Full Chip Simulation is the only connection: restart the session on the project's FCS .ini (Lab3's
          // default P&E connection already falls back to it; this makes the choice explicit, like at the lab).
          const dir = session?.projectDir;
          const ini = dir ? `${dir.replace(/[\\/]+$/, '')}/Full_Chip_Simulation.ini` : undefined;
          void (async () => {
            const exists = ini ? await Promise.resolve(s12.files.stat(ini)).then((st) => !!st, () => false) : false;
            await s12.debug.launch(exists ? { iniPath: ini } : {});
          })().catch(report);
        }}
      />
      <AboutDialog open={dialog === 'about'} onClose={() => setDialog(null)} version={version} />
    </div>
  );
}

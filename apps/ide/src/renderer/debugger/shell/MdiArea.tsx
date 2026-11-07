/**
 * hiwave MDI client area: component windows are free-floating children positioned in percent of this area (exactly
 * the .hwl geometry), each with a caption (system icon, title, minimize/maximize/close), an Object Info Bar
 * ("headline") and the registered component as body. Drag the caption to move, the edges to resize, double-click the
 * caption to maximize. Minimized windows become caption-only icons along the bottom edge.
 *
 * State lives in the shell (layout.ts reducer); this file only renders it and reports user gestures.
 */
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { HwlAttributeInfo, UiCommandInfo } from '../../../shared/api';
import type { MenuEntry } from '../../common/menu/model';
import { ComponentHostContext, type ComponentHost, type HiwaveComponentName } from '../components/contract';
import { findComponent } from '../components/registry';
import { DebuggerBusContext, type DebuggerBus } from './bus';
import { iconSlots, type MdiAction, type MdiState, type MdiWindow, type Rect } from './layout';
import { ToolbarIcons } from './toolbar-icons';

/** What the shell provides to every window. */
export interface MdiServices {
  setMenu(windowId: string, items: MenuEntry[] | null): void;
  onUiCommand(windowId: string, fn: (cmd: UiCommandInfo) => void): () => void;
  send(cmd: UiCommandInfo): void;
  status(text: string): void;
  open(name: HiwaveComponentName, attributes?: HwlAttributeInfo[]): void;
  activateTitle(title: string): void;
}

export interface MdiAreaProps {
  state: MdiState;
  dispatch: (a: MdiAction) => void;
  services: MdiServices;
  hideHeadline?: boolean;
  style?: CSSProperties;
}

export function MdiArea({ state, dispatch, services, hideHeadline, style }: MdiAreaProps) {
  const ref = useRef<HTMLDivElement>(null);
  const slots = iconSlots(state.windows);
  const svc = useRef(services);
  svc.current = services;
  const stableServices = useMemo<MdiServices>(
    () => ({
      setMenu: (id, items) => svc.current.setMenu(id, items),
      onUiCommand: (id, fn) => svc.current.onUiCommand(id, fn),
      send: (c) => svc.current.send(c),
      status: (t) => svc.current.status(t),
      open: (n, a) => svc.current.open(n, a),
      activateTitle: (t) => svc.current.activateTitle(t),
    }),
    [],
  );
  return (
    <div ref={ref} className="s12-mdi" style={style} data-testid="mdi-area">
      {state.windows.map((w) => (
        <MdiChild key={w.id} win={w} active={w.id === state.active} areaRef={ref} dispatch={dispatch} services={stableServices} iconSlot={slots.get(w.id)} hideHeadline={!!hideHeadline} />
      ))}
    </div>
  );
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

interface ChildProps {
  win: MdiWindow;
  active: boolean;
  areaRef: React.RefObject<HTMLDivElement | null>;
  dispatch: (a: MdiAction) => void;
  services: MdiServices;
  iconSlot?: number;
  hideHeadline: boolean;
}

const MdiChild = memo(function MdiChild({ win, active, areaRef, dispatch, services, iconSlot, hideHeadline }: ChildProps) {
  const [headline, setHeadline] = useState('');
  const id = win.id;
  // attributes from the layout are given to the component once (it reports changes through the bus)
  const [initialAttrs] = useState(win.attributes);
  const host = useMemo<ComponentHost>(
    () => ({
      setMenu: (items) => services.setMenu(id, items),
      setHeadline: (t) => setHeadline((h) => (h === t ? h : t)),
      open: (name, opts) => services.open(name, opts?.attributes),
      activate: (t) => services.activateTitle(t),
      onUiCommand: (fn) => services.onUiCommand(id, fn),
    }),
    [id, services],
  );
  const bus = useMemo<DebuggerBus>(
    () => ({ send: (c) => services.send(c), setAttributes: (attributes) => dispatch({ type: 'setAttributes', id, attributes }), status: (t) => services.status(t) }),
    [id, services, dispatch],
  );

  const drag = useCallback(
    (e: React.MouseEvent, edge: Edge | 'move') => {
      if (e.button !== 0 || win.maximized || win.minimized) return;
      e.preventDefault();
      const box = areaRef.current?.getBoundingClientRect();
      if (!box || !box.width || !box.height) return;
      const start = { x: e.clientX, y: e.clientY, r: { ...win.rect } };
      const move = (ev: MouseEvent) => {
        const dx = ((ev.clientX - start.x) / box.width) * 100;
        const dy = ((ev.clientY - start.y) / box.height) * 100;
        const r: Rect = { ...start.r };
        if (edge === 'move') {
          r.x += dx;
          r.y += dy;
        } else {
          if (edge.includes('e')) r.w += dx;
          if (edge.includes('s')) r.h += dy;
          if (edge.includes('w')) {
            r.x += dx;
            r.w -= dx;
          }
          if (edge.includes('n')) {
            r.y += dy;
            r.h -= dy;
          }
        }
        dispatch({ type: 'setRect', id, rect: r });
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [areaRef, dispatch, id, win.maximized, win.minimized, win.rect],
  );

  const entry = findComponent(win.component);
  const C = entry?.component;
  const geometry: CSSProperties = win.minimized
    ? { left: (iconSlot ?? 0) * 164, bottom: 0, width: 160, height: 20 }
    : win.maximized
      ? { left: 0, top: 0, right: 0, bottom: 0 }
      : { left: `${win.rect.x}%`, top: `${win.rect.y}%`, width: `${win.rect.w}%`, height: `${win.rect.h}%` };

  return (
    <div
      className={`s12-mdi-child${active ? ' active' : ''}${win.minimized ? ' minimized' : ''}${win.maximized ? ' maximized' : ''}`}
      style={{ ...geometry, zIndex: win.z }}
      data-testid={`mdi-window-${win.title}`}
      data-window-id={id}
      data-component={win.component}
      role="dialog"
      aria-label={win.title}
      onMouseDownCapture={() => {
        if (!active || win.minimized) dispatch({ type: 'activate', id });
      }}
    >
      <div
        className={`cw-caption s12-mdi-caption${active ? ' active' : ''}`}
        onMouseDown={(e) => drag(e, 'move')}
        onDoubleClick={() => dispatch({ type: win.maximized || win.minimized ? 'restore' : 'maximize', id })}
        data-testid={`mdi-caption-${win.title}`}
      >
        <span className="s12-mdi-sysicon">{ToolbarIcons.component}</span>
        <span className="s12-mdi-title">{win.title}</span>
        <CaptionButton label="Minimize" glyph="_" onClick={() => dispatch({ type: 'minimize', id })} />
        <CaptionButton label={win.maximized || win.minimized ? 'Restore' : 'Maximize'} glyph={win.maximized || win.minimized ? '❐' : '□'} onClick={() => dispatch({ type: win.maximized || win.minimized ? 'restore' : 'maximize', id })} />
        <CaptionButton label="Close" glyph="×" onClick={() => dispatch({ type: 'close', id })} testId={`mdi-close-${win.title}`} />
      </div>
      <div className="s12-mdi-content" style={win.minimized ? { display: 'none' } : undefined}>
        {!hideHeadline && (headline || entry?.infoBar) && (
          <div className="s12-mdi-headline cw-sunken" data-testid={`headline-${win.title}`}>
            {/* "left\tright": the right part (e.g. "Line: 42", "Auto") stays visible, the left one is ellipsized */}
            <span className="s12-mdi-headline-main">{headline.split('\t')[0]}</span>
            {headline.includes('\t') && <span className="s12-mdi-headline-side">{headline.split('\t').slice(1).join('  ')}</span>}
          </div>
        )}
        <div className="s12-mdi-body">
          <ComponentHostContext.Provider value={host}>
            <DebuggerBusContext.Provider value={bus}>
              {C ? <C instanceId={id} title={win.title} instance={win.instance} attributes={initialAttrs} active={active} /> : <div className="cw-placeholder">Unknown component {win.component}</div>}
            </DebuggerBusContext.Provider>
          </ComponentHostContext.Provider>
        </div>
      </div>
      {!win.minimized && !win.maximized && EDGES.map((e) => <div key={e} className={`s12-mdi-grip ${e}`} onMouseDown={(ev) => drag(ev, e)} />)}
    </div>
  );
});

function CaptionButton({ label, glyph, onClick, testId }: { label: string; glyph: string; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      className="s12-mdi-capbtn"
      aria-label={label}
      title={label}
      data-testid={testId}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {glyph}
    </button>
  );
}

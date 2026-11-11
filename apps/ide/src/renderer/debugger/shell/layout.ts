/**
 * hiwave MDI layout model. A `.hwl` places every component window as a free-floating MDI child whose rectangle is in
 * percent of the main frame's client area (`OPEN source 0 0 60 42`). We keep exactly that model: each window has a
 * percent rectangle, a z-order and min/max state; MdiArea renders it as absolutely positioned child windows.
 *
 * Pure functions only (reducer + geometry), so the layout behaviour is unit-tested without a DOM.
 */
import type { HwlAttributeInfo, HwlLayoutInfo } from '../../../shared/api';
import type { HiwaveComponentName } from '../components/contract';
import { findComponent } from '../components/registry';

/** Rectangle in percent of the MDI client area. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MdiWindow {
  /** Stable id (never changes, even when the title is renumbered). */
  id: string;
  /** Window title used by `<Title> <` commands: "Source", "Data:1". */
  title: string;
  component: HiwaveComponentName;
  /** Component kind as written in OPEN ("source", "data"); kept for writing the .hwl back. */
  kind: string;
  instance: number;
  rect: Rect;
  minimized: boolean;
  maximized: boolean;
  /** Stacking order: higher is in front. */
  z: number;
  attributes: HwlAttributeInfo[];
  openFlags?: string;
}

export interface MdiState {
  windows: MdiWindow[];
  /** Id of the active (front, highlighted caption) window. */
  active: string | null;
  /** Layout-level settings from the .hwl (written back by Save Configuration). */
  bckcolor?: number;
  font?: { face: string; size: number; color: string };
  autosize?: boolean;
  otherRaw: string[];
  eol: '\r\n' | '\n';
  /** Components named in the layout that the registry does not know (not opened). */
  unknown: string[];
  /** Counter for window ids. */
  seq: number;
}

/**
 * Window ids are unique for the lifetime of the page (a reloaded layout gets new ids, so its components remount and
 * re-register their menus).
 */
let idCounter = 0;
const newId = (): string => `w${++idCounter}`;

export const EMPTY_MDI: MdiState = { windows: [], active: null, otherRaw: [], eol: '\r\n', unknown: [], seq: 0 };

const clampRect = (r: Rect): Rect => {
  const w = Math.min(100, Math.max(2, r.w));
  const h = Math.min(100, Math.max(2, r.h));
  return { x: Math.min(100 - 2, Math.max(-w + 4, r.x)), y: Math.min(100 - 2, Math.max(0, r.y)), w, h };
};

/** Default rectangle for windows opened without geometry (`OPEN source`, Component > Open). UNCERTAIN: hiwave's rule. */
export function defaultRect(index: number): Rect {
  const step = (index % 8) * 3;
  return { x: 5 + step, y: 5 + step, w: 50, h: 40 };
}

/** Titles of one component kind: "Memory" alone, "Memory:1", "Memory:2"... when several are open. */
function renumber(windows: MdiWindow[]): MdiWindow[] {
  const byKind = new Map<string, MdiWindow[]>();
  for (const w of windows) {
    const list = byKind.get(w.component) ?? [];
    list.push(w);
    byKind.set(w.component, list);
  }
  return windows.map((w) => {
    const list = byKind.get(w.component)!;
    const title = list.length > 1 ? `${w.component}:${w.instance}` : w.component;
    return title === w.title ? w : { ...w, title };
  });
}

/** Window whose title (or kind) matches a hiwave window reference ("Data:2", "data", "Assembly"). */
export function findWindow(state: Pick<MdiState, 'windows'>, ref: string): MdiWindow | undefined {
  const r = ref.trim().replace(/^"|"$/g, '').toLowerCase();
  return (
    state.windows.find((w) => w.title.toLowerCase() === r) ??
    state.windows.find((w) => w.title.toLowerCase() === `${r}:1`) ??
    state.windows.find((w) => w.component.toLowerCase() === r || w.kind.toLowerCase() === r)
  );
}

/** Windows a `Comp < cmd` UI command is addressed to: exact title first, else every window of that kind. */
export function windowsForCommand(state: Pick<MdiState, 'windows'>, component: string): MdiWindow[] {
  const r = component.trim().toLowerCase();
  const exact = state.windows.filter((w) => w.title.toLowerCase() === r);
  if (exact.length) return exact;
  const entry = findComponent(r.replace(/:\d+$/, ''));
  return entry ? state.windows.filter((w) => w.component === entry.name) : [];
}

/** .hwl layout -> MDI state (windows with percent rectangles, z-order from ACTIVATE). */
export function hwlToMdi(layout: HwlLayoutInfo): MdiState {
  const unknown: string[] = [];
  let seq = 0;
  const counts = new Map<string, number>();
  const windows: MdiWindow[] = [];
  let noGeo = 0;
  for (const w of layout.windows) {
    const entry = findComponent(w.component);
    if (!entry) {
      unknown.push(w.component);
      continue;
    }
    // a layout saved while the board was an MDI child (0.1.x): the board now has its own window
    if (entry.name === BOARD_COMPONENT) continue;
    const n = (counts.get(entry.name) ?? 0) + 1;
    counts.set(entry.name, n);
    const rect = w.hasGeometry === false ? defaultRect(noGeo++) : clampRect({ x: w.x, y: w.y, w: w.w, h: w.h });
    const flags = (w.openFlags ?? '').toUpperCase();
    windows.push({
      id: newId(),
      title: w.title || entry.name,
      component: entry.name,
      kind: w.component,
      instance: n,
      rect,
      minimized: flags.includes(';I'),
      maximized: flags.includes(';MAX'),
      z: ++seq,
      attributes: w.attributes.map((a) => ({ ...a })),
      openFlags: w.openFlags,
    });
  }
  let state: MdiState = { windows: renumber(windows), active: null, bckcolor: layout.bckcolor, font: layout.font, autosize: layout.autosize, otherRaw: [...layout.otherRaw], eol: layout.eol, unknown, seq };
  // ACTIVATE "A" "B" ... activates in order: the last one ends up in front and active
  for (const t of layout.activate) {
    const w = findWindow(state, t);
    if (w) state = mdiReducer(state, { type: 'activate', id: w.id });
  }
  if (!state.active && state.windows.length) state = { ...state, active: topWindow(state.windows)?.id ?? null };
  return state;
}

/** MDI state -> .hwl layout (Save Configuration / Window > Layout > Store). */
export function mdiToHwl(state: MdiState): HwlLayoutInfo {
  const byZ = [...state.windows].sort((a, b) => a.z - b.z);
  return {
    windows: state.windows.map((w) => ({
      component: w.kind,
      title: w.title,
      x: Math.round(w.rect.x),
      y: Math.round(w.rect.y),
      w: Math.round(w.rect.w),
      h: Math.round(w.rect.h),
      openFlags: w.minimized ? ';I' : w.maximized ? ';MAX' : undefined,
      attributes: w.attributes.map((a) => ({ ...a })),
    })),
    bckcolor: state.bckcolor,
    font: state.font,
    autosize: state.autosize,
    // z-order bottom -> top, so replaying ACTIVATE restores the stacking and the active window
    activate: byZ.map((w) => w.title),
    otherRaw: [...state.otherRaw],
    warnings: [],
    eol: state.eol,
  };
}

const topWindow = (ws: readonly MdiWindow[]): MdiWindow | undefined => ws.reduce<MdiWindow | undefined>((t, w) => (!t || w.z > t.z ? w : t), undefined);

// ------------------------------------------------------------------------------------------------ arrangement

/** Window > Cascade: staggered, 60% x 60%, in current z-order (front window last = front). */
export function cascade(windows: readonly MdiWindow[]): MdiWindow[] {
  const order = windows.filter((w) => !w.minimized).sort((a, b) => a.z - b.z);
  const step = 3;
  const pos = new Map(order.map((w, i) => [w.id, i]));
  return windows.map((w) => {
    const i = pos.get(w.id);
    if (i === undefined) return w;
    const k = i % 12;
    return { ...w, maximized: false, rect: { x: k * step, y: k * (step + 1), w: 60, h: 60 } };
  });
}

/** Window > Tile: a grid of equal cells (columns = ceil(sqrt(n))), in window order. */
export function tile(windows: readonly MdiWindow[]): MdiWindow[] {
  const vis = windows.filter((w) => !w.minimized);
  const n = vis.length;
  if (!n) return [...windows];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const pos = new Map(vis.map((w, i) => [w.id, i]));
  return windows.map((w) => {
    const i = pos.get(w.id);
    if (i === undefined) return w;
    const r = Math.floor(i / cols);
    const c = i % cols;
    // the last row spreads its windows over the full width
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const cw = 100 / inRow;
    return { ...w, maximized: false, rect: { x: c * cw, y: (r * 100) / rows, w: cw, h: 100 / rows } };
  });
}

/**
 * Slot of each minimized (iconic) window along the bottom edge, in windows-array order. MdiArea draws the icons at
 * fixed pixel positions from these slots; Window > Arrange Icons re-packs them (see the reducer).
 */
export function iconSlots(windows: readonly MdiWindow[]): Map<string, number> {
  const out = new Map<string, number>();
  let i = 0;
  for (const w of windows) if (w.minimized) out.set(w.id, i++);
  return out;
}

// ------------------------------------------------------------------------------------------------ ME3305 board

/** The ME3305 board's component (registry name). It has its own window, so it is never an MDI child here. */
export const BOARD_COMPONENT: HiwaveComponentName = 'ME3305 Board';
// ------------------------------------------------------------------------------------------------ reducer

export type MdiAction =
  | { type: 'load'; layout: HwlLayoutInfo }
  | { type: 'open'; component: HiwaveComponentName; rect?: Rect; attributes?: HwlAttributeInfo[]; kind?: string; minimized?: boolean; maximized?: boolean }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'setRect'; id: string; rect: Rect }
  | { type: 'minimize'; id: string }
  | { type: 'maximize'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'setAttributes'; id: string; attributes: HwlAttributeInfo[] }
  | { type: 'cascade' }
  | { type: 'tile' }
  | { type: 'arrangeIcons' }
  | { type: 'font'; font: { face: string; size: number; color: string } }
  | { type: 'bckcolor'; color: number }
  | { type: 'autosize'; on: boolean };

export function mdiReducer(state: MdiState, a: MdiAction): MdiState {
  const maxZ = state.windows.reduce((m, w) => Math.max(m, w.z), 0);
  const map = (id: string, f: (w: MdiWindow) => MdiWindow): MdiWindow[] => state.windows.map((w) => (w.id === id ? f(w) : w));
  switch (a.type) {
    case 'load':
      return hwlToMdi(a.layout);
    case 'open': {
      const entry = findComponent(a.component);
      // the board has its own window (DebuggerShell shows it); never an MDI child
      if (!entry || entry.name === BOARD_COMPONENT) return state;
      const existing = state.windows.filter((w) => w.component === entry.name);
      if (existing.length && !entry.multiInstance) {
        const w = existing[0];
        const moved = mdiReducer(a.rect ? { ...state, windows: map(w.id, (x) => ({ ...x, rect: clampRect(a.rect!) })) } : state, { type: 'activate', id: w.id });
        return a.minimized ? mdiReducer(moved, { type: 'minimize', id: w.id }) : a.maximized ? mdiReducer(moved, { type: 'maximize', id: w.id }) : moved;
      }
      const instance = existing.reduce((m, w) => Math.max(m, w.instance), 0) + 1;
      const id = newId();
      const win: MdiWindow = {
        id,
        title: entry.name,
        component: entry.name,
        kind: a.kind ?? entry.name.toLowerCase().replace(/\s+/g, ''),
        instance,
        rect: a.rect ? clampRect(a.rect) : defaultRect(state.windows.length),
        minimized: false,
        maximized: false,
        z: maxZ + 1,
        attributes: a.attributes ?? [],
      };
      const opened: MdiState = { ...state, seq: state.seq + 1, windows: renumber([...state.windows, win]), active: id };
      // `OPEN comp x y w h;I` opens iconic, `;MAX` maximized (the .hwl flags)
      return a.minimized ? mdiReducer(opened, { type: 'minimize', id }) : a.maximized ? mdiReducer(opened, { type: 'maximize', id }) : opened;
    }
    case 'close': {
      const windows = renumber(state.windows.filter((w) => w.id !== a.id));
      const active = state.active === a.id ? (topWindow(windows.filter((w) => !w.minimized))?.id ?? null) : state.active;
      return { ...state, windows, active };
    }
    case 'activate': {
      const w = state.windows.find((x) => x.id === a.id);
      if (!w) return state;
      if (state.active === a.id && w.z === maxZ && !w.minimized) return state;
      return { ...state, active: a.id, windows: map(a.id, (x) => ({ ...x, z: maxZ + 1, minimized: false })) };
    }
    case 'setRect':
      return { ...state, windows: map(a.id, (w) => ({ ...w, rect: clampRect(a.rect), maximized: false })) };
    case 'minimize': {
      const windows = map(a.id, (w) => ({ ...w, minimized: true, maximized: false }));
      const active = state.active === a.id ? (topWindow(windows.filter((w) => !w.minimized))?.id ?? null) : state.active;
      return { ...state, windows, active };
    }
    case 'maximize':
      return mdiReducer({ ...state, windows: map(a.id, (w) => ({ ...w, maximized: true, minimized: false })) }, { type: 'activate', id: a.id });
    case 'restore':
      return mdiReducer({ ...state, windows: map(a.id, (w) => ({ ...w, maximized: false, minimized: false })) }, { type: 'activate', id: a.id });
    case 'setAttributes':
      return { ...state, windows: map(a.id, (w) => ({ ...w, attributes: a.attributes })) };
    case 'cascade':
      return { ...state, windows: cascade(state.windows) };
    case 'tile':
      return { ...state, windows: tile(state.windows) };
    case 'arrangeIcons':
      // icons are always packed along the bottom (iconSlots) and cannot be dragged, so they are always arranged.
      // UNCERTAIN: hiwave lets icons be moved freely; we do not.
      return state;
    case 'font':
      return { ...state, font: a.font };
    case 'bckcolor':
      return { ...state, bckcolor: a.color };
    case 'autosize':
      return { ...state, autosize: a.on };
  }
}

// ------------------------------------------------------------------------------------------------ colours / fonts

/**
 * Arguments of the interpreter's `OPEN component [x y w h][;I|;MAX]` (the flag may be glued to the last number, as
 * the .hwl writes it). Null without a component name.
 */
export function parseOpenArgs(argText: string): { name: string; rect?: Rect; minimized: boolean; maximized: boolean } | null {
  let t = argText;
  let minimized = false;
  let maximized = false;
  t = t.replace(/;\s*(MAX|I)\b/gi, (_m, f: string) => {
    if (f.toUpperCase() === 'I') minimized = true;
    else maximized = true;
    return ' ';
  });
  const [name, ...rest] = t.trim().split(/\s+/).filter(Boolean);
  if (!name) return null;
  const nums = rest.slice(0, 4).map(Number);
  const rect = nums.length === 4 && nums.every((n) => Number.isFinite(n)) ? { x: nums[0], y: nums[1], w: nums[2], h: nums[3] } : undefined;
  return { name, rect, minimized, maximized };
}

/** Win32 COLORREF (0x00BBGGRR, PALETTERGB flag 0x02000000 ignored) -> CSS "#rrggbb". */
export function colorrefToCss(c: number): string {
  const r = c & 0xff;
  const g = (c >>> 8) & 0xff;
  const b = (c >>> 16) & 0xff;
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** CSS "#rrggbb" -> COLORREF with the PALETTERGB flag hiwave writes (50331647 = 0x02FFFFFF = white). */
export function cssToColorref(css: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim());
  if (!m) return 0x02ffffff;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  return (0x02000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/** hiwave font size is in points; the screen is 96 dpi. */
export const pointsToPx = (pt: number): number => Math.round((pt * 96) / 72);

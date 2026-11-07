/**
 * hiwave "Data" component (docs/research/r1/ide.md §6 Data): rows `name | value | type`, Scope Global / Local / User,
 * Format (Symbolic, Hex, Bin, Oct, Dec, UDec, Bit Reverse, Char; for all rows or per row from the pop-up),
 * Mode Automatic / Periodical / Locked / Frozen (+ Update Rate), changed values in red, in-place value edit,
 * user expressions (.xpr: add / edit / delete, Open .xpr..., Save .xpr), watchpoint bars (read green, write red,
 * read/write yellow, disabled grey) and the watchpoint pop-up.
 *
 * Variables (DWARF objects from debug.globals, and user expressions that name one) are read through
 * useMemoryWatch; other expressions are evaluated by the engine (debug.evaluate) on each refresh.
 *
 * Zoom (In/Out) shows the elements of the selected array as the top level; Options > Pointer as Array displays
 * pointer variables as arrays of N elements at the pointed-to address (expand with +). Dialogs are mounted in a
 * DialogLayer so their key/mouse events never reach this window's handlers.
 *
 * UNCERTAIN: hiwave's Global scope lists the module's globals; user expressions (.xpr, `Data < ADDXPR`) are shown
 * first in Global scope and alone in User scope. Assembly has no locals: Local scope shows the procedure only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseApiError, type EvalResult, type ExpressionItem, type FrameInfo, type MemoryBlockInfo, type MemoryRange, type VariableEntry, type WatchKind } from '../../../../shared/api';
import { parseXpr, writeXpr } from '@s12/formats';
import { Button, Dialog, useResetOnOpen } from '../../../common/controls';
import { hex } from '../../../common/format';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import { SEP, type MenuEntry } from '../../../common/menu/model';
import { useDebugSnapshot, useMemoryWatch, useS12, useS12Event, useSession } from '../../../common/s12';
import { ControlpointsDialog } from '../../dialogs/ControlpointsDialog';
import { DialogLayer, inDialog } from '../../dialogs/DialogLayer';
import { PromptDialog, intRange } from '../../dialogs/PromptDialog';
import { useWatchpoints } from '../../dialogs/useControlpoints';
import { DND_MIME, getDnd, setDnd, useComponentHost, useComponentMenu, useUiCommands, type DebuggerComponentProps } from '../contract';
import { unitValue } from '../memory/model';
import { ChangeTracker, MODE_LABELS, RefreshPolicy, V_UNINIT, V_UNMAPPED, type RefreshMode } from '../memory/refresh';
import {
  DATA_FORMAT_LABELS,
  DATA_FORMAT_SHORT,
  SCOPE_LABELS,
  elementRows,
  exprRow,
  exprValueSize,
  expressionBelongs,
  formatDataValue,
  isPointerType,
  parseDataAttributes,
  parseDataInput,
  pointeeSize,
  typeText,
  valueBytes,
  varRow,
  type DataFormat,
  type DataRow,
  type DataScope,
} from './model';

const WATCH_BAR: Record<WatchKind, string> = { read: '#008000', write: '#ff0000', readwrite: '#e0c000' };
const MAX_ARRAY_PREVIEW = 8;

type Val = number | { error: string };

export function DataComponent({ title, instance, attributes }: DebuggerComponentProps) {
  const s12 = useS12();
  const host = useComponentHost();
  const session = useSession();
  const init = useMemo(() => parseDataAttributes(attributes), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [scope, setScope] = useState<DataScope>(init.scope ?? (instance === 2 ? 'local' : 'global'));
  const [fmt, setFmt] = useState<DataFormat>(init.format ?? 'symb');
  const [rowFmt, setRowFmt] = useState<Record<string, DataFormat>>({});
  const [mode, setMode] = useState<RefreshMode>(init.mode ?? 'automatic');
  const [rate, setRate] = useState(init.updateRate ?? 10);
  const [nameWidth, setNameWidth] = useState(init.nameWidth ?? 16);
  const [sort, setSort] = useState(init.sort ?? false);
  const [module, setModule] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ key: string; text: string } | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'expr'; old?: string } | { kind: 'rate' } | { kind: 'width' } | { kind: 'watchpoints' } | { kind: 'ptrarray' }>(null);
  /** Zoomed-in array row (its elements are the top level), or null. */
  const [zoom, setZoom] = useState<DataRow | null>(null);
  /** Options > Pointer as Array. */
  const [ptrArray, setPtrArray] = useState<{ on: boolean; count: number }>({ on: false, count: 10 });
  const [message, setMessage] = useState<string | null>(null);
  const fail = useCallback((e: unknown) => setMessage(parseApiError(e).message), []);

  // ---- symbol data: globals, user expressions, procedure
  const [globals, setGlobals] = useState<VariableEntry[]>([]);
  const [exprs, setExprs] = useState<ExpressionItem[]>([]);
  const [frame, setFrame] = useState<FrameInfo | null>(null);
  const reload = useCallback(() => {
    void s12.debug.globals().then((g) => setGlobals(g ?? []), () => setGlobals([]));
    void s12.debug.expressions().then((x) => setExprs(x ?? []), () => undefined);
  }, [s12]);
  useEffect(() => {
    if (session) reload();
  }, [session, reload]);
  useS12Event('debug', 'loaded', reload);
  useS12Event('debug', 'expressions', (x) => setExprs(x));

  // ---- rows
  const readVar = (blks: readonly MemoryBlockInfo[] | undefined, address: number, size: number): number | null => {
    if (!blks) return null;
    for (const b of blks) {
      const i = address - b.address;
      if (i >= 0 && i + size <= b.bytes.length) return unitValue(b.bytes, b.status, i, size as 1 | 2 | 4);
    }
    return null;
  };
  const userRows = useMemo(() => {
    // keys must be unique even when the engine list holds an expression twice (e.g. from an .xpr file)
    const seenKeys = new Map<string, number>();
    return exprs
      .filter((e) => expressionBelongs(e, title, instance))
      .map((e) => {
        const r = exprRow(e, globals);
        const n = seenKeys.get(r.key) ?? 0;
        seenKeys.set(r.key, n + 1);
        return n ? { ...r, key: `${r.key}#${n}` } : r;
      });
  }, [exprs, globals, title, instance]);
  const modules = useMemo(() => [...new Set(globals.map((g) => g.module).filter((m): m is string => !!m))], [globals]);
  const topRows = useMemo(() => {
    let rows: DataRow[];
    if (zoom) return elementRows(zoom);
    if (scope === 'user') rows = userRows;
    else if (scope === 'local') rows = [];
    else {
      const named = new Set(userRows.filter((r) => r.kind === 'var').map((r) => r.name));
      rows = [...userRows, ...globals.filter((g) => !module || g.module === module).filter((g) => !named.has(g.name)).map(varRow)];
    }
    return sort ? [...rows].sort((a, b) => a.name.localeCompare(b.name)) : rows;
  }, [scope, userRows, globals, module, sort, zoom]);

  // Pointer as Array: elements of an expanded pointer variable, at the address it holds (needs its shown value)
  const isPtr = (r: DataRow) => ptrArray.on && r.kind === 'var' && r.count === 1 && r.index === undefined && isPointerType(r.typeName);
  const shownRef = useRef<{ key: string; blocks: MemoryBlockInfo[] } | null>(null);
  const ptrElements = (r: DataRow): DataRow[] => {
    const p = readVar(shownRef.current?.blocks, r.address!, r.size);
    if (p === null || p < 0) return [];
    const esz = pointeeSize(r.typeName);
    const out: DataRow[] = [];
    for (let i = 0; i < ptrArray.count; i++)
      out.push({ ...r, key: `${r.key}->[${i}]`, name: `[${i}]`, address: (p + i * esz) & 0xffff, size: esz, count: 1, index: i, typeName: r.typeName.replace(/\*\s*$/, '').trim() });
    return out;
  };
  const ptrRows = topRows.filter((r) => isPtr(r) && expanded.has(r.key)).flatMap(ptrElements);
  const ptrKey = ptrRows.map((r) => `${r.key}@${r.address}`).join(',');
  const rows = useMemo(
    () => topRows.flatMap((r) => (r.count > 1 && expanded.has(r.key) ? [r, ...elementRows(r)] : isPtr(r) && expanded.has(r.key) ? [r, ...ptrRows.filter((e) => e.key.startsWith(`${r.key}->`))] : [r])),
    [topRows, expanded, ptrKey, ptrArray.on], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- values: variables through memory watches, expressions through evaluate()
  const ranges = useMemo<MemoryRange[]>(() => {
    if (zoom) return [{ address: zoom.address!, length: zoom.size * Math.min(zoom.count, 1024), space: 'local' }];
    const out: MemoryRange[] = topRows.filter((r) => r.kind === 'var').map((r) => ({ address: r.address!, length: r.size * Math.min(r.count, 1024), space: 'local' }));
    for (const r of ptrRows) out.push({ address: r.address!, length: r.size, space: 'local' });
    return out;
  }, [topRows, zoom, ptrKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const rangesKey = ranges.map((r) => `${r.address}:${r.length}`).join(',');
  const blocks = useMemoryWatch(ranges);
  const snap = useDebugSnapshot();
  const policy = useRef(new RefreshPolicy()).current;
  const tracker = useRef(new ChangeTracker<string>()).current;
  const shown = shownRef;
  const seen = useRef(-1);
  const [exprVals, setExprVals] = useState<Record<string, Val>>({});
  const [evalTick, setEvalTick] = useState<{ n: number; epoch: boolean }>({ n: 0, epoch: false });

  if (seen.current !== snap.seq) {
    seen.current = snap.seq;
    const d = policy.update(snap, mode, rate * 100, performance.now());
    if (blocks && (d.accept || shown.current?.key !== rangesKey)) {
      const values: [string, number][] = [];
      for (const r of [...topRows, ...ptrRows]) {
        if (r.kind !== 'var') continue;
        for (let i = 0; i < Math.min(r.count, 1024); i++) {
          const v = readVar(blocks, r.address! + i * r.size, r.size);
          if (v !== null) values.push([r.count > 1 ? `${r.key}[${i}]` : r.key, v]);
        }
      }
      tracker.observe(values, d.accept && d.epoch);
      shown.current = { key: rangesKey, blocks };
    } else if (d.epoch) tracker.markEpoch();
    if (d.accept && snap.state !== 'none') queueMicrotask(() => setEvalTick((t) => ({ n: t.n + 1, epoch: d.epoch })));
  }
  const exprList = useMemo(() => topRows.filter((r) => r.kind === 'expr').map((r) => r.expression!), [topRows]);
  const exprKey = exprList.join('\n');
  const evaluating = useRef(false);
  /** A refresh arrived while an evaluation was in flight: run once more when it finishes (epoch carried over). */
  const pendingEval = useRef<{ epoch: boolean } | null>(null);
  useEffect(() => {
    if (!exprList.length || !session) return;
    if (evaluating.current) {
      pendingEval.current = { epoch: (pendingEval.current?.epoch ?? false) || evalTick.epoch };
      return;
    }
    evaluating.current = true;
    const epoch = evalTick.epoch;
    void s12.debug
      .evaluate(exprList)
      .then((res: EvalResult[]) => {
        const vals: Record<string, Val> = {};
        const obs: [string, number][] = [];
        for (const r of res ?? []) {
          vals[`xpr:${r.expression}`] = r.error !== undefined || r.value === undefined ? { error: r.error ?? 'error' } : r.value;
          if (r.value !== undefined) obs.push([`xpr:${r.expression}`, r.value]);
        }
        tracker.observe(obs, epoch);
        setExprVals(vals);
      }, fail)
      .finally(() => {
        evaluating.current = false;
        const p = pendingEval.current;
        pendingEval.current = null;
        if (p) setEvalTick((t) => ({ n: t.n + 1, epoch: p.epoch }));
      });
  }, [evalTick, exprKey, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local scope: the current procedure (refreshed with the values)
  useEffect(() => {
    if (scope !== 'local' || !session) return;
    void s12.debug.callStack().then((f) => setFrame(f?.[0] ?? null), () => setFrame(null));
  }, [scope, session, evalTick, s12]);

  const valueOf = (r: DataRow): Val | null => {
    if (r.kind === 'expr') return exprVals[r.key] ?? null;
    const v = readVar(shown.current?.blocks, r.address!, r.size);
    return v;
  };
  const changedOf = (r: DataRow): boolean => {
    if (r.count > 1 && r.index === undefined) {
      for (let i = 0; i < Math.min(r.count, 1024); i++) if (tracker.changed(`${r.key}[${i}]`)) return true;
      return false;
    }
    return tracker.changed(r.key);
  };
  const fmtOf = (r: DataRow): DataFormat => rowFmt[r.key.replace(/\[\d+\]$/, '')] ?? fmt;
  const text = (r: DataRow): string => {
    if (r.count > 1 && r.index === undefined) {
      const parts: string[] = [];
      for (let i = 0; i < Math.min(r.count, MAX_ARRAY_PREVIEW); i++) {
        const v = readVar(shown.current?.blocks, r.address! + i * r.size, r.size);
        parts.push(v === null ? '' : v === V_UNINIT ? 'uu' : v === V_UNMAPPED ? '--' : formatDataValue(v, r.size, r.signed, fmtOf(r)));
      }
      return `{${parts.join(',')}${r.count > MAX_ARRAY_PREVIEW ? ',...' : ''}}`;
    }
    const v = valueOf(r);
    if (v === null) return '';
    if (typeof v === 'object') return `<${v.error}>`;
    if (v === V_UNINIT) return 'u'.repeat(r.size * 2);
    if (v === V_UNMAPPED) return '-'.repeat(r.size * 2);
    if (r.kind === 'expr') return formatDataValue(v, exprValueSize(v), v < 0, fmtOf(r));
    return formatDataValue(v, r.size, r.signed, fmtOf(r));
  };

  // ---- headline
  useEffect(() => {
    const where = zoom ? zoom.name : scope === 'local' ? (frame?.name ?? '') : (module ?? (scope === 'user' ? 'User' : 'All modules'));
    host.setHeadline(message ?? `${where}   ${MODE_LABELS[mode]}   ${DATA_FORMAT_SHORT[fmt]}   ${SCOPE_LABELS[scope]}`);
  }, [host, scope, frame, module, mode, fmt, message, zoom]);

  // ---- actions
  const addExpression = (expr: string, replacing?: string): boolean => {
    const e = expr.trim();
    if (e !== replacing && userRows.some((r) => r.expression === e)) {
      // hiwave lists an expression once per window: select the existing row instead of adding a duplicate
      setMessage(`"${e}" is already in the list`);
      setSelected(`xpr:${e}`);
      return false;
    }
    void s12.debug.addExpression(e, title).catch(fail);
    return true;
  };
  const removeExpression = (expr: string) => void s12.debug.removeExpression(expr).catch(fail);
  const commitEdit = async (r: DataRow, t: string) => {
    if (r.kind !== 'var' || r.address === undefined) {
      setMessage('Expression cannot be modified');
      setEdit(null);
      return;
    }
    const v = parseDataInput(t, fmtOf(r), r.size);
    const bytes = v === null ? null : valueBytes(v, r.size);
    if (!bytes) {
      setMessage(`Invalid value "${t}"`);
      return;
    }
    setMessage(null);
    setEdit(null);
    await s12.debug.writeMemory(r.address, bytes, 'local').catch(fail);
  };
  const openXpr = async () => {
    const [p] = await s12.files.openDialog({ title: 'Open Expressions', filters: [{ name: 'Expression files', extensions: ['xpr'] }] });
    if (!p) return;
    try {
      const f = parseXpr((await s12.files.readText(p)).text);
      const have = new Set(userRows.map((r) => r.expression));
      for (const e of f.entries) if (!(e.onlyIfNew && have.has(e.expression))) await s12.debug.addExpression(e.expression, title);
    } catch (e) {
      fail(e);
    }
  };
  const saveXprAs = async () => {
    const p = await s12.files.saveDialog({ title: 'Save Expressions', filters: [{ name: 'Expression files', extensions: ['xpr'] }] });
    if (!p) return;
    const text = writeXpr(exprs.map((e) => ({ expression: e.expression, component: e.component, onlyIfNew: true })), '\n');
    await s12.files.writeText({ path: p, text, eol: 'crlf' }).catch(fail);
  };
  const wps = useWatchpoints();
  const watchOf = (r: DataRow) => {
    if (r.kind !== 'var' || r.address === undefined) return undefined;
    const end = r.address + r.size * (r.index === undefined ? r.count : 1) - 1;
    return wps.find((w) => (w.space ?? 'local') === 'local' && w.start <= end && w.end >= r.address!);
  };
  const setWatch = (r: DataRow, kind: WatchKind) =>
    r.address !== undefined && void s12.debug.setWatchpoint({ start: r.address, end: r.address + r.size * (r.index === undefined ? r.count : 1) - 1, kind, space: 'local', label: r.name }).catch(fail);

  const zoomIn = (r: DataRow | null) => {
    if (!r || r.kind !== 'var' || r.count <= 1 || r.index !== undefined) return setMessage('Only arrays can be zoomed');
    setMessage(null);
    setZoom(r);
    setSelected(null);
  };

  // ---- attributes / UI commands
  useUiCommands((c) => {
    const kw = c.keyword.toUpperCase();
    if (kw === 'ATTRIBUTES') {
      const a = parseDataAttributes(c.argText);
      if (a.scope) setScope(a.scope);
      if (a.format) setFmt(a.format);
      if (a.mode) setMode(a.mode);
      if (a.updateRate) setRate(a.updateRate);
      if (a.nameWidth) setNameWidth(a.nameWidth);
      if (a.sort !== undefined) setSort(a.sort);
    } else if (kw === 'SMOD') setModule(c.argText.trim() || null);
    else if (kw === 'ZOOM') {
      // UNCERTAIN: `ZOOM <variable> [IN|OUT]` (hiwave: ZOOM address IN|OUT); OUT or no variable zooms out
      const m = /^\s*(.*?)\s*(?:\b(in|out))?\s*$/i.exec(c.argText) ?? [];
      const name = (m[1] ?? '').trim();
      if ((m[2] ?? '').toLowerCase() === 'out' || !name) setZoom(null);
      else zoomIn(topRows.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null);
    } else if (kw === 'PTRARRAY') {
      // UNCERTAIN: `PTRARRAY ON|OFF [count]`
      const [onoff, n] = c.argText.trim().split(/[\s,]+/);
      const count = Number(n);
      setPtrArray((p) => ({ on: !/^off$/i.test(onoff ?? ''), count: Number.isInteger(count) && count > 0 ? Math.min(count, 1024) : p.count }));
    }
  });

  // ---- menus
  const formatItems = (cur: DataFormat, set: (f: DataFormat) => void, prefix: string): MenuEntry[] =>
    (Object.keys(DATA_FORMAT_LABELS) as DataFormat[]).map((f) => ({ id: `${prefix}.${f}`, label: DATA_FORMAT_LABELS[f], checked: cur === f, onSelect: () => set(f) }));
  const componentMenu = useMemo<MenuEntry[]>(
    () => [
      {
        id: 'data.zoom',
        label: '&Zoom',
        submenu: [
          { id: 'data.zoom.in', label: '&In', disabled: !!zoom, onSelect: () => zoomIn(rows.find((r) => r.key === selected) ?? null) },
          { id: 'data.zoom.out', label: '&Out', disabled: !zoom, onSelect: () => setZoom(null) },
        ],
      },
      { id: 'data.scope', label: '&Scope', submenu: (['global', 'local', 'user'] as DataScope[]).map((s) => ({ id: `data.scope.${s}`, label: `&${SCOPE_LABELS[s]}`, checked: scope === s, onSelect: () => setScope(s) })) },
      { id: 'data.format', label: '&Format', submenu: formatItems(fmt, (f) => (setFmt(f), setRowFmt({})), 'data.format') },
      {
        id: 'data.mode',
        label: '&Mode',
        submenu: (['automatic', 'periodical', 'locked', 'frozen'] as RefreshMode[]).map((m) => ({ id: `data.mode.${m}`, label: `&${m[0].toUpperCase()}${m.slice(1)}`, checked: mode === m, onSelect: () => setMode(m) })),
      },
      { id: 'data.updateRate', label: '&Update Rate...', onSelect: () => setDialog({ kind: 'rate' }) },
      {
        id: 'data.options',
        label: '&Options',
        submenu: [
          { id: 'data.ptrArray', label: '&Pointer as Array...', checked: ptrArray.on, onSelect: () => setDialog({ kind: 'ptrarray' }) },
          { id: 'data.nameWidth', label: '&Name Width...', onSelect: () => setDialog({ kind: 'width' }) },
        ],
      },
      { id: 'data.sort', label: 'S&ort', checked: sort, onSelect: () => setSort((v) => !v) },
      {
        id: 'data.module',
        label: 'Open Mo&dule',
        submenu: [{ id: 'data.module.all', label: '(&All modules)', checked: module === null, onSelect: () => setModule(null) }, ...modules.map((m) => ({ id: `data.module.${m}`, label: m, checked: module === m, onSelect: () => setModule(m) }))],
      },
      SEP,
      { id: 'data.addExpression', label: '&Add Expression...', onSelect: () => setDialog({ kind: 'expr' }) },
      { id: 'data.openXpr', label: 'Open .&xpr...', onSelect: () => void openXpr() },
      { id: 'data.saveXpr', label: 'Sa&ve .xpr', onSelect: () => void s12.debug.saveExpressions().catch(fail) },
      { id: 'data.saveXprAs', label: 'Save .xpr As...', onSelect: () => void saveXprAs() },
    ],
    [scope, fmt, mode, sort, module, modules, exprs, userRows, zoom, selected, rows, ptrArray], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useComponentMenu(componentMenu);

  const popup = (x: number, y: number, r: DataRow | null) => {
    const user = r?.expression !== undefined && r.index === undefined;
    const wp = r ? watchOf(r) : undefined;
    const items: MenuEntry[] = [
      { id: 'data.popup.add', label: '&Add Expression...', onSelect: () => setDialog({ kind: 'expr' }) },
      { id: 'data.popup.edit', label: '&Edit Expression...', disabled: !user, onSelect: () => r && setDialog({ kind: 'expr', old: r.expression }) },
      { id: 'data.popup.delete', label: '&Delete Expression', disabled: !user, onSelect: () => r?.expression && removeExpression(r.expression) },
      SEP,
      { id: 'data.popup.format', label: '&Format', disabled: !r, submenu: r ? formatItems(fmtOf(r), (f) => setRowFmt((m) => ({ ...m, [r.key.replace(/\[\d+\]$/, '')]: f })), 'data.popup.format') : [] },
      SEP,
      {
        id: 'data.popup.setWatch',
        label: 'Set &Watchpoint',
        disabled: r?.kind !== 'var',
        submenu: r
          ? [
              { id: 'data.popup.watch.read', label: '&Read', onSelect: () => setWatch(r, 'read') },
              { id: 'data.popup.watch.write', label: '&Write', onSelect: () => setWatch(r, 'write') },
              { id: 'data.popup.watch.readwrite', label: 'R&ead/Write', onSelect: () => setWatch(r, 'readwrite') },
            ]
          : [],
      },
      { id: 'data.popup.deleteWatch', label: 'De&lete Watchpoint', disabled: !wp, onSelect: () => wp && void s12.debug.removeWatchpoint(wp.id).catch(fail) },
      {
        id: 'data.popup.toggleWatch',
        label: wp?.enabled === false ? 'E&nable Watchpoint' : 'Disa&ble Watchpoint',
        disabled: !wp,
        onSelect: () => wp && void s12.debug.updateWatchpoint(wp.id, { enabled: !wp.enabled }).catch(fail),
      },
      { id: 'data.popup.showWatch', label: 'Show Watc&hpoints', onSelect: () => setDialog({ kind: 'watchpoints' }) },
      SEP,
      {
        id: 'data.popup.showLocation',
        label: 'Show &Location',
        disabled: r?.address === undefined,
        onSelect: () => r?.address !== undefined && void s12.debug.exec(`Memory < SMEM 0x${hex(r.address, 4)},${r.size * (r.index === undefined ? r.count : 1)}`, { echo: false }).catch(fail),
      },
    ];
    setMenu({ x, y, items });
  };

  // ---- render
  const rowOf = (t: EventTarget | null): DataRow | null => {
    const el = (t as HTMLElement | null)?.closest?.('[data-key]') as HTMLElement | null;
    return el ? (rows.find((r) => r.key === el.dataset.key) ?? null) : null;
  };
  const nameCh = `${nameWidth + 2}ch`;
  return (
    <div
      className="cw-mono"
      style={{ height: '100%', overflow: 'auto', background: 'var(--cw-window)', outline: 'none' }}
      tabIndex={0}
      data-testid="data-component"
      data-title={title}
      onKeyDown={(e) => {
        // only keys aimed at the list: never those typed into a dialog or an edit field
        if (edit || inDialog(e.target) || (e.target !== e.currentTarget && (e.target as HTMLElement).closest?.('input, textarea, select, button'))) return;
        const r = rows.find((x) => x.key === selected);
        if (e.key === 'Delete' && r?.expression && r.index === undefined) removeExpression(r.expression);
        else if (e.key === 'Enter' && r) setEdit({ key: r.key, text: text(r) });
        else if (e.key === 'Insert') setDialog({ kind: 'expr' });
        else return;
        e.preventDefault();
      }}
      onDoubleClick={(e) => {
        if (inDialog(e.target)) return;
        if (!rowOf(e.target)) setDialog({ kind: 'expr' });
      }}
      onContextMenu={(e) => {
        if (inDialog(e.target)) return;
        e.preventDefault();
        const r = rowOf(e.target);
        if (r) setSelected(r.key);
        popup(e.clientX, e.clientY, r);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const p = getDnd(e);
        if (!p) return;
        e.preventDefault();
        if (p.kind === 'expression') addExpression(p.expression);
        else if (p.kind === 'address') addExpression(`0x${hex(p.address, 4)}`);
        else if (p.kind === 'register') addExpression(p.name);
      }}
    >
      {scope === 'local' && !rows.length && <div style={{ color: 'var(--cw-gray-text)', padding: 2 }}>{frame ? `${frame.name}: no local variables` : 'No procedure'}</div>}
      {rows.map((r) => {
        const wp = watchOf(r);
        const isSel = selected === r.key;
        const changed = changedOf(r);
        const val = text(r);
        return (
          <div
            key={r.key}
            data-key={r.key}
            className={`cw-row${isSel ? ' selected' : ''}`}
            style={{ display: 'flex', height: 16, lineHeight: '16px', whiteSpace: 'pre', background: isSel ? 'var(--cw-highlight)' : undefined, color: isSel ? 'var(--cw-highlight-text)' : undefined }}
            onMouseDown={() => setSelected(r.key)}
          >
            <span data-testid={wp ? `watchbar-${r.name}` : undefined} style={{ width: 4, flex: 'none', marginRight: 2, background: wp ? (wp.enabled ? WATCH_BAR[wp.kind] : 'var(--cw-gray-text)') : undefined }} />
            <span
              className="data-name"
              draggable
              onDragStart={(e) => setDnd(e, { kind: 'expression', expression: r.expression ?? r.name, address: r.address, source: 'Data' })}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (r.expression && r.index === undefined) setDialog({ kind: 'expr', old: r.expression });
                else if (r.count > 1 || isPtr(r)) setExpanded((s) => new Set(s.has(r.key) ? [...s].filter((k) => k !== r.key) : [...s, r.key]));
              }}
              style={{ width: nameCh, flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: r.index !== undefined ? '2ch' : undefined }}
            >
              {((r.count > 1 && r.index === undefined) || isPtr(r)) && (
                <span
                  className="cw-tree-toggle"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setExpanded((s) => new Set(s.has(r.key) ? [...s].filter((k) => k !== r.key) : [...s, r.key]));
                  }}
                >
                  {expanded.has(r.key) ? '−' : '+'}
                </span>
              )}
              {r.name}
            </span>
            {edit?.key === r.key ? (
              <input
                aria-label={`Edit ${r.name}`}
                className="cw-mono"
                autoFocus
                style={{ width: '16ch', flex: 'none', font: 'inherit', padding: 0, border: 'none', outline: '1px solid var(--cw-highlight)' }}
                value={edit.text}
                onChange={(e) => setEdit({ key: r.key, text: e.target.value })}
                onBlur={() => setEdit(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitEdit(r, edit.text);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setEdit(null);
                  }
                }}
              />
            ) : (
              <span
                className={`data-value${changed ? ' changed' : ''}`}
                data-testid={`value-${r.name}`}
                style={{ width: '16ch', flex: 'none', overflow: 'hidden', color: changed && !isSel ? 'var(--cw-changed)' : undefined }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setSelected(r.key);
                  if (r.count > 1 && r.index === undefined) return;
                  setEdit({ key: r.key, text: val });
                }}
              >
                {val}
              </span>
            )}
            <span style={{ marginLeft: '1ch', overflow: 'hidden', textOverflow: 'ellipsis', color: isSel ? undefined : 'var(--cw-gray-text)' }}>{r.kind === 'var' ? typeText(r) : ''}</span>
          </div>
        );
      })}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <DialogLayer>
        <PromptDialog
          open={dialog?.kind === 'expr'}
          title="Edit Expression"
          label="Expression:"
          initial={dialog?.kind === 'expr' ? (dialog.old ?? '') : ''}
          validate={(t) => (t.trim() ? null : 'Enter an expression')}
          onOk={(t) => {
            const old = dialog?.kind === 'expr' ? dialog.old : undefined;
            if (old !== undefined && old === t.trim()) return;
            if (old === undefined) return void addExpression(t);
            if (userRows.some((r) => r.expression === t.trim())) return void addExpression(t);
            void (async () => {
              await s12.debug.removeExpression(old).catch(fail);
              addExpression(t, old);
            })();
          }}
          onClose={() => setDialog(null)}
          testId="expression-dialog"
        />
        <PromptDialog open={dialog?.kind === 'rate'} title="Update Rate" label="Update rate (x 100 ms):" initial={String(rate)} validate={intRange(1, 600)} onOk={(t) => setRate(Number(t))} onClose={() => setDialog(null)} />
        <PromptDialog open={dialog?.kind === 'width'} title="Name Width" label="Name width (characters):" initial={String(nameWidth)} validate={intRange(4, 200)} onOk={(t) => setNameWidth(Number(t))} onClose={() => setDialog(null)} />
        <ControlpointsDialog open={dialog?.kind === 'watchpoints'} initialTab="watchpoints" onClose={() => setDialog(null)} />
        <PointerArrayDialog open={dialog?.kind === 'ptrarray'} value={ptrArray} onOk={setPtrArray} onClose={() => setDialog(null)} />
      </DialogLayer>
    </div>
  );
}

/** Options > Pointer as Array: display pointer variables as arrays of N elements. UNCERTAIN: hiwave dialog layout. */
function PointerArrayDialog({ open, value, onOk, onClose }: { open: boolean; value: { on: boolean; count: number }; onOk: (v: { on: boolean; count: number }) => void; onClose: () => void }) {
  const [on, setOn] = useState(value.on);
  const [count, setCount] = useState(String(value.count));
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setOn(value.on);
    setCount(String(value.count));
    setError(null);
  });
  const ok = () => {
    const err = intRange(1, 1024)(count);
    if (err) return setError(err);
    onOk({ on, count: Number(count) });
    onClose();
  };
  return (
    <Dialog
      open={open}
      title="Pointer as Array"
      onClose={onClose}
      width={300}
      testId="ptrarray-dialog"
      buttons={
        <>
          <Button isDefault onClick={ok} testId="ptrarray-ok">
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <label style={{ display: 'block', marginBottom: 6 }}>
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Display pointers as arrays
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span>Number of elements:</span>
          <input aria-label="Number of elements" className="cw-field cw-mono" style={{ width: 60 }} value={count} disabled={!on} onChange={(e) => setCount(e.target.value)} />
        </label>
        <button type="submit" hidden />
        {error && (
          <div role="alert" style={{ color: 'var(--cw-cmd-error)', marginTop: 6 }}>
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}

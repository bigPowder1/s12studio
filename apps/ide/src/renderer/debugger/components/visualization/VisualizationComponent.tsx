/**
 * hiwave "VisualizationTool" (lite): a canvas of user instruments bound to registers / memory:
 *   LED (one bit of a port or byte), 7-segment display (byte/word as hex/decimal digits, or raw segment bits),
 *   bar graph (value between min and max), text value (hex/dec/bin/char).
 * Add from the toolbar, the component menu or the canvas context menu; double-click (or right-click > Edit) edits;
 * drag moves. Values come from the debug snapshot (registers) and one memory watch for all memory bindings, so the
 * instruments update at the snapshot rate while running and on every halt.
 * Config: per project in `<projectDir>/S12Studio.vtl.json`, keyed by the window's instance number (configKey in
 * model.ts; titles are renumbered by the shell; UNCERTAIN: hiwave stores .vtl files in its own format). It is only
 * written after the user changes something; a pending edit is flushed to its project's file before the window closes
 * or the project changes. All file reads/writes of one window run in order (a reload never overtakes a save).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import type { MenuEntry } from '../../../common/menu/model';
import { useDebugSnapshot, useMemoryWatch, useS12, useSession } from '../../../common/s12';
import { useComponentMenu, type DebuggerComponentProps } from '../contract';
import { InstrumentDialog } from './InstrumentDialog';
import { InstrumentFace } from './Instruments';
import {
  bytesOf,
  configKey,
  configPath,
  displayLabel,
  freeSlot,
  KIND_NAMES,
  newInstrument,
  parseConfig,
  readValue,
  resolveLocal,
  serializeConfig,
  watchRanges,
  type Binding,
  type Instrument,
  type InstrumentKind,
} from './model';
import './visualization.css';

const KINDS: InstrumentKind[] = ['led', 'seg7', 'bar', 'text'];
const SAVE_DELAY_MS = 300;
const GRID = 4;

export function VisualizationComponent({ instance }: DebuggerComponentProps) {
  const api = useS12();
  const session = useSession();
  const snap = useDebugSnapshot();
  const [items, setItems] = useState<Instrument[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  const [dialog, setDialog] = useState<{
    inst: Instrument;
    isNew: boolean;
  } | null>(null);
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);
  const [bindings, setBindings] = useState<Record<string, Binding>>({});
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectDir = session?.projectDir ?? null;
  const key = configKey(instance);

  // ---------------------------------------------------------------- load / save (per project)
  /** File I/O queue: loads and saves of this window run strictly in order. */
  const io = useRef<Promise<unknown>>(Promise.resolve());
  const runIo = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const p = io.current.then(fn);
    io.current = p.catch(() => undefined);
    return p;
  }, []);
  /** Edit waiting for the save delay, with the file and key it belongs to. */
  const pendingSave = useRef<{
    path: string;
    key: string;
    items: Instrument[];
  } | null>(null);

  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const job = pendingSave.current;
    pendingSave.current = null;
    if (!job) return;
    void runIo(async () => {
      const old = await api.files.readText(job.path).then(
        (f) => parseConfig(f.text),
        () => parseConfig('{}'),
      );
      old.windows[job.key] = job.items;
      await api.files.writeText({
        path: job.path,
        text: serializeConfig(old),
        eol: 'lf',
      });
      setSaveError('');
    }).catch((e: unknown) => setSaveError(`Could not save ${job.path}: ${e instanceof Error ? e.message : String(e)}`));
  }, [api, runIo]);

  useEffect(() => {
    setPath(null); // edits made before the load completes are not saved anywhere (no stale path)
    if (!projectDir) {
      setItems([]);
      return;
    }
    let alive = true;
    const p = configPath(projectDir);
    void runIo(() => api.files.readText(p)).then(
      (f) => {
        if (!alive) return;
        setItems(parseConfig(f.text).windows[key] ?? []);
        setPath(p);
      },
      () => {
        if (!alive) return;
        setItems([]); // no file yet: start empty (never carry another project's instruments over)
        setPath(p);
      },
    );
    return () => {
      alive = false;
      flush(); // a pending edit goes to the project it was made in
    };
  }, [api, projectDir, key, runIo, flush]);

  const save = useCallback(
    (next: Instrument[]) => {
      if (!path) return;
      pendingSave.current = { path, key, items: next };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [path, key, flush],
  );

  const update = useCallback(
    (fn: (prev: Instrument[]) => Instrument[]) => {
      setItems((prev) => {
        const next = fn(prev);
        save(next);
        return next;
      });
    },
    [save],
  );

  // ---------------------------------------------------------------- bindings
  const generation = useRef(0);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    generation.current++;
    pending.current.clear();
    setBindings({});
  }, [session]);
  const exprs = useMemo(() => [...new Set(items.map((i) => i.expr))], [items]);
  useEffect(() => {
    const todo = exprs.filter((e) => !(e in bindings) && !pending.current.has(e));
    if (!todo.length) return;
    const local: Record<string, Binding> = {};
    const remote: string[] = [];
    for (const e of todo) {
      const b = resolveLocal(e);
      if (b) local[e] = b;
      else remote.push(e);
    }
    if (Object.keys(local).length) setBindings((b) => ({ ...b, ...local }));
    if (!remote.length || !session) return;
    const gen = generation.current;
    for (const e of remote) {
      pending.current.add(e);
      void api.debug
        .resolve(e)
        .then(
          (n): Binding => (typeof n === 'number' ? { kind: 'mem', address: n } : { kind: 'error', message: `cannot resolve '${e}'` }),
          (): Binding => ({ kind: 'error', message: `cannot resolve '${e}'` }),
        )
        .then((b) => {
          if (gen !== generation.current) return;
          pending.current.delete(e);
          setBindings((m) => ({ ...m, [e]: b }));
        });
    }
  }, [api, exprs, bindings, session]);

  const ranges = useMemo(() => {
    const mem: { address: number; size: number }[] = [];
    for (const i of items) {
      const b = bindings[i.expr];
      if (b?.kind === 'mem') mem.push({ address: b.address, size: i.size });
    }
    return watchRanges(mem);
  }, [items, bindings]);
  const blocks = useMemoryWatch(ranges);
  const bytes = useMemo(() => bytesOf(blocks), [blocks]);

  // ---------------------------------------------------------------- editing
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** Add at (x, y) (canvas context menu) or at the first free slot (toolbar, component menu). */
  const add = useCallback((kind: InstrumentKind, x?: number, y?: number) => {
    let n = newInstrument(kind);
    const pos = x !== undefined && y !== undefined ? { x, y } : freeSlot(itemsRef.current, n, canvasRef.current?.clientWidth || 480);
    n = { ...n, ...pos };
    setDialog({ inst: n, isNew: true });
  }, []);
  const removeAll = useCallback(() => update(() => []), [update]);

  const menu = useMemo<MenuEntry[]>(
    () => [
      ...KINDS.map((k) => ({
        id: `vis.add.${k}`,
        label: `Add ${KIND_NAMES[k]}`,
        onSelect: () => add(k),
      })),
      { kind: 'separator' as const },
      {
        id: 'vis.removeAll',
        label: 'Remove All Instruments',
        disabled: items.length === 0,
        onSelect: removeAll,
      },
    ],
    [add, removeAll, items.length],
  );
  useComponentMenu(menu);

  const onCanvasContext = (e: ReactMouseEvent) => {
    e.preventDefault();
    const r = canvasRef.current?.getBoundingClientRect();
    const x = Math.max(0, Math.round(e.clientX - (r?.left ?? 0) + (canvasRef.current?.scrollLeft ?? 0)));
    const y = Math.max(0, Math.round(e.clientY - (r?.top ?? 0) + (canvasRef.current?.scrollTop ?? 0)));
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: KINDS.map((k) => ({
        label: `Add ${KIND_NAMES[k]}`,
        onSelect: () => add(k, x, y),
      })),
    });
  };
  const onItemContext = (e: ReactMouseEvent, inst: Instrument) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Edit...', onSelect: () => setDialog({ inst, isNew: false }) },
        {
          label: 'Delete',
          onSelect: () => update((p) => p.filter((i) => i.id !== inst.id)),
        },
      ],
    });
  };

  const startDrag = (e: ReactMouseEvent, inst: Instrument) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    let pos = { x: inst.x, y: inst.y };
    const move = (ev: MouseEvent) => {
      pos = {
        x: Math.max(0, Math.round((inst.x + ev.clientX - sx) / GRID) * GRID),
        y: Math.max(0, Math.round((inst.y + ev.clientY - sy) / GRID) * GRID),
      };
      setDrag({ id: inst.id, ...pos });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDrag(null);
      if (pos.x !== inst.x || pos.y !== inst.y) update((p) => p.map((i) => (i.id === inst.id ? { ...i, ...pos } : i)));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="vis-root" data-testid="visualization-component">
      <div className="vis-toolbar">
        <span>Add:</span>
        {KINDS.map((k) => (
          <button key={k} type="button" className="cw-button vis-add" onClick={() => add(k)} data-testid={`vis-add-${k}`}>
            {KIND_NAMES[k]}
          </button>
        ))}
        <span className="vis-hint">{path ? `${items.length} instrument(s), saved with the project` : 'not saved (no project session)'}</span>
      </div>
      {saveError && (
        <div className="vis-error" role="alert">
          {saveError}
        </div>
      )}
      <div ref={canvasRef} className="vis-canvas" onContextMenu={onCanvasContext} data-testid="vis-canvas">
        {items.length === 0 && <div className="vis-empty">Right-click or use Add to place instruments (LED, 7-segment, bar graph, text).</div>}
        {items.map((inst) => {
          const b = bindings[inst.expr];
          const v = readValue(inst, b, snap, bytes);
          const p = drag?.id === inst.id ? drag : inst;
          return (
            <div
              key={inst.id}
              className={`vis-item vis-${inst.kind}`}
              style={{ left: p.x, top: p.y }}
              data-testid={`vis-item-${inst.id}`}
              data-kind={inst.kind}
              data-value={v ?? ''}
              title={b?.kind === 'error' ? b.message : `${inst.expr}${b?.kind === 'mem' ? ` @ $${b.address.toString(16).toUpperCase()}` : ''}`}
              onMouseDown={(e) => startDrag(e, inst)}
              onDoubleClick={() => setDialog({ inst, isNew: false })}
              onContextMenu={(e) => onItemContext(e, inst)}
            >
              <div className="vis-label">{displayLabel(inst)}</div>
              <InstrumentFace inst={inst} value={v} />
              {b?.kind === 'error' && <div className="vis-item-error">?</div>}
            </div>
          );
        })}
      </div>
      <ContextMenu state={ctx} onClose={() => setCtx(null)} />
      <InstrumentDialog
        value={dialog?.inst ?? null}
        isNew={dialog?.isNew ?? false}
        onCancel={() => setDialog(null)}
        onDelete={(id) => {
          update((p) => p.filter((i) => i.id !== id));
          setDialog(null);
        }}
        onOk={(inst) => {
          update((p) => (p.some((i) => i.id === inst.id) ? p.map((i) => (i.id === inst.id ? inst : i)) : [...p, inst]));
          setDialog(null);
        }}
      />
    </div>
  );
}

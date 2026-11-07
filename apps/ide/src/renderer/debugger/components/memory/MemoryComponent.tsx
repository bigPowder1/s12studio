/**
 * hiwave "Memory" component (docs/research/r1/ide.md §6 Memory).
 *
 *   - rows `address | units | ASCII`; Word size Byte/Word/Lword; Format Hex/Bin/Oct/Dec/UDec/Bit Reverse
 *   - "uu" = uninitialized, "--" = no memory (MEM_UNINITIALIZED / MEM_UNMAPPED from the engine)
 *   - values changed since the last refresh in red; Mode Automatic / Periodical (Update Rate) / Frozen
 *   - double-click (or type a digit over the selected unit) to edit: Enter writes, Tab writes and moves on, Esc cancels
 *   - Address... (numbers, symbols, expressions), Fill..., drag to select, watchpoint underline (read green, write
 *     red, read/write black) and the pop-up Set/Delete/Show Watchpoints
 *   - virtualised over the 64K CPU space or the 8M global space: only the visible rows are watched
 *   - layout attributes (FORMAT, WORD, ASC, ADR, MODE, UPDATERATE, ADDRESS) and `Memory < SMEM range` / ATTRIBUTES
 *   - CopyMem..., Search Pattern..., pop-up Show Location (Source + Assembly)
 *   - dialogs are mounted in a DialogLayer so their key/mouse events never reach this window's handlers
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AddressSpace, MemoryBlockInfo, MemoryRange, UiCommandInfo, WatchKind } from '../../../../shared/api';
import { parseApiError } from '../../../../shared/api';
import { hex } from '../../../common/format';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import { SEP, type MenuEntry } from '../../../common/menu/model';
import { useDebugSnapshot, useMemoryWatch, useS12 } from '../../../common/s12';
import { AddressDialog } from '../../dialogs/AddressDialog';
import { ControlpointsDialog } from '../../dialogs/ControlpointsDialog';
import { CopyMemDialog } from '../../dialogs/CopyMemDialog';
import { DialogLayer, inDialog } from '../../dialogs/DialogLayer';
import { FillMemoryDialog } from '../../dialogs/FillMemoryDialog';
import { markpoints } from '../../dialogs/markpoints';
import { PromptDialog, intRange } from '../../dialogs/PromptDialog';
import { resolveAddress } from '../../dialogs/resolve';
import { SearchPatternDialog } from '../../dialogs/SearchPatternDialog';
import { useWatchpoints } from '../../dialogs/useControlpoints';
import { showLocation, useDebuggerBus } from '../../shell/bus';
import { DND_MIME, getDnd, setDnd, useComponentHost, useComponentMenu, useUiCommands, type DebuggerComponentProps } from '../contract';
import {
  FORMAT_LABELS,
  SPACE_SIZE,
  WATCH_COLORS,
  addressDigits,
  asciiChar,
  byteKey,
  formatUnit,
  parseMemoryAttributes,
  parseRangeText,
  parseUnitInput,
  splitAttributes,
  unitBytes,
  unitValue,
  unitWidth,
  watchAt,
  type MemFormat,
  type MemUnit,
  type MemoryAttrs,
} from './model';
import { ChangeTracker, MODE_LABELS, RefreshPolicy, V_UNMAPPED, type RefreshMode } from './refresh';
import './memory.css';

export const ROW_HEIGHT = 16;
/** Rows assumed visible before the first layout (and in jsdom, which has no layout). */
const DEFAULT_ROWS = 16;
/** Approximate width of one Courier New 12px character. */
const CHAR_W = 7.2;

interface Selection {
  anchor: number;
  end: number;
}
const selRange = (s: Selection | null): [number, number] | null => (s ? [Math.min(s.anchor, s.end), Math.max(s.anchor, s.end)] : null);

interface Shown {
  key: string;
  blocks: MemoryBlockInfo[];
}
const blocksKey = (b: readonly MemoryBlockInfo[]) => b.map((x) => `${x.space}:${x.address}:${x.bytes.length}`).join(',');

export function MemoryComponent({ title, attributes }: DebuggerComponentProps) {
  const s12 = useS12();
  const host = useComponentHost();
  const init = useMemo<MemoryAttrs>(() => parseMemoryAttributes(attributes), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [unit, setUnit] = useState<MemUnit>(init.unit ?? 1);
  const [fmt, setFmt] = useState<MemFormat>(init.format ?? 'hex');
  const [ascii, setAscii] = useState(init.ascii ?? true);
  const [showAddr, setShowAddr] = useState(init.showAddress ?? true);
  const [mode, setMode] = useState<RefreshMode>(init.mode ?? 'automatic');
  const [rate, setRate] = useState(init.updateRate ?? 10);
  const [space, setSpace] = useState<AddressSpace>(init.space ?? 'local');
  const spaceRef = useRef(space);
  spaceRef.current = space;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [sel, setSel] = useState<Selection | null>(null);
  const [edit, setEdit] = useState<{ addr: number; text: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<null | 'address' | 'fill' | 'copy' | 'search' | 'rate' | 'watchpoints' | 'markpoints'>(null);
  const bus = useDebuggerBus();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /** The in-place edit was finished by Enter/Tab/Esc (its blur must not commit again). */
  const editDone = useRef(false);

  // ---- geometry: bytes per row adapt to the width (16, 8 or 4), rows to the height
  const digits = addressDigits(space);
  const bpr = useMemo(() => {
    if (!size.w) return 16;
    for (const n of [16, 8, 4]) {
      if (n < unit) break;
      const chars = (showAddr ? digits + 1 : 0) + (n / unit) * (unitWidth(unit, fmt) + 1) + (ascii ? n + 2 : 0) + 1;
      if (chars * CHAR_W <= size.w) return n;
    }
    return Math.max(4, unit);
  }, [size.w, unit, fmt, ascii, showAddr, digits]);
  const visibleRows = size.h ? Math.max(1, Math.ceil(size.h / ROW_HEIGHT)) : DEFAULT_ROWS;
  const spaceSize = SPACE_SIZE[space];
  const totalRows = Math.ceil(spaceSize / bpr);
  const [topAddr, setTopAddr] = useState(() => Math.min(init.address ?? 0, SPACE_SIZE[init.space ?? 'local'] - 1));
  const topRow = Math.min(Math.floor(topAddr / bpr), Math.max(0, totalRows - 1));

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep the native scroll position in step with topRow (goto, SMEM, attribute changes)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && Math.floor(el.scrollTop / ROW_HEIGHT) !== topRow) el.scrollTop = topRow * ROW_HEIGHT;
  }, [topRow, bpr]);

  const goto = useCallback(
    (address: number, select?: [number, number]) => {
      const a = Math.max(0, Math.min(address, SPACE_SIZE[space] - 1));
      setTopAddr(a);
      setSel(select ? { anchor: select[0], end: select[1] } : { anchor: a, end: a });
    },
    [space],
  );

  // ---- data: watch only the visible rows
  const rowsShown = Math.min(visibleRows + 1, totalRows - topRow);
  const rangeStart = topRow * bpr;
  const ranges = useMemo<MemoryRange[]>(() => [{ address: rangeStart, length: Math.max(0, Math.min(rowsShown * bpr, spaceSize - rangeStart)), space }], [rangeStart, rowsShown, bpr, spaceSize, space]);
  const blocks = useMemoryWatch(ranges);
  const snap = useDebugSnapshot();
  const policy = useRef(new RefreshPolicy()).current;
  const tracker = useRef(new ChangeTracker()).current;
  const shown = useRef<Shown | null>(null);
  const seen = useRef(-1);
  if (seen.current !== snap.seq) {
    // once per snapshot: apply the refresh mode (Automatic / Periodical / Frozen)
    seen.current = snap.seq;
    const d = policy.update(snap, mode, rate * 100, performance.now());
    const key = blocks ? blocksKey(blocks) : null;
    if (blocks && key && (d.accept || shown.current?.key !== key)) {
      const values: [number, number][] = [];
      for (const b of blocks) for (let i = 0; i < b.bytes.length; i++) values.push([byteKey(b.space, b.address + i), unitValue(b.bytes, b.status, i, 1)]);
      tracker.observe(values, d.accept && d.epoch);
      shown.current = { key, blocks };
    } else if (d.epoch) tracker.markEpoch();
  }
  const data = shown.current?.blocks.find((b) => b.space === space) ?? null;
  const unitAt = (a: number): number | null => {
    if (!data) return null;
    const i = a - data.address;
    return i >= 0 && i + unit <= data.bytes.length ? unitValue(data.bytes, data.status, i, unit) : null;
  };
  const unitChanged = (a: number): boolean => {
    for (let i = 0; i < unit; i++) if (tracker.changed(byteKey(space, a + i))) return true;
    return false;
  };

  const wps = useWatchpoints();
  const sr = selRange(sel);

  // ---- headline (Object Info Bar)
  useEffect(() => {
    const where = sr ? (sr[0] === sr[1] ? `0x${hex(sr[0], digits)}` : `0x${hex(sr[0], digits)}..0x${hex(sr[1], digits)}`) : `0x${hex(rangeStart, digits)}`;
    host.setHeadline(message ?? `${where}   ${MODE_LABELS[mode]}${space === 'global' ? '   Global' : ''}`);
  }, [host, sr?.[0], sr?.[1], rangeStart, mode, space, digits, message]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- editing
  const write = useCallback(
    async (addr: number, text: string, next: boolean, refocus = true) => {
      const v = parseUnitInput(text, unit, fmt);
      if (v === null) {
        setMessage(`Invalid value "${text}"`);
        return;
      }
      setMessage(null);
      try {
        await s12.debug.writeMemory(addr, unitBytes(v, unit), space);
      } catch (e) {
        setMessage(parseApiError(e).message);
      }
      if (next && addr + unit < spaceSize) {
        const n = addr + unit;
        setSel({ anchor: n, end: n });
        setEdit({ addr: n, text: '' });
        if (n >= rangeStart + visibleRows * bpr) setTopAddr(n - (visibleRows - 1) * bpr);
      } else setEdit(null);
      if (refocus) rootRef.current?.focus();
    },
    [s12, unit, fmt, space, spaceSize, rangeStart, visibleRows, bpr],
  );

  // ---- watchpoints from the pop-up
  const setWatch = (kind: WatchKind, r: [number, number] | null) => {
    if (!r) return;
    void s12.debug.setWatchpoint({ start: r[0], end: Math.max(r[1], r[0] + unit - 1), kind, space }).catch((e) => setMessage(parseApiError(e).message));
  };
  const overlappingOf = (r: [number, number] | null) => (r ? wps.filter((w) => (w.space ?? 'local') === space && w.start <= r[1] && w.end >= r[0]) : []);
  const deleteWatch = (r: [number, number] | null) => {
    for (const w of overlappingOf(r)) void s12.debug.removeWatchpoint(w.id).catch((e) => setMessage(parseApiError(e).message));
  };

  // ---- attributes / UI commands
  const applyAttrs = useCallback(
    (a: MemoryAttrs) => {
      if (a.unit) setUnit(a.unit);
      if (a.format) setFmt(a.format);
      if (a.ascii !== undefined) setAscii(a.ascii);
      if (a.showAddress !== undefined) setShowAddr(a.showAddress);
      if (a.mode) setMode(a.mode);
      if (a.updateRate) setRate(a.updateRate);
      if (a.space && a.space !== spaceRef.current) {
        // another address space: the old selection/top address mean something else there
        const max = SPACE_SIZE[a.space] - 1;
        setSpace(a.space);
        setSel(null);
        setEdit(null);
        setTopAddr((t) => Math.min(t, max));
      }
      if (a.address !== undefined) setTopAddr(Math.min(a.address, SPACE_SIZE[a.space ?? spaceRef.current] - 1));
    },
    [],
  );
  useUiCommands((c: UiCommandInfo) => {
    const kw = c.keyword.toUpperCase();
    if (kw === 'ATTRIBUTES') applyAttrs(parseMemoryAttributes(splitAttributes(c.argText)));
    else if (kw === 'SMEM' || kw === 'SPC' || kw === 'ADDRESS') {
      void (async () => {
        // command-language numbers are C-style ($FF, 0xFF; bare digits decimal)
        const r = parseRangeText(c.argText);
        const start = await resolveAddress(s12, r.start, 10);
        if (start === null) return setMessage(`Cannot resolve "${r.start}"`);
        let end = start;
        if (r.end) end = (await resolveAddress(s12, r.end, 10)) ?? start;
        else if (r.size) end = start + Math.max(1, (await resolveAddress(s12, r.size, 10)) ?? 1) - 1;
        goto(start, [start, end]);
      })();
    }
  });

  // ---- menus
  const componentMenu = useMemo<MenuEntry[]>(
    () => [
      {
        id: 'memory.wordsize',
        label: '&Word size',
        submenu: ([1, 2, 4] as MemUnit[]).map((u) => ({ id: `memory.unit.${u}`, label: u === 1 ? '&Byte' : u === 2 ? '&Word' : '&Lword', checked: unit === u, onSelect: () => setUnit(u) })),
      },
      {
        id: 'memory.format',
        label: '&Format',
        submenu: (Object.keys(FORMAT_LABELS) as MemFormat[]).map((f) => ({ id: `memory.format.${f}`, label: FORMAT_LABELS[f], checked: fmt === f, onSelect: () => setFmt(f) })),
      },
      {
        id: 'memory.mode',
        label: '&Mode',
        submenu: (['automatic', 'periodical', 'frozen'] as RefreshMode[]).map((m) => ({ id: `memory.mode.${m}`, label: m === 'automatic' ? '&Automatic' : m === 'periodical' ? '&Periodical' : '&Frozen', checked: mode === m, onSelect: () => setMode(m) })),
      },
      {
        id: 'memory.display',
        label: '&Display',
        submenu: [
          { id: 'memory.display.address', label: '&Address', checked: showAddr, onSelect: () => setShowAddr((v) => !v) },
          { id: 'memory.display.ascii', label: 'A&SCII', checked: ascii, onSelect: () => setAscii((v) => !v) },
          SEP,
          // UNCERTAIN: hiwave's S12X memory window offers the global address space through SHOW_ADDRESSSPACE
          { id: 'memory.display.global', label: '&Global Addresses', checked: space === 'global', onSelect: () => (setSpace((s) => (s === 'global' ? 'local' : 'global')), setTopAddr(0), setSel(null)) },
        ],
      },
      SEP,
      { id: 'memory.fill', label: '&Fill...', onSelect: () => setDialog('fill') },
      { id: 'memory.address', label: '&Address...', onSelect: () => setDialog('address') },
      { id: 'memory.copyMem', label: '&CopyMem...', onSelect: () => setDialog('copy') },
      { id: 'memory.searchPattern', label: '&Search Pattern...', onSelect: () => setDialog('search') },
      { id: 'memory.updateRate', label: '&Update Rate...', onSelect: () => setDialog('rate') },
    ],
    [unit, fmt, mode, showAddr, ascii, space],
  );
  useComponentMenu(componentMenu);

  const popup = (x: number, y: number, r: [number, number] | null) => {
    const hasSel = !!r;
    setMenu({
      x,
      y,
      items: [
        {
          id: 'memory.setWatchpoint',
          label: 'Set &Watchpoint',
          disabled: !hasSel,
          submenu: [
            { id: 'memory.setWatch.read', label: '&Read', onSelect: () => setWatch('read', r) },
            { id: 'memory.setWatch.write', label: '&Write', onSelect: () => setWatch('write', r) },
            { id: 'memory.setWatch.readwrite', label: 'R&ead/Write', onSelect: () => setWatch('readwrite', r) },
          ],
        },
        { id: 'memory.deleteWatchpoint', label: '&Delete Watchpoint', disabled: !overlappingOf(r).length, onSelect: () => deleteWatch(r) },
        { id: 'memory.showWatchpoints', label: 'Show Watc&hpoints', onSelect: () => setDialog('watchpoints') },
        SEP,
        { id: 'memory.setMarkpoint', label: 'Set &Markpoint', disabled: !hasSel, onSelect: () => r && markpoints.add({ name: `0x${hex(r[0], digits)}`, address: r[0], kind: 'memory' }) },
        { id: 'memory.showMarkpoints', label: 'Show Mar&kpoints', onSelect: () => setDialog('markpoints') },
        SEP,
        // UNCERTAIN: Show Location in Memory scrolls Source and Assembly to the selected address (global addresses
        // are not code locations in this clone's Source/Assembly windows, so it is local-space only)
        { id: 'memory.showLocation', label: 'Show &Location', disabled: !hasSel || space !== 'local', onSelect: () => r && showLocation(bus, r[0], ['Source', 'Assembly']) },
        SEP,
        { id: 'memory.popup.address', label: '&Address...', onSelect: () => setDialog('address') },
        { id: 'memory.popup.fill', label: '&Fill...', onSelect: () => setDialog('fill') },
      ],
    });
  };

  // ---- mouse / keyboard
  const addrOf = (t: EventTarget | null): number | null => {
    const el = (t as HTMLElement | null)?.closest?.('[data-addr]') as HTMLElement | null;
    return el ? Number(el.dataset.addr) : null;
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // only keys aimed at the dump itself: never those typed into a dialog, the context menu or the edit field
    if (edit || inDialog(e.target) || (e.target !== e.currentTarget && (e.target as HTMLElement).closest?.('input, textarea, select, button'))) return;
    const cur = sel?.end;
    const move = (d: number) => {
      if (cur === undefined) return;
      const n = Math.max(0, Math.min(spaceSize - unit, cur + d));
      setSel(e.shiftKey && sel ? { anchor: sel.anchor, end: n } : { anchor: n, end: n });
      if (n < rangeStart) setTopAddr(n);
      else if (n >= rangeStart + visibleRows * bpr) setTopAddr(n - (visibleRows - 1) * bpr);
    };
    if (e.key === 'ArrowRight') move(unit);
    else if (e.key === 'ArrowLeft') move(-unit);
    else if (e.key === 'ArrowDown') move(bpr);
    else if (e.key === 'ArrowUp') move(-bpr);
    else if (e.key === 'PageDown') setTopAddr(Math.min(spaceSize - 1, rangeStart + visibleRows * bpr));
    else if (e.key === 'PageUp') setTopAddr(Math.max(0, rangeStart - visibleRows * bpr));
    else if (e.key === 'Enter' && cur !== undefined) setEdit({ addr: cur - (cur % unit), text: '' });
    else if (cur !== undefined && e.key.length === 1 && !e.ctrlKey && !e.altKey && /[0-9a-fA-F$%@x-]/.test(e.key)) {
      // typing over the selected unit starts an in-place edit
      setEdit({ addr: cur - (cur % unit), text: e.key });
    } else return;
    e.preventDefault();
  };

  // ---- render rows
  const rows: React.ReactNode[] = [];
  const unitsPerRow = bpr / unit;
  const w = unitWidth(unit, fmt);
  for (let r = 0; r < rowsShown; r++) {
    const rowAddr = (topRow + r) * bpr;
    const cells: React.ReactNode[] = [];
    let asc = '';
    for (let u = 0; u < unitsPerRow; u++) {
      const a = rowAddr + u * unit;
      if (a >= spaceSize) break;
      const v = unitAt(a);
      const isSel = !!sr && a + unit - 1 >= sr[0] && a <= sr[1];
      const wp = v !== null && v !== V_UNMAPPED ? watchAt(wps, space, a, unit) : undefined;
      const cls = `mem-cell${isSel ? ' selected' : ''}${v !== null && unitChanged(a) ? ' changed' : ''}${wp ? ` watch${wp.enabled ? '' : ' disabled'}` : ''}`;
      if (edit && edit.addr === a)
        cells.push(
          <input
            key={a}
            className="mem-cell mem-edit cw-mono"
            aria-label="Edit memory"
            autoFocus
            style={{ width: `${w + 0.5}ch` }}
            value={edit.text}
            onChange={(e) => setEdit({ addr: a, text: e.target.value })}
            onFocus={() => (editDone.current = false)}
            onBlur={() => {
              if (editDone.current) return;
              editDone.current = true;
              // UNCERTAIN: hiwave commits a valid entry when the edit field loses focus (Windows edit-control style);
              // an invalid or empty entry is dropped
              const text = edit.text;
              if (text.trim() && parseUnitInput(text, unit, fmt) !== null) void write(a, text, false, false);
              else setEdit((cur) => (cur && cur.addr === a ? null : cur));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') editDone.current = true;
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                if (edit.text.trim()) void write(a, edit.text, e.key === 'Tab');
                else if (e.key === 'Tab') setEdit({ addr: Math.min(spaceSize - unit, a + unit), text: '' });
                else setEdit(null);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setEdit(null);
                rootRef.current?.focus();
              }
            }}
          />,
        );
      else
        cells.push(
          <span key={a} className={cls} data-addr={a} style={wp ? { textDecorationColor: WATCH_COLORS[wp.kind] } : undefined} title={wp ? `${wp.kind} watchpoint` : undefined}>
            {v === null ? ' '.repeat(w) : formatUnit(v, unit, fmt)}
          </span>,
        );
      if (ascii)
        for (let i = 0; i < unit; i++) {
          const off = data ? a + i - data.address : -1;
          asc += data && off >= 0 && off < data.bytes.length ? asciiChar(data.bytes[off], data.status[off]) : ' ';
        }
    }
    rows.push(
      <div key={rowAddr} className="mem-row" data-row={rowAddr}>
        {showAddr && (
          <span
            className="mem-addr"
            draggable
            onDragStart={(e) => {
              const r0 = sr ?? [rowAddr, rowAddr + bpr - 1];
              setDnd(e, { kind: 'range', start: r0[0], end: r0[1], source: 'Memory' });
            }}
          >
            {hex(rowAddr, digits)}
          </span>
        )}
        {cells}
        {ascii && <span className="mem-ascii">{asc}</span>}
      </div>,
    );
  }

  return (
    <div
      ref={rootRef}
      className="mem-root cw-mono"
      tabIndex={0}
      data-testid="memory-component"
      data-title={title}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const p = getDnd(e);
        if (!p) return;
        e.preventDefault();
        if (p.kind === 'address') goto(p.address);
        else if (p.kind === 'range') goto(p.start, [p.start, p.end]);
        else if (p.kind === 'register') goto(p.value & 0xffff);
        else if (p.kind === 'expression') {
          if (p.address !== undefined) goto(p.address);
          else void resolveAddress(s12, p.expression).then((a) => a !== null && goto(a));
        }
      }}
    >
      <div
        ref={scrollRef}
        className="mem-scroll"
        onScroll={(e) => {
          const row = Math.floor(e.currentTarget.scrollTop / ROW_HEIGHT);
          if (row !== topRow) setTopAddr(row * bpr);
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          const a = addrOf(e.target);
          if (a === null) return;
          dragging.current = true;
          setSel(e.shiftKey && sel ? { anchor: sel.anchor, end: a } : { anchor: a, end: a });
          const up = () => {
            dragging.current = false;
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mouseup', up);
        }}
        onMouseOver={(e) => {
          if (!dragging.current || !(e.buttons & 1)) return;
          const a = addrOf(e.target);
          if (a !== null && sel) setSel({ anchor: sel.anchor, end: a + unit - 1 });
        }}
        onDoubleClick={(e) => {
          const a = addrOf(e.target);
          if (a === null) return;
          setSel({ anchor: a, end: a });
          setEdit({ addr: a, text: '' });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const a = addrOf(e.target);
          let r = sr;
          if (a !== null && !(sr && a >= sr[0] && a <= sr[1])) {
            r = [a, a + unit - 1];
            setSel({ anchor: r[0], end: r[1] });
          }
          popup(e.clientX, e.clientY, r);
        }}
      >
        <div style={{ height: totalRows * ROW_HEIGHT }} />
        <div className="mem-rows" style={{ top: topRow * ROW_HEIGHT }}>
          {rows}
        </div>
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <DialogLayer>
        <AddressDialog open={dialog === 'address'} initial={sr?.[0] ?? rangeStart} onOk={(a) => goto(a)} onClose={() => setDialog(null)} />
        <FillMemoryDialog open={dialog === 'fill'} from={sr?.[0]} to={sr?.[1]} space={space} onClose={() => setDialog(null)} />
        <CopyMemDialog open={dialog === 'copy'} from={sr?.[0]} to={sr?.[1]} space={space} onClose={() => setDialog(null)} onCopied={(d, n) => goto(d, [d, d + n - 1])} />
        <SearchPatternDialog open={dialog === 'search'} from={sr?.[0] ?? rangeStart} space={space} onClose={() => setDialog(null)} onFound={(a, n) => goto(a, [a, a + n - 1])} />
        <PromptDialog
          open={dialog === 'rate'}
          title="Update Rate"
          label="Update rate (x 100 ms):"
          initial={String(rate)}
          validate={intRange(1, 600)}
          onOk={(t) => setRate(Number(t))}
          onClose={() => setDialog(null)}
        />
        <ControlpointsDialog open={dialog === 'watchpoints' || dialog === 'markpoints'} initialTab={dialog === 'markpoints' ? 'markpoints' : 'watchpoints'} onClose={() => setDialog(null)} />
      </DialogLayer>
    </div>
  );
}

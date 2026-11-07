/**
 * hiwave "Assembly" component (docs/research/r1/ide.md §6 Assembly): address | code bytes (Display Code) |
 * instruction (Display Symbolic) | absolute branch target (Display Absolute Address), label rows, PC line highlighted,
 * breakpoint marks in the left margin (click toggles; pop-up Set/Delete/Enable/Disable Breakpoint, Run To Cursor,
 * Set Program Counter, Show Location). Scrolls by instruction (wheel, arrows, PgUp/PgDn); "Address..." shows any
 * address. Info bar: the procedure name.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseApiError, type DisasmLine, type SymbolEntry } from '../../../../shared/api';
import { hex } from '../../../common/format';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import { SEP, type MenuEntry } from '../../../common/menu/model';
import { useDebugSnapshot, useS12, useS12Event, useSession } from '../../../common/s12';
import { setDnd, useComponentHost, useComponentMenu, useUiCommands, type DebuggerComponentProps } from '../contract';
import { breakpointMenuState, resolveCommandAddress, resolveDialogAddress, showLocation, toggleBreakpointAt, useBreakpoints, useDebuggerBus } from '../../shell/bus';
import { PromptDialog } from '../../shell/PromptDialog';
import { ControlpointsDialog } from '../../dialogs/ControlpointsDialog';
import { asmRows, attributesFromOptions, optionsFromAttributes, procedureAt, rowText, unwindScroll, type AsmOptions, type AsmRow, type ScrollStep } from './model';

/** Row height before the first row is measured (9pt Courier New at 1.25em; jsdom has no layout). */
const DEFAULT_ROW_PX = 15;
const BEFORE_PC = 3;

export function AssemblyComponent({ attributes }: DebuggerComponentProps) {
  const s12 = useS12();
  const host = useComponentHost();
  const bus = useDebuggerBus();
  const snap = useDebugSnapshot();
  const session = useSession();
  const bps = useBreakpoints();
  const init = useMemo(() => optionsFromAttributes(attributes), [attributes]);
  const [opts, setOpts] = useState<AsmOptions>(init.options);
  const [top, setTop] = useState<number | null>(init.topPc ?? null);
  const [lines, setLines] = useState<DisasmLine[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [visible, setVisible] = useState(40);
  // measured from the rendered rows, so FONT / Component > Fonts keep the row count and paging right
  const [rowPx, setRowPx] = useState(DEFAULT_ROW_PX);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [askAddress, setAskAddress] = useState(false);
  const [symbols, setSymbols] = useState<SymbolEntry[]>([]);
  const [loadGen, setLoadGen] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const halted = snap.state === 'halted';
  const pc = snap.registers && halted ? snap.registers.PC : undefined;
  const report = useCallback((e: unknown) => bus.status(parseApiError(e).message), [bus]);

  /** Address of the instruction `n` instructions before `address` (the engine decodes from a line start further back). */
  const back = useCallback(
    async (address: number, n: number): Promise<number> => {
      const l = await s12.debug.disassemble({ address, count: n * 5 + 1, before: n });
      if (!Array.isArray(l)) return address;
      const i = l.findIndex((x) => x.address === address);
      return i < 0 ? address : l[Math.max(0, i - n)].address;
    },
    [s12],
  );

  useS12Event('debug', 'loaded', () => setLoadGen((g) => g + 1));

  // symbols for the info bar (procedure name)
  useEffect(() => {
    if (!session) return;
    let live = true;
    void Promise.resolve(s12.debug.symbols()).then((s) => live && Array.isArray(s) && setSymbols(s.filter((x) => x.kind !== 'object')), () => undefined);
    return () => {
      live = false;
    };
  }, [s12, session, loadGen]);

  // row height of the current font (re-measured after every render; cheap: one offsetHeight)
  useLayoutEffect(() => {
    const h = box.current?.querySelector<HTMLElement>('.s12-code-line')?.offsetHeight;
    if (h && h !== rowPx) setRowPx(h);
  });

  // rows that fit the window
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => el.clientHeight > 0 && setVisible(Math.max(8, Math.ceil(el.clientHeight / rowPx) + 1));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowPx, !!snap.registers]);

  // follow the PC on every halt: keep the view when PC is visible, else put PC a few lines from the top
  // (keyed by the halt, not the snapshot seq: snapshots also arrive for memory watches and must not move the view)
  const followKey = pc === undefined ? null : `${snap.halt?.cycles ?? ''}:${pc}`;
  const lastFollow = useRef<string | null>(null);
  useEffect(() => {
    if (pc === undefined || followKey === null) return;
    if (followKey === lastFollow.current) return;
    lastFollow.current = followKey;
    const shown = lines.slice(0, Math.max(1, visible - 2)).some((l) => l.address === pc);
    if (!shown || top === null) {
      let live = true;
      back(pc, BEFORE_PC).then((a) => live && setTop(a), () => live && setTop(pc));
      return () => {
        live = false;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);

  // fetch the rows (also after every halt: memory may have changed)
  const haltKey = halted ? `${snap.halt?.cycles ?? ''}:${snap.halt?.pc ?? ''}` : '';
  useEffect(() => {
    if (top === null || !snap.registers) return;
    let live = true;
    void Promise.resolve(s12.debug.disassemble({ address: top, count: visible, symbolic: opts.symbolic })).then((l) => live && Array.isArray(l) && setLines(l), () => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s12, top, visible, opts.symbolic, haltKey, loadGen, !!snap.registers]);

  // forward scrolls, so scrolling back returns to exactly the same rows (disassembling backwards resyncs differently,
  // e.g. in erased $FF code), also when the page size changed in between; see unwindScroll()
  const history = useRef<ScrollStep[]>([]);
  const scrollBy = useCallback(
    (n: number) => {
      if (top === null) return;
      if (n > 0) {
        const i = Math.min(n, lines.length - 1);
        const t = lines[i]?.address;
        if (t !== undefined && t !== top) {
          history.current.push({ from: top, to: t, n: i });
          if (history.current.length > 256) history.current.shift();
          setTop(t);
        }
      } else if (n < 0) {
        const r = unwindScroll(history.current, top, -n);
        if (r.partial) {
          const { from, index } = r.partial;
          void Promise.resolve(s12.debug.disassemble({ address: from, count: index + 1 })).then((l) => {
            const a = Array.isArray(l) ? l[index]?.address : undefined;
            if (a === undefined) return setTop(from);
            history.current.push({ from, to: a, n: index });
            setTop(a);
          }, () => undefined);
        } else if (r.rest > 0) back(r.top, r.rest).then(setTop, () => undefined);
        else setTop(r.top);
      }
    },
    [s12, top, lines, back],
  );

  /** Show an address: `SPC` arguments follow the command-language number rules, the dialog takes hex or a symbol. */
  const goto = useCallback(
    async (text: string, from: 'command' | 'dialog') => {
      const a = from === 'command' ? await resolveCommandAddress(s12, text) : await resolveDialogAddress(s12, text);
      if (a === null || a === undefined) {
        bus.status(`Cannot resolve "${text}"`);
        return;
      }
      setTop(await back(a, BEFORE_PC));
      setSel(a & 0xffff);
    },
    [s12, bus, back],
  );

  useUiCommands((c) => {
    const kw = c.keyword.toUpperCase();
    if (kw === 'SPC') void goto(c.argText.trim(), 'command').catch(report);
    else if (kw === 'ATTRIBUTES') {
      const r = optionsFromAttributes([...(c.argText.match(/[A-Za-z_]+\s+[^,]+/g) ?? [])].map((p) => ({ name: p.split(/\s+/)[0], value: p.slice(p.split(/\s+/)[0].length).trim() })), opts);
      setOpts(r.options);
      if (r.topPc !== undefined) setTop(r.topPc);
    }
  });

  useEffect(() => {
    bus.setAttributes(attributesFromOptions(attributes, opts, top ?? undefined));
  }, [bus, attributes, opts, top]);

  const procName = useMemo(() => procedureAt(symbols, sel ?? pc ?? top ?? 0), [symbols, sel, pc, top]);
  useEffect(() => {
    host.setHeadline(snap.registers ? procName : '');
  }, [host, procName, snap.registers]);

  const toggle = (k: keyof AsmOptions) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const compMenu = useMemo<MenuEntry[]>(
    () => [
      { id: 'assembly.address', label: '&Address...', onSelect: () => setAskAddress(true) },
      SEP,
      { id: 'assembly.code', label: 'Display &Code', checked: opts.code, onSelect: () => toggle('code') },
      { id: 'assembly.symbolic', label: 'Display &Symbolic', checked: opts.symbolic, onSelect: () => toggle('symbolic') },
      { id: 'assembly.adr', label: 'Display A&ddress', checked: opts.address, onSelect: () => toggle('address') },
      { id: 'assembly.absadr', label: 'Display Absolute Add&ress', checked: opts.absAddress, onSelect: () => toggle('absAddress') },
    ],
    [opts],
  );
  useComponentMenu(compMenu);

  const rows = useMemo(() => asmRows(lines, opts, pc, bps), [lines, opts, pc, bps]);

  const [showBps, setShowBps] = useState(false);
  const popup = (e: React.MouseEvent, r: AsmRow) => {
    e.preventDefault();
    setSel(r.address);
    const { bp } = breakpointMenuState(bps, r.address);
    const d = s12.debug;
    const items: MenuEntry[] = [
      { id: 'asm.setBp', label: 'Set &Breakpoint', disabled: !!bp || !snap.registers, onSelect: () => void d.setBreakpoint({ address: r.address }).catch(report) },
      { id: 'asm.delBp', label: '&Delete Breakpoint', disabled: !bp, onSelect: () => bp && void d.removeBreakpoint(bp.id).catch(report) },
      bp?.enabled === false
        ? { id: 'asm.enBp', label: '&Enable Breakpoint', onSelect: () => void d.updateBreakpoint(bp.id, { enabled: true }).catch(report) }
        : { id: 'asm.disBp', label: 'D&isable Breakpoint', disabled: !bp, onSelect: () => bp && void d.updateBreakpoint(bp.id, { enabled: false }).catch(report) },
      SEP,
      { id: 'asm.showBps', label: 'Show B&reakpoints...', onSelect: () => setShowBps(true) },
      SEP,
      { id: 'asm.runTo', label: '&Run To Cursor', disabled: !halted, onSelect: () => void d.runTo(r.address).catch(report) },
      { id: 'asm.setPc', label: 'Set &Program Counter', disabled: !halted, onSelect: () => void d.writeRegister('PC', r.address).catch(report) },
      { id: 'asm.showLoc', label: 'Show &Location', onSelect: () => showLocation(bus, r.address, ['Source', 'Memory']) },
      SEP,
      { id: 'asm.copy', label: '&Copy', onSelect: () => void navigator.clipboard?.writeText(rowText(r)).catch(() => undefined) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  if (!snap.registers) return <div className="cw-placeholder">No application loaded</div>;

  return (
    <div
      ref={box}
      className="s12-code cw-mono"
      style={{ overflow: 'hidden' }}
      tabIndex={0}
      data-testid="assembly-component"
      onWheel={(e) => scrollBy(e.deltaY > 0 ? 3 : -3)}
      onKeyDown={(e) => {
        const page = Math.max(1, visible - 2);
        const k: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
        if (k[e.key]) {
          e.preventDefault();
          scrollBy(k[e.key]);
        }
      }}
    >
      {rows.map((r) =>
        r.kind === 'label' ? (
          <div key={r.key} className="s12-code-line label">
            <span className="s12-gutter" />
            <span>{r.text}</span>
          </div>
        ) : (
          <div
            key={r.key}
            className={`s12-code-line${r.isPc ? ' pc' : ''}${sel === r.address ? ' sel' : ''}`}
            data-testid={`asm-row-${hex(r.address, 4)}`}
            data-pc={r.isPc || undefined}
            data-bp={r.bp ? (r.bp.enabled ? 'enabled' : 'disabled') : undefined}
            draggable
            onDragStart={(e) => setDnd(e, { kind: 'address', address: r.address, source: 'Assembly' })}
            onMouseDown={(e) => e.button === 0 && setSel(r.address)}
            onContextMenu={(e) => popup(e, r)}
          >
            <span className="s12-gutter" data-testid={`asm-gutter-${hex(r.address, 4)}`} title="Set/Delete Breakpoint" onClick={() => void toggleBreakpointAt(s12, bps, r.address).catch(report)}>
              {r.bp && <span className={`s12-bp${r.bp.enabled ? '' : ' disabled'}${r.bp.temporary ? ' temporary' : ''}`} />}
            </span>
            <span style={{ paddingLeft: 3, color: r.illegal ? 'var(--cw-changed)' : undefined }}>{rowText(r)}</span>
          </div>
        ),
      )}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <ControlpointsDialog open={showBps} initialTab="breakpoints" onClose={() => setShowBps(false)} />
      <PromptDialog
        title="Show PC"
        label="Address (hex number or symbol):"
        initial={pc !== undefined ? '0x' + hex(pc, 4) : ''}
        open={askAddress}
        onClose={() => setAskAddress(false)}
        onOk={(t) => void goto(t, 'dialog').catch(report)}
        testId="assembly-address-dialog"
      />
    </div>
  );
}

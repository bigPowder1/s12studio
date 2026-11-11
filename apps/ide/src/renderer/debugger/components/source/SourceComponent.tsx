/**
 * hiwave "Source" component (docs/research/r1/ide.md §6 Source): read-only, chroma-coded view of the module's `.dbg`
 * file that contains the PC (the shared Monaco `SourceView` from common/monaco); the PC statement is highlighted.
 * Glyph margin: breakpoint marks per kind (permanent, temporary, conditional, counting; click toggles) and optional
 * Marks (lines where a breakpoint is possible). Pop-up: Set/Delete/Enable/Disable Breakpoint, Run To Cursor, Show
 * Location, Set Program Counter, Open Source File, Copy, Go to Line, Find, Marks. Info bar: full path and "Line: N"
 * (first visible line). When the PC is in code without source (library), shows "no source" and leaves it to Assembly.
 *
 * No-source halts keep the file already shown. When nothing has been shown yet (NORUNAFTERLOAD: the load stops at the
 * reset entry, which is in the ME3305 library's start-up code whose `.dbg` is not on the student's PC), the window
 * shows the application's main module instead (the file of `main`, scrolled to `main:`) with no PC line, so a
 * student never faces an empty Source window (owner decision; hiwave itself would leave it empty, final fidelity
 * F11). Normal PC following resumes at the first halt in code that has source.
 *
 * The PC line follows the *current* PC: the snapshot's `source` belongs to the PC of the last halt, so after Set
 * Program Counter / a PC edit in the Register window (no halt) the location is looked up with `debug.sourceLocation`.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseApiError, type BreakpointInfo, type LineAddress, type SourceFileInfo, type SourceLocationInfo, type SourceText } from '../../../../shared/api';
import { Button, Dialog } from '../../../common/controls';
import { addr } from '../../../common/format';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import { SEP, type MenuEntry } from '../../../common/menu/model';
import { buildSourceContextMenu, SourceView, type SourceBreakpointKind, type SourceBreakpointMark, type SourceLineInfo, type SourceViewHandle } from '../../../common/monaco';
import { useDebugSnapshot, useS12, useS12Event, useSession } from '../../../common/s12';
import { useComponentHost, useComponentMenu, useUiCommands, type DebuggerComponentProps } from '../contract';
import { resolveCommandAddress, showLocation, useBreakpoints, useDebuggerBus } from '../../shell/bus';
import { PromptDialog } from '../../shell/PromptDialog';
import { ControlpointsDialog } from '../../dialogs/ControlpointsDialog';
import { addressForLine, breakpointsByLine, findLine, mainLabelLine, pickMainSource, sameFile } from './model';

const attrOn = (attrs: readonly { name: string; value: string }[], name: string, def: boolean) => {
  const v = attrs.find((a) => a.name.toUpperCase() === name)?.value;
  return v === undefined ? def : !/^(off|0|false)$/i.test(v.trim());
};

/** Margin icon kind of a breakpoint (temporary wins, then an active condition, then a counter > 1). */
export function breakpointKind(b: BreakpointInfo): SourceBreakpointKind {
  if (b.temporary) return 'temporary';
  if (b.condition && b.conditionEnabled !== false) return 'conditional';
  if (b.counter && b.counter.interval > 1) return 'counting';
  return 'permanent';
}

/**
 * The debugger's monospace font (shell `FONT` command / Component > Fonts set `--cw-mono-font[-size]` on the MDI
 * area) as Monaco options; re-read when the MDI area's style changes.
 */
function useMonoFont(ref: React.RefObject<HTMLElement | null>): { family?: string; size?: number } {
  const [font, setFont] = useState<{ family?: string; size?: number }>({});
  const read = useCallback(() => {
    const el = ref.current;
    if (!el || typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(el);
    const family = cs.getPropertyValue('--cw-mono-font').trim() || undefined;
    const px = parseFloat(cs.getPropertyValue('--cw-mono-font-size'));
    const size = Number.isFinite(px) && px > 0 ? px : undefined;
    setFont((f) => (f.family === family && f.size === size ? f : { family, size }));
  }, [ref]);
  useLayoutEffect(() => {
    read();
    const area = ref.current?.closest('.s12-mdi');
    if (!area || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(read);
    mo.observe(area, { attributes: true, attributeFilter: ['style'] });
    return () => mo.disconnect();
  }, [ref, read]);
  return font;
}

export function SourceComponent({ attributes }: DebuggerComponentProps) {
  const s12 = useS12();
  const host = useComponentHost();
  const bus = useDebuggerBus();
  const snap = useDebugSnapshot();
  const session = useSession();
  const bps = useBreakpoints();
  const [src, setSrc] = useState<SourceText | null>(null);
  const [lineAddrs, setLineAddrs] = useState<LineAddress[]>([]);
  const [noSource, setNoSource] = useState<string | null>(null);
  const [marks, setMarks] = useState(() => attrOn(attributes, 'MARKS', false));
  const [firstVisible, setFirstVisible] = useState(1);
  const [dialog, setDialog] = useState<null | 'line' | 'find' | 'open' | 'proc' | 'bpts'>(null);
  const [emptyMenu, setEmptyMenu] = useState<ContextMenuState | null>(null);
  const [lastFind, setLastFind] = useState('');
  const [files, setFiles] = useState<SourceFileInfo[]>([]);
  const [loadGen, setLoadGen] = useState(0);
  const view = useRef<SourceViewHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const font = useMonoFont(root);
  /**
   * Line to put the cursor on once the view shows the file (SPC, Go to Line, Find after a file switch); `quiet` only
   * scrolls it to the top (main module at start: no cursor move, no focus theft from the active window).
   */
  const pendingGoto = useRef<{ line: number; file?: string; quiet?: boolean } | null>(null);
  const halted = snap.state === 'halted';
  const report = useCallback((e: unknown) => bus.status(parseApiError(e).message), [bus]);

  // .dbg files that could not be read: not retried on every snapshot (cleared when an application is loaded)
  const missing = useRef(new Set<string>());
  const reading = useRef<string | null>(null);
  /** Main-module fallback already looked up for this load (once per load: see `showMainModule`). */
  const mainTried = useRef(false);
  /** Bumped when a file gets shown (showFile) or the application reloads: a pending main-module fallback is stale. */
  const fileGen = useRef(0);
  useS12Event('debug', 'loaded', () => {
    setSrc(null);
    missing.current.clear();
    mainTried.current = false;
    fileGen.current++;
    setLoadGen((g) => g + 1);
  });

  // the file the view shows (as of the last render; the view switches its model in its own effect, which runs
  // before this component's effects in the same commit)
  const srcRef = useRef<SourceText | null>(null);
  srcRef.current = src;
  /** The shown file has the PC line (set during render, at `pcLine`). */
  const pcShown = useRef(false);
  /** Put the cursor on a line of `file` (default: the shown file) once the view shows it (`quiet`: scroll only). */
  const gotoLine = useCallback((line: number, file?: string, quiet?: boolean) => {
    const want = file ?? srcRef.current?.file;
    const v = view.current;
    // a quiet (main-module) scroll never moves the view away from a PC line: PC following has taken over
    if (quiet && pcShown.current) {
      pendingGoto.current = null;
      return;
    }
    if (v?.editor()?.getModel() && want && sameFile(want, srcRef.current?.file)) {
      pendingGoto.current = null;
      if (quiet) v.revealLine(line, 'top');
      else v.gotoLine(line);
    } else pendingGoto.current = { line, file: want, quiet };
  }, []);
  useEffect(() => {
    const p = pendingGoto.current;
    if (p && p.file && sameFile(p.file, src?.file) && view.current?.editor()?.getModel()) gotoLine(p.line, p.file, p.quiet);
  });

  /** Show a file (loading it when needed). */
  const showFile = useCallback(
    async (file: string) => {
      if (!src || !sameFile(src.file, file)) {
        // before the awaits: a main-module fallback still in flight must not land after (or over) this file
        fileGen.current++;
        const text = await s12.debug.readSource(file);
        const la = await s12.debug.lineAddresses(file).catch(() => [] as LineAddress[]);
        setSrc(text);
        setLineAddrs(Array.isArray(la) ? la : []);
      }
      setNoSource(null);
    },
    [s12, src],
  );

  // where the current PC is: the snapshot's location belongs to the last halt's PC (review finding 2)
  const pc = halted ? snap.registers?.PC : undefined;
  const haltPc = halted ? snap.halt?.pc : undefined;
  const snapLoc = halted ? snap.source : undefined;
  const haltKey = snap.halt?.cycles;
  const [pcLoc, setPcLoc] = useState<{ pc: number; loc: SourceLocationInfo | null } | null>(null);
  useEffect(() => {
    if (pc === undefined) return;
    if (haltPc === pc) {
      setPcLoc({ pc, loc: snapLoc ?? null });
      return;
    }
    let live = true;
    void Promise.resolve(s12.debug.sourceLocation(pc)).then(
      (l) => live && setPcLoc({ pc, loc: l ?? null }),
      () => live && setPcLoc({ pc, loc: null }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s12, pc, haltPc, snapLoc?.file, snapLoc?.line, haltKey, loadGen]);

  /**
   * No source for the PC and no file shown yet: show the application's main module (looked up once per load) under
   * the "no source" headline (set by the caller), with no PC line. Dropped when a file got shown meanwhile (PC following, Open Source File...)
   * or the application was reloaded.
   */
  const showMainModule = useCallback(
    () => {
      if (srcRef.current || mainTried.current) return;
      mainTried.current = true;
      const gen = fileGen.current;
      const d = s12.debug;
      void (async () => {
        const files = await Promise.resolve(d.sourceFiles()).catch(() => [] as SourceFileInfo[]);
        const at = await Promise.resolve(d.resolve('main')).catch(() => null);
        const loc = typeof at === 'number' ? await Promise.resolve(d.sourceLocation(at)).catch(() => null) : null;
        const pick = pickMainSource(Array.isArray(files) ? files : [], loc ?? null);
        if (!pick) return;
        const text = await d.readSource(pick.file);
        const la = await Promise.resolve(d.lineAddresses(pick.file)).catch(() => [] as LineAddress[]);
        // stale: a file got shown or is being read for the PC (PC following took over), or the application reloaded
        if (fileGen.current !== gen || srcRef.current || reading.current !== null) return;
        setSrc(text);
        setLineAddrs(Array.isArray(la) ? la : []);
        gotoLine(mainLabelLine(text.text.split(/\r?\n/)) ?? pick.line ?? 1, pick.file, true);
      })().catch(() => undefined);
    },
    [s12, gotoLine],
  );

  // follow the PC: open its file (the view keeps the PC line in sight); no source: keep the shown file, or show the
  // main module when none is shown yet
  useEffect(() => {
    if (!pcLoc) return;
    const { pc: at, loc } = pcLoc;
    if (!loc) {
      const reason = `No source for PC ${addr(at)}: see the Assembly window`;
      setNoSource(reason);
      showMainModule();
      return;
    }
    const notFound = `No source for PC ${addr(at)} (${loc.file.split(/[\\/]/).pop()} not found): see the Assembly window`;
    if (missing.current.has(loc.file)) {
      setNoSource(notFound);
      showMainModule();
      return;
    }
    if (reading.current === loc.file) return;
    reading.current = loc.file;
    showFile(loc.file)
      .then(() => {
        // PC following owns the scroll position now: a queued main-module scroll is dropped
        if (pendingGoto.current?.quiet) pendingGoto.current = null;
      })
      .catch(() => {
        missing.current.add(loc.file);
        setNoSource(notFound);
        showMainModule();
      })
      .finally(() => {
        reading.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcLoc]);

  /** Show the source line of an address expression (SPC, Find Procedure). */
  const showSourceOf = useCallback(
    (t: string) =>
      void (async () => {
        const a = await resolveCommandAddress(s12, t);
        if (a === null) return bus.status(`Cannot resolve "${t}"`);
        const l = await s12.debug.sourceLocation(a);
        if (!l) return bus.status(`No source for ${addr(a)}`);
        await showFile(l.file);
        gotoLine(l.line, l.file);
      })().catch(report),
    [s12, bus, showFile, gotoLine, report],
  );

  useUiCommands((c) => {
    const kw = c.keyword.toUpperCase();
    if (kw === 'SPC') {
      showSourceOf(c.argText.trim());
    } else if (kw === 'ATTRIBUTES' && /MARKS\s+(\w+)/i.test(c.argText)) {
      setMarks(!/off/i.test(/MARKS\s+(\w+)/i.exec(c.argText)![1]));
    }
  });

  useEffect(() => {
    bus.setAttributes(attributes.some((a) => a.name.toUpperCase() === 'MARKS') ? attributes.map((a) => (a.name.toUpperCase() === 'MARKS' ? { ...a, value: marks ? 'on' : 'off' } : a)) : [...attributes, { name: 'MARKS', value: marks ? 'on' : 'off' }]);
  }, [bus, attributes, marks]);

  useEffect(() => {
    host.setHeadline(src ? `${src.path}\tLine: ${firstVisible}` : '');
  }, [host, src, firstVisible]);

  const textLines = useMemo(() => (src ? src.text.split(/\r?\n/) : []), [src]);
  const bpLines = useMemo(() => breakpointsByLine(lineAddrs, bps), [lineAddrs, bps]);
  const codeLines = useMemo(() => [...new Set(lineAddrs.map((l) => l.line))].sort((a, b) => a - b), [lineAddrs]);
  const marksForView = useMemo<SourceBreakpointMark[]>(() => [...bpLines].map(([line, b]) => ({ line, enabled: b.enabled, kind: breakpointKind(b), id: b.id })), [bpLines]);
  const pcLine = pcLoc?.loc && src && sameFile(pcLoc.loc.file, src.file) ? pcLoc.loc.line : null;
  pcShown.current = pcLine !== null;

  const toggleAtLine = useCallback(
    async (line: number) => {
      const bp = bpLines.get(line);
      if (bp) return void (await s12.debug.removeBreakpoint(bp.id));
      const a = addressForLine(lineAddrs, line);
      if (!a) return bus.status('No code at or after this line');
      const existing = bpLines.get(a.line);
      if (existing) await s12.debug.removeBreakpoint(existing.id);
      else await s12.debug.setBreakpoint({ address: a.address });
    },
    [s12, bus, bpLines, lineAddrs],
  );

  const cursorLine = () => view.current?.getCursorLine() ?? firstVisible;

  const doFind = useCallback(
    (text: string) => {
      setLastFind(text);
      const ln = findLine(textLines, text, (view.current?.getCursorLine() ?? 0) + 1);
      if (ln === undefined) return bus.status(`"${text}" not found`);
      gotoLine(ln);
    },
    [textLines, bus, gotoLine],
  );

  const openFileDialog = useCallback(() => {
    void Promise.resolve(s12.debug.sourceFiles()).then((f) => setFiles(Array.isArray(f) ? f : []), () => setFiles([]));
    setDialog('open');
  }, [s12]);

  const copyText = useCallback((text: string) => {
    if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);
  const copy = useCallback(() => copyText(view.current?.getSelectedText() || textLines[(view.current?.getCursorLine() ?? 1) - 1] || ''), [copyText, textLines]);

  const compMenu = useMemo<MenuEntry[]>(
    () => [
      { id: 'source.open', label: '&Open Source File...', disabled: !session, onSelect: openFileDialog },
      SEP,
      { id: 'source.copy', label: '&Copy', shortcut: 'Ctrl+C', onSelect: copy },
      { id: 'source.gotoLine', label: '&Go to Line...', shortcut: 'Ctrl+G', disabled: !src, onSelect: () => setDialog('line') },
      { id: 'source.find', label: '&Find...', shortcut: 'Ctrl+F', disabled: !src, onSelect: () => setDialog('find') },
      { id: 'source.findNext', label: 'Find &Next', shortcut: 'F3', disabled: !src || !lastFind, onSelect: () => doFind(lastFind) },
      { id: 'source.findProcedure', label: 'Find &Procedure...', shortcut: 'Ctrl+I', disabled: !session, onSelect: () => setDialog('proc') },
      SEP,
      { id: 'source.marks', label: '&Marks', checked: marks, onSelect: () => setMarks((m) => !m) },
    ],
    [session, openFileDialog, copy, src, lastFind, doFind, marks],
  );
  useComponentMenu(compMenu);

  /** The hiwave pop-up for a line (shared builder from common/monaco + Marks). */
  const contextMenu = (info: SourceLineInfo): MenuEntry[] => {
    const at = addressForLine(lineAddrs, info.line);
    const d = s12.debug;
    const items = buildSourceContextMenu(info, {
      setBreakpoint: () => at && void d.setBreakpoint({ address: at.address }).catch(report),
      deleteBreakpoint: (i) => i.breakpoint?.id !== undefined && void d.removeBreakpoint(i.breakpoint.id).catch(report),
      enableBreakpoint: (i) => i.breakpoint?.id !== undefined && void d.updateBreakpoint(i.breakpoint.id, { enabled: true }).catch(report),
      disableBreakpoint: (i) => i.breakpoint?.id !== undefined && void d.updateBreakpoint(i.breakpoint.id, { enabled: false }).catch(report),
      runToCursor: () => at && void d.runTo(at.address).catch(report),
      showLocation: () => at && showLocation(bus, at.address, ['Assembly', 'Memory']),
      setProgramCounter: () => at && void d.writeRegister('PC', at.address).catch(report),
      openSourceFile: session ? openFileDialog : undefined,
      copy: (i) => copyText(i.selection || textLines[i.line - 1] || ''),
      gotoLine: () => setDialog('line'),
      find: () => setDialog('find'),
      showBreakpoints: () => setDialog('bpts'),
      findProcedure: () => setDialog('proc'),
    });
    // running: no Run To Cursor / Set Program Counter (hiwave greys them out)
    const out = items.map((e) => ('id' in e && !halted && (e.id === 'src.runToCursor' || e.id === 'src.setProgramCounter') ? { ...e, disabled: true } : e));
    return [...out, SEP, { id: 'src.marks', label: 'Marks', checked: marks, onSelect: () => setMarks((m) => !m) }];
  };

  const dialogs = (
    <>
      <PromptDialog
        title="Go to Line"
        label={`Line number (1-${textLines.length}):`}
        initial={String(dialog === 'line' ? cursorLine() : firstVisible)}
        open={dialog === 'line'}
        onClose={() => setDialog(null)}
        validate={(t) => (/^\d+$/.test(t.trim()) && Number(t) >= 1 && Number(t) <= textLines.length ? null : 'Enter a valid line number')}
        onOk={(t) => gotoLine(Number(t))}
        testId="source-goto-dialog"
      />
      <PromptDialog title="Find" label="Find what:" initial={lastFind} open={dialog === 'find'} onClose={() => setDialog(null)} onOk={doFind} testId="source-find-dialog" />
      <PromptDialog title="Find Procedure" label="Procedure:" initial="" open={dialog === 'proc'} onClose={() => setDialog(null)} validate={(t) => (t.trim() ? null : 'Enter a procedure name')} onOk={(t) => showSourceOf(t.trim())} testId="source-findproc-dialog" />
      <ControlpointsDialog open={dialog === 'bpts'} initialTab="breakpoints" onClose={() => setDialog(null)} />
      <ContextMenu state={emptyMenu} onClose={() => setEmptyMenu(null)} />
      <Dialog
        title="Open Source File"
        open={dialog === 'open'}
        onClose={() => setDialog(null)}
        width={420}
        testId="source-open-dialog"
        buttons={<Button onClick={() => setDialog(null)}>Cancel</Button>}
      >
        <div className="cw-sunken" style={{ height: 200, overflow: 'auto', background: 'var(--cw-window)' }}>
          {files.length === 0 && <div className="cw-placeholder">No source files</div>}
          {files.map((f) => (
            <div
              key={f.file}
              className="cw-row"
              style={{ padding: '1px 4px', color: f.path ? undefined : 'var(--cw-gray-text)', cursor: 'default' }}
              title={f.path ?? 'source not found'}
              data-testid={`source-file-${f.module}`}
              onDoubleClick={() => {
                setDialog(null);
                showFile(f.file)
                  .then(() => gotoLine(1, f.file))
                  .catch(report);
              }}
            >
              {f.module} <span style={{ color: 'var(--cw-gray-text)' }}>{f.file}</span>
            </div>
          ))}
        </div>
      </Dialog>
    </>
  );

  return (
    <div
      ref={root}
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
      data-testid="source-component"
      data-empty={src ? undefined : true}
      data-file={src?.path}
      data-pc-line={pcLine ?? undefined}
      data-bp-lines={[...bpLines.keys()].sort((a, b) => a - b).join(' ') || undefined}
      onKeyDownCapture={(e) => {
        // hiwave keys (before Monaco's own find widget / go-to-line)
        const k = e.key.toLowerCase();
        if (!src || e.altKey) return;
        if (e.ctrlKey && k === 'i') {
          e.preventDefault();
          e.stopPropagation();
          setDialog('proc');
        } else if (e.ctrlKey && (k === 'g' || k === 'f')) {
          e.preventDefault();
          e.stopPropagation();
          setDialog(k === 'g' ? 'line' : 'find');
        } else if (e.key === 'F3' && lastFind) {
          e.preventDefault();
          e.stopPropagation();
          doFind(lastFind);
        }
      }}
    >
      {src && noSource && (
        // neutral grey, not red: at start this is the normal state (PC in the library start-up code), not an error
        <div className="s12-mdi-headline" style={{ color: 'var(--cw-gray-text)', flex: 'none' }} data-testid="source-no-source">
          {noSource}
        </div>
      )}
      {src ? (
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <SourceView
            ref={view}
            text={src.text}
            path={src.path ?? src.file}
            pcLine={pcLine}
            codeLines={codeLines}
            showMarks={marks}
            breakpoints={marksForView}
            onToggleBreakpoint={(line) => void toggleAtLine(line).catch(report)}
            contextMenu={contextMenu}
            onTopLineChange={(l) => {
              setFirstVisible(l);
              const p = pendingGoto.current;
              if (p) gotoLine(p.line, p.file, p.quiet);
            }}
            fontFamily={font.family}
            fontSize={font.size}
            testId="source-view"
          />
        </div>
      ) : (
        // hiwave leaves a Source window without source empty (final fidelity F11): the reason goes to the tooltip
        <div
          style={{ flex: 1, minHeight: 0, background: 'var(--cw-window)' }}
          data-testid="source-empty"
          title={snap.registers ? (noSource ?? 'No source') : 'No application loaded'}
          onContextMenu={(e) => {
            e.preventDefault();
            setEmptyMenu({ x: e.clientX, y: e.clientY, items: [{ id: 'src.openSourceFile', label: 'Open Source File...', disabled: !session, onSelect: openFileDialog }] });
          }}
        />
      )}
      {dialogs}
    </div>
  );
}

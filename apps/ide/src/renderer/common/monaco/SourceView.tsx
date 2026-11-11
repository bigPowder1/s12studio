/**
 * Read-only Monaco source view for the debugger's Source component (hiwave, ide.md §6 "Source component"):
 *   - shows a .dbg/.asm text with the hiwave chroma coding (keywords blue, comments green, strings red)
 *   - highlights the current PC statement (blue bar, white text) with an arrow in the margin
 *   - breakpoint markers in the glyph margin: red disc; disabled = hollow; temporary "T"; conditional "?";
 *     counting "#"; clicking the margin calls onToggleBreakpoint (only on code lines when codeLines is given)
 *   - per-line "has code" marks (lines with line-table entries; hiwave "Marks")
 *   - right-click: a context menu built by the owner (buildSourceContextMenu gives the hiwave items)
 *   - ref API: revealLine, getTopLine, getCursorLine, focus, find, gotoLine, getSelectedText
 *
 * The owner (components track) maps debug.lineAddresses to codeLines and debug.breakpoints to markers; this view
 * only paints and reports clicks.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { ContextMenu, type ContextMenuState } from '../menu/MenuBar';
import { SEP, type MenuEntry } from '../menu/model';
import { languageForPath, HC12_LANGUAGE_ID } from './hc12';
import { useMonaco } from './loader';
import { THEME } from '../../../shared/theme/tokens';
import { CW_HIWAVE_THEME } from './themes';
import './sourceView.css';

export type SourceBreakpointKind = 'permanent' | 'temporary' | 'conditional' | 'counting';

export interface SourceBreakpointMark {
  /** 1-based line. */
  line: number;
  enabled: boolean;
  kind?: SourceBreakpointKind;
  /** Owner's id (passed back in context-menu info). */
  id?: number;
}

export interface SourceLineInfo {
  line: number;
  hasCode: boolean;
  breakpoint?: SourceBreakpointMark;
  isPc: boolean;
  /** Selected text (or the word under the mouse). */
  selection: string;
}

export interface SourceViewProps {
  text: string;
  /** Identity of the text (file path); a change resets the scroll position. Also picks the language. */
  path?: string;
  /** 1-based line of the current PC statement (null/undefined: none). */
  pcLine?: number | null;
  /** Lines that have code (line-table entries). Undefined: every line accepts breakpoints, no marks drawn. */
  codeLines?: Iterable<number> | null;
  /** Draw the code-line marks (default true when codeLines is given). */
  showMarks?: boolean;
  breakpoints?: readonly SourceBreakpointMark[];
  /** Margin click (glyph margin or line decorations) on a line. */
  onToggleBreakpoint?: (line: number, info: SourceLineInfo) => void;
  /** Right-click menu entries for a line; return [] for no menu. */
  contextMenu?: (info: SourceLineInfo) => MenuEntry[];
  /** First visible line changed (hiwave info bar "Line: N"). */
  onTopLineChange?: (line: number) => void;
  /** Keep the PC line in view when it changes (default true). */
  followPc?: boolean;
  fontFamily?: string;
  fontSize?: number;
  tabSize?: number;
  testId?: string;
}

export interface SourceViewHandle {
  revealLine(line: number, where?: 'center' | 'top' | 'nearest'): void;
  getTopLine(): number;
  getCursorLine(): number;
  focus(): void;
  /** Open the find widget. */
  find(): void;
  /** Put the cursor on a line and reveal it. */
  gotoLine(line: number): void;
  getSelectedText(): string;
  /** The underlying Monaco editor (null until loaded). */
  editor(): MonacoNs.editor.IStandaloneCodeEditor | null;
}

export interface SourceMenuHandlers {
  setBreakpoint?: (info: SourceLineInfo) => void;
  deleteBreakpoint?: (info: SourceLineInfo) => void;
  enableBreakpoint?: (info: SourceLineInfo) => void;
  disableBreakpoint?: (info: SourceLineInfo) => void;
  runToCursor?: (info: SourceLineInfo) => void;
  showBreakpoints?: () => void;
  showLocation?: () => void;
  setProgramCounter?: (info: SourceLineInfo) => void;
  openSourceFile?: () => void;
  copy?: (info: SourceLineInfo) => void;
  gotoLine?: () => void;
  find?: () => void;
  findProcedure?: () => void;
}

/**
 * The hiwave Source pop-up menu (ide.md §6): Set/Delete/Enable/Disable Breakpoint, Run To Cursor, Show Breakpoints,
 * Show Location, Set Program Counter, Open Source File, Copy, Go to Line, Find, Find Procedure. Items whose handler
 * is missing are omitted; line-specific items are disabled on lines without code.
 * UNCERTAIN: Markpoints, Foldings, Marks and ToolTips submenus are not offered.
 */
export function buildSourceContextMenu(info: SourceLineInfo, h: SourceMenuHandlers): MenuEntry[] {
  const groups: MenuEntry[][] = [];
  const bp: MenuEntry[] = [];
  if (info.breakpoint) {
    if (h.deleteBreakpoint) bp.push({ id: 'src.deleteBreakpoint', label: 'Delete Breakpoint', onSelect: () => h.deleteBreakpoint!(info) });
    if (info.breakpoint.enabled && h.disableBreakpoint) bp.push({ id: 'src.disableBreakpoint', label: 'Disable Breakpoint', onSelect: () => h.disableBreakpoint!(info) });
    if (!info.breakpoint.enabled && h.enableBreakpoint) bp.push({ id: 'src.enableBreakpoint', label: 'Enable Breakpoint', onSelect: () => h.enableBreakpoint!(info) });
  } else if (h.setBreakpoint) bp.push({ id: 'src.setBreakpoint', label: 'Set Breakpoint', disabled: !info.hasCode, onSelect: () => h.setBreakpoint!(info) });
  if (h.runToCursor) bp.push({ id: 'src.runToCursor', label: 'Run To Cursor', disabled: !info.hasCode, onSelect: () => h.runToCursor!(info) });
  if (h.showBreakpoints) bp.push({ id: 'src.showBreakpoints', label: 'Show Breakpoints...', onSelect: h.showBreakpoints });
  groups.push(bp);
  const loc: MenuEntry[] = [];
  if (h.showLocation) loc.push({ id: 'src.showLocation', label: 'Show Location', onSelect: h.showLocation });
  if (h.setProgramCounter) loc.push({ id: 'src.setProgramCounter', label: 'Set Program Counter', disabled: !info.hasCode, onSelect: () => h.setProgramCounter!(info) });
  if (h.openSourceFile) loc.push({ id: 'src.openSourceFile', label: 'Open Source File...', onSelect: h.openSourceFile });
  groups.push(loc);
  const edit: MenuEntry[] = [];
  if (h.copy) edit.push({ id: 'src.copy', label: 'Copy', shortcut: 'Ctrl+C', disabled: !info.selection, onSelect: () => h.copy!(info) });
  if (h.gotoLine) edit.push({ id: 'src.gotoLine', label: 'Go to Line...', shortcut: 'Ctrl+G', onSelect: h.gotoLine });
  if (h.find) edit.push({ id: 'src.find', label: 'Find...', shortcut: 'Ctrl+F', onSelect: h.find });
  if (h.findProcedure) edit.push({ id: 'src.findProcedure', label: 'Find Procedure...', shortcut: 'Ctrl+I', onSelect: h.findProcedure });
  groups.push(edit);
  const out: MenuEntry[] = [];
  for (const g of groups.filter((x) => x.length)) {
    if (out.length) out.push(SEP);
    out.push(...g);
  }
  return out;
}

/** Glyph-margin class names for a line (exported for tests). */
export function glyphClassFor(bp: SourceBreakpointMark | undefined, isPc: boolean): string {
  const c: string[] = [];
  if (bp) {
    c.push('s12-bp', `s12-bp-${bp.kind ?? 'permanent'}`);
    if (!bp.enabled) c.push('s12-bp-disabled');
  }
  if (isPc) c.push('s12-pc-arrow');
  return c.join(' ');
}

/** Decorations for the view state (exported for tests). */
export function sourceDecorations(model: Pick<MonacoNs.editor.ITextModel, 'getLineCount' | 'getLineMaxColumn'>, s: { pcLine?: number | null; breakpoints?: readonly SourceBreakpointMark[]; codeLines?: ReadonlySet<number> | null; showMarks: boolean }): MonacoNs.editor.IModelDeltaDecoration[] {
  const n = model.getLineCount();
  const out: MonacoNs.editor.IModelDeltaDecoration[] = [];
  const bps = new Map<number, SourceBreakpointMark>();
  for (const b of s.breakpoints ?? []) if (b.line >= 1 && b.line <= n) bps.set(b.line, b);
  const pc = s.pcLine && s.pcLine >= 1 && s.pcLine <= n ? s.pcLine : null;
  const glyphLines = new Set<number>([...bps.keys(), ...(pc ? [pc] : [])]);
  for (const line of glyphLines) {
    out.push({ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { glyphMarginClassName: glyphClassFor(bps.get(line), line === pc), glyphMarginHoverMessage: bps.has(line) ? { value: describeBp(bps.get(line)!) } : undefined } });
  }
  if (pc) {
    out.push({ range: { startLineNumber: pc, startColumn: 1, endLineNumber: pc, endColumn: model.getLineMaxColumn(pc) }, options: { isWholeLine: true, className: 's12-pc-line', inlineClassName: 's12-pc-text' } });
  }
  if (s.showMarks && s.codeLines) {
    for (const line of s.codeLines) if (line >= 1 && line <= n) out.push({ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { linesDecorationsClassName: 's12-code-mark' } });
  }
  return out;
}

function describeBp(b: SourceBreakpointMark): string {
  const k = b.kind ?? 'permanent';
  return `${k[0].toUpperCase()}${k.slice(1)} breakpoint${b.enabled ? '' : ' (disabled)'}`;
}

export const SourceView = forwardRef<SourceViewHandle, SourceViewProps>(function SourceView(props, ref) {
  const { text, path, pcLine, codeLines, breakpoints, followPc = true, fontFamily = THEME.monoFont, fontSize = 12, tabSize = 8, testId = 'source-view' } = props;
  const monaco = useMonaco();
  const hostRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<MonacoNs.editor.ITextModel | null>(null);
  const decoRef = useRef<MonacoNs.editor.IEditorDecorationsCollection | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const codeSet = useMemo(() => (codeLines ? new Set(codeLines) : null), [codeLines]);
  const codeRef = useRef(codeSet);
  codeRef.current = codeSet;
  const showMarks = props.showMarks ?? !!codeSet;

  const lineInfo = (line: number, selection: string): SourceLineInfo => {
    const p = propsRef.current;
    return { line, hasCode: codeRef.current ? codeRef.current.has(line) : true, breakpoint: p.breakpoints?.find((b) => b.line === line), isPc: p.pcLine === line, selection };
  };

  // editor
  useEffect(() => {
    const host = hostRef.current;
    if (!monaco || !host) return;
    const ed = monaco.editor.create(host, {
      model: null,
      readOnly: true,
      domReadOnly: true,
      theme: CW_HIWAVE_THEME,
      fontFamily,
      fontSize,
      fontLigatures: false,
      lineNumbers: 'off',
      glyphMargin: true,
      folding: false,
      lineDecorationsWidth: 8,
      minimap: { enabled: false },
      contextmenu: false,
      renderLineHighlight: 'none',
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      matchBrackets: 'never',
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      guides: { indentation: false },
      links: false,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      automaticLayout: true,
      fixedOverflowWidgets: true,
      cursorBlinking: 'solid',
      readOnlyMessage: { value: 'The Source component is read-only' },
      // window-style scrollbars: shown whenever the text overflows (not only on hover), with arrows and an opaque track
      // (sourceView.css), so a thumb never floats over the text
      scrollbar: { vertical: 'visible', horizontal: 'visible', useShadows: false, verticalHasArrows: true, horizontalHasArrows: true, verticalScrollbarSize: 14, horizontalScrollbarSize: 14, arrowSize: 14, alwaysConsumeMouseWheel: false },
    });
    edRef.current = ed;
    decoRef.current = ed.createDecorationsCollection([]);
    const MT = monaco.editor.MouseTargetType;
    const subs = [
      ed.onMouseDown((e) => {
        const t = e.target;
        if (!e.event.leftButton || !t.position) return;
        if (t.type !== MT.GUTTER_GLYPH_MARGIN && t.type !== MT.GUTTER_LINE_DECORATIONS) return;
        const info = lineInfo(t.position.lineNumber, '');
        if (!info.hasCode && !info.breakpoint) return; // breakpoints only on code lines
        propsRef.current.onToggleBreakpoint?.(t.position.lineNumber, info);
      }),
      ed.onContextMenu((e) => {
        const build = propsRef.current.contextMenu;
        const pos = e.target.position;
        if (!build || !pos) return;
        e.event.preventDefault();
        const model = ed.getModel();
        const sel = ed.getSelection();
        let selection = sel && model && !sel.isEmpty() ? model.getValueInRange(sel) : '';
        if (!selection && model) selection = model.getWordAtPosition(pos)?.word ?? '';
        const items = build(lineInfo(pos.lineNumber, selection));
        if (items.length) setMenu({ x: e.event.posx, y: e.event.posy, items });
      }),
      ed.onDidScrollChange(() => {
        const r = ed.getVisibleRanges()[0];
        if (r) propsRef.current.onTopLineChange?.(r.startLineNumber);
      }),
    ];
    return () => {
      for (const s of subs) s.dispose();
      ed.dispose();
      modelRef.current?.dispose();
      modelRef.current = null;
      edRef.current = null;
      decoRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco]);

  useEffect(() => {
    edRef.current?.updateOptions({ fontFamily, fontSize });
  }, [fontFamily, fontSize]);

  // model: a new path gets a fresh model; same path + new text keeps the scroll position
  const lastPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    const ed = edRef.current;
    if (!monaco || !ed) return;
    const lang = path ? languageForPath(path) : HC12_LANGUAGE_ID;
    let model = modelRef.current;
    if (!model || lastPath.current !== path) {
      const old = model;
      model = monaco.editor.createModel(text, lang === 'plaintext' ? HC12_LANGUAGE_ID : lang);
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      modelRef.current = model;
      ed.setModel(model);
      old?.dispose();
      lastPath.current = path;
      const r = ed.getVisibleRanges()[0];
      propsRef.current.onTopLineChange?.(r?.startLineNumber ?? 1);
    } else if (model.getValue() !== text) {
      const vs = ed.saveViewState();
      model.setValue(text);
      if (vs) ed.restoreViewState(vs);
    }
    model.updateOptions({ tabSize });
  }, [monaco, text, path, tabSize]);

  // decorations
  useEffect(() => {
    const model = modelRef.current;
    if (!decoRef.current || !model) return;
    decoRef.current.set(sourceDecorations(model, { pcLine, breakpoints, codeLines: codeSet, showMarks }));
  }, [monaco, text, path, pcLine, breakpoints, codeSet, showMarks]);

  // follow the PC
  useEffect(() => {
    const ed = edRef.current;
    if (!ed || !followPc || !pcLine || !modelRef.current) return;
    ed.revealLineInCenterIfOutsideViewport(pcLine);
  }, [monaco, pcLine, path, followPc]);

  useImperativeHandle(
    ref,
    () => ({
      revealLine: (line, where = 'center') => {
        const ed = edRef.current;
        if (!ed) return;
        if (where === 'top') ed.revealLineNearTop(line);
        else if (where === 'nearest') ed.revealLine(line);
        else ed.revealLineInCenter(line);
      },
      getTopLine: () => edRef.current?.getVisibleRanges()[0]?.startLineNumber ?? 1,
      getCursorLine: () => edRef.current?.getPosition()?.lineNumber ?? 1,
      focus: () => edRef.current?.focus(),
      find: () => {
        const ed = edRef.current;
        if (!ed) return;
        ed.focus();
        void ed.getAction('actions.find')?.run();
      },
      gotoLine: (line) => {
        const ed = edRef.current;
        const model = ed?.getModel();
        if (!ed || !model) return;
        const l = Math.min(Math.max(1, line), model.getLineCount());
        ed.setPosition({ lineNumber: l, column: 1 });
        ed.revealLineInCenter(l);
        ed.focus();
      },
      getSelectedText: () => {
        const ed = edRef.current;
        const sel = ed?.getSelection();
        const model = ed?.getModel();
        return sel && model ? model.getValueInRange(sel) : '';
      },
      editor: () => edRef.current,
    }),
    [],
  );

  return (
    <div className="s12-source-view" data-testid={testId}>
      <div ref={hostRef} className="s12-source-host" />
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
});

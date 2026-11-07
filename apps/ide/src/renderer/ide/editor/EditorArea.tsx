/**
 * CodeWarrior source editor windows (ide.md §5): one Monaco editor showing the active document of a tab strip of
 * open files (one text model each), the CW editor-window toolbar (Interfaces / Functions / Document Settings pop-ups,
 * Path, modification icon), the "Line N  Col N" indicator, "save changes?" prompts, Go to Line, Find/Replace (Monaco
 * find widget), Find in Files with a Search Results pane, comment/uncomment.
 *
 * Driven by the `editor.*` IDE commands (../commands.ts), a ref (EditorAreaHandle), or getEditorArea() (bridge.ts).
 * Line endings: models always use '\n'; each document remembers the file's EOL (files.readText) and writes it back
 * (files.writeText), so CRLF files stay CRLF. Auto-indent is off, as in CodeWarrior's defaults.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { parseApiError, DEFAULT_SETTINGS, type EditorPrefs, type Eol } from '../../../shared/api';
import { useProject, useS12, useS12Event } from '../../common/s12';
import { commentLines, scanIncludes, scanLabels, type CommentMode, type TextSearchOptions } from '../../common/monaco/asmText';
import { languageForPath } from '../../common/monaco/hc12';
import { loadMonaco, useMonaco, type Monaco } from '../../common/monaco/loader';
import { CW_IDE_THEME, CW_PLAIN_THEME } from '../../common/monaco/themes';
import { useIdeCommand } from '../commands';
import { setEditorArea, type EditorAreaHandle } from './bridge';
import { baseName, dirName, isBinaryPath, isDirty, joinPath, samePath, visualColumn, type EditorDoc } from './documents';
import { useEditorModals } from './EditorDialogs';
import { EditorToolbar } from './EditorToolbar';
import { FindInFilesDialog, searchFiles, SearchResultsPane, type FindInFilesRequest, type SearchSummary } from './FindInFiles';
import { forwardMenuShortcuts } from './keys';
import './editor.css';

export type { EditorAreaHandle } from './bridge';

const SAVE_FILTERS = [
  { name: 'Assembly source', extensions: ['asm', 'inc', 's'] },
  { name: 'All files', extensions: ['*'] },
];

const LINE_NUMBERS_KEY = 's12.editor.lineNumbers';

function readLineNumbersPref(): boolean {
  try {
    return localStorage.getItem(LINE_NUMBERS_KEY) === '1';
  } catch {
    return false;
  }
}

/** App editor preferences (settings.editor) kept current. */
function useEditorPrefs(): EditorPrefs {
  const s12 = useS12();
  const [prefs, setPrefs] = useState<EditorPrefs>(DEFAULT_SETTINGS.editor);
  useEffect(() => {
    let live = true;
    void Promise.resolve(s12.settings.get())
      .then((s) => {
        if (live && s?.editor) setPrefs({ ...DEFAULT_SETTINGS.editor, ...s.editor });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [s12]);
  useS12Event('settings', 'changed', (s) => {
    if (s?.editor) setPrefs({ ...DEFAULT_SETTINGS.editor, ...s.editor });
  });
  return prefs;
}

/** Monaco options for a CodeWarrior-like editor. */
export function editorOptions(prefs: EditorPrefs, lineNumbers: boolean): MonacoNs.editor.IStandaloneEditorConstructionOptions {
  return {
    theme: prefs.syntaxColoring ? CW_IDE_THEME : CW_PLAIN_THEME,
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    fontLigatures: false,
    lineNumbers: lineNumbers ? 'on' : 'off',
    lineNumbersMinChars: 4,
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 6,
    minimap: { enabled: false },
    // CodeWarrior defaults: no auto-indent, no completion, no auto-closing
    autoIndent: 'none',
    formatOnType: false,
    formatOnPaste: false,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: 'off',
    parameterHints: { enabled: false },
    autoClosingBrackets: 'never',
    autoClosingQuotes: 'never',
    autoSurround: 'never',
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    renderLineHighlight: 'none',
    matchBrackets: 'near',
    scrollBeyondLastLine: false,
    stickyScroll: { enabled: false },
    guides: { indentation: false },
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    links: false,
    renderWhitespace: 'none',
    cursorBlinking: 'blink',
    automaticLayout: true,
    fixedOverflowWidgets: true,
    contextmenu: true,
    smoothScrolling: false,
    mouseWheelZoom: false,
    find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
  };
}

export interface EditorAreaProps {
  /** Called whenever the active document changes (the shell may show it in the title or status bar). */
  onActiveChange?: (path: string | null) => void;
}

export const EditorArea = forwardRef<EditorAreaHandle, EditorAreaProps>(function EditorArea({ onActiveChange }, ref) {
  const s12 = useS12();
  const project = useProject();
  const monaco = useMonaco();
  const prefs = useEditorPrefs();
  const [lineNumbers, setLineNumbersState] = useState(readLineNumbersPref);
  const { ask, modal } = useEditorModals();

  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const docsRef = useRef<EditorDoc[]>([]);
  const activeRef = useRef<string | null>(null);
  const pendingGoto = useRef(new Map<string, { line: number; column?: number }>());
  const savingRef = useRef(new Set<string>());
  const dirtyShown = useRef(new Map<string, boolean>());
  const counters = useRef({ key: 0, untitled: 0 });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** Last text copied, cut or pasted in the editor: Edit > Paste falls back to it when the system clipboard cannot be read. */
  const lastClipText = useRef<string | null>(null);
  /** Window-close guard state (beforeunload): a "save changes?" round is running / the close was confirmed. */
  const unloadGuard = useRef({ prompting: false, confirmed: false });

  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [fif, setFif] = useState<{ open: boolean; initial: Partial<FindInFilesRequest> }>({ open: false, initial: {} });
  const [results, setResults] = useState<{ summary: SearchSummary | null; busy: boolean } | null>(null);

  const docs = docsRef.current;
  const active = docs.find((d) => d.key === activeRef.current) ?? null;

  const activeDoc = () => docsRef.current.find((d) => d.key === activeRef.current) ?? null;

  const updateCursor = useCallback(() => {
    const ed = editorRef.current;
    const pos = ed?.getPosition();
    const model = ed?.getModel();
    if (!pos || !model) return;
    setCursor({ line: pos.lineNumber, col: visualColumn(model.getLineContent(pos.lineNumber), pos.column, prefsRef.current.tabSize) });
  }, []);

  /** Re-render when the active document's dirty state flips (not on every keystroke). */
  const checkDirty = useCallback(() => {
    let changed = false;
    for (const d of docsRef.current) {
      const v = isDirty(d);
      if (dirtyShown.current.get(d.key) !== v) {
        dirtyShown.current.set(d.key, v);
        changed = true;
      }
    }
    if (changed) bump();
  }, [bump]);

  const applyGoto = useCallback((doc: EditorDoc) => {
    const ed = editorRef.current;
    const g = pendingGoto.current.get(doc.key);
    if (!ed || !g || ed.getModel() !== doc.model) return;
    pendingGoto.current.delete(doc.key);
    const model = doc.model;
    const line = Math.min(Math.max(1, g.line), model.getLineCount());
    if (g.column) {
      ed.setPosition({ lineNumber: line, column: Math.max(1, g.column) });
    } else {
      // CodeWarrior selects the whole line when jumping to an error / search hit
      ed.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) });
    }
    ed.revealLineInCenter(line);
    ed.focus();
  }, []);

  /** Show a document in the editor (saves the previous one's view state). */
  const activate = useCallback(
    (key: string | null) => {
      const ed = editorRef.current;
      const prev = activeDoc();
      if (ed && prev && ed.getModel() === prev.model) prev.viewState = ed.saveViewState();
      activeRef.current = key;
      const doc = activeDoc();
      if (ed) {
        if (doc) {
          if (ed.getModel() !== doc.model) {
            ed.setModel(doc.model);
            if (doc.viewState) ed.restoreViewState(doc.viewState);
          }
          ed.updateOptions({ readOnly: doc.readOnly });
          applyGoto(doc);
          ed.focus();
        } else ed.setModel(null);
      }
      updateCursor();
      onActiveChange?.(doc?.path ?? null);
      bump();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyGoto, updateCursor, bump, onActiveChange],
  );

  // ---------------------------------------------------------------------------------------------- Monaco instance

  useEffect(() => {
    const host = hostRef.current;
    if (!monaco || !host) return;
    const ed = monaco.editor.create(host, { ...editorOptions(prefsRef.current, lineNumbers), model: null });
    editorRef.current = ed;
    const subs = [ed.onDidChangeCursorPosition(() => updateCursor()), ed.onDidChangeModelContent(() => checkDirty())];
    addEditorActions(monaco, ed, (m) => handleRef.current?.comment(m));
    const unforward = forwardMenuShortcuts(host);
    const onClip = (e: ClipboardEvent) => {
      const t = e.clipboardData?.getData('text/plain');
      if (t) lastClipText.current = t;
    };
    host.addEventListener('copy', onClip);
    host.addEventListener('cut', onClip);
    host.addEventListener('paste', onClip);
    const cur = activeRef.current;
    activeRef.current = null;
    activate(cur);
    return () => {
      for (const s of subs) s.dispose();
      unforward();
      host.removeEventListener('copy', onClip);
      host.removeEventListener('cut', onClip);
      host.removeEventListener('paste', onClip);
      ed.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !monaco) return;
    const o = editorOptions(prefs, lineNumbers);
    ed.updateOptions({ fontFamily: o.fontFamily, fontSize: o.fontSize, lineNumbers: o.lineNumbers });
    monaco.editor.setTheme(o.theme as string);
    for (const d of docsRef.current) d.model.updateOptions({ tabSize: prefs.tabSize, insertSpaces: prefs.insertSpaces });
    updateCursor();
  }, [monaco, prefs, lineNumbers, updateCursor]);

  const setLineNumbers = (v: boolean) => {
    setLineNumbersState(v);
    try {
      localStorage.setItem(LINE_NUMBERS_KEY, v ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
  };

  // ---------------------------------------------------------------------------------------------- documents

  const newModel = (m: Monaco, text: string, path: string | null): MonacoNs.editor.ITextModel => {
    const model = m.editor.createModel(text, path ? languageForPath(path) : 'hc12asm');
    model.setEOL(m.editor.EndOfLineSequence.LF);
    model.updateOptions({ tabSize: prefsRef.current.tabSize, insertSpaces: prefsRef.current.insertSpaces });
    return model;
  };

  const message = (title: string, text: string) => ask({ kind: 'message', title, text });

  const openFile = async (path: string, line?: number, column?: number): Promise<boolean> => {
    const existing = docsRef.current.find((d) => samePath(d.path, path));
    if (existing) {
      if (line) pendingGoto.current.set(existing.key, { line, column });
      activate(existing.key);
      return true;
    }
    if (isBinaryPath(path)) {
      await message('Open', `"${baseName(path)}" is not a text file and cannot be opened in the editor.`);
      return false;
    }
    let file;
    try {
      file = await s12.files.readText(path);
    } catch (e) {
      await message('Open', `Could not open "${baseName(path)}":\n${parseApiError(e).message}`);
      return false;
    }
    const m = await loadMonaco();
    const again = docsRef.current.find((d) => samePath(d.path, path)); // opened meanwhile
    if (again) return openFile(path, line, column);
    const model = newModel(m, file.text, file.path);
    const key = `d${++counters.current.key}`;
    const doc: EditorDoc = { key, path: file.path, name: baseName(file.path), model, eol: file.eol, savedEol: file.eol, savedVersion: model.getAlternativeVersionId(), mtimeMs: file.mtimeMs, readOnly: file.readOnly, viewState: null };
    docsRef.current = [...docsRef.current, doc];
    dirtyShown.current.set(key, false);
    if (line) pendingGoto.current.set(key, { line, column });
    activate(key);
    void Promise.resolve(s12.files.watch(file.path)).catch(() => undefined);
    void Promise.resolve(s12.files.addRecent(file.path)).catch(() => undefined);
    return true;
  };

  const newFile = () => {
    void loadMonaco().then((m) => {
      const key = `d${++counters.current.key}`;
      const model = newModel(m, '', null);
      const doc: EditorDoc = { key, path: null, name: `Untitled ${++counters.current.untitled}`, model, eol: 'crlf', savedEol: 'crlf', savedVersion: model.getAlternativeVersionId(), readOnly: false, viewState: null };
      docsRef.current = [...docsRef.current, doc];
      activate(key);
    });
  };

  const saveDoc = async (doc: EditorDoc, as = false): Promise<boolean> => {
    let path = doc.path;
    if (!path || as) {
      const def = doc.path ?? (project ? joinPath(joinPath(project.dir, 'Sources'), `${doc.name.replace(/\s+/g, '')}.asm`) : `${doc.name}.asm`);
      path = await s12.files.saveDialog({ title: as ? 'Save As' : 'Save', defaultPath: def, filters: SAVE_FILTERS });
      if (!path) return false;
    }
    const text = doc.model.getValue();
    const write = (expect?: number) => s12.files.writeText({ path: path!, text, eol: doc.eol, expectMtimeMs: expect });
    savingRef.current.add(path.toLowerCase());
    try {
      let r: { mtimeMs: number };
      try {
        r = await write(samePath(path, doc.path) ? doc.mtimeMs : undefined);
      } catch (e) {
        const err = parseApiError(e);
        if (err.code !== 'busy') throw e;
        const ok = await ask({ kind: 'confirm', title: 'Save', text: `"${baseName(path)}" was changed on disk since it was opened.\nOverwrite it with the editor's version?`, ok: 'Overwrite', cancel: 'Cancel' });
        if (!ok) return false;
        r = await write(undefined);
      }
      if (!samePath(path, doc.path)) {
        if (doc.path) void Promise.resolve(s12.files.unwatch(doc.path)).catch(() => undefined);
        void Promise.resolve(s12.files.watch(path)).catch(() => undefined);
        const m = await loadMonaco();
        const lang = languageForPath(path);
        if (doc.model.getLanguageId() !== 'plaintext' || lang === 'plaintext') m.editor.setModelLanguage(doc.model, lang);
        doc.path = path;
        doc.name = baseName(path);
        doc.readOnly = false;
        if (activeRef.current === doc.key) onActiveChange?.(path);
      }
      doc.mtimeMs = r.mtimeMs;
      doc.savedVersion = doc.model.getAlternativeVersionId();
      doc.savedEol = doc.eol;
      doc.external = undefined;
      checkDirty();
      bump();
      return true;
    } catch (e) {
      await message('Save', `Could not save "${baseName(path)}":\n${parseApiError(e).message}`);
      return false;
    } finally {
      // Change notices for our own write that arrive later carry the mtime just stored in doc.mtimeMs and are
      // recognised by it ('changed' handler), so a real outside change right after a save is not ignored.
      savingRef.current.delete(path.toLowerCase());
    }
  };

  const reloadDoc = async (doc: EditorDoc): Promise<boolean> => {
    if (!doc.path) return false;
    let f;
    try {
      f = await s12.files.readText(doc.path);
    } catch (e) {
      await message('Revert', `Could not read "${doc.name}":\n${parseApiError(e).message}`);
      return false;
    }
    const ed = editorRef.current;
    const isActive = ed?.getModel() === doc.model;
    const vs = isActive ? ed!.saveViewState() : doc.viewState;
    if (doc.model.getValue() !== f.text) {
      doc.model.setValue(f.text);
      if (isActive && vs) ed!.restoreViewState(vs);
    }
    doc.eol = f.eol;
    doc.savedEol = f.eol;
    doc.savedVersion = doc.model.getAlternativeVersionId();
    doc.mtimeMs = f.mtimeMs;
    doc.readOnly = f.readOnly;
    doc.external = undefined;
    if (isActive) ed!.updateOptions({ readOnly: f.readOnly });
    checkDirty();
    bump();
    return true;
  };

  const closeDoc = async (doc: EditorDoc): Promise<boolean> => {
    if (isDirty(doc)) {
      if (activeRef.current !== doc.key) activate(doc.key);
      const a = await ask({ kind: 'save', name: doc.name });
      if (a === 'cancel') return false;
      if (a === 'save' && !(await saveDoc(doc))) return false;
    }
    const list = docsRef.current;
    const i = list.indexOf(doc);
    if (i < 0) return true;
    const rest = list.filter((d) => d !== doc);
    docsRef.current = rest;
    dirtyShown.current.delete(doc.key);
    pendingGoto.current.delete(doc.key);
    if (activeRef.current === doc.key) {
      const next = rest[Math.min(i, rest.length - 1)] ?? null;
      activeRef.current = null; // do not save the closing document's view state
      if (editorRef.current?.getModel() === doc.model) editorRef.current.setModel(null);
      activate(next?.key ?? null);
    } else bump();
    doc.model.dispose();
    if (doc.path) void Promise.resolve(s12.files.unwatch(doc.path)).catch(() => undefined);
    return true;
  };

  // external changes (files.watch)
  useS12Event('files', 'changed', ({ path, kind, mtimeMs }) => void onDiskChange(path, kind, mtimeMs));
  const onDiskChange = async (path: string, kind: 'change' | 'delete', mtimeMs?: number) => {
    const doc = docsRef.current.find((d) => samePath(d.path, path));
    if (!doc || savingRef.current.has(path.toLowerCase())) return; // a save of ours is being written
    if (kind === 'delete') {
      doc.external = 'deleted';
      bump();
      return;
    }
    if (mtimeMs === undefined) mtimeMs = (await Promise.resolve(s12.files.stat(path)).catch(() => null))?.mtimeMs;
    if (mtimeMs !== undefined && doc.mtimeMs !== undefined && Math.abs(mtimeMs - doc.mtimeMs) <= 1) return; // our own save / unchanged
    if (!isDirty(doc)) {
      void reloadDoc(doc);
      return;
    }
    doc.external = 'changed';
    bump();
    void ask({ kind: 'confirm', title: 'File Changed', text: `"${doc.name}" was modified outside the editor.\nReload it and discard your changes?`, ok: 'Reload', cancel: 'Keep Mine' }).then((ok) => {
      if (ok) void reloadDoc(doc);
    });
  };

  // ---------------------------------------------------------------------------------------------- editing helpers

  const trigger = (id: string, focus = true) => {
    const ed = editorRef.current;
    if (!ed || !ed.getModel()) return;
    if (focus) ed.focus();
    const action = ed.getAction(id);
    if (action) void action.run();
    else ed.trigger('s12', id, null);
  };

  const comment = (mode: CommentMode = 'toggle') => {
    const ed = editorRef.current;
    const doc = activeDoc();
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!ed || !doc || !model || !sel || doc.readOnly) return;
    let end = sel.endLineNumber;
    if (end > sel.startLineNumber && sel.endColumn === 1) end--; // selection ending at column 1 excludes that line
    const lines: string[] = [];
    for (let l = sel.startLineNumber; l <= end; l++) lines.push(model.getLineContent(l));
    const out = commentLines(lines, mode);
    if (out.every((l, i) => l === lines[i])) return;
    const range = { startLineNumber: sel.startLineNumber, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) };
    ed.pushUndoStop();
    ed.executeEdits('s12-comment', [{ range, text: out.join('\n'), forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.setSelection({ startLineNumber: sel.startLineNumber, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) });
    ed.focus();
  };

  /**
   * Edit > Paste (menu / toolbar). Monaco's paste action needs the async clipboard API; main grants 'clipboard-read'
   * to the app's own windows, so text copied in other programs is read here. Falls back to the last text
   * copied/cut/pasted in the editor if the read fails (Ctrl+V always works: it is the native paste event).
   */
  const paste = async () => {
    const ed = editorRef.current;
    const doc = activeDoc();
    if (!ed || !doc || doc.readOnly) return;
    let text: string | null = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = null;
    }
    if (!text) text = lastClipText.current;
    if (!text || editorRef.current !== ed) return;
    ed.focus();
    ed.trigger('menu', 'paste', { text });
  };

  const gotoLine = async (line?: number) => {
    const doc = activeDoc();
    const ed = editorRef.current;
    if (!doc) return;
    let target: number | null | undefined = line;
    if (target === undefined) target = await ask({ kind: 'gotoLine', max: doc.model.getLineCount(), current: ed?.getPosition()?.lineNumber ?? 1 });
    if (target == null) return;
    pendingGoto.current.set(doc.key, { line: target });
    applyGoto(doc);
  };

  const runSearch = async (req: FindInFilesRequest) => {
    setFif((f) => ({ ...f, open: false, initial: req }));
    setResults({ summary: null, busy: true });
    const projectFiles = (project?.files ?? []).flatMap((f) => (f.path ? [f.path] : []));
    const openDocs = docsRef.current.flatMap((d) => (d.path ? [{ path: d.path, text: d.model.getValue() }] : []));
    const summary = await searchFiles(s12, req, { projectFiles, openDocs });
    setResults({ summary, busy: false });
  };

  const findInFiles = (query?: string, options?: TextSearchOptions) => {
    const sel = editorRef.current?.getSelection();
    const model = editorRef.current?.getModel();
    const selected = sel && model && sel.startLineNumber === sel.endLineNumber && !sel.isEmpty() ? model.getValueInRange(sel) : '';
    const folder = activeDoc()?.path ? dirName(activeDoc()!.path!) : project?.dir;
    setFif({ open: true, initial: { ...(query !== undefined ? { query } : selected ? { query: selected } : {}), ...options, ...(folder && !fif.initial.folder ? { folder } : {}) } });
  };

  // ---------------------------------------------------------------------------------------------- imperative API

  const handle: EditorAreaHandle = {
    openFile,
    newFile,
    save: async () => {
      const d = activeDoc();
      return d ? saveDoc(d) : false;
    },
    saveAs: async () => {
      const d = activeDoc();
      return d ? saveDoc(d, true) : false;
    },
    saveAll: async () => {
      let ok = true;
      for (const d of [...docsRef.current]) if (isDirty(d)) ok = (await saveDoc(d)) && ok;
      return ok;
    },
    revert: async () => {
      const d = activeDoc();
      if (!d?.path) return false;
      if (isDirty(d)) {
        const ok = await ask({ kind: 'confirm', title: 'Revert', text: `Revert "${d.name}" to the last saved version?\nAll changes will be lost.`, ok: 'Revert', cancel: 'Cancel' });
        if (!ok) return false;
      }
      return reloadDoc(d);
    },
    close: async (path) => {
      const d = path ? docsRef.current.find((x) => samePath(x.path, path)) : activeDoc();
      return d ? closeDoc(d) : true;
    },
    closeAll: async () => {
      for (const d of [...docsRef.current]) if (!(await closeDoc(d))) return false;
      return true;
    },
    find: () => trigger('actions.find'),
    findNext: () => trigger('editor.action.nextMatchFindAction'),
    findPrevious: () => trigger('editor.action.previousMatchFindAction'),
    replace: () => trigger('editor.action.startFindReplaceAction'),
    findInFiles,
    gotoLine: (line) => void gotoLine(line),
    comment,
    edit: (cmd) => {
      const ids: Record<typeof cmd, string> = {
        undo: 'undo',
        redo: 'redo',
        cut: 'editor.action.clipboardCutAction',
        copy: 'editor.action.clipboardCopyAction',
        paste: 'editor.action.clipboardPasteAction',
        selectAll: 'editor.action.selectAll',
        balance: 'editor.action.selectToBracket',
        shiftLeft: 'editor.action.outdentLines',
        shiftRight: 'editor.action.indentLines',
      };
      if (cmd === 'undo' || cmd === 'redo') {
        editorRef.current?.focus();
        editorRef.current?.trigger('s12', cmd, null);
      } else if (cmd === 'paste') void paste();
      else trigger(ids[cmd]);
    },
    focus: () => editorRef.current?.focus(),
    activePath: () => activeDoc()?.path ?? null,
    hasActiveDocument: () => activeDoc() !== null,
    openPaths: () => docsRef.current.flatMap((d) => (d.path ? [d.path] : [])),
    dirtyPaths: () => docsRef.current.filter(isDirty).map((d) => d.path ?? d.name),
    hasUnsavedChanges: () => docsRef.current.some(isDirty),
  };
  const handleRef = useRef(handle);
  handleRef.current = handle;
  // stable facade: a plain object with exactly the handle's methods, each calling the latest closure
  const facade = useMemo<EditorAreaHandle>(
    () =>
      Object.fromEntries(
        Object.keys(handleRef.current).map((k) => [k, (...a: unknown[]) => (handleRef.current[k as keyof EditorAreaHandle] as (...x: unknown[]) => unknown)(...a)]),
      ) as unknown as EditorAreaHandle,
    [],
  );
  useImperativeHandle(ref, () => facade, [facade]);
  useEffect(() => {
    setEditorArea(facade);
    return () => setEditorArea(null);
  }, [facade]);

  // Window close / quit with unsaved changes: cancel the close (Electron cancels silently on a prevented
  // beforeunload), ask "save changes?" per modified document (closeAll), then close the window for real.
  // The E2E harness quits the app forcibly, so the guard is off there unless a spec enables it (__s12UnloadGuard).
  const e2eRef = useRef(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve(s12.app.info())
      .then((i) => {
        if (live) e2eRef.current = !!i?.e2e;
      })
      .catch(() => undefined);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const g = unloadGuard.current;
      if (g.confirmed || !docsRef.current.some(isDirty)) return;
      if (e2eRef.current && !(globalThis as { __s12UnloadGuard?: boolean }).__s12UnloadGuard) return;
      e.preventDefault();
      e.returnValue = '';
      if (g.prompting) return;
      g.prompting = true;
      void handleRef.current
        .closeAll()
        .then((ok) => {
          if (!ok) return;
          g.confirmed = true;
          return Promise.resolve(s12.app.closeWindow());
        })
        .catch(() => undefined)
        .finally(() => {
          g.prompting = false;
        });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      live = false;
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [s12]);

  // IDE commands (menus, toolbar, project window, errors window)
  useIdeCommand('editor.open', ({ path, line, column }) => void facade.openFile(path, line, column));
  useIdeCommand('editor.save', () => void facade.save());
  useIdeCommand('editor.saveAs', () => void facade.saveAs());
  useIdeCommand('editor.saveAll', () => void facade.saveAll());
  useIdeCommand('editor.close', () => void facade.close());
  useIdeCommand('editor.revert', () => void facade.revert());
  useIdeCommand('editor.find', () => facade.find());
  useIdeCommand('editor.findNext', () => facade.findNext());
  useIdeCommand('editor.replace', () => facade.replace());
  useIdeCommand('editor.findInFiles', () => facade.findInFiles());
  useIdeCommand('editor.gotoLine', () => facade.gotoLine());
  useIdeCommand('editor.undo', () => facade.edit('undo'));
  useIdeCommand('editor.redo', () => facade.edit('redo'));
  useIdeCommand('editor.cut', () => facade.edit('cut'));
  useIdeCommand('editor.copy', () => facade.edit('copy'));
  useIdeCommand('editor.paste', () => facade.edit('paste'));
  useIdeCommand('editor.selectAll', () => facade.edit('selectAll'));
  useIdeCommand('editor.balance', () => facade.edit('balance'));
  useIdeCommand('editor.shiftLeft', () => facade.edit('shiftLeft'));
  useIdeCommand('editor.shiftRight', () => facade.edit('shiftRight'));
  useIdeCommand('editor.new', () => facade.newFile());
  useIdeCommand('editor.closeAll', () => void facade.closeAll());
  useIdeCommand('editor.findPrevious', () => facade.findPrevious());

  // ---------------------------------------------------------------------------------------------- render

  const dirty = active ? isDirty(active) : false;
  return (
    <div className="s12-editor-area" data-testid="editor-area">
      {docs.length > 0 && (
        <div className="s12-editor-tabs" role="tablist" data-testid="editor-tabs">
          {docs.map((d) => {
            const dd = isDirty(d);
            return (
              <div
                key={d.key}
                role="tab"
                aria-selected={d.key === activeRef.current}
                className={`s12-editor-tab${d.key === activeRef.current ? ' active' : ''}`}
                title={d.path ?? d.name}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    void closeDoc(d);
                  } else if (e.button === 0) activate(d.key);
                }}
                data-testid={`editor-tab-${d.name}`}
              >
                <span>{d.name + (dd ? ' *' : '')}</span>
                <button
                  type="button"
                  className="s12-editor-tab-close"
                  aria-label={`Close ${d.name}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void closeDoc(d)}
                >
                  {'×'}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="s12-editor-window" style={{ display: active ? 'flex' : 'none' }}>
        {active && (
          <EditorToolbar
            path={active.path}
            name={active.name}
            dirty={dirty}
            readOnly={active.readOnly}
            external={active.external}
            getLabels={() => scanLabels(active.model.getValue())}
            getIncludes={() => scanIncludes(active.model.getValue())}
            onGoto={(line, column) => {
              pendingGoto.current.set(active.key, { line, column });
              applyGoto(active);
            }}
            onOpenInclude={(f) => void openInclude(f)}
            syntaxColoring={active.model.getLanguageId() !== 'plaintext'}
            onSyntaxColoring={(on) => {
              // Syntax colouring on = the file's language, or HC12 assembly for other text files (.prm, .map ...)
              const lang = active.path ? languageForPath(active.path) : 'plaintext';
              monaco?.editor.setModelLanguage(active.model, on ? (lang === 'plaintext' ? 'hc12asm' : lang) : 'plaintext');
              bump();
            }}
            lineNumbers={lineNumbers}
            onLineNumbers={setLineNumbers}
            eol={active.eol}
            onEol={(eol: Eol) => {
              active.eol = eol;
              checkDirty();
              bump();
            }}
          />
        )}
        <div ref={hostRef} className="s12-monaco-host" data-testid="editor-monaco" />
        <div className="s12-editor-status" data-testid="editor-status">
          <span data-testid="editor-linecol">
            Line {cursor.line}&nbsp;&nbsp;&nbsp;Col {cursor.col}
          </span>
          <span style={{ flex: 1 }} />
          {active && <span>{active.eol === 'crlf' ? 'DOS' : 'Unix'}</span>}
          {active?.readOnly && <span>Read Only</span>}
        </div>
      </div>
      {!active && <div className="s12-mdi-empty" data-testid="editor-empty" />}
      {results && (
        <SearchResultsPane
          summary={results.summary}
          busy={results.busy}
          onOpen={(p, line, column) => void openFile(p, line, column)}
          onClose={() => setResults(null)}
        />
      )}
      <FindInFilesDialog
        open={fif.open}
        initial={fif.initial}
        hasProject={!!project}
        onFind={(req) => void runSearch(req)}
        onCancel={() => setFif((f) => ({ ...f, open: false }))}
        onBrowse={async () => (await s12.files.openDialog({ title: 'Find in Files: Folder', directory: true, defaultPath: project?.dir }))[0] ?? null}
      />
      {modal}
    </div>
  );

  async function openInclude(file: string) {
    const name = baseName(file.replace(/\\/g, '/'));
    const fromProject = project?.files.find((f) => f.path && samePath(baseName(f.path), name))?.path;
    const cur = activeDoc()?.path;
    const candidates = [fromProject, cur ? joinPath(dirName(cur), file) : undefined, project ? joinPath(project.dir, file) : undefined].filter((x): x is string => !!x);
    for (const c of candidates) {
      const st = await Promise.resolve(s12.files.stat(c)).catch(() => null);
      if (st?.isFile) {
        await openFile(c);
        return;
      }
    }
    await message('Interfaces', `Include file "${file}" was not found.`);
  }
});

/** Editor context-menu actions added to Monaco (comment / uncomment for assembly). */
function addEditorActions(m: Monaco, ed: MonacoNs.editor.IStandaloneCodeEditor, comment: (mode: CommentMode) => void): void {
  ed.addAction({ id: 's12.comment', label: 'Comment', contextMenuGroupId: '1_modification', contextMenuOrder: 10, run: () => comment('comment') });
  ed.addAction({ id: 's12.uncomment', label: 'Uncomment', contextMenuGroupId: '1_modification', contextMenuOrder: 11, run: () => comment('uncomment') });
  // UNCERTAIN: CodeWarrior has no default toggle-comment key; Ctrl+/ follows common editors.
  ed.addAction({ id: 's12.toggleComment', label: 'Toggle Comment', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.Slash], run: () => comment('toggle') });
}

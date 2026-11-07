/**
 * Small in-memory stand-in for the Monaco namespace (jsdom cannot run the editor widget). Implements the subset the
 * S12 Studio editor and Source view use: text models with line access and edits, an editor with model switching,
 * cursor/selection, reveal, actions/trigger, decorations, mouse/context-menu/scroll listeners.
 *
 *   const fake = createFakeMonaco();
 *   setMonacoLoader(() => Promise.resolve(fake.monaco));
 *   ... fake.editors[0].triggered, fake.editors[0].decorations(), fake.editors[0].fireMouseDown(...)
 */
import type { Monaco } from '../loader';

type Listener<T> = (e: T) => void;

class Emitter<T> {
  private ls = new Set<Listener<T>>();
  event = (l: Listener<T>) => {
    this.ls.add(l);
    return { dispose: () => this.ls.delete(l) };
  };
  fire(e: T) {
    for (const l of [...this.ls]) l(e);
  }
}

export interface FakeRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface FakePosition {
  lineNumber: number;
  column: number;
}

const selectionOf = (r: FakeRange) => ({ ...r, isEmpty: () => r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn, getPosition: () => ({ lineNumber: r.endLineNumber, column: r.endColumn }) });

let altCounter = 1;

export class FakeModel {
  lines: string[];
  altVersion = altCounter++;
  versionId = 1;
  eol = 0;
  options: Record<string, unknown> = {};
  disposed = false;
  readonly onContent = new Emitter<unknown>();
  constructor(
    text: string,
    public language: string,
  ) {
    this.lines = text.split(/\r?\n/);
  }
  getValue() {
    return this.lines.join('\n');
  }
  getValueLength() {
    return this.getValue().length;
  }
  setValue(t: string) {
    this.lines = t.split(/\r?\n/);
    this.bump();
  }
  private bump() {
    this.versionId++;
    this.altVersion = altCounter++;
    this.onContent.fire({});
  }
  getLineCount() {
    return this.lines.length;
  }
  getLineContent(l: number) {
    return this.lines[l - 1] ?? '';
  }
  getLinesContent() {
    return [...this.lines];
  }
  getLineMaxColumn(l: number) {
    return this.getLineContent(l).length + 1;
  }
  getAlternativeVersionId() {
    return this.altVersion;
  }
  getVersionId() {
    return this.versionId;
  }
  setEOL(e: number) {
    this.eol = e;
  }
  updateOptions(o: Record<string, unknown>) {
    Object.assign(this.options, o);
  }
  getLanguageId() {
    return this.language;
  }
  dispose() {
    this.disposed = true;
  }
  isDisposed() {
    return this.disposed;
  }
  onDidChangeContent(l: Listener<unknown>) {
    return this.onContent.event(l);
  }
  private offsetAt(p: FakePosition): number {
    let o = 0;
    for (let i = 0; i < p.lineNumber - 1; i++) o += this.lines[i].length + 1;
    return o + p.column - 1;
  }
  getValueInRange(r: FakeRange) {
    return this.getValue().slice(this.offsetAt({ lineNumber: r.startLineNumber, column: r.startColumn }), this.offsetAt({ lineNumber: r.endLineNumber, column: r.endColumn }));
  }
  getFullModelRange(): FakeRange {
    return { startLineNumber: 1, startColumn: 1, endLineNumber: this.lines.length, endColumn: this.getLineMaxColumn(this.lines.length) };
  }
  getWordAtPosition(p: FakePosition) {
    const line = this.getLineContent(p.lineNumber);
    const re = /[\w.$%@]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) if (m.index < p.column && p.column <= m.index + m[0].length + 1) return { word: m[0], startColumn: m.index + 1, endColumn: m.index + m[0].length + 1 };
    return null;
  }
  applyEdit(r: FakeRange, text: string) {
    const v = this.getValue();
    const a = this.offsetAt({ lineNumber: r.startLineNumber, column: r.startColumn });
    const b = this.offsetAt({ lineNumber: r.endLineNumber, column: r.endColumn });
    this.lines = (v.slice(0, a) + text + v.slice(b)).split('\n');
    this.bump();
  }
}

export interface FakeDecoration {
  range: FakeRange;
  options: Record<string, unknown>;
}

export class FakeEditor {
  model: FakeModel | null = null;
  options: Record<string, unknown>;
  position: FakePosition = { lineNumber: 1, column: 1 };
  selection: FakeRange = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  revealed: number[] = [];
  triggered: string[] = [];
  actions = new Map<string, { id: string; label: string; run: () => unknown; keybindings?: number[] }>();
  decorationSets: FakeDecoration[][] = [];
  focused = 0;
  topLine = 1;
  disposed = false;
  readonly cursor = new Emitter<unknown>();
  readonly content = new Emitter<unknown>();
  readonly mouseDown = new Emitter<unknown>();
  readonly contextMenu = new Emitter<unknown>();
  readonly scroll = new Emitter<unknown>();
  private modelSub: { dispose(): void } | null = null;
  readonly textarea: HTMLTextAreaElement;
  constructor(
    readonly host: HTMLElement,
    opts: Record<string, unknown>,
  ) {
    this.options = { ...opts };
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'inputarea';
    host.appendChild(this.textarea);
    if (opts.model) this.setModel(opts.model as FakeModel);
  }
  getModel() {
    return this.model;
  }
  setModel(m: FakeModel | null) {
    this.modelSub?.dispose();
    this.model = m;
    this.modelSub = m ? m.onDidChangeContent(() => this.content.fire({})) : null;
    this.position = { lineNumber: 1, column: 1 };
    this.selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  }
  updateOptions(o: Record<string, unknown>) {
    Object.assign(this.options, o);
  }
  getOption(k: string) {
    return this.options[k];
  }
  getPosition() {
    return this.model ? { ...this.position } : null;
  }
  setPosition(p: FakePosition) {
    this.position = { ...p };
    this.selection = { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column };
    this.cursor.fire({ position: p });
  }
  getSelection() {
    return this.model ? selectionOf(this.selection) : null;
  }
  setSelection(r: FakeRange) {
    this.selection = { ...r };
    this.position = { lineNumber: r.endLineNumber, column: r.endColumn };
    this.cursor.fire({ position: this.position });
  }
  revealLine(l: number) {
    this.revealed.push(l);
  }
  revealLineInCenter(l: number) {
    this.revealed.push(l);
  }
  revealLineNearTop(l: number) {
    this.revealed.push(l);
  }
  revealLineInCenterIfOutsideViewport(l: number) {
    this.revealed.push(l);
  }
  focus() {
    this.focused++;
  }
  hasTextFocus() {
    return this.focused > 0;
  }
  saveViewState() {
    return { position: { ...this.position }, selection: { ...this.selection } };
  }
  restoreViewState(vs: { position: FakePosition; selection: FakeRange } | null) {
    if (!vs) return;
    this.position = { ...vs.position };
    this.selection = { ...vs.selection };
  }
  onDidChangeCursorPosition(l: Listener<unknown>) {
    return this.cursor.event(l);
  }
  onDidChangeModelContent(l: Listener<unknown>) {
    return this.content.event(l);
  }
  onMouseDown(l: Listener<unknown>) {
    return this.mouseDown.event(l);
  }
  onContextMenu(l: Listener<unknown>) {
    return this.contextMenu.event(l);
  }
  onDidScrollChange(l: Listener<unknown>) {
    return this.scroll.event(l);
  }
  getVisibleRanges() {
    return [{ startLineNumber: this.topLine, startColumn: 1, endLineNumber: this.topLine + 30, endColumn: 1 }];
  }
  addAction(desc: { id: string; label: string; run: () => unknown; keybindings?: number[] }) {
    this.actions.set(desc.id, desc);
    return { dispose: () => this.actions.delete(desc.id) };
  }
  getAction(id: string) {
    const a = this.actions.get(id);
    return {
      id,
      run: async () => {
        this.triggered.push(id);
        await a?.run();
      },
    };
  }
  /** [command id, payload] of every trigger() call (e.g. 'paste' with { text }). */
  triggeredArgs: [string, unknown][] = [];
  trigger(_src: string, id: string, payload?: unknown) {
    this.triggered.push(id);
    this.triggeredArgs.push([id, payload]);
  }
  executeEdits(_src: string, edits: { range: FakeRange; text: string }[]) {
    for (const e of [...edits].reverse()) this.model?.applyEdit(e.range, e.text);
    return true;
  }
  pushUndoStop() {
    return true;
  }
  createDecorationsCollection(d: FakeDecoration[] = []) {
    this.decorationSets.push(d);
    const idx = this.decorationSets.length - 1;
    return {
      set: (n: FakeDecoration[]) => {
        this.decorationSets[idx] = n;
      },
      clear: () => {
        this.decorationSets[idx] = [];
      },
      get length() {
        return 0;
      },
    };
  }
  /** All current decorations (every collection). */
  decorations(): FakeDecoration[] {
    return this.decorationSets.flat();
  }
  layout() {}
  getDomNode() {
    return this.host;
  }
  dispose() {
    this.disposed = true;
    this.modelSub?.dispose();
    this.textarea.remove();
  }
  /** Simulate typing: replace the whole text (fires content listeners). */
  typeText(text: string) {
    this.model?.setValue(text);
  }
}

export interface FakeMonaco {
  monaco: Monaco;
  editors: FakeEditor[];
  models: FakeModel[];
  theme: () => string | null;
  languages: string[];
}

export const MOUSE_TARGET = { GUTTER_GLYPH_MARGIN: 2, GUTTER_LINE_NUMBERS: 3, GUTTER_LINE_DECORATIONS: 4, CONTENT_TEXT: 6 } as const;

export function createFakeMonaco(): FakeMonaco {
  const editors: FakeEditor[] = [];
  const models: FakeModel[] = [];
  const languages: string[] = [];
  let theme: string | null = null;
  const keyNum = new Proxy({} as Record<string, number>, { get: (_t, k) => (typeof k === 'string' ? k.length * 7 : 0) });
  const monaco = {
    editor: {
      create: (host: HTMLElement, opts: Record<string, unknown>) => {
        const e = new FakeEditor(host, opts);
        editors.push(e);
        if (typeof opts.theme === 'string') theme = opts.theme;
        return e;
      },
      createModel: (text: string, lang?: string) => {
        const m = new FakeModel(text, lang ?? 'plaintext');
        models.push(m);
        return m;
      },
      setModelLanguage: (m: FakeModel, lang: string) => {
        m.language = lang;
      },
      setTheme: (t: string) => {
        theme = t;
      },
      defineTheme: () => undefined,
      EndOfLineSequence: { LF: 0, CRLF: 1 },
      MouseTargetType: MOUSE_TARGET,
    },
    languages: {
      register: (l: { id: string }) => languages.push(l.id),
      setMonarchTokensProvider: () => ({ dispose() {} }),
      setLanguageConfiguration: () => ({ dispose() {} }),
    },
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
    KeyCode: keyNum,
  };
  return { monaco: monaco as unknown as Monaco, editors, models, theme: () => theme, languages };
}

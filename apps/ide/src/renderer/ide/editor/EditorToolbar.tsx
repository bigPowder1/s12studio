/**
 * CodeWarrior editor-window toolbar (ide.md §5): pop-up buttons, then "Path:" and the file-modification icon.
 *   h.  Interfaces: the INCLUDE files of this source (opens them)
 *   {}  Functions: the code labels (and sections/macros) of this file in file order; Ctrl+click sorts them
 *       alphabetically (CW), Shift+click lists every label incl. data and EQU constants (S12 Studio extension).
 *       UNCERTAIN: which assembly labels CodeWarrior lists here.
 *   M.  Markers: not implemented (no marker storage yet)
 *   #   Document Settings: syntax colouring, line numbers, line-ending format
 * UNCERTAIN: ide.md lists Interfaces ({}) and Functions (M); the CW editor icons from memory are h. = Interfaces,
 * {} = Functions, M. = Markers. The task brief also calls {} the function popup, so that is what is used here.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { MenuList, type ContextMenuState } from '../../common/menu/MenuBar';
import { SEP, type MenuEntry } from '../../common/menu/model';
import type { AsmInclude, AsmLabel, LabelKind } from '../../common/monaco/asmText';
import type { Eol } from '../../../shared/api';

export interface EditorToolbarProps {
  path: string | null;
  name: string;
  dirty: boolean;
  readOnly: boolean;
  external?: 'changed' | 'deleted';
  getLabels: () => AsmLabel[];
  getIncludes: () => AsmInclude[];
  onGoto: (line: number, column: number) => void;
  onOpenInclude: (file: string) => void;
  syntaxColoring: boolean;
  onSyntaxColoring: (v: boolean) => void;
  lineNumbers: boolean;
  onLineNumbers: (v: boolean) => void;
  eol: Eol;
  onEol: (eol: Eol) => void;
}

const KIND_MARK: Record<LabelKind, string> = { code: '', data: '  (data)', constant: '  (EQU)', section: '  (section)', macro: '  (macro)', label: '' };

export function EditorToolbar(p: EditorToolbarProps) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const at = (e: MouseEvent, items: MenuEntry[]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom, items });
  };
  const functions = (e: MouseEvent) => {
    let labels = p.getLabels();
    if (!e.shiftKey) labels = labels.filter((l) => l.kind === 'code' || l.kind === 'section' || l.kind === 'macro' || l.kind === 'label');
    if (e.ctrlKey) labels = [...labels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const items: MenuEntry[] = labels.length
      ? labels.map((l) => ({ id: `fn-${l.line}`, label: (l.name + KIND_MARK[l.kind]).replace(/&/g, '&&'), onSelect: () => p.onGoto(l.line, l.column) }))
      : [{ label: '(no labels)', disabled: true }];
    at(e, items);
  };
  const interfaces = (e: MouseEvent) => {
    const inc = p.getIncludes();
    at(e, inc.length ? inc.map((i) => ({ id: `inc-${i.line}`, label: i.file.replace(/&/g, '&&'), onSelect: () => p.onOpenInclude(i.file) })) : [{ label: '(no include files)', disabled: true }]);
  };
  const settings = (e: MouseEvent) =>
    at(e, [
      { id: 'doc-syntax', label: 'Syntax Coloring', checked: p.syntaxColoring, onSelect: () => p.onSyntaxColoring(!p.syntaxColoring) },
      { id: 'doc-lines', label: 'Line Numbers', checked: p.lineNumbers, onSelect: () => p.onLineNumbers(!p.lineNumbers) },
      SEP,
      { id: 'doc-crlf', label: 'Windows (CR/LF) Line Endings', checked: p.eol === 'crlf', disabled: p.readOnly, onSelect: () => p.onEol('crlf') },
      { id: 'doc-lf', label: 'Unix (LF) Line Endings', checked: p.eol === 'lf', disabled: p.readOnly, onSelect: () => p.onEol('lf') },
    ]);
  return (
    <div className="s12-editor-toolbar" data-testid="editor-toolbar">
      <button type="button" className="s12-popup-btn" title="Interfaces" onClick={interfaces} data-testid="editor-interfaces">
        h.
      </button>
      <button type="button" className="s12-popup-btn" title="Functions (Ctrl+click: alphabetical)" onClick={functions} data-testid="editor-functions">
        {'{ }'}
      </button>
      <button type="button" className="s12-popup-btn" title="Markers" disabled>
        M.
      </button>
      <button type="button" className="s12-popup-btn" title="Document Settings" onClick={settings} data-testid="editor-docsettings">
        #
      </button>
      <span className="s12-editor-path" title={p.path ?? p.name}>
        Path: {p.path ?? p.name}
      </span>
      {p.external && <span className="s12-editor-external">{p.external === 'deleted' ? 'File deleted on disk' : 'File changed on disk'}</span>}
      {p.readOnly && (
        <span title="Read-only" className="s12-editor-lock" data-testid="editor-readonly">
          <LockIcon />
        </span>
      )}
      <span title={p.dirty ? 'Modified' : 'Not modified'} className={`s12-editor-modified${p.dirty ? ' dirty' : ''}`} data-testid="editor-modified">
        <PencilIcon />
      </span>
      <PopupMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

/** Toolbar pop-up: like ContextMenu, but long lists (labels) scroll inside the window. */
export function PopupMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [state, onClose]);
  if (!state) return null;
  const maxHeight = Math.max(120, window.innerHeight - state.y - 8);
  return (
    <div ref={ref} style={{ position: 'fixed', left: Math.max(0, Math.min(state.x, window.innerWidth - 260)), top: state.y, zIndex: 3000 }}>
      <MenuList items={state.items} style={{ position: 'relative', maxHeight, overflowY: 'auto' }} onDone={onClose} showMnemonics={false} testId="context-menu" />
    </div>
  );
}

function PencilIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 14l1-4 8-8 3 3-8 8z" fill="currentColor" stroke="#000" strokeWidth={0.6} />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width={12} height={14} viewBox="0 0 12 14" aria-hidden>
      <rect x="1" y="6" width="10" height="7" fill="#c8a000" stroke="#000" strokeWidth={0.8} />
      <path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="#000" />
    </svg>
  );
}

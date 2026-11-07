/** Editor document bookkeeping (one Monaco text model per open file) and path helpers. */
import type * as Monaco from 'monaco-editor/editor/editor.api';
import type { Eol } from '../../../shared/api';

export interface EditorDoc {
  /** Stable key (tabs); survives Save As. */
  key: string;
  /** Real path; null for an untitled document (File > New Text File). */
  path: string | null;
  /** Window/tab title ("main.asm", "Untitled 1"). */
  name: string;
  model: Monaco.editor.ITextModel;
  /** Line ending written on save (the file's own; CodeWarrior files are CRLF). */
  eol: Eol;
  /** Model alternative version id at the last load/save (dirty = differs). */
  savedVersion: number;
  /** Line ending at the last load/save (an EOL change alone makes the document dirty). */
  savedEol: Eol;
  mtimeMs?: number;
  readOnly: boolean;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  /** Set when the file changed/was deleted on disk while the document had unsaved changes. */
  external?: 'changed' | 'deleted';
}

export const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
export const dirName = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}${dir.includes('\\') && !dir.includes('/') ? '\\' : '/'}${name}` : name);

/** Same file? (case-insensitive like Windows/CodeWarrior; separators normalised). */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
}

/** Files the editor refuses to open as text (object code / ELF). */
export function isBinaryPath(p: string): boolean {
  return /\.(abs|o|obj|lib|elf|exe|dll|mcp|phy|bin|png|jpg|gif|bmp|ico)$/i.test(p);
}

export function isDirty(d: EditorDoc): boolean {
  return d.model.getAlternativeVersionId() !== d.savedVersion || d.eol !== d.savedEol || (d.path === null && d.model.getValueLength() > 0);
}

/** Visual column (1-based) of a model column with tabs expanded (CodeWarrior's "Col" counts screen columns). */
export function visualColumn(lineText: string, column: number, tabSize: number): number {
  let v = 0;
  for (let i = 0; i < column - 1 && i < lineText.length; i++) v = lineText[i] === '\t' ? v + tabSize - (v % tabSize) : v + 1;
  return v + 1 + Math.max(0, column - 1 - lineText.length);
}

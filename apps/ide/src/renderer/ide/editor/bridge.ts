/**
 * Imperative API of the editor area (CodeWarrior editor windows). The IDE shell drives it through the `editor.*` IDE
 * commands (../commands.ts), a React ref on <EditorArea ref=...>, or `getEditorArea()` for code that cannot hold a
 * ref (e.g. Project > Compile asking for the active file).
 */
import type { CommentMode, TextSearchOptions } from '../../common/monaco/asmText';

export interface EditorAreaHandle {
  /** Open (or activate) a file; optionally go to a 1-based line/column. Resolves false when it could not be opened. */
  openFile(path: string, line?: number, column?: number): Promise<boolean>;
  /** File > New Text File. */
  newFile(): void;
  /** Save the active document (Save As for untitled ones). */
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  saveAll(): Promise<boolean>;
  /** Revert the active document to the saved file (asks first when modified). */
  revert(): Promise<boolean>;
  /** Close the active document or the given path ("save changes?" when modified). False = cancelled. */
  close(path?: string): Promise<boolean>;
  /** Close everything (window close / project close). False = cancelled. */
  closeAll(): Promise<boolean>;
  find(): void;
  findNext(): void;
  findPrevious(): void;
  replace(): void;
  /** Search > Find in Files (optionally pre-filled). */
  findInFiles(query?: string, options?: TextSearchOptions): void;
  /** Go to a line; without an argument shows the Go to Line dialog. */
  gotoLine(line?: number): void;
  comment(mode?: CommentMode): void;
  /** Edit menu commands routed to the focused document. */
  edit(cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'balance' | 'shiftLeft' | 'shiftRight'): void;
  focus(): void;
  activePath(): string | null;
  openPaths(): string[];
  dirtyPaths(): string[];
  hasUnsavedChanges(): boolean;
}

let current: EditorAreaHandle | null = null;

/** The mounted editor area (null when none). */
export function getEditorArea(): EditorAreaHandle | null {
  return current;
}

/** @internal EditorArea registers itself. */
export function setEditorArea(h: EditorAreaHandle | null): void {
  current = h;
}

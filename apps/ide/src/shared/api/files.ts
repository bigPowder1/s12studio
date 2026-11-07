/** Files API: native dialogs, text file read/write (editor), directory listing, watching, recent files. */

export interface FileFilter {
  name: string;
  /** Extensions without dot; ['*'] for all files. */
  extensions: string[];
}

export interface OpenDialogRequest {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
  multi?: boolean;
  /** Pick directories instead of files. */
  directory?: boolean;
}

export interface SaveDialogRequest {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export type Eol = 'crlf' | 'lf';

/** Byte encoding of a text file; Save writes a file back in the encoding it was read with. // added-by: engine */
export type TextEncodingName = 'windows-1252' | 'utf-8' | 'utf-8-bom'; // added-by: engine

export interface TextFile {
  path: string;
  /** Content with line endings normalised to '\n'. */
  text: string;
  /** Line ending found in the file (CodeWarrior files are CRLF). */
  eol: Eol;
  mtimeMs: number;
  readOnly: boolean;
  /** Encoding found in the file (ASCII / ANSI files are 'windows-1252', like CodeWarrior). */
  encoding?: TextEncodingName; // added-by: engine
}

export interface WriteTextRequest {
  path: string;
  /** '\n'-separated text. */
  text: string;
  /** Line ending to write (default 'crlf'). */
  eol?: Eol;
  /** Fail with 'busy' when the file's mtime differs (written by someone else since read). */
  expectMtimeMs?: number;
  /** Encoding to write (default: the file's encoding when read, else 'windows-1252'). */
  encoding?: TextEncodingName; // added-by: engine
}

export interface FileStatInfo {
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FilesApi {
  /** Returns chosen paths; [] when cancelled. */
  openDialog(req: OpenDialogRequest): Promise<string[]>;
  /** Returns the chosen path or null when cancelled. */
  saveDialog(req: SaveDialogRequest): Promise<string | null>;
  readText(path: string): Promise<TextFile>;
  writeText(req: WriteTextRequest): Promise<{ mtimeMs: number }>;
  stat(path: string): Promise<FileStatInfo | null>;
  readDir(path: string): Promise<DirEntry[]>;
  /** Show the file in the OS file manager ("Open in Windows Explorer"). */
  reveal(path: string): Promise<void>;
  /** Start watching a file; 'changed' events follow. Idempotent. */
  watch(path: string): Promise<void>;
  unwatch(path: string): Promise<void>;
  recent(): Promise<string[]>;
  addRecent(path: string): Promise<void>;
}

export interface FilesEvents {
  /** A watched file changed or was deleted on disk. */
  changed: { path: string; kind: 'change' | 'delete'; mtimeMs?: number };
  /**
   * A file should be opened in the IDE (command line, second instance, OS open-file). `.mcp` files are opened as
   * projects by main itself (project 'changed' follows); other files arrive here for the editor.
   */
  openRequest: { path: string; line?: number };
}

export const FILES_METHODS = ['openDialog', 'saveDialog', 'readText', 'writeText', 'stat', 'readDir', 'reveal', 'watch', 'unwatch', 'recent', 'addRecent'] as const;

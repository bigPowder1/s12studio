/**
 * The service container passed to IPC handlers. Everything Electron-specific (windows, dialogs, shell) sits behind
 * `WindowsPort` so handlers and services stay unit-testable in plain Node.
 */
import type { WindowKind } from '../shared/api/common';
import type { OpenDialogRequest, SaveDialogRequest } from '../shared/api/files';
import type { MessageBoxRequest, UpdateNotice } from '../shared/api/app';
import type { EventBus } from './events';
import type { BuildService } from './engine/build-service';
import type { DebugHost } from './engine/debug-host';
import type { FileWatchers } from './engine/file-watchers';
import type { ProjectService } from './engine/project-service';
import type { SettingsStore } from './engine/settings-store';
import type { TextFiles } from './engine/text-files';

export interface WindowsPort {
  /** The window's renderer subscribed to events: flush what was queued for it. */
  rendererReady(senderId: number): void;
  /** Create (or focus) the debugger window; resolves once its renderer has loaded. */
  openDebugger(): Promise<void>;
  focus(kind: WindowKind): Promise<void>;
  /** Show the ME3305 board window over the debugger (no-op without a debugger window); focus it when asked. */
  showBoard(focus: boolean): Promise<void>;
  close(senderId: number): void;
  minimize(senderId: number): void;
  toggleMaximize(senderId: number): void;
  setTitle(senderId: number, title: string): void;
  toggleDevTools(senderId: number): void;
  quit(): void;
  openExternal(url: string): Promise<void>;
  showOpenDialog(senderId: number, req: OpenDialogRequest): Promise<string[]>;
  showSaveDialog(senderId: number, req: SaveDialogRequest): Promise<string | null>;
  reveal(path: string): void;
}

export interface AppMeta {
  name: string;
  version: string;
  platform: string;
  electron: string;
  e2e: boolean;
  /** A blank_project copy was found in the templates folder (AppInfo.courseTemplate). */
  courseTemplate?: boolean;
  /** <userData>/templates (AppInfo.userTemplatesDir). */
  userTemplatesDir?: string;
}

/** Update service surface used by IPC (src/main/updates). */
export interface UpdatesPort {
  /** "Restart to update": quit normally, then install the downloaded update and relaunch. */
  requestRestart(): void;
  /** Latest notice sent to the IDE (null: none); app.info() hands it to windows that load later. */
  readonly notice: UpdateNotice | null;
}

/** Student conveniences behind app.prepareDemo / app.showMessage (src/main/index.ts; absent in tests). */
export interface StudentPort {
  /** Copy the demo project to Documents (once) and resolve to the copy's project file (engine/examples-dir.ts). */
  prepareDemo(): Promise<string>;
  /** Native message box over the window with this webContents id. */
  showMessage(senderId: number, req: MessageBoxRequest): Promise<void>;
}

export interface MainServices {
  bus: EventBus;
  projects: ProjectService;
  builds: BuildService;
  debug: DebugHost;
  settings: SettingsStore;
  watchers: FileWatchers;
  /** Editor text files (EOL memory). */
  textFiles: TextFiles;
  windows: WindowsPort;
  meta: AppMeta;
  /** {Compiler} root passed to debug sessions. */
  compilerDir?: string;
  /** Packaged-build updates (absent in tests). */
  updates?: UpdatesPort;
  /** Demo project + message boxes (absent in tests). */
  student?: StudentPort;
}

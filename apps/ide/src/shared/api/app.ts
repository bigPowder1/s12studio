/** App / window-level API: identity of the calling window, window control, quit. */
import type { WindowKind } from './common';

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  electron: string;
  /** Kind of the window that asked. */
  windowKind: WindowKind;
  /** True when started by the E2E harness (S12_E2E=1). */
  e2e: boolean;
  /**
   * A copy of the ME 3305 `blank_project` (a CodeWarrior project folder) was found in the templates folder, so
   * File > New... can list it. Undefined from older mains / test doubles: treat as available.
   */
  courseTemplate?: boolean;
  /** The per-user templates folder (<userData>/templates) where a blank_project copy is looked for (File > New...). */
  userTemplatesDir?: string;
  /** The latest update notice (the `update` event) for windows that (re)load after it was sent. */
  updateNotice?: UpdateNotice;
}

/**
 * A newer release was found (packaged builds only; see src/main/updates).
 *   downloaded  Windows / Linux AppImage: the update is downloaded and installs when the app quits;
 *               `app.installUpdate()` quits now (the usual save prompts) and restarts into the new version.
 *   available   macOS (ad-hoc signed builds cannot replace themselves) and other Linux packages: `url` is the release
 *               page to download from (open it with `app.openExternal`).
 */
export interface UpdateNotice {
  state: 'downloaded' | 'available';
  /** Version of the new release, without a leading "v" ("0.2.0"). */
  version: string;
  /** Release page (https). */
  url?: string;
}

/** A native message box over the calling window (app.showMessage). */
export interface MessageBoxRequest {
  type?: 'error' | 'warning' | 'info';
  /** Window title (default: the product name). */
  title?: string;
  message: string;
  /** Second paragraph (a path, the reason...). */
  detail?: string;
}

export interface AppApi {
  info(): Promise<AppInfo>;
  /**
   * The renderer has subscribed to its events: main flushes the events it queued for this window while it was
   * loading (command-line opens, a session started before the debugger window mounted...). Call once after mount.
   */
  ready(): Promise<void>;
  /** Close the calling window. */
  closeWindow(): Promise<void>;
  minimizeWindow(): Promise<void>;
  /** Toggle maximize of the calling window. */
  toggleMaximize(): Promise<void>;
  /** Set the calling window's title. */
  setTitle(title: string): Promise<void>;
  /** Bring a window kind to the front (opens the debugger window empty if it does not exist). */
  focusWindow(kind: 'ide' | 'debugger'): Promise<void>;
  /**
   * Show the ME3305 board window (a separate window that floats over the debugger; created on first use, closed with
   * the debugger). `focus` brings it to the front and focuses it; otherwise it is shown without taking focus. Does
   * nothing without a debugger window.
   */
  showBoard(opts?: { focus?: boolean }): Promise<void>;
  toggleDevTools(): Promise<void>;
  /** File > Exit in either window. */
  quit(): Promise<void>;
  /** Open an http(s) URL in the system browser (Help > Website). */
  openExternal(url: string): Promise<void>;
  /** Quit (with the usual "save changes?" prompts) and restart into a downloaded update (UpdateNotice 'downloaded'). */
  installUpdate(): Promise<void>;
  /**
   * The demo project (examples/blinky) in a writable place: copies the installed demo to
   * <Documents>/S12 Studio/Demo (blinky) unless a copy is there, and resolves to the copy's project file (open it with
   * project.open). Errors: 'not-found' when the demo is not installed, 'io' when the copy fails.
   */
  prepareDemo(): Promise<string>;
  /** Show a native message box over the calling window; resolves when it is dismissed. */
  showMessage(req: MessageBoxRequest): Promise<void>;
}

export interface AppEvents {
  /** Window focus changed (component menus/shortcuts can react). */
  focus: { focused: boolean };
  /** Main asks the renderer to run a menu command (native menu / accelerator fallback). */
  command: { command: string };
  /** A newer release is available or downloaded (sent to the IDE window). */
  update: UpdateNotice;
}

export const APP_METHODS = ['info', 'ready', 'closeWindow', 'minimizeWindow', 'toggleMaximize', 'setTitle', 'focusWindow', 'showBoard', 'toggleDevTools', 'quit', 'openExternal', 'installUpdate', 'prepareDemo', 'showMessage'] as const;

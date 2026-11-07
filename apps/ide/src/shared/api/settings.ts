/**
 * Settings API: application preferences (stored as JSON in Electron userData) and raw access to the open project's
 * sidecar ('<name>.s12studio.json'; structured edits go through ProjectApi).
 */

export interface EditorPrefs {
  fontFamily: string;
  fontSize: number;
  tabSize: number;
  /** Insert spaces instead of tabs. */
  insertSpaces: boolean;
  syntaxColoring: boolean;
}

export interface DebuggerPrefs {
  pacing: 'true-time' | 'max';
  speedFactor: number;
  /** Snapshot rate while running (Hz). */
  snapshotHz: number;
  /** Map the PC keyboard to the ME305 keypad when the board component has focus. */
  keyboardToKeypad: boolean;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface AppSettings {
  version: 1;
  showStartupDialog: boolean;
  recentProjects: string[];
  recentFiles: string[];
  editor: EditorPrefs;
  debugger: DebuggerPrefs;
  windows: { ide?: WindowBounds; debugger?: WindowBounds };
}

/** Deep-partial patch for AppSettings (arrays are replaced). */
export type AppSettingsPatch = {
  [K in keyof AppSettings]?: AppSettings[K] extends unknown[] ? AppSettings[K] : AppSettings[K] extends object ? Partial<AppSettings[K]> : AppSettings[K];
};

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  showStartupDialog: true,
  recentProjects: [],
  recentFiles: [],
  editor: { fontFamily: "'Courier New', Courier, monospace", fontSize: 13, tabSize: 8, insertSpaces: false, syntaxColoring: true },
  debugger: { pacing: 'true-time', speedFactor: 1, snapshotHz: 30, keyboardToKeypad: true },
  windows: {},
};

export interface SettingsApi {
  get(): Promise<AppSettings>;
  update(patch: AppSettingsPatch): Promise<AppSettings>;
  /** Raw sidecar JSON of the open project (null without a project). */
  sidecar(): Promise<unknown | null>;
}

export interface SettingsEvents {
  changed: AppSettings;
}

export const SETTINGS_METHODS = ['get', 'update', 'sidecar'] as const;

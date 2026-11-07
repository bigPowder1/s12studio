/**
 * The window.s12 contract: one namespace per domain. Each namespace = the domain's request methods + `on(event, cb)`.
 *
 *   const s12 = useS12();                       // renderer (src/renderer/common/s12)
 *   const info = await s12.project.open(path);
 *   const off = s12.debug.on('snapshot', (snap) => ...);
 */
import type { AssertComplete, EventSource } from './common';
import { APP_METHODS, type AppApi, type AppEvents } from './app';
import { BOARD_METHODS, type BoardApi, type BoardEvents } from './board';
import { BUILD_METHODS, type BuildApi, type BuildEvents } from './build';
import { DEBUG_METHODS, type DebugApi, type DebugEvents } from './debug';
import { FILES_METHODS, type FilesApi, type FilesEvents } from './files';
import { LAYOUT_METHODS, type LayoutApi, type LayoutEvents } from './layout';
import { PROJECT_METHODS, type ProjectApi, type ProjectEvents } from './project';
import { SETTINGS_METHODS, type SettingsApi, type SettingsEvents } from './settings';

export * from './common';
export * from './app';
export * from './files';
export * from './project';
export * from './build';
export * from './debug';
export * from './board';
export * from './layout';
export * from './settings';

/** Domain -> request API. */
export interface S12Methods {
  app: AppApi;
  files: FilesApi;
  project: ProjectApi;
  build: BuildApi;
  debug: DebugApi;
  board: BoardApi;
  layout: LayoutApi;
  settings: SettingsApi;
}

/** Domain -> event map. */
export interface S12Events {
  app: AppEvents;
  files: FilesEvents;
  project: ProjectEvents;
  build: BuildEvents;
  debug: DebugEvents;
  board: BoardEvents;
  layout: LayoutEvents;
  settings: SettingsEvents;
}

export type Domain = keyof S12Methods;

/** The object the preload exposes as `window.s12`. */
export type S12Api = { [D in Domain]: S12Methods[D] & EventSource<S12Events[D]> };

/** Method names per domain (preload bridge + main registration check). */
export const API_METHODS = {
  app: APP_METHODS,
  files: FILES_METHODS,
  project: PROJECT_METHODS,
  build: BUILD_METHODS,
  debug: DEBUG_METHODS,
  board: BOARD_METHODS,
  layout: LAYOUT_METHODS,
  settings: SETTINGS_METHODS,
} as const satisfies { [D in Domain]: readonly (keyof S12Methods[D])[] };

export const DOMAINS = Object.keys(API_METHODS) as Domain[];

// Compile-time completeness: every interface method is listed (a missing name makes these `true` checks fail).
type Check<T extends true> = T;
export type _MethodListsComplete = [
  Check<AssertComplete<AppApi, typeof APP_METHODS>>,
  Check<AssertComplete<FilesApi, typeof FILES_METHODS>>,
  Check<AssertComplete<ProjectApi, typeof PROJECT_METHODS>>,
  Check<AssertComplete<BuildApi, typeof BUILD_METHODS>>,
  Check<AssertComplete<DebugApi, typeof DEBUG_METHODS>>,
  Check<AssertComplete<BoardApi, typeof BOARD_METHODS>>,
  Check<AssertComplete<LayoutApi, typeof LAYOUT_METHODS>>,
  Check<AssertComplete<SettingsApi, typeof SETTINGS_METHODS>>,
];

declare global {
  interface Window {
    /** Typed preload bridge (src/preload/index.ts). Absent in plain-browser previews/tests unless mocked. */
    s12: S12Api;
  }
}

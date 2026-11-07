/**
 * Release identity read from the app's own package.json (apps/ide/package.json; inside app.asar when packaged).
 * ONE configuration point for packaging and runtime:
 *   "s12studio": { "appId": ... }   electron-builder appId == Windows AppUserModelID (taskbar grouping, notifications)
 *   "repository"                    GitHub repository whose Releases feed the updater (CI rewrites it from
 *                                   GITHUB_REPOSITORY through electron-builder extraMetadata; docs/RELEASING.md)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** UNCERTAIN: the department decides the final reverse-DNS id; change it in apps/ide/package.json "s12studio.appId". */
export const DEFAULT_APP_ID = 'edu.calpoly.s12studio';

export interface AppPackage {
  appId: string;
  /** package.json "repository" as written (string or { url }). */
  repository: unknown;
}

export function readAppPackage(appPath: string): AppPackage {
  try {
    const pkg = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as { s12studio?: { appId?: unknown }; repository?: unknown };
    const id = pkg.s12studio?.appId;
    return { appId: typeof id === 'string' && id ? id : DEFAULT_APP_ID, repository: pkg.repository };
  } catch {
    return { appId: DEFAULT_APP_ID, repository: undefined };
  }
}

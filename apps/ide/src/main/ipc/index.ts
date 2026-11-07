/** Registers every domain's handlers on a router. */
import type { MainServices } from '../services';
import { appHandlers } from './handlers/app';
import { buildHandlers } from './handlers/build';
import { boardHandlers, debugHandlers } from './handlers/debug';
import { filesHandlers } from './handlers/files';
import { layoutHandlers } from './handlers/layout';
import { projectHandlers } from './handlers/project';
import { settingsHandlers } from './handlers/settings';
import { IpcRouter } from './router';

export function createRouter(s: MainServices): IpcRouter {
  const r = new IpcRouter();
  r.register('app', appHandlers(s));
  r.register('files', filesHandlers(s));
  r.register('project', projectHandlers(s));
  r.register('build', buildHandlers(s));
  r.register('debug', debugHandlers(s));
  r.register('board', boardHandlers(s));
  r.register('layout', layoutHandlers(s));
  r.register('settings', settingsHandlers(s));
  const missing = r.missing();
  if (missing.length) throw new Error(`IPC handlers missing for: ${missing.join(', ')}`);
  return r;
}

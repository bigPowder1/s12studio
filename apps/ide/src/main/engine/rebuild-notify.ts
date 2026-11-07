/**
 * Rebuild while debugging: after a Make that relinked the application the debug session has loaded, tell the
 * windows (`debug.applicationRebuilt`) so the debugger can offer to reload it.
 */
import type { BuildResultInfo } from '../../shared/api/build';
import type { SessionInfo } from '../../shared/api/debug';
import type { EventBus } from '../events';
import type { DebugHost } from './debug-host';

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

/** Returns true when the notice was sent. */
export async function notifyRebuild(debug: Pick<DebugHost, 'running' | 'call'>, bus: EventBus, r: BuildResultInfo): Promise<boolean> {
  if (!r.ok || !r.linked || !r.absPath || !debug.running) return false;
  const sess = (await debug.call('debug.session', []).catch(() => null)) as SessionInfo | null;
  if (!sess?.absPath || norm(sess.absPath) !== norm(r.absPath)) return false;
  bus.emit('debug', 'applicationRebuilt', { absPath: sess.absPath, target: r.target });
  return true;
}

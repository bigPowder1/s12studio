/**
 * Debug engine worker thread entry (built to out/main/debug-worker.js, started by src/main/engine/debug-host.ts).
 * The simulator's run loop lives here so true-time simulation never blocks the main process or the UI.
 */
import { parentPort } from 'node:worker_threads';
import { parseApiError } from '../shared/api/common';
import { ApiError } from '../shared/api/common';
import { DebugEngine } from './engine';
import type { FromWorker, ToWorker } from './protocol';

if (!parentPort) throw new Error('debug-worker must run in a worker thread');
const port = parentPort;

const post = (m: FromWorker): void => port.postMessage(m);

const engine = new DebugEngine((domain, event, payload) => post({ type: 'event', domain, event, payload }));

port.on('message', async (m: ToWorker) => {
  if (m.type === 'dispose') {
    await engine.dispose();
    process.exit(0);
  }
  if (m.type !== 'call') return;
  try {
    const value = await engine.call(m.method, m.args);
    post({ type: 'result', id: m.id, ok: true, value });
  } catch (e) {
    const err = e instanceof ApiError ? { code: e.code, message: e.message } : parseApiError(e);
    post({ type: 'result', id: m.id, ok: false, error: err });
  }
});

post({ type: 'ready' });

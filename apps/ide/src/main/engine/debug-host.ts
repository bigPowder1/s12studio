/**
 * DebugHost: main-side proxy of the debug engine worker thread. Starts the worker lazily, correlates calls, relays
 * the worker's events to the EventBus (to the debugger window), and restarts after a crash.
 */
import { Worker } from 'node:worker_threads';
import { ApiError } from '../../shared/api/common';
import type { FromWorker, ToWorker } from '../../worker/protocol';
import type { EventBus } from '../events';

/** Minimal Worker surface (lets tests substitute an in-process fake). */
export interface WorkerLike {
  postMessage(m: ToWorker): void;
  on(event: 'message', fn: (m: FromWorker) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  on(event: 'exit', fn: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export class DebugHost {
  private worker: WorkerLike | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  constructor(
    private readonly bus: EventBus,
    /** Creates the worker; default spawns `workerPath` with worker_threads. */
    private readonly spawn: () => WorkerLike,
  ) {}

  static forScript(bus: EventBus, workerPath: string): DebugHost {
    return new DebugHost(bus, () => new Worker(workerPath) as unknown as WorkerLike);
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const w = this.spawn();
    this.worker = w;
    this.ready = new Promise<void>((resolve, reject) => {
      w.on('message', (m: FromWorker) => {
        switch (m.type) {
          case 'ready':
            resolve();
            break;
          case 'result': {
            const p = this.pending.get(m.id);
            if (!p) break;
            this.pending.delete(m.id);
            if (m.ok) p.resolve(m.value);
            else p.reject(new ApiError(m.error.code, m.error.message));
            break;
          }
          case 'event':
            this.bus.emitRaw(m.domain, m.event, m.payload, 'debugger');
            break;
        }
      });
      w.on('error', (e: Error) => {
        reject(e);
        this.crashed(`debug engine error: ${e.message}`);
      });
      w.on('exit', (code: number) => {
        if (this.worker === w) this.crashed(`debug engine exited (code ${code})`);
      });
    });
    return this.ready;
  }

  private crashed(message: string): void {
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) p.reject(new ApiError('internal', message));
    this.pending.clear();
    this.bus.emit('debug', 'engineError', { message }, 'debugger');
    this.bus.emit('debug', 'session', null, 'debugger');
  }

  /** Call `<domain>.<method>` in the worker. */
  async call(method: string, args: unknown[] = []): Promise<unknown> {
    await this.start();
    const w = this.worker;
    if (!w) throw new ApiError('internal', 'debug engine is not running');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ type: 'call', id, method, args });
    });
  }

  get running(): boolean {
    return this.worker !== null;
  }

  async dispose(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.ready = null;
    if (!w) return;
    try {
      w.postMessage({ type: 'dispose' });
    } catch {
      // already gone
    }
    await Promise.race([w.terminate(), new Promise((r) => setTimeout(r, 1000))]);
  }
}

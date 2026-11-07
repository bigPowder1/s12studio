import { describe, expect, it } from 'vitest';
import { EventBus } from '../events';
import { DebugHost, type WorkerLike } from './debug-host';
import type { FromWorker, ToWorker } from '../../worker/protocol';

/** In-process fake worker: answers 'echo' calls, fails others, can emit events / crash. */
function fakeWorker() {
  const handlers: Record<string, ((x: never) => void)[]> = {};
  const fire = (ev: string, x: unknown) => handlers[ev]?.forEach((h) => h(x as never));
  const w: WorkerLike & { emit(m: FromWorker): void; crash(): void; terminated: boolean } = {
    terminated: false,
    postMessage(m: ToWorker) {
      if (m.type !== 'call') return;
      queueMicrotask(() =>
        fire('message', m.method === 'debug.echo' ? { type: 'result', id: m.id, ok: true, value: m.args } : { type: 'result', id: m.id, ok: false, error: { code: 'not-implemented', message: m.method } }),
      );
    },
    on(ev: string, fn: (x: never) => void) {
      (handlers[ev] ??= []).push(fn);
      if (ev === 'message') queueMicrotask(() => fire('message', { type: 'ready' }));
      return w;
    },
    async terminate() {
      w.terminated = true;
      return 0;
    },
    emit: (m: FromWorker) => fire('message', m),
    crash: () => fire('exit', 1),
  } as never;
  return w;
}

describe('DebugHost', () => {
  it('correlates calls, maps errors, relays events to the debugger window, recovers from a crash', async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.attach((d, e, p, to) => seen.push([d, e, p, to]));
    let w = fakeWorker();
    let spawned = 0;
    const host = new DebugHost(bus, () => {
      spawned++;
      return (w = fakeWorker());
    });
    expect(await host.call('debug.echo', [1, 'a'])).toEqual([1, 'a']);
    await expect(host.call('debug.other')).rejects.toMatchObject({ code: 'not-implemented', message: 'debug.other' });
    w.emit({ type: 'event', domain: 'debug', event: 'running', payload: { kind: 'go' } });
    expect(seen).toContainEqual(['debug', 'running', { kind: 'go' }, 'debugger']);
    w.crash();
    expect(seen).toContainEqual(['debug', 'engineError', { message: 'debug engine exited (code 1)' }, 'debugger']);
    expect(await host.call('debug.echo', [2])).toEqual([2]);
    expect(spawned).toBe(2);
    await host.dispose();
    expect(w.terminated).toBe(true);
  });
});

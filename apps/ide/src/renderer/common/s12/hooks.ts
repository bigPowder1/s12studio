/**
 * React hooks over window.s12. How components subscribe:
 *   - useDebugSnapshot()          latest DebugSnapshot (registers, cycles, run state; ~30 Hz while running)
 *   - usePreviousHaltSnapshot()   snapshot of the halt before the current one ("changed values in red")
 *   - useMemoryWatch(ranges)      watched memory blocks, refreshed with every snapshot
 *   - useSession() / useBoardState() / useProject()
 *   - useS12Event(domain, event, cb)   any other event (output, breakpoints, uiCommand, build messages...)
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { BoardState, DebugSnapshot, Domain, MemoryBlockInfo, MemoryRange, ProjectInfo, S12Events, SessionInfo } from '../../../shared/api';
import { useS12, useS12Store } from './context';

export function useS12Event<D extends Domain, E extends keyof S12Events[D] & string>(domain: D, event: E, listener: (payload: S12Events[D][E]) => void): void {
  const api = useS12();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    const ns = api[domain] as unknown as { on: (e: string, l: (p: unknown) => void) => () => void };
    return ns.on(event, (p) => ref.current(p as S12Events[D][E]));
  }, [api, domain, event]);
}

export function useDebugSnapshot(): DebugSnapshot {
  const c = useS12Store().snapshot;
  return useSyncExternalStore(c.subscribe, c.get, c.get);
}

export function usePreviousHaltSnapshot(): DebugSnapshot | null {
  const c = useS12Store().previousHaltSnapshot;
  return useSyncExternalStore(c.subscribe, c.get, c.get);
}

export function useSession(): SessionInfo | null {
  const store = useS12Store();
  const api = useS12();
  const c = store.session;
  useEffect(() => {
    // pull once: the session may have started before this window subscribed
    let live = true;
    void api.debug.session().then((s) => live && s && !c.value && c.set(s), () => undefined);
    return () => {
      live = false;
    };
  }, [api, c]);
  return useSyncExternalStore(c.subscribe, c.get, c.get);
}

export function useBoardState(): BoardState | null {
  const c = useS12Store().board;
  return useSyncExternalStore(c.subscribe, c.get, c.get);
}

export function useProject(): ProjectInfo | null {
  const store = useS12Store();
  const api = useS12();
  const c = store.project;
  useEffect(() => {
    let live = true;
    void api.project.current().then((p) => live && p && !c.value && c.set(p), () => undefined);
    return () => {
      live = false;
    };
  }, [api, c]);
  return useSyncExternalStore(c.subscribe, c.get, c.get);
}

const rangesKey = (r: readonly MemoryRange[]) => r.map((x) => `${x.space ?? 'local'}:${x.address}:${x.length}`).join(',');

/**
 * Watch memory ranges: the engine includes them in every snapshot (immediately when halted, ~30 Hz while running).
 * Returns the blocks (same order as `ranges`) or null until the first snapshot that has them.
 */
export function useMemoryWatch(ranges: readonly MemoryRange[]): MemoryBlockInfo[] | null {
  const api = useS12();
  const id = `mem${useId()}`;
  const key = rangesKey(ranges);
  const snap = useDebugSnapshot();
  const session = useSession();
  useEffect(() => {
    if (!session) return;
    void api.debug.watchMemory(id, [...ranges]).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id, key, session]);
  useEffect(() => () => void api.debug.unwatchMemory(id).catch(() => undefined), [api, id]);
  const blocks = snap.memory[id];
  return blocks && rangesKey(blocks.map((b) => ({ address: b.address, length: b.bytes.length, space: b.space }))) === key ? blocks : null;
}

/** Re-render every `ms` (cheap timers for blinking cursors etc.). */
export function useTicker(ms: number, enabled = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const h = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(h);
  }, [ms, enabled]);
  return n;
}

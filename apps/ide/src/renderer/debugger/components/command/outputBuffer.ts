/**
 * Command window output, buffered per window from the moment the renderer loads: STARTUP / POSTLOAD command-file
 * output and FCS warnings arrive (as `debug.output` events) before the Command component is mounted by the layout,
 * and must still be shown. One buffer per api object; Cache Size (CACHESIZE, default 1000 lines) caps it.
 */
import { useSyncExternalStore } from 'react';
import type { OutputLineInfo, S12Api } from '../../../../shared/api';

export interface BufferedLine extends OutputLineInfo {
  id: number;
}

type Listener = () => void;

/**
 * Shown (Command window + status bar) when Make relinked the application loaded in the session: the debugger keeps
 * running the old code (and its symbols/source) until it is loaded again.
 * UNCERTAIN: hiwave's own reaction to a rebuild while it is open is unverified; CodeWarrior's Project > Debug (F5)
 * reloads the new .abs into the open debugger, which is what this points the user to.
 */
export function rebuiltNotice(absPath: string): string {
  const name = absPath.split(/[\\/]/).pop() || absPath;
  return `${name} was rebuilt. Project > Debug (F5) in the IDE or File > Load Application... loads the new code.`;
}

export class OutputBuffer {
  private lines: BufferedLine[] = [];
  private nextId = 1;
  private listeners = new Set<Listener>();
  cacheSize = 1000;

  constructor(api: S12Api) {
    api.debug.on('output', (l) => this.push(l));
    api.debug.on('clearOutput', () => this.clear());
    api.debug.on('applicationRebuilt', (r) => this.push([{ text: rebuiltNotice(r.absPath), kind: 'warning' }]));
  }

  push(lines: readonly OutputLineInfo[]): void {
    if (!lines.length) return;
    const add = lines.map((l) => ({ text: l.text, kind: l.kind, id: this.nextId++ }));
    this.lines = [...this.lines, ...add].slice(-this.cacheSize);
    this.notify();
  }

  clear(): void {
    this.lines = [];
    this.notify();
  }

  setCacheSize(n: number): void {
    this.cacheSize = Math.max(10, n);
    if (this.lines.length > this.cacheSize) {
      this.lines = this.lines.slice(-this.cacheSize);
      this.notify();
    }
  }

  get = (): BufferedLine[] => this.lines;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

const buffers = new WeakMap<S12Api, OutputBuffer>();

export function outputBufferFor(api: S12Api): OutputBuffer {
  let b = buffers.get(api);
  if (!b) buffers.set(api, (b = new OutputBuffer(api)));
  return b;
}

export function useOutputLines(api: S12Api): BufferedLine[] {
  const b = outputBufferFor(api);
  return useSyncExternalStore(b.subscribe, b.get, b.get);
}

// In the app, start buffering as soon as this module loads (the registry imports it at startup).
try {
  const api = (globalThis as { s12?: S12Api }).s12;
  if (api?.debug?.on) outputBufferFor(api);
} catch {
  /* not in Electron */
}

/**
 * Markpoints (named bookmarks in source, data or memory; Controlpoints Configuration > Markpoints tab).
 * UNCERTAIN: hiwave keeps markpoints per session and does not persist them in the .bpt; the IPC contract has no
 * markpoint API, so they live in the debugger window (one store per window, lost when the window closes).
 */
import { useSyncExternalStore } from 'react';

export interface Markpoint {
  id: number;
  name: string;
  address: number;
  kind: 'source' | 'data' | 'memory';
}

type Listener = () => void;

class MarkpointStore {
  private items: Markpoint[] = [];
  private next = 1;
  private listeners = new Set<Listener>();
  list = (): Markpoint[] => this.items;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  add(m: Omit<Markpoint, 'id'>): Markpoint {
    const mp = { ...m, id: this.next++ };
    this.set([...this.items, mp]);
    return mp;
  }
  update(id: number, patch: Partial<Omit<Markpoint, 'id'>>): void {
    this.set(this.items.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }
  remove(id: number): void {
    this.set(this.items.filter((m) => m.id !== id));
  }
  clear(): void {
    this.set([]);
  }
  private set(items: Markpoint[]): void {
    this.items = items;
    for (const l of [...this.listeners]) l();
  }
}

export const markpoints = new MarkpointStore();

export function useMarkpoints(): Markpoint[] {
  return useSyncExternalStore(markpoints.subscribe, markpoints.list, markpoints.list);
}

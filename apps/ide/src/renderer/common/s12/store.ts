/**
 * S12Store: one subscription per window to the high-rate debug streams, cached for useSyncExternalStore.
 *   - latest DebugSnapshot (registers, cycles, run state, watched memory) - updated at ~30 Hz while running
 *   - current SessionInfo
 *   - latest BoardState
 *   - latest ProjectInfo (IDE window)
 * Components never subscribe to `debug.snapshot` themselves; they use the hooks in hooks.ts.
 */
import type { BoardState, DebugSnapshot, ProjectInfo, S12Api, SessionInfo } from '../../../shared/api';

type Listener = () => void;

export const EMPTY_SNAPSHOT: DebugSnapshot = { seq: 0, state: 'none', statusText: '', cycles: 0, busHz: 0, simSeconds: 0, registers: null, memory: {} };

class Cell<T> {
  private listeners = new Set<Listener>();
  constructor(public value: T) {}
  set(v: T): void {
    this.value = v;
    for (const l of [...this.listeners]) l();
  }
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = (): T => this.value;
}

export class S12Store {
  readonly snapshot = new Cell<DebugSnapshot>(EMPTY_SNAPSHOT);
  /** Snapshot seq of the previous halt (components diff against it to paint changed values red). */
  readonly previousHaltSnapshot = new Cell<DebugSnapshot | null>(null);
  readonly session = new Cell<SessionInfo | null>(null);
  readonly board = new Cell<BoardState | null>(null);
  readonly project = new Cell<ProjectInfo | null>(null);
  private lastHalted: DebugSnapshot | null = null;

  constructor(readonly api: S12Api) {
    api.debug.on('snapshot', (s) => {
      if (s.seq < this.snapshot.value.seq && s.seq !== 0) return; // stale (out-of-order) snapshot
      if (s.state === 'halted' && this.snapshot.value.state !== 'halted') {
        this.previousHaltSnapshot.set(this.lastHalted);
      }
      if (s.state === 'halted') this.lastHalted = s;
      this.snapshot.set(s);
    });
    api.debug.on('session', (s) => {
      this.session.set(s);
      if (!s) {
        this.lastHalted = null;
        this.previousHaltSnapshot.set(null);
        this.snapshot.set({ ...EMPTY_SNAPSHOT, seq: this.snapshot.value.seq });
      }
    });
    api.board.on('state', (b) => this.board.set(b));
    api.project.on('changed', (p) => this.project.set(p));
    api.project.on('closed', () => this.project.set(null));
  }
}

/**
 * hiwave refresh modes shared by the Memory and Data components (docs/research/r1/ide.md §6):
 *   - Automatic   values are refreshed whenever the target halts (and on every change while halted)
 *   - Periodical  additionally refreshed every UPDATERATE * 100 ms while the target runs
 *   - Frozen      never refreshed (only newly scrolled-in addresses are fetched)
 *   - Locked      Data only; behaves like Frozen here (UNCERTAIN: hiwave locks Local scope to one procedure)
 *
 * A "refresh epoch" starts at every halt (a new PC/cycle count) and at every periodical refresh; values that differ
 * from the value shown at the start of the epoch are painted red ("changed since the last refresh").
 */
import type { DebugSnapshot } from '../../../../shared/api';

export type RefreshMode = 'automatic' | 'periodical' | 'frozen' | 'locked';

export const MODE_LABELS: Record<RefreshMode, string> = { automatic: 'Auto', periodical: 'Periodical', frozen: 'Frozen', locked: 'Locked' };

export function parseMode(v: string | undefined): RefreshMode | undefined {
  const s = (v ?? '').trim().toLowerCase();
  if (s.startsWith('auto')) return 'automatic';
  if (s.startsWith('period')) return 'periodical';
  if (s.startsWith('frozen') || s === 'freeze') return 'frozen';
  if (s.startsWith('lock')) return 'locked';
  return undefined;
}

export interface RefreshDecision {
  /** Take the new values for display. */
  accept: boolean;
  /** A new refresh epoch starts (re-baseline the changed-value comparison). */
  epoch: boolean;
}

/** Decides per snapshot whether a component refreshes. Feed every snapshot once (guarded by `seq`). */
export class RefreshPolicy {
  private lastSeq = -1;
  private last: RefreshDecision = { accept: true, epoch: false };
  private haltKey: string | null = null;
  private lastPeriodic = -Infinity;

  update(snap: DebugSnapshot, mode: RefreshMode, rateMs: number, now: number): RefreshDecision {
    if (snap.seq === this.lastSeq) return this.last;
    this.lastSeq = snap.seq;
    this.last = this.decide(snap, mode, rateMs, now);
    return this.last;
  }

  private decide(snap: DebugSnapshot, mode: RefreshMode, rateMs: number, now: number): RefreshDecision {
    if (mode === 'frozen' || mode === 'locked') return { accept: false, epoch: false };
    if (snap.state === 'none') return { accept: true, epoch: false };
    if (snap.state === 'running') {
      this.haltKey = null;
      if (mode === 'periodical' && now - this.lastPeriodic >= rateMs) {
        this.lastPeriodic = now;
        return { accept: true, epoch: true };
      }
      return { accept: false, epoch: false };
    }
    // halted: every halt (new cycle count / PC) is a new epoch; later snapshots of the same halt only update values
    const key = `${snap.cycles}:${snap.registers?.PC ?? ''}:${snap.halt?.reason ?? ''}`;
    const epoch = key !== this.haltKey;
    this.haltKey = key;
    return { accept: true, epoch };
  }
}

/** Value marker for bytes without a value. */
export const V_UNINIT = -1;
export const V_UNMAPPED = -2;

/**
 * Remembers the last shown value per key and the value at the start of the current epoch.
 * `changed(k)` = the value differs from the one shown at the previous refresh.
 */
export class ChangeTracker<K = number> {
  private last = new Map<K, number>();
  private base = new Map<K, number>();
  private pendingEpoch = false;

  /** Mark that the next observe() starts a new epoch (when the new values are not available yet). */
  markEpoch(): void {
    this.pendingEpoch = true;
  }

  observe(values: readonly (readonly [K, number])[], epoch: boolean): void {
    if (epoch || this.pendingEpoch) {
      // baseline = what was shown for the observed keys before this refresh (cost bounded by the visible range);
      // keys not observed now start a fresh baseline when they come back into view
      const base = new Map<K, number>();
      for (const [k] of values) {
        const v = this.last.get(k);
        if (v !== undefined) base.set(k, v);
      }
      this.base = base;
      this.pendingEpoch = false;
    }
    for (const [k, v] of values) {
      // a key seen for the first time in this epoch (scrolled into view, a new expression) takes its previous shown
      // value, or else its first value, as its baseline, so later edits/fills still paint it red
      if (!this.base.has(k)) this.base.set(k, this.last.get(k) ?? v);
      this.last.set(k, v);
    }
    if (this.last.size > 262144) {
      // scrolled through a lot of memory: forget everything (no red marks until the next refresh)
      this.last = new Map();
      this.base = new Map();
    }
  }

  changed(k: K): boolean {
    const b = this.base.get(k);
    return b !== undefined && b !== this.last.get(k);
  }

  reset(): void {
    this.last.clear();
    this.base.clear();
  }
}

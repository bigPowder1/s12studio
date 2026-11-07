/**
 * Watchers for open editor files: emit `files.changed` (debounced) when a watched file changes on disk.
 *
 * Each file is watched through its parent directory, filtered by name: a watch on the file itself follows the inode,
 * so it goes deaf after an atomic replace (write temp + rename over the original: git checkout, vim, many editors).
 * Events are emitted only when the file's identity/mtime/size actually differ from the last report.
 */
import { statSync, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { EventBus } from '../events';
import { normKey } from './path-key';

interface Entry {
  /** The path as first added: events report this spelling. */
  path: string;
  w: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  /** Last state reported (or found when watching started); null = file absent. */
  last: string | null;
  /** Bumped per check: a slower, older stat must not overwrite a newer result. */
  seq: number;
}

const caseFold = process.platform === 'win32' || process.platform === 'darwin';
const sameName = (a: string, b: string): boolean => (caseFold ? a.toLowerCase() === b.toLowerCase() : a === b);

export class FileWatchers {
  /** By normKey(path): "C:/x/Main.asm" and "c:\\x\\main.asm" are one watch on Windows. */
  private watchers = new Map<string, Entry>();

  constructor(
    private readonly bus: EventBus,
    private readonly debounceMs = 100,
  ) {}

  add(path: string): void {
    const k = normKey(path);
    if (this.watchers.has(k)) return;
    const name = basename(path);
    let w: FSWatcher;
    try {
      w = watch(dirname(path), { persistent: false });
    } catch {
      return; // missing directory: nothing to watch
    }
    // Baseline taken synchronously, after the watch is up: an async stat could resolve after a change that follows
    // add() immediately and take the changed state as the baseline, swallowing that change.
    const entry: Entry = { path, w, timer: null, last: statSig(path), seq: 0 };
    this.watchers.set(k, entry);
    w.on('change', (_ev, file) => {
      if (file && !sameName(String(file), name)) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => void this.check(k, entry), this.debounceMs);
    });
    w.on('error', () => this.remove(path));
  }

  private async check(k: string, entry: Entry): Promise<void> {
    const path = entry.path;
    entry.timer = null;
    const seq = ++entry.seq;
    const st = await stat(path).catch(() => null);
    if (this.watchers.get(k) !== entry || seq !== entry.seq) return; // unwatched, or a newer check is running
    const now = st ? sig(st) : null;
    if (now === entry.last) return;
    entry.last = now;
    this.bus.emit('files', 'changed', st ? { path, kind: 'change', mtimeMs: st.mtimeMs } : { path, kind: 'delete' });
  }

  remove(path: string): void {
    const k = normKey(path);
    const e = this.watchers.get(k);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.w.close();
    this.watchers.delete(k);
  }

  dispose(): void {
    for (const e of [...this.watchers.values()]) this.remove(e.path);
  }
}

function statSig(path: string): string | null {
  try {
    return sig(statSync(path));
  } catch {
    return null;
  }
}

function sig(st: { ino: number; mtimeMs: number; size: number }): string {
  return `${st.ino}:${st.mtimeMs}:${st.size}`;
}

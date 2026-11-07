import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../events';
import { FileWatchers } from './file-watchers';

const dir = mkdtempSync(join(tmpdir(), 's12ide-fw-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('FileWatchers (editor: file changed on disk)', () => {
  it('emits files.changed (debounced) for a change, then delete; unwatch stops events', async () => {
    const bus = new EventBus();
    const got: { path: string; kind: string; mtimeMs?: number }[] = [];
    bus.attach((d, e, p) => d === 'files' && e === 'changed' && got.push(p as (typeof got)[number]));
    const w = new FileWatchers(bus);
    const p = join(dir, 'main.asm');
    writeFileSync(p, 'one\r\n');
    w.add(p);
    w.add(p); // idempotent
    writeFileSync(p, 'two\r\n');
    writeFileSync(p, 'three\r\n');
    await waitFor(() => got.length > 0);
    expect(got[0]).toMatchObject({ path: p, kind: 'change' });
    expect(got[0].mtimeMs).toBeGreaterThan(0);
    got.length = 0;
    unlinkSync(p);
    await waitFor(() => got.some((g) => g.kind === 'delete'));
    w.remove(p);
    got.length = 0;
    writeFileSync(p, 'again\r\n');
    await new Promise((r) => setTimeout(r, 250));
    expect(got).toEqual([]);
    w.add(join(dir, 'missing.asm')); // no throw
    w.dispose();
  });

  it('keeps reporting after atomic replaces (temp file renamed over the original); a missing file reports its creation', async () => {
    const bus = new EventBus();
    const got: { path: string; kind: string; mtimeMs?: number }[] = [];
    bus.attach((d, e, p) => d === 'files' && e === 'changed' && got.push(p as (typeof got)[number]));
    const w = new FileWatchers(bus, 50);
    const p = join(dir, 'atomic.asm');
    writeFileSync(p, 'v1\r\n');
    w.add(p);
    await new Promise((r) => setTimeout(r, 50));
    for (const v of ['v2', 'v3 longer', 'v4']) {
      const n = got.length;
      writeFileSync(`${p}.tmp`, `${v}\r\n`);
      renameSync(`${p}.tmp`, p);
      await waitFor(() => got.length > n);
      expect(got.at(-1)).toMatchObject({ path: p, kind: 'change' });
    }
    // other files in the directory do not report for it
    const n = got.length;
    writeFileSync(join(dir, 'neighbour.asm'), 'x');
    await new Promise((r) => setTimeout(r, 200));
    expect(got.length).toBe(n);

    const later = join(dir, 'later.inc');
    w.add(later);
    writeFileSync(later, 'x\r\n');
    await waitFor(() => got.some((g) => g.path === later && g.kind === 'change'));
    w.dispose();
  });
});

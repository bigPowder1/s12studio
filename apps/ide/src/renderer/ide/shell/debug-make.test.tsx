/**
 * Project > Debug makes the target (assemble + link) before it launches the debugger, like CodeWarrior's Debug
 * command: Bring Up To Date alone never linked, so the debugger ran a stale bin/Project.abs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createMockS12 } from '../../common/testing/mockS12';
import type { BuildResultInfo } from '../../../shared/api';
import { createIdeActions, setIdeStatus, useIdeStatus } from './actions';
import { renderHook } from '@testing-library/react';

const result = (over: Partial<BuildResultInfo> = {}): BuildResultInfo =>
  ({ ok: true, target: 'Standard', errors: 0, warnings: 0, messages: [], upToDate: false, compiled: [], skipped: [], linked: true, burned: true, outputs: [], files: [], elapsedMs: 1, ...over }) as BuildResultInfo;

afterEach(() => setIdeStatus('Ready'));

describe('Project > Debug runs Make first', () => {
  it('makes (not Bring Up To Date), then launches', async () => {
    const order: string[] = [];
    const m = createMockS12({
      build: { make: async () => (order.push('make'), result()) },
      debug: { launch: async () => (order.push('launch'), {}) as never },
    });
    expect(await createIdeActions(m.api, () => null).debug()).toBe(true);
    expect(order).toEqual(['make', 'launch']);
    expect(m.calls('build', 'bringUpToDate')).toHaveLength(0);
  });

  it('an up-to-date target launches at once (nothing assembled or linked)', async () => {
    const m = createMockS12({ build: { make: async () => result({ upToDate: true, linked: false, burned: false, absPath: '/p/bin/Project.abs' }) } });
    expect(await createIdeActions(m.api, () => null).debug()).toBe(true);
    expect(m.calls('debug', 'launch')).toHaveLength(1);
  });

  it('a Make with errors does not launch and says why in the status bar', async () => {
    const m = createMockS12({ build: { make: async () => result({ ok: false, errors: 2, linked: false }) } });
    const status = renderHook(() => useIdeStatus());
    expect(await createIdeActions(m.api, () => null).debug()).toBe(false);
    expect(m.calls('debug', 'launch')).toHaveLength(0);
    status.rerender();
    expect(status.result.current).toBe('Debug cancelled: 2 error(s)');
  });
});

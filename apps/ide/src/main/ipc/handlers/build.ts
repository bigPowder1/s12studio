import type { DomainHandlers } from '../router';
import { v } from '../validate';
import type { MainServices } from '../../services';

const req = v.optional(v.object({ target: v.optional(v.string({ min: 1, max: 255 })), force: v.optional(v.boolean()) }));

export function buildHandlers(s: MainServices): DomainHandlers<'build'> {
  const B = s.builds;
  return {
    make: { args: [req], run: (_ctx, r) => B.make(r) },
    bringUpToDate: { args: [req], run: (_ctx, r) => B.bringUpToDate(r) },
    compile: { args: [v.array(v.string({ min: 1, max: 255 }), 1000), req], run: (_ctx, names, r) => B.compile(names, r) },
    stop: { args: [], run: () => B.stop() },
    removeObjectCode: {
      args: [v.optional(v.object({ target: v.optional(v.string({ min: 1, max: 255 })), allTargets: v.optional(v.boolean()) }))],
      run: (_ctx, r) => B.removeObjectCode(r),
    },
    isBuilding: { args: [], run: () => B.building },
    lastResult: { args: [], run: () => B.lastResult() },
  };
}

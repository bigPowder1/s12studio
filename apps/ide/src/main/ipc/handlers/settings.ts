import type { AppSettingsPatch } from '../../../shared/api/settings';
import type { DomainHandlers } from '../router';
import { v } from '../validate';
import type { MainServices } from '../../services';

const bounds = v.object({ x: v.number(), y: v.number(), width: v.number({ min: 0 }), height: v.number({ min: 0 }), maximized: v.boolean() });

const patchV = v.object({
  version: v.optional(v.literal(2)),
  showStartupDialog: v.optional(v.boolean()),
  recentProjects: v.optional(v.array(v.path(), 50)),
  recentFiles: v.optional(v.array(v.path(), 50)),
  editor: v.optional(
    v.object({
      fontSize: v.optional(v.number({ min: 6, max: 72 })),
      tabSize: v.optional(v.int(1, 16)),
      insertSpaces: v.optional(v.boolean()),
      syntaxColoring: v.optional(v.boolean()),
    }),
  ),
  debugger: v.optional(
    v.object({
      pacing: v.optional(v.literal('true-time', 'max')),
      speedFactor: v.optional(v.number({ min: 0.001, max: 1000 })),
      snapshotHz: v.optional(v.number({ min: 1, max: 120 })),
      keyboardToKeypad: v.optional(v.boolean()),
    }),
  ),
  windows: v.optional(v.object({ ide: v.optional(bounds), debugger: v.optional(bounds) })),
});

export function settingsHandlers(s: MainServices): DomainHandlers<'settings'> {
  return {
    get: { args: [], run: () => s.settings.get() },
    update: {
      args: [patchV],
      run: async (_ctx, patch) => {
        const next = await s.settings.update(patch as AppSettingsPatch);
        // a pacing change applies to the running session at once (true-time <-> max speed)
        const d = (patch as AppSettingsPatch).debugger;
        if (d && (d.pacing !== undefined || d.speedFactor !== undefined) && s.debug.running)
          await s.debug.call('debug.setPacing', [next.debugger.pacing, next.debugger.speedFactor]).catch(() => undefined);
        return next;
      },
    },
    sidecar: { args: [], run: () => (s.projects.current ? structuredClone(s.projects.current.sidecar) : null) },
  };
}

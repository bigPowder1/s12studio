import type { ToolKey } from '../../../shared/api/project';
import type { DomainHandlers } from '../router';
import { v } from '../validate';
import type { MainServices } from '../../services';

const name = () => v.string({ min: 1, max: 255 });
const groupPath = () => v.array(v.string({ min: 1, max: 255 }), 32);
const tool = v.literal<ToolKey>('assembler', 'compiler', 'linker', 'burner', 'importer', 'libmaker');

export function projectHandlers(s: MainServices): DomainHandlers<'project'> {
  const P = s.projects;
  return {
    open: {
      args: [v.path()],
      run: async (_ctx, path) => {
        const info = await P.open(path);
        await s.settings.addRecent('recentProjects', info.path);
        return info;
      },
    },
    close: { args: [], run: () => P.close() },
    current: { args: [], run: () => (P.current ? P.fullInfo() : null) },
    reload: { args: [], run: () => P.reload() },
    newProject: {
      args: [v.object({ template: v.literal('blank_project', 'minimal'), dir: v.path(), name: name() })],
      run: (_ctx, req) => P.newProject(req),
    },
    addFiles: {
      args: [v.array(v.path(), 1000), v.optional(groupPath())],
      run: (_ctx, paths, group) =>
        P.edit(async (p) => {
          for (const f of paths) await p.addFile(f, { group });
        }),
    },
    removeFile: { args: [name()], run: (_ctx, n) => P.edit((p) => p.removeFile(n)) },
    moveFile: { args: [name(), groupPath(), v.optional(v.int(0, 1e6))], run: (_ctx, n, g, i) => P.edit((p) => p.moveFile(n, g, i)) },
    addGroup: { args: [groupPath()], run: (_ctx, g) => P.edit((p) => p.addGroup(g)) },
    renameGroup: { args: [groupPath(), name()], run: (_ctx, g, n) => P.edit((p) => p.renameGroup(g, n)) },
    removeGroup: { args: [groupPath()], run: (_ctx, g) => P.edit((p) => p.removeGroup(g)) },
    setLinkOrder: { args: [name(), v.array(name(), 10000)], run: (_ctx, t, names) => P.edit((p) => p.setLinkOrder(t, names)) },
    setCurrentTarget: { args: [name()], run: (_ctx, t) => P.edit((p) => p.setCurrentTarget(t)) },
    setConnection: { args: [v.nullable(name())], run: (_ctx, c) => P.edit((p) => p.setConnection(c ?? undefined)) },
    setDebugFlag: { args: [name(), v.boolean()], run: (_ctx, n, d) => P.edit((p) => p.setDebug(n, d)) },
    setTouched: { args: [name(), v.boolean()], run: (_ctx, n, t) => P.setTouched(n, t) },
    setOption: { args: [name(), tool, v.nullable(v.string({ max: 65536 }))], run: (_ctx, t, k, val) => P.edit((p) => p.setOption(t, k, val ?? undefined)) },
    setAccessPaths: {
      args: [name(), v.nullable(v.object({ user: v.array(v.string({ max: 4096 }), 1000), system: v.array(v.string({ max: 4096 }), 1000) }))],
      run: (_ctx, t, paths) => P.edit((p) => p.setAccessPaths(t, paths ?? undefined)),
    },
    setOutput: {
      args: [name(), v.object({ dir: v.optional(v.string({ max: 4096 })), file: v.optional(v.string({ max: 255 })) })],
      run: (_ctx, t, out) => P.edit((p) => p.setOutput(t, out)),
    },
    setDebuggerArgs: { args: [name(), v.nullable(v.string({ max: 65536 }))], run: (_ctx, t, a) => P.edit((p) => p.setDebuggerArgs(t, a ?? undefined)) },
    debuggerConfig: { args: [v.optional(name())], run: (_ctx, t) => P.debuggerConfig(t) },
  };
}

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from '../../../shared/api/common';
import { DEFAULT_OPEN_FILTERS } from '../../engine/text-files';
import type { DomainHandlers } from '../router';
import { v } from '../validate';
import type { MainServices } from '../../services';

const filters = v.optional(v.array(v.object({ name: v.string({ max: 200 }), extensions: v.array(v.string({ max: 32 }), 64) }), 32));

/** Re-exported for older imports (decoding lives in engine/text-files.ts). */
export { decodeText } from '../../engine/text-files';

export function filesHandlers(s: MainServices): DomainHandlers<'files'> {
  const io = (e: unknown, path: string): never => {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ApiError(code === 'ENOENT' ? 'not-found' : 'io', `${path}: ${(e as Error).message}`);
  };
  return {
    openDialog: {
      args: [v.object({ title: v.optional(v.string({ max: 200 })), defaultPath: v.optional(v.path()), filters, multi: v.optional(v.boolean()), directory: v.optional(v.boolean()) })],
      run: (ctx, req) => s.windows.showOpenDialog(ctx.senderId, req.directory || req.filters?.length ? req : { ...req, filters: DEFAULT_OPEN_FILTERS }),
    },
    saveDialog: {
      args: [v.object({ title: v.optional(v.string({ max: 200 })), defaultPath: v.optional(v.path()), filters })],
      run: (ctx, req) => s.windows.showSaveDialog(ctx.senderId, req),
    },
    readText: { args: [v.path()], run: (_ctx, path) => s.textFiles.read(path) },
    writeText: {
      args: [v.object({ path: v.path(), text: v.string(), eol: v.optional(v.literal('crlf', 'lf')), expectMtimeMs: v.optional(v.number()), encoding: v.optional(v.literal('windows-1252', 'utf-8', 'utf-8-bom')) })],
      run: (_ctx, req) => s.textFiles.write(req),
    },
    stat: {
      args: [v.path()],
      run: async (_ctx, path) => {
        const st = await stat(path).catch(() => null);
        return st ? { path, isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs } : null;
      },
    },
    readDir: {
      args: [v.path()],
      run: async (_ctx, path) => {
        try {
          const ents = await readdir(path, { withFileTypes: true });
          return ents.map((e) => ({ name: e.name, path: join(path, e.name), isDirectory: e.isDirectory() }));
        } catch (e) {
          return io(e, path);
        }
      },
    },
    reveal: { args: [v.path()], run: (_ctx, path) => s.windows.reveal(path) },
    watch: { args: [v.path()], run: (_ctx, path) => s.watchers.add(path) },
    unwatch: { args: [v.path()], run: (_ctx, path) => s.watchers.remove(path) },
    recent: { args: [], run: async () => (await s.settings.get()).recentFiles },
    addRecent: { args: [v.path()], run: (_ctx, path) => s.settings.addRecent('recentFiles', path) },
  };
}

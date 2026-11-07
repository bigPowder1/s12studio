import { ApiError } from '../../../shared/api/common';
import type { DomainHandlers } from '../router';
import { v } from '../validate';
import type { MainServices } from '../../services';

export function appHandlers(s: MainServices): DomainHandlers<'app'> {
  const student = () => {
    if (!s.student) throw new ApiError('not-implemented', 'not available in this build');
    return s.student;
  };
  return {
    info: { args: [], run: (ctx) => ({ ...s.meta, windowKind: ctx.windowKind, ...(s.updates?.notice ? { updateNotice: s.updates.notice } : {}) }) },
    ready: { args: [], run: (ctx) => s.windows.rendererReady(ctx.senderId) },
    closeWindow: { args: [], run: (ctx) => s.windows.close(ctx.senderId) },
    minimizeWindow: { args: [], run: (ctx) => s.windows.minimize(ctx.senderId) },
    toggleMaximize: { args: [], run: (ctx) => s.windows.toggleMaximize(ctx.senderId) },
    setTitle: { args: [v.string({ max: 1024 })], run: (ctx, title) => s.windows.setTitle(ctx.senderId, title) },
    focusWindow: { args: [v.literal('ide', 'debugger')], run: (_ctx, kind) => s.windows.focus(kind) },
    toggleDevTools: { args: [], run: (ctx) => s.windows.toggleDevTools(ctx.senderId) },
    quit: { args: [], run: () => s.windows.quit() },
    openExternal: { args: [v.string({ max: 2048, pattern: /^https?:\/\//i })], run: (_ctx, url) => s.windows.openExternal(url) },
    installUpdate: { args: [], run: () => s.updates?.requestRestart() },
    prepareDemo: { args: [], run: () => student().prepareDemo() },
    showMessage: {
      args: [v.object({ type: v.optional(v.literal('error', 'warning', 'info')), title: v.optional(v.string({ max: 256 })), message: v.string({ min: 1, max: 4096 }), detail: v.optional(v.string({ max: 8192 })) })],
      run: (ctx, req) => student().showMessage(ctx.senderId, req),
    },
  };
}

/**
 * IPC router: per-domain handler tables with argument validators. Pure (no Electron import) so it is unit-tested
 * in Node; src/main/index.ts binds it to ipcMain.handle.
 *
 *   router.register('project', {
 *     open: { args: [v.path()], run: (ctx, path) => projects.open(path) },
 *     ...
 *   });
 */
import { API_METHODS, ApiError, type Domain, type S12Methods, type WindowKind } from '../../shared/api';
import { invokeChannel } from '../../shared/ipc';
import { validateArgs, type Validator } from './validate';

/** Who called (window kind + an opaque sender handle main uses to address replies). */
export interface CallContext {
  windowKind: WindowKind;
  /** Electron WebContents id of the caller (-1 in tests). */
  senderId: number;
}

type AnyFn = (...args: never[]) => unknown;

export interface MethodHandler<F extends AnyFn> {
  /** One validator per parameter (validated values are passed to run). */
  args: readonly Validator<unknown>[];
  run: (ctx: CallContext, ...args: Parameters<F>) => ReturnType<F> | Awaited<ReturnType<F>>;
}

export type DomainHandlers<D extends Domain> = {
  [M in keyof S12Methods[D]]: S12Methods[D][M] extends AnyFn ? MethodHandler<S12Methods[D][M]> : never;
};

export type Dispatch = (ctx: CallContext, args: unknown[]) => Promise<unknown>;

const EXPECTED_CODES: ReadonlySet<string> = new Set(['invalid-argument', 'not-found', 'no-project', 'no-session', 'busy', 'not-implemented']);

/** `[code] message` so the renderer can recover the code (parseApiError). */
export function encodeError(e: unknown): Error {
  if (e instanceof ApiError) {
    const err = new Error(`[${e.code}] ${e.message}`);
    // Expected outcomes (a missing source, no session yet, a busy build...) are answers, not crashes: Electron logs
    // every rejected ipcMain.handle with the error's stack, so these carry a one-line stack instead.
    if (EXPECTED_CODES.has(e.code)) err.stack = `Error: ${err.message}`;
    return err;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/^\[[a-z-]+\] /.test(msg)) return new Error(msg);
  return new Error(`[internal] ${msg}`);
}

export const notImplemented = (what: string): never => {
  throw new ApiError('not-implemented', `${what} is not implemented yet`);
};

export class IpcRouter {
  private readonly table = new Map<string, Dispatch>();

  register<D extends Domain>(domain: D, handlers: DomainHandlers<D>): void {
    for (const [method, h] of Object.entries(handlers) as [string, MethodHandler<AnyFn>][]) {
      const channel = invokeChannel(domain, method);
      const where = `${domain}.${method}`;
      this.table.set(channel, async (ctx, raw) => {
        try {
          const args = validateArgs(h.args, raw, where);
          return await (h.run as (ctx: CallContext, ...a: unknown[]) => unknown)(ctx, ...args);
        } catch (e) {
          throw encodeError(e);
        }
      });
    }
  }

  /** Channels of the shared contract that have no handler (should be empty at startup). */
  missing(): string[] {
    const out: string[] = [];
    for (const [domain, methods] of Object.entries(API_METHODS)) for (const m of methods) if (!this.table.has(invokeChannel(domain as Domain, m))) out.push(`${domain}.${m}`);
    return out;
  }

  channels(): string[] {
    return [...this.table.keys()];
  }

  dispatcher(channel: string): Dispatch | undefined {
    return this.table.get(channel);
  }

  /** Call a handler directly (tests). */
  async call(domain: Domain, method: string, args: unknown[] = [], ctx: CallContext = { windowKind: 'ide', senderId: -1 }): Promise<unknown> {
    const d = this.table.get(invokeChannel(domain, method));
    if (!d) throw new Error(`no handler for ${domain}.${method}`);
    return d(ctx, args);
  }
}

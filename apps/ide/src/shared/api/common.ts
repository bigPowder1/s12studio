/**
 * Shared building blocks of the window.s12 contract (preload <-> main <-> renderer).
 *
 * Every domain module (files.ts, project.ts, ...) exports:
 *   - `<Domain>Api`       interface of request methods; every method returns a Promise and its arguments/results
 *                         must be structured-cloneable (plain objects, arrays, numbers, strings, Uint8Array).
 *   - `<Domain>Events`    map of event name -> payload type (main -> renderer pushes).
 *   - `<DOMAIN>_METHODS`  the method names as a const array (the preload builds the bridge from it, the main
 *                         process checks every handler is registered). `satisfies MethodList<...>` keeps it complete.
 *
 * IPC channels (see ../ipc.ts): invoke `s12:<domain>.<method>`, events on `s12:evt` as (domain, event, payload).
 */

/** Unsubscribe function returned by every `on(...)`. */
export type Unsubscribe = () => void;

/** Event subscription surface each domain exposes as `window.s12.<domain>.on(event, cb)`. */
export interface EventSource<E> {
  on<K extends keyof E & string>(event: K, listener: (payload: E[K]) => void): Unsubscribe;
}

/** Method names of an API interface, as a tuple that must list every key exactly. */
export type MethodList<T> = readonly (keyof T & string)[];

/** Compile-time check that a method list covers every key of the API interface. */
export type AssertComplete<T, L extends readonly string[]> = Exclude<keyof T, L[number]> extends never ? true : Exclude<keyof T, L[number]>;

/** Error codes thrown across IPC (`err.message` is prefixed with `[code] `; see preload `unwrapError`). */
export type ApiErrorCode = 'invalid-argument' | 'not-found' | 'no-project' | 'no-session' | 'busy' | 'not-implemented' | 'io' | 'internal';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Parse the `[code] message` form produced by main for errors that crossed IPC. */
export function parseApiError(e: unknown): { code: ApiErrorCode; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  // Electron wraps: "Error invoking remote method 's12:x.y': Error: [code] msg"
  const stripped = raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
  const m = /^\[([a-z-]+)\] ([\s\S]*)$/.exec(stripped);
  return m ? { code: m[1] as ApiErrorCode, message: m[2] } : { code: 'internal', message: stripped };
}

/** Which window a renderer runs in. */
export type WindowKind = 'ide' | 'debugger';

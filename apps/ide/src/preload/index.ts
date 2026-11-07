/**
 * Preload (sandboxed, contextIsolation on): exposes the typed `window.s12` bridge built from the shared method
 * lists. No Node APIs reach the renderer; every call becomes ipcRenderer.invoke(`s12:<domain>.<method>`, ...args)
 * and every event arrives on one channel as (domain, event, payload).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { API_METHODS, DOMAINS, type Domain, type S12Api } from '../shared/api';
import { EVENT_CHANNEL, invokeChannel } from '../shared/ipc';

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on(EVENT_CHANNEL, (_e: IpcRendererEvent, domain: string, event: string, payload: unknown) => {
  const set = listeners.get(`${domain}:${event}`);
  if (!set) return;
  for (const l of [...set]) {
    try {
      l(payload);
    } catch (err) {
      console.error(`s12 ${domain}.${event} listener failed`, err);
    }
  }
});

/** Strip Electron's "Error invoking remote method ..." prefix so callers see the main-side `[code] message`. */
function unwrapError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
}

function buildDomain(domain: Domain): Record<string, unknown> {
  const ns: Record<string, unknown> = {};
  for (const method of API_METHODS[domain] as readonly string[]) {
    const channel = invokeChannel(domain, method);
    ns[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args).catch((e: unknown) => Promise.reject(unwrapError(e)));
  }
  ns.on = (event: string, listener: Listener) => {
    if (typeof event !== 'string' || typeof listener !== 'function') throw new TypeError('on(event: string, listener: function)');
    const key = `${domain}:${event}`;
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  return ns;
}

const api = Object.fromEntries(DOMAINS.map((d) => [d, buildDomain(d)])) as unknown as S12Api;

contextBridge.exposeInMainWorld('s12', api);

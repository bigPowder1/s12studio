/**
 * In-memory window.s12 for component tests (jsdom) and UI previews.
 *
 *   const m = createMockS12({ debug: { readRegisters: async () => regs } });
 *   render(<S12Provider api={m.api}><Register /></S12Provider>);
 *   m.emit('debug', 'snapshot', snap);
 *   expect(m.calls('debug', 'step')).toEqual([['instr']]);
 *
 * Unimplemented methods resolve to undefined (or `defaults` below) and are recorded.
 */
import { API_METHODS, DOMAINS, type Domain, type S12Api, type S12Events, type S12Methods } from '../../../shared/api';

export type MockOverrides = { [D in Domain]?: Partial<S12Methods[D]> };

export interface MockS12 {
  api: S12Api;
  /** Push an event to subscribers (as main would). */
  emit<D extends Domain, E extends keyof S12Events[D] & string>(domain: D, event: E, payload: S12Events[D][E]): void;
  /** Recorded argument lists of a method's calls. */
  calls(domain: Domain, method: string): unknown[][];
  /** Every call in order. */
  log: { domain: Domain; method: string; args: unknown[] }[];
  /** Number of listeners on an event. */
  listenerCount(domain: Domain, event: string): number;
}

/** Results for common getters so components render without overrides. */
const DEFAULTS: Partial<Record<string, unknown>> = {
  'app.info': { name: 'S12 Studio', version: '0.0.0-test', platform: 'test', electron: '0', windowKind: 'ide', e2e: false },
  'project.current': null,
  'debug.session': null,
  'debug.breakpoints': [],
  'debug.watchpoints': [],
  'debug.expressions': [],
  'debug.sourceFiles': [],
  'debug.symbols': [],
  'debug.globals': [],
  'debug.callStack': [],
  'debug.disassemble': [],
  'debug.evaluate': [],
  'board.keys': [],
  'files.recent': [],
  'build.isBuilding': false,
  'build.lastResult': null,
};

export function createMockS12(overrides: MockOverrides = {}): MockS12 {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const log: MockS12['log'] = [];
  const api: Record<string, Record<string, unknown>> = {};
  for (const d of DOMAINS) {
    const ns: Record<string, unknown> = {};
    const ov = (overrides[d] ?? {}) as Record<string, (...a: unknown[]) => unknown>;
    for (const m of API_METHODS[d] as readonly string[]) {
      ns[m] = async (...args: unknown[]) => {
        log.push({ domain: d, method: m, args });
        if (ov[m]) return ov[m](...args);
        return structuredClone(DEFAULTS[`${d}.${m}`]);
      };
    }
    ns.on = (event: string, l: (p: unknown) => void) => {
      const k = `${d}:${event}`;
      let set = listeners.get(k);
      if (!set) listeners.set(k, (set = new Set()));
      set.add(l);
      return () => set.delete(l);
    };
    api[d] = ns;
  }
  return {
    api: api as unknown as S12Api,
    emit: (domain, event, payload) => {
      for (const l of [...(listeners.get(`${domain}:${event}`) ?? [])]) l(payload);
    },
    calls: (domain, method) => log.filter((c) => c.domain === domain && c.method === method).map((c) => c.args),
    log,
    listenerCount: (domain, event) => listeners.get(`${domain}:${event}`)?.size ?? 0,
  };
}

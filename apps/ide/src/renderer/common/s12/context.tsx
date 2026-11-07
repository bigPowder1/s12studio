/**
 * Access to the window.s12 bridge from React. Production code uses window.s12; tests and previews wrap the tree in
 * <S12Provider api={createMockS12().api}>. One S12Store (snapshot/session/board caches) is created per api object.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { S12Api } from '../../../shared/api';
import { S12Store } from './store';

interface Ctx {
  api: S12Api;
  store: S12Store;
}

const S12Context = createContext<Ctx | null>(null);
const stores = new WeakMap<S12Api, S12Store>();

/** The shared store of an api object (created on first use). */
export function storeFor(api: S12Api): S12Store {
  let s = stores.get(api);
  if (!s) stores.set(api, (s = new S12Store(api)));
  return s;
}

/** The preload bridge. Throws outside Electron unless a provider supplies one. */
export function getS12(): S12Api {
  const api = (globalThis as { s12?: S12Api }).s12;
  if (!api) throw new Error('window.s12 is not available (not running in the S12 Studio Electron shell)');
  return api;
}

export function S12Provider({ api, children }: { api?: S12Api; children: ReactNode }) {
  const value = useMemo(() => {
    const a = api ?? getS12();
    return { api: a, store: storeFor(a) };
  }, [api]);
  return <S12Context.Provider value={value}>{children}</S12Context.Provider>;
}

function useCtx(): Ctx {
  const c = useContext(S12Context);
  if (c) return c;
  const api = getS12();
  return { api, store: storeFor(api) };
}

/** The typed API: `const s12 = useS12(); await s12.debug.step('instr');` */
export function useS12(): S12Api {
  return useCtx().api;
}

export function useS12Store(): S12Store {
  return useCtx().store;
}

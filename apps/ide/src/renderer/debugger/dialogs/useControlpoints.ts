/** Live breakpoint / watchpoint lists: initial pull + `breakpoints` / `watchpoints` events (reset on session/load). */
import { useEffect, useState } from 'react';
import type { BreakpointInfo, WatchpointInfo } from '../../../shared/api';
import { useS12, useS12Event, useSession } from '../../common/s12';

export function useBreakpoints(): BreakpointInfo[] {
  const s12 = useS12();
  const session = useSession();
  const [list, setList] = useState<BreakpointInfo[]>([]);
  useEffect(() => {
    if (!session) return setList([]);
    let live = true;
    void s12.debug.breakpoints().then((b) => live && setList(b ?? []), () => undefined);
    return () => {
      live = false;
    };
  }, [s12, session]);
  useS12Event('debug', 'breakpoints', (b) => setList(b));
  return list;
}

export function useWatchpoints(): WatchpointInfo[] {
  const s12 = useS12();
  const session = useSession();
  const [list, setList] = useState<WatchpointInfo[]>([]);
  useEffect(() => {
    if (!session) return setList([]);
    let live = true;
    void s12.debug.watchpoints().then((w) => live && setList(w ?? []), () => undefined);
    return () => {
      live = false;
    };
  }, [s12, session]);
  useS12Event('debug', 'watchpoints', (w) => setList(w));
  return list;
}

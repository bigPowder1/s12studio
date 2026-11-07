/** Debugger window root: create the store (event subscriptions), then tell main it may flush queued events. */
import { useEffect } from 'react';
import { useS12, useS12Store } from '../common/s12';
import { DebuggerShell } from './shell/DebuggerShell';

export function DebuggerApp() {
  const s12 = useS12();
  useS12Store();
  useEffect(() => {
    void s12.app.ready();
  }, [s12]);
  return <DebuggerShell />;
}

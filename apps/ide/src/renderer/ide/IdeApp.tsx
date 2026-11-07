/** IDE window root: wires window-level events, then tells main it is ready (flushes queued events). */
import { useEffect } from 'react';
import { parseApiError } from '../../shared/api';
import { useS12, useS12Event, useS12Store } from '../common/s12';
import { setIdeStatus } from './shell/actions';
import { openPath } from './shell/open-dispatch';
import { IdeShell } from './shell/IdeShell';

export function IdeApp() {
  const s12 = useS12();
  useS12Store(); // create the store (project subscription) before main flushes queued events
  // command line / second instance / OS open-file: .abs starts the debugger, text files go to the editor
  useS12Event('files', 'openRequest', ({ path, line }) => void openPath(s12, path, { line }).catch((e) => setIdeStatus(parseApiError(e).message)));
  useEffect(() => {
    void s12.app.ready();
  }, [s12]);
  return <IdeShell />;
}

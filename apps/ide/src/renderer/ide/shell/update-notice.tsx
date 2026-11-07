/**
 * IDE status-bar pane for app.update (src/main/updates): non-modal, click to act.
 *   downloaded  "S12 Studio 0.2.0 downloaded - Restart to update"   -> "save changes?" for modified documents (like
 *               File > Exit; Cancel keeps everything), then app.installUpdate() (normal quit + relaunch)
 *   available   "S12 Studio 0.2.0 is available - Download"          -> opens the release page
 * The notice arrives as the app.update event; a window that (re)loads later gets it from app.info().updateNotice.
 */
import { useEffect, useState } from 'react';
import type { S12Api, UpdateNotice } from '../../../shared/api';
import type { StatusPane } from '../../common/controls';
import { useS12, useS12Event } from '../../common/s12';
import { getEditorArea } from '../editor/bridge';

export function useUpdateNotice(): UpdateNotice | null {
  const s12 = useS12();
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  useS12Event('app', 'update', setNotice);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => s12.app.info())
      .then(
        (i) => {
          if (live && i?.updateNotice) setNotice((cur) => cur ?? i.updateNotice!);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [s12]);
  return notice;
}

export function updateNoticeText(n: UpdateNotice): string {
  return n.state === 'downloaded' ? `S12 Studio ${n.version} downloaded — Restart to update` : `S12 Studio ${n.version} is available — Download`;
}

/** The status-bar pane for a notice (null: none). */
export function updatePane(n: UpdateNotice | null, s12: S12Api): StatusPane | null {
  if (!n) return null;
  const act = () => void (n.state === 'downloaded' ? restart(s12) : n.url ? s12.app.openExternal(n.url) : Promise.resolve()).catch(() => undefined);
  return {
    id: 'update',
    width: 330,
    content: <UpdateLink text={updateNoticeText(n)} />,
    title: n.state === 'downloaded' ? 'The update installs when S12 Studio closes. Click to restart now.' : 'Open the download page in your browser',
    onClick: act,
  };
}

/** "Restart to update": the File > Exit "save changes?" round first, so a Cancel never leaves a restart queued. */
async function restart(s12: S12Api): Promise<void> {
  const editor = getEditorArea();
  if (editor && !(await editor.closeAll())) return;
  await s12.app.installUpdate();
}

function UpdateLink({ text }: { text: string }) {
  return (
    <span data-testid="ide-update-notice" style={{ cursor: 'pointer', color: 'var(--cw-link, #0000ee)', textDecoration: 'underline' }}>
      {text}
    </span>
  );
}

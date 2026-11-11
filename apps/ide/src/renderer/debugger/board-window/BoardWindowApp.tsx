/**
 * The ME3305 board window (S12 Studio addition): the board simulator in its own window, a child of the debugger
 * window that floats over it and can be moved and resized anywhere (main/windows.ts, kind 'board'). It is the
 * debugger page loaded at `#board`, so it shares the debugger's store and the board component; its menu bar has one
 * "Board" menu with the board component's own commands (Power Cycle, Release All Keys, keyboard mapping).
 */
import { useEffect, useMemo, useState } from 'react';
import { MenuBar } from '../../common/menu/MenuBar';
import type { MenuEntry, TopMenu } from '../../common/menu/model';
import { useS12, useS12Store } from '../../common/s12';
import { BoardComponent } from '../components/board/BoardComponent';
import { ComponentHostContext, type ComponentHost } from '../components/contract';
import './board-window.css';

export const BOARD_WINDOW_TITLE = 'ME3305 Board';

export function BoardWindowApp() {
  const s12 = useS12();
  useS12Store();
  const [items, setItems] = useState<MenuEntry[] | null>(null);
  useEffect(() => {
    document.title = BOARD_WINDOW_TITLE;
    void s12.app.ready();
  }, [s12]);
  // a minimal host: the board only registers its menu; other components live in the debugger window
  const host = useMemo<ComponentHost>(
    () => ({
      setMenu: (m) => setItems(m),
      setHeadline: () => undefined,
      open: () => void s12.app.focusWindow('debugger').catch(() => undefined),
      activate: () => undefined,
      onUiCommand: () => () => undefined,
    }),
    [s12],
  );
  const menus = useMemo<TopMenu[]>(() => [{ label: '&Board', id: 'board', items: items ?? [], disabled: !items?.length }], [items]);
  return (
    <div className="board-window" data-testid="board-window">
      <MenuBar menus={menus} testId="board-menubar" />
      <div className="board-window-body">
        <ComponentHostContext.Provider value={host}>
          <BoardComponent instanceId="board-window" title={BOARD_WINDOW_TITLE} instance={1} attributes={[]} active />
        </ComponentHostContext.Provider>
      </div>
    </div>
  );
}

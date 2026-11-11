import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/theme.css';
import './shell/dock-theme.css';
import { S12Provider } from '../common/s12';
import { BoardWindowApp } from './board-window/BoardWindowApp';
import { DebuggerApp } from './DebuggerApp';

// the same page serves the debugger window and, at #board, the ME3305 board window (main/windows.ts)
const isBoardWindow = window.location.hash === '#board';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <S12Provider>{isBoardWindow ? <BoardWindowApp /> : <DebuggerApp />}</S12Provider>
  </StrictMode>,
);

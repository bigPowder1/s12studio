import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/theme.css';
import './shell/dock-theme.css';
import { S12Provider } from '../common/s12';
import { DebuggerApp } from './DebuggerApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <S12Provider>
      <DebuggerApp />
    </S12Provider>
  </StrictMode>,
);

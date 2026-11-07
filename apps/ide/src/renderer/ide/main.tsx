import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/theme.css';
import { S12Provider } from '../common/s12';
import { IdeApp } from './IdeApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <S12Provider>
      <IdeApp />
    </S12Provider>
  </StrictMode>,
);

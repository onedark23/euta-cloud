import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SessionProvider } from './session';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './ui/tokens.css';
import './ui/ui.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);

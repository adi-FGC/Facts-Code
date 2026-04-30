import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.tsx';

// Design system — must load before the app so first paint is styled.
import '@factstack/ui-theme/tokens.css';
import '@factstack/ui-theme/glass.css';
import './styles/app.css';
import './styles/graph.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

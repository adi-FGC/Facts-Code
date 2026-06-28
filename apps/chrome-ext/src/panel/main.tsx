/**
 * Panel entry. Mounts the React-free Remix v3 app once via createRoot, after
 * loading the shared design tokens + panel-global CSS.
 */
import { createRoot } from 'remix/ui';
import { App } from './App.tsx';

import '@factstack/ui-theme/tokens.css';
import './panel.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from panel.html');

createRoot(container).render(<App />);

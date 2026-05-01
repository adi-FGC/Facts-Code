/**
 * Boot the Remix v3 client runtime.
 *
 * Uses `@remix-run/ui`'s `createRoot` — the SPA-friendly mount point that
 * doesn't require a server-driven Frame tree. Same shape as React's
 * `createRoot`, different VDOM underneath.
 *
 * No React here. No ReactDOM. The build is React-free top to bottom.
 */
import { createRoot } from '@remix-run/ui';
import { App } from './App.tsx';

// Design system — must load before app render so first paint is styled.
import '@factstack/ui-theme/tokens.css';
import '@factstack/ui-theme/glass.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

const root = createRoot(container);
root.render(<App />);

// Re-render on URL changes so the route table picks up navigations.
// This is the SPA shim for the Frame-less mount: instead of relying on
// Remix's frame router, we listen for popstate + a custom `factstack:nav`
// event (dispatched by the in-app `navigate()` helper) and ask the root
// to render the App again.
const rerender = () => root.render(<App />);
window.addEventListener('popstate', rerender);
window.addEventListener('factstack:nav', rerender);

// Global click-delegation for internal <a href="..."> links. We do it at
// the document level instead of via a per-element `on('click', ...)` mixin
// because the latter has tight DOM-event type narrowing that fights with
// the `<header>` host. One listener handles every link in the app —
// pushState's the URL, fires `factstack:nav`, suppresses the page reload.
import { linkClick } from './lib/navigate.ts';
document.addEventListener('click', linkClick);

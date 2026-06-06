/**
 * Boot the Remix v3 client runtime.
 *
 * Uses `remix/ui`'s `createRoot` — the SPA-friendly mount point that
 * doesn't require a server-driven Frame tree. Same shape as React's
 * `createRoot`, different VDOM underneath. (The `remix/ui` subpath
 * lives in the umbrella `remix` package; it currently re-exports
 * `@remix-run/ui` but importing through the umbrella is the canonical
 * forward path — the standalone `@remix-run/ui` is folding into the
 * umbrella source upstream.)
 *
 * No React here. No ReactDOM. The build is React-free top to bottom.
 */
import { createRoot } from 'remix/ui';
import { App } from './App.tsx';

// Design system — must load before app render so first paint is styled.
import '@factstack/ui-theme/tokens.css';
import '@factstack/ui-theme/glass.css';
import '@factstack/ui-theme/diagram.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

// Mount the app ONCE. All navigation reactivity lives inside <AppRouter/>
// (App.tsx), which re-renders via its own `handle.update()` on popstate +
// `factstack:nav` + data-ready. We deliberately do NOT call root.render()
// again on those events: repeated `createRoot().render()` is not re-entrant
// in this VDOM and silently blanks #root on the 2nd+ call (the old
// "blank on client navigation, fine on refresh" bug).
const root = createRoot(container);
root.render(<App />);

// Global click-delegation for internal <a href="..."> links. We do it at
// the document level instead of via a per-element `on('click', ...)` mixin
// because the latter has tight DOM-event type narrowing that fights with
// the `<header>` host. One listener handles every link in the app —
// pushState's the URL, fires `factstack:nav`, suppresses the page reload.
import { linkClick } from './lib/navigate.ts';
document.addEventListener('click', linkClick);

/* Global keyboard shortcuts. ⌘K is owned by CommandPalette (which
   attaches its own listener). ⌘J cycles the theme — discoverable via
   the Config tab + theme toggle; we don't render a separate "press ?
   for help" flash because the palette footer already shows its three
   shortcuts and the design spec rule against modals applies to a
   shortcuts-help modal too. */
import { cycleThemeShortcut } from './lib/theme.ts';
document.addEventListener('keydown', (e) => {
  if (e.key === 'j' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    cycleThemeShortcut();
  }
});

/**
 * Top-level component for the Remix v3 SPA.
 *
 * Component model (Remix v3, NOT React):
 *   - A component is `(handle) => (props) => RemixNode`. Setup runs once
 *     per instance; the inner render fn is called for each update.
 *   - State lives in the closure between renders. `handle.update()`
 *     schedules a re-render; `handle.signal` aborts on unmount.
 *
 * Routing model:
 *   - We use `remix/route-pattern` for typed `href` strings (see
 *     `lib/routes.ts`) but we don't use Remix's Frame router — that's
 *     server-driven. Our SPA mount uses a tiny `navigate()` helper that
 *     pushState's + dispatches an event, and `main.tsx` re-renders the
 *     App on every URL change. Same UX, ~20 lines of glue.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import { activeTab } from './lib/routes.ts';
import { loadArtifacts, type Dataset } from './lib/loadArtifacts.ts';
import { Header } from './components/Header.tsx';
import { TreePanel } from './components/TreePanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Overview } from './routes/Overview.tsx';
import { Risks } from './routes/Risks.tsx';
import { Credentials } from './routes/Credentials.tsx';
import { Vulnerabilities } from './routes/Vulnerabilities.tsx';
import { History } from './routes/History.tsx';
import { GraphRoute } from './routes/GraphRoute.tsx';
import { Flow } from './routes/Flow.tsx';
import { Files } from './routes/Files.tsx';
import { Library } from './routes/Library.tsx';
import { RoutesTab } from './routes/RoutesTab.tsx';
import { Tests } from './routes/Tests.tsx';
import { About } from './routes/About.tsx';
import { Config } from './routes/Config.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { OpenModal } from './components/OpenModal.tsx';

interface AppProps {
  /** Empty — App takes no props. Declared so the JSX type checks. */
}

/**
 * Module-scoped data cache. The Remix runtime re-instantiates `App`
 * every render (cheap), so we hoist the dataset out and trigger a
 * re-render via `handle.update()` once it loads.
 *
 * The Re-analyze button dispatches a `factstack:dataset` CustomEvent
 * with the freshly-loaded Dataset; the listener below replaces
 * `cached` in place + asks `main.tsx` to re-render the root. We keep
 * root-level re-rendering outside component handles because the root
 * handle in the Remix UI runtime does not implement `handle.update()`.
 */
let cached: Dataset | null = null;
let loadError: string | null = null;
let loadStarted = false;

export const DATA_READY_EVENT = 'factstack:data-ready';

function notifyDataReady() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(DATA_READY_EVENT));
  }
}

function ensureLoadStarted() {
  if (loadStarted) return;
  loadStarted = true;
  loadArtifacts()
    .then((data) => {
      cached = data;
      notifyDataReady();
    })
    .catch((err: unknown) => {
      loadError = err instanceof Error ? err.message : String(err);
      notifyDataReady();
    });
}

/* Re-analyze hook. The button calls `requestReanalyze()` itself and
   dispatches the result via this event so we don't need a back-channel
   import from the button into App. */
if (typeof window !== 'undefined') {
  window.addEventListener('factstack:dataset', (e: Event) => {
    const detail = (e as CustomEvent<Dataset>).detail;
    if (detail) {
      cached = detail;
      loadError = null;
      notifyDataReady();
    }
  });
}

export function App(_handle: Handle<AppProps>) {
  ensureLoadStarted();
  return () => {
    if (loadError) return <ErrorScreen message={loadError} />;
    if (!cached) return <Loading />;
    return <Shell data={cached} />;
  };
}

function ErrorScreen(handle: Handle<{ message: string }>) {
  return () => {
    const { message } = handle.props;
    return (
    <div mix={css({ padding: '32px', maxWidth: '640px' })}>
      <h1 class="serif" mix={css({ fontSize: '28px', marginBottom: '12px' })}>Nothing to analyze yet.</h1>
      <p mix={css({ color: 'var(--fg-muted)' })}>
        Run <span class="mono">factstack ui</span> from a project directory, or open this file
        after `factstack export`.
      </p>
      <p class="mono" mix={css({ color: 'var(--fg-subtle)', fontSize: '12px', marginTop: '16px' })}>
        {message}
      </p>
    </div>
    );
  };
}

/* Audit M6 fix: instead of a bare "Loading…" string in the corner,
   render the same shell skeleton (header rule + tree column rule +
   status rule + a tiny blinking caret) so first paint already has
   the layout established. When data lands, only the content area
   swaps — no whole-page reflow. */
function Loading(_h: Handle) {
  return () => (
    <div class="skeleton-shell" role="status" aria-label="Loading FACTS dashboard">
      <div class="sk-h" />
      <div class="sk-t" />
      <div class="sk-m">
        <div class="sk-pulse" />
      </div>
      <div class="sk-f" />
    </div>
  );
}

function Shell(handle: Handle<{ data: Dataset }>) {
  return () => {
    const { data } = handle.props;
    const tab = activeTab(location.pathname);
    return (
      <>
        <a href="#main" class="skip-link">Skip to content</a>
        <div class="app-shell">
          <Header data={data} />
          <TreePanel data={data} />
          {/* tabIndex={-1} makes <main> a programmatic focus target so the
              skip-link (`<a href="#main">`) MOVES focus here, not just
              scrolls. Without it the browser scrolls to #main but focus
              stays on the link, so the next Tab dumps the user back into the
              nav — defeating the skip link. -1 keeps it out of the Tab order. */}
          <main id="main" tabIndex={-1}>
            {renderRoute(tab, data)}
          </main>
          <StatusBar data={data} />
        </div>
        {/* Command palette overlays everything when open. The component
            attaches its own document-level ⌘K listener so it doesn't
            need wiring into Header. */}
        <CommandPalette data={data} />
        {/* OpenModal: always mounted, invisible until ⌘O or a header
            button dispatches `factstack:open`. Owns its own state and
            cleanup; no wiring needed beyond mounting. */}
        <OpenModal />
      </>
    );
  };
}

function renderRoute(tab: ReturnType<typeof activeTab>, data: Dataset) {
  // Hand-rolled switch — small + obvious, no router needed beyond the
  // pathname → tab mapping in lib/routes.ts.
  switch (tab) {
    case 'overview': return <Overview data={data} />;
    case 'graph':    return <GraphRoute data={data} />;
    case 'flow':     return <Flow data={data} />;
    case 'files':    return <Files data={data} />;
    case 'library':  return <Library data={data} />;
    case 'routes':   return <RoutesTab data={data} />;
    case 'risks':    return <Risks data={data} />;
    case 'credentials':    return <Credentials data={data} />;
    case 'vulnerabilities': return <Vulnerabilities data={data} />;
    case 'tests':    return <Tests data={data} />;
    case 'history':  return <History data={data} />;
    case 'about':    return <About data={data} />;
    case 'config':   return <Config data={data} />;
  }
}

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
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import { activeTab } from './lib/routes.ts';
import { loadArtifacts, type Dataset } from './lib/loadArtifacts.ts';
import { Header } from './components/Header.tsx';
import { TreePanel } from './components/TreePanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Overview } from './routes/Overview.tsx';
import { Risks } from './routes/Risks.tsx';
import { History } from './routes/History.tsx';
import { GraphRoute } from './routes/GraphRoute.tsx';
import { Dag } from './routes/Dag.tsx';
import { Files } from './routes/Files.tsx';
import { Library } from './routes/Library.tsx';
import { RoutesTab } from './routes/RoutesTab.tsx';
import { Tests } from './routes/Tests.tsx';
import { About } from './routes/About.tsx';
import { Config } from './routes/Config.tsx';

interface AppProps {
  /** Empty — App takes no props. Declared so the JSX type checks. */
}

/**
 * Module-scoped data cache. The Remix runtime re-instantiates `App`
 * every render (cheap), so we hoist the dataset out and trigger a
 * re-render via `handle.update()` once it loads.
 */
let cached: Dataset | null = null;
let loadError: string | null = null;
let loadStarted = false;
const subscribers = new Set<() => void>();

function ensureLoadStarted() {
  if (loadStarted) return;
  loadStarted = true;
  loadArtifacts()
    .then((data) => {
      cached = data;
      for (const fn of subscribers) fn();
    })
    .catch((err: unknown) => {
      loadError = err instanceof Error ? err.message : String(err);
      for (const fn of subscribers) fn();
    });
}

export function App(handle: Handle<AppProps>) {
  ensureLoadStarted();
  // Subscribe to data-cache changes so the App re-renders when
  // loadArtifacts() resolves. handle.signal aborts on unmount, so we
  // remove the subscriber automatically.
  const fire = () => { void handle.update(); };
  subscribers.add(fire);
  handle.signal.addEventListener('abort', () => subscribers.delete(fire));

  return () => {
    if (loadError) return <ErrorScreen message={loadError} />;
    if (!cached) return <Loading />;
    return <Shell data={cached} />;
  };
}

function ErrorScreen(_h: Handle<{ message: string }>) {
  return ({ message }: { message: string }) => (
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
}

function Loading(_h: Handle) {
  return () => (
    <div mix={css({ padding: '32px', color: 'var(--fg-muted)' })}>Loading…</div>
  );
}

function Shell(_h: Handle<{ data: Dataset }>) {
  return ({ data }: { data: Dataset }) => {
    const tab = activeTab(location.pathname);
    return (
      <>
        <a href="#main" class="skip-link">Skip to content</a>
        <div class="app-shell">
          <Header data={data} />
          <TreePanel data={data} />
          <main id="main">
            {renderRoute(tab, data)}
          </main>
          <StatusBar data={data} />
        </div>
      </>
    );
  };
}

function renderRoute(tab: ReturnType<typeof activeTab>, data: Dataset) {
  // Hand-rolled switch — small + obvious, no router needed beyond the
  // pathname → tab mapping in lib/routes.ts.
  switch (tab) {
    case 'overview': return <Overview data={data} />;
    case 'graph':    return <GraphRoute />;
    case 'dag':      return <Dag />;
    case 'files':    return <Files />;
    case 'library':  return <Library data={data} />;
    case 'routes':   return <RoutesTab data={data} />;
    case 'risks':    return <Risks data={data} />;
    case 'tests':    return <Tests />;
    case 'history':  return <History data={data} />;
    case 'about':    return <About data={data} />;
    case 'config':   return <Config />;
  }
}

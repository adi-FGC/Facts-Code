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
import { activeTab, TABS } from './lib/routes.ts';
import { loadArtifacts, type Dataset } from './lib/loadArtifacts.ts';
import { Header } from './components/Header.tsx';
import { TreePanel } from './components/TreePanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Overview } from './routes/Overview.tsx';
import { Architecture } from './routes/Architecture.tsx';
import { Modules } from './routes/Modules.tsx';
import { FilesTab } from './routes/FilesTab.tsx';
import { Docs } from './routes/Docs.tsx';
import { Review } from './routes/Review.tsx';
import { Security } from './routes/Security.tsx';
import { Tests } from './routes/Tests.tsx';
import { History } from './routes/History.tsx';
import { About } from './routes/About.tsx';
import { Config } from './routes/Config.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { CssSuggestionsPanel } from './ui/CssSuggestionsPanel.tsx';
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

/**
 * Root component — mounted ONCE by `createRoot` in main.tsx. The root handle
 * in this Remix UI runtime does NOT implement `handle.update()`, so the root
 * can't re-render itself. It simply mounts <AppRouter/>, a normal (non-root)
 * component whose `handle.update()` DOES work — and that drives every nav.
 *
 * Why not the old approach (re-call `root.render(<App/>)` on each nav event)?
 * In this VDOM `createRoot().render()` is NOT re-entrant: the 2nd+ call
 * unmounts the tree and silently fails to re-mount, blanking #root. That was
 * the "blank on client navigation, fine on hard refresh" bug. Single mount +
 * child `handle.update()` is the reliable pattern. (Fixed 2026-06-03.)
 */
export function App(_handle: Handle<AppProps>) {
  return () => <AppRouter />;
}

/**
 * The reactive router. Lives one level below the root, so its
 * `handle.update()` works (the same path every interactive component uses).
 * Subscribes to URL changes — `popstate` (back/forward) + `factstack:nav`
 * (dispatched by the in-app linkClick helper) — and the data-ready event,
 * and re-renders. The active route is derived from `location.pathname`,
 * threaded into <Shell> as the `path` prop so the swap is unmissable.
 */
function AppRouter(handle: Handle) {
  ensureLoadStarted();
  // AppRouter re-renders ONLY for the data lifecycle (Loading → Shell →
  // Error). That's a component TYPE change, i.e. a clean remount, which the
  // runtime handles. It deliberately does NOT listen for navigation events:
  // re-rendering this root-adjacent component IN PLACE corrupts the
  // reconciler and blanks the whole tree (the "blank on client nav, fine on
  // refresh" bug). Per-navigation reactivity lives in DEEP components —
  // RouteView (below) and NumberedNav — whose handle.update() patches a
  // small subtree, the same path SubViewTabs uses, which works reliably.
  const onData = () => {
    void handle.update();
  };
  window.addEventListener(DATA_READY_EVENT, onData);
  handle.signal.addEventListener('abort', () => {
    window.removeEventListener(DATA_READY_EVENT, onData);
  });
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
            {/* RouteView is the per-navigation reactive boundary (see below).
                Shell itself mounts once and never patches, so the chrome
                (Header, file tree, status bar) keeps its state across navs. */}
            <RouteView data={data} />
          </main>
          <StatusBar data={data} />
          {/* a11y: polite live region; RouteView.onChange writes the active
              view name here on client-side navigation so screen-reader users
              get the route-change signal a SPA otherwise swallows. Visually
              hidden via .sr-only (a class, not an inline style — CSP-clean). */}
          <div id="route-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>
        </div>
        {/* Command palette overlays everything when open. The component
            attaches its own document-level ⌘K listener so it doesn't
            need wiring into Header. */}
        <CommandPalette data={data} />
        {/* OpenModal: always mounted, invisible until ⌘O or a header
            button dispatches `factstack:open`. Owns its own state and
            cleanup; no wiring needed beyond mounting. */}
        <OpenModal />
        {/* CSS audit drawer: a collapsible RHS panel whose handle badge is a
            live suggestion ticker. Hides when the scanned project has no CSS. */}
        <CssSuggestionsPanel data={data} />
      </>
    );
  };
}

/**
 * RouteView — the per-navigation reactive boundary. Deep in the tree
 * (App → AppRouter → Shell → main → RouteView), so its `handle.update()`
 * patches only the route subtree — exactly like SubViewTabs, which works,
 * whereas re-rendering the root-adjacent Shell in place blanks the whole
 * tree. Subscribes to URL changes — `popstate` (back/forward) and the in-app
 * `factstack:nav` event (from the linkClick helper) — and re-renders the
 * active route. (Blank-on-client-nav fix, 2026-06-03.)
 */
function RouteView(handle: Handle<{ data: Dataset }>) {
  const onChange = () => {
    void handle.update();
    /* a11y: after the route subtree patches, announce the new view to assistive
       tech and move focus into <main> so a subsequent Tab resumes in the new
       content rather than the header nav. rAF waits for the patched DOM (same
       pattern as NumberedNav.scrollActiveIntoView). preventScroll keeps the
       viewport put — the new content already starts at the top of <main>. */
    requestAnimationFrame(() => {
      const label = TABS.find((t) => t.key === activeTab(location.pathname))?.label ?? 'Page';
      const announcer = document.getElementById('route-announcer');
      if (announcer) announcer.textContent = `${label} view loaded`;
      (document.getElementById('main') as HTMLElement | null)?.focus({ preventScroll: true });
    });
  };
  window.addEventListener('popstate', onChange);
  window.addEventListener('factstack:nav', onChange);
  handle.signal.addEventListener('abort', () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('factstack:nav', onChange);
  });
  return () => renderRoute(activeTab(location.pathname), handle.props.data);
}

function renderRoute(tab: ReturnType<typeof activeTab>, data: Dataset) {
  // Hand-rolled switch — small + obvious, no router needed beyond the
  // pathname → tab mapping in lib/routes.ts.
  switch (tab) {
    case 'overview':     return <Overview data={data} />;
    case 'architecture': return <Architecture data={data} />;
    case 'modules':      return <Modules data={data} />;
    case 'files':        return <FilesTab data={data} />;
    case 'docs':         return <Docs data={data} />;
    case 'review':       return <Review data={data} />;
    case 'security':     return <Security data={data} />;
    case 'tests':        return <Tests data={data} />;
    case 'history':      return <History data={data} />;
    case 'config':       return <Config data={data} />;
    case 'about':        return <About data={data} />;
  }
}

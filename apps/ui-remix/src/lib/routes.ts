/**
 * Route catalog — single source of truth for every page in the app.
 *
 * Uses `remix/route-pattern` (Remix v3 beta) for strongly-typed URL
 * matching and generation. This lets the rest of the app reference
 * routes by name (`tabs.routes.href()`) instead of stringly-typed
 * paths that drift when we rename a page.
 *
 * Why Remix's RoutePattern over hand-rolled strings:
 *   - typed param extraction (e.g. `/files/:path` → `{ path: string }`)
 *   - `href()` method gives compile-time errors for missing params
 *   - the same patterns can match incoming requests if/when we add
 *     server-side endpoints later (e.g. `/api/reanalyze` becomes a
 *     RoutePattern instance shared by client + server).
 */
import { RoutePattern } from 'remix/route-pattern';

/**
 * The 11 global tabs that mirror the legacy prototype's surface.
 * Order is canonical — used by the Header tablist.
 */
export const tabPatterns = {
  overview: new RoutePattern('/'),
  graph:    new RoutePattern('/graph'),
  dag:      new RoutePattern('/dag'),
  files:    new RoutePattern('/files'),
  library:  new RoutePattern('/library'),
  routes:   new RoutePattern('/routes'),
  risks:    new RoutePattern('/risks'),
  tests:    new RoutePattern('/tests'),
  history:  new RoutePattern('/history'),
  about:    new RoutePattern('/about'),
  config:   new RoutePattern('/config'),
} as const;

export type TabKey = keyof typeof tabPatterns;

/**
 * Tab metadata used by the Header. The href() calls happen once at
 * module load — they're constants for the lifetime of the app.
 */
export interface TabMeta {
  key: TabKey;
  label: string;
  href: string;
  /**
   * `true` when the route is fully implemented; `false` for stubs
   * that point at the legacy prototype. Header uses this to render
   * a "porting" badge.
   */
  ported: boolean;
}

export const TABS: readonly TabMeta[] = [
  { key: 'overview', label: 'Overview', href: tabPatterns.overview.href(), ported: true  },
  { key: 'graph',    label: 'Graph',    href: tabPatterns.graph.href(),    ported: true  },
  { key: 'dag',      label: 'DAG',      href: tabPatterns.dag.href(),      ported: false },
  { key: 'files',    label: 'Files',    href: tabPatterns.files.href(),    ported: true  },
  { key: 'library',  label: 'Library',  href: tabPatterns.library.href(),  ported: false },
  { key: 'routes',   label: 'Routes',   href: tabPatterns.routes.href(),   ported: false },
  { key: 'risks',    label: 'Risks',    href: tabPatterns.risks.href(),    ported: true  },
  { key: 'tests',    label: 'Tests',    href: tabPatterns.tests.href(),    ported: false },
  { key: 'history',  label: 'History',  href: tabPatterns.history.href(),  ported: true  },
  { key: 'about',    label: 'About',    href: tabPatterns.about.href(),    ported: false },
  { key: 'config',   label: 'Config',   href: tabPatterns.config.href(),   ported: false },
] as const;

/** Public URL of the legacy prototype demo, for "see this feature working" links. */
export const LEGACY_DEMO_URL = 'https://factstack-demo.netlify.app';

/**
 * Route catalog — single source of truth for every page in the app.
 *
 * Uses `remix/route-pattern` for strongly-typed URL matching and
 * `href()` generation. Same data structure feeds the Header tablist
 * and the App's route table.
 */
import { RoutePattern } from 'remix/route-pattern';

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

export interface TabMeta {
  key: TabKey;
  label: string;
  href: string;
  /**
   * `true` when the route renders the actual feature. `false` flips on
   * the "porting" amber dot in the Header so users see the work in
   * progress.
   */
  ported: boolean;
}

export const TABS: readonly TabMeta[] = [
  { key: 'overview', label: 'Overview', href: tabPatterns.overview.href(), ported: true  },
  { key: 'graph',    label: 'Graph',    href: tabPatterns.graph.href(),    ported: false },
  { key: 'dag',      label: 'DAG',      href: tabPatterns.dag.href(),      ported: false },
  { key: 'files',    label: 'Files',    href: tabPatterns.files.href(),    ported: false },
  { key: 'library',  label: 'Library',  href: tabPatterns.library.href(),  ported: true  },
  { key: 'routes',   label: 'Routes',   href: tabPatterns.routes.href(),   ported: true  },
  { key: 'risks',    label: 'Risks',    href: tabPatterns.risks.href(),    ported: true  },
  { key: 'tests',    label: 'Tests',    href: tabPatterns.tests.href(),    ported: false },
  { key: 'history',  label: 'History',  href: tabPatterns.history.href(),  ported: true  },
  { key: 'about',    label: 'About',    href: tabPatterns.about.href(),    ported: true  },
  { key: 'config',   label: 'Config',   href: tabPatterns.config.href(),   ported: false },
] as const;

/**
 * Match the current pathname to a tab key. Falls back to `overview` for
 * anything unrecognized — same behavior as React Router's `<Navigate />`
 * fallback in the previous version.
 */
export function activeTab(pathname: string): TabKey {
  // Strip trailing slash (except for root)
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  for (const t of TABS) {
    if (t.href === p) return t.key;
  }
  return 'overview';
}

export const LEGACY_DEMO_URL = 'https://factstack-demo.netlify.app';

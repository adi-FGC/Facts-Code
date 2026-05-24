/**
 * Route catalog — single source of truth for every page in the app.
 *
 * Uses `remix/route-pattern` for strongly-typed URL matching and
 * `createHref()` (from the modular `remix/route-pattern/href` subpath)
 * for href generation. Same data structure feeds the Header tablist
 * and the App's route table.
 *
 * Migration note (beta.2, 2026-05-22): `route-pattern` was split into
 * per-API subpaths (`/href`, `/match`, `/join`, `/specificity`) in
 * PR #11400. The old `pattern.href()` instance method is gone —
 * we now call the standalone `createHref(pattern)` factory. For
 * parameter-less routes that's a no-arg call; for parametric routes
 * (`/users/:id`) you'd pass `createHref(pattern, { id })`.
 */
import { RoutePattern } from 'remix/route-pattern';
import { createHref } from 'remix/route-pattern/href';

/* `RoutePattern.parse(source)` is the canonical factory in beta.2.
 * The old `new RoutePattern(source)` direct constructor is now
 * reserved for pre-parsed parts (see RoutePattern.d.ts) — passing a
 * source string to `new RoutePattern` is a type error now. The
 * parse-method form is what every demo uses. */
export const tabPatterns = {
  overview: RoutePattern.parse('/'),
  /* /graph absorbed /dag in v0.4 — three view modes (heatmap, diagram,
   * layers) live behind one tab now. The /dag route still resolves to
   * the Graph tab via the `dagAlias` matcher in `activeTab` so old
   * deep links don't 404. */
  graph:    RoutePattern.parse('/graph'),
  /* /flow added in v0.5 — architectural data-flow + entity relationships.
   * Sits between graph and files because the narrative is: see the
   * structure (graph), see what flows through it (flow), then drill
   * into individual files. */
  flow:     RoutePattern.parse('/flow'),
  files:    RoutePattern.parse('/files'),
  library:  RoutePattern.parse('/library'),
  routes:   RoutePattern.parse('/routes'),
  risks:    RoutePattern.parse('/risks'),
  tests:    RoutePattern.parse('/tests'),
  history:  RoutePattern.parse('/history'),
  about:    RoutePattern.parse('/about'),
  config:   RoutePattern.parse('/config'),
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
  { key: 'overview', label: 'Overview', href: createHref(tabPatterns.overview), ported: true  },
  { key: 'graph',    label: 'Graph',    href: createHref(tabPatterns.graph),    ported: true  },
  { key: 'flow',     label: 'Flow',     href: createHref(tabPatterns.flow),     ported: true  },
  { key: 'files',    label: 'Files',    href: createHref(tabPatterns.files),    ported: true  },
  { key: 'library',  label: 'Library',  href: createHref(tabPatterns.library),  ported: true  },
  { key: 'routes',   label: 'Routes',   href: createHref(tabPatterns.routes),   ported: true  },
  { key: 'risks',    label: 'Risks',    href: createHref(tabPatterns.risks),    ported: true  },
  { key: 'tests',    label: 'Tests',    href: createHref(tabPatterns.tests),    ported: true  },
  { key: 'history',  label: 'History',  href: createHref(tabPatterns.history),  ported: true  },
  { key: 'about',    label: 'About',    href: createHref(tabPatterns.about),    ported: true  },
  { key: 'config',   label: 'Config',   href: createHref(tabPatterns.config),   ported: true  },
] as const;

/**
 * Match the current pathname to a tab key. Falls back to `overview` for
 * anything unrecognized — same behavior as React Router's `<Navigate />`
 * fallback in the previous version.
 */
export function activeTab(pathname: string): TabKey {
  // Strip trailing slash (except for root)
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  /* /dag was the layered DAG tab in v0.3 — merged into /graph in v0.4.
     Old links + bookmarks resolve to the Graph tab so they don't 404. */
  if (p === '/dag') return 'graph';
  for (const t of TABS) {
    if (t.href === p) return t.key;
  }
  return 'overview';
}

export const LEGACY_DEMO_URL = 'https://factstack-demo.netlify.app';

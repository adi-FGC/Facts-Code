/**
 * Route catalog — the plain label+path pairs for every page in the
 * FACTS web app, as pure data with NO framework dependency.
 *
 * `apps/ui-remix/src/lib/routes.ts` owns the `remix/route-pattern`
 * matching machinery (RoutePattern parsing, `createHref`, alias
 * resolution). But the label+path LIST it renders must also be reachable
 * from the isomorphic spec tier — the discoverability artifacts
 * (sitemap.xml, llms.txt route list, .well-known/mcp.json) need to
 * enumerate the app's routes without pulling `remix/*` into
 * `@factstack/spec` (which has no deps outside zod).
 *
 * So this file is the single source of truth for the label+path pairs;
 * the UI's routes.ts imports `ROUTE_CATALOG` from here and derives its
 * `TABS` / `ICON_TABS` hrefs from it, so the two can't drift.
 *
 * 11 routes total: 9 numbered nav tabs + 2 right-side icon destinations
 * (Config gear, About ?↔!). Order matches the UI's tablist.
 */

export interface RouteMeta {
  /** URL path, root-relative, no trailing slash (except '/'). */
  path: string;
  /** Human-readable tab label. */
  label: string;
}

/** The 9 numbered nav tabs, in display order. */
export const ROUTE_CATALOG: readonly RouteMeta[] = [
  { path: '/', label: 'Overview' },
  { path: '/architecture', label: 'Architecture' },
  { path: '/modules', label: 'Modules' },
  { path: '/files', label: 'Files' },
  { path: '/docs', label: 'Docs' },
  { path: '/review', label: 'Review' },
  { path: '/security', label: 'Security' },
  { path: '/tests', label: 'Tests' },
  { path: '/history', label: 'History' },
  /* Right-side icon destinations — reachable by URL + the header
     ConfigIcon / AboutIcon, but not part of the numbered nav. */
  { path: '/config', label: 'Config' },
  { path: '/about', label: 'About' },
] as const;

/**
 * Route catalog — single source of truth for every page in the app.
 *
 * Uses `remix/route-pattern` for strongly-typed URL matching and
 * `createHref()` (from the modular `remix/route-pattern/href` subpath)
 * for href generation. Same data structure feeds the Header tablist
 * and the App's route table.
 *
 * v0.9 IA consolidation — 14 tabs collapsed to 7 numbered tabs + 2
 * right-side icon routes:
 *
 *   01 Overview      (+ token-economics ROI panel)
 *   02 Architecture  ← Graph + Flow + Routes   (SubViewTabs)
 *   03 Files         ← Files + Library/Packages (SubViewTabs)
 *   04 Review        (Change Verdict)
 *   05 Security      ← Risks + Credentials + Vulnerabilities (SubViewTabs)
 *   06 Tests
 *   07 History
 *   ⚙  Config        (right-side rotating-gear icon, not numbered)
 *   ?  About         (right-side ?↔! icon, not numbered)
 *
 * Every retired URL (/graph, /flow, /routes, /risks, /credentials,
 * /vulnerabilities, /library, /dag) still resolves — see `activeTab` —
 * and SubViewTabs reads the pathname to pre-select the right sub-view,
 * so old bookmarks land exactly where they used to.
 */
import { RoutePattern } from 'remix/route-pattern';
import { createHref } from 'remix/route-pattern/href';
import { ROUTE_CATALOG } from '@factstack/spec';

/**
 * The label+path list is sourced from `ROUTE_CATALOG` in `@factstack/spec`
 * (pure data, no `remix/*` dep) so the discoverability artifacts
 * (sitemap.xml, llms.txt, .well-known/mcp.json) and this app's tablist
 * can't drift. This module keeps the RoutePattern machinery for typed
 * matching + href generation; it just no longer hardcodes the labels.
 *
 * Index the catalog by path so the TABS / ICON_TABS builders below can
 * look up a label for a given route without re-listing them here.
 */
const LABEL_BY_PATH = new Map(ROUTE_CATALOG.map((r) => [r.path, r.label]));
function labelFor(path: string): string {
  const label = LABEL_BY_PATH.get(path);
  if (!label) {
    // A tab pattern with no catalog entry is a drift bug — fail loud in
    // dev rather than render a blank tab. (All 11 patterns below have an
    // entry; this guards future additions.)
    throw new Error(`routes.ts: no ROUTE_CATALOG label for "${path}" — add it to packages/spec/src/routes.ts.`);
  }
  return label;
}

export const tabPatterns = {
  overview: RoutePattern.parse('/'),
  architecture: RoutePattern.parse('/architecture'),
  modules: RoutePattern.parse('/modules'),
  files: RoutePattern.parse('/files'),
  docs: RoutePattern.parse('/docs'),
  review: RoutePattern.parse('/review'),
  security: RoutePattern.parse('/security'),
  tests: RoutePattern.parse('/tests'),
  history: RoutePattern.parse('/history'),
  /* Meta destinations — reachable by URL and by the right-side header
     icons (ConfigIcon / AboutIcon), but NOT part of the numbered nav. */
  config: RoutePattern.parse('/config'),
  about: RoutePattern.parse('/about'),
} as const;

export type TabKey = keyof typeof tabPatterns;

export interface TabMeta {
  key: TabKey;
  label: string;
  href: string;
  /**
   * `true` when the route renders the actual feature. `false` flips on
   * the "porting" amber dot in the Header so users see the work in
   * progress. All routes are ported as of v0.9.
   */
  ported: boolean;
}

/** The numbered nav — 9 primary tabs. Config + About are rendered as
 *  right-side icons by the Header, not here. */
/** Build a TabMeta from a pattern key. Href comes from the RoutePattern
 *  machinery; label comes from ROUTE_CATALOG (the single source of truth
 *  shared with the discoverability artifacts). All tabs are ported. */
function tab(key: TabKey): TabMeta {
  const href = createHref(tabPatterns[key]);
  return { key, label: labelFor(href), href, ported: true };
}

export const TABS: readonly TabMeta[] = [
  tab('overview'),
  tab('architecture'),
  tab('modules'),
  tab('files'),
  tab('docs'),
  tab('review'),
  tab('security'),
  tab('tests'),
  tab('history'),
] as const;

/** Right-side icon destinations (Config gear, About ?↔!). */
export const ICON_TABS: readonly TabMeta[] = [
  tab('config'),
  tab('about'),
] as const;

/**
 * Aliases: retired URLs → the tab that now hosts them. SubViewTabs uses
 * the original pathname to pick the sub-view, so these only need to map
 * to the parent tab for nav-highlight + routing purposes.
 */
const ALIASES: Record<string, TabKey> = {
  '/dag': 'architecture',
  '/graph': 'architecture',
  '/flow': 'architecture',
  '/routes': 'architecture',
  '/risks': 'security',
  '/credentials': 'security',
  '/vulnerabilities': 'security',
  '/library': 'files',
};

/**
 * Match the current pathname to a tab key. Falls back to `overview` for
 * anything unrecognized.
 */
export function activeTab(pathname: string): TabKey {
  // Strip trailing slash (except for root)
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const alias = ALIASES[p];
  if (alias) return alias;
  for (const t of TABS) {
    if (t.href === p) return t.key;
  }
  for (const t of ICON_TABS) {
    if (t.href === p) return t.key;
  }
  return 'overview';
}

export const LEGACY_DEMO_URL = 'https://factstack-demo.netlify.app';

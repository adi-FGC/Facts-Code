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

export const tabPatterns = {
  overview: RoutePattern.parse('/'),
  architecture: RoutePattern.parse('/architecture'),
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

/** The numbered nav — 7 primary tabs. Config + About are rendered as
 *  right-side icons by the Header, not here. */
export const TABS: readonly TabMeta[] = [
  { key: 'overview',     label: 'Overview',     href: createHref(tabPatterns.overview),     ported: true },
  { key: 'architecture', label: 'Architecture', href: createHref(tabPatterns.architecture), ported: true },
  { key: 'files',        label: 'Files',        href: createHref(tabPatterns.files),        ported: true },
  { key: 'docs',         label: 'Docs',         href: createHref(tabPatterns.docs),         ported: true },
  { key: 'review',       label: 'Review',       href: createHref(tabPatterns.review),       ported: true },
  { key: 'security',     label: 'Security',     href: createHref(tabPatterns.security),     ported: true },
  { key: 'tests',        label: 'Tests',        href: createHref(tabPatterns.tests),        ported: true },
  { key: 'history',      label: 'History',      href: createHref(tabPatterns.history),      ported: true },
] as const;

/** Right-side icon destinations (Config gear, About ?↔!). */
export const ICON_TABS: readonly TabMeta[] = [
  { key: 'config', label: 'Config', href: createHref(tabPatterns.config), ported: true },
  { key: 'about',  label: 'About',  href: createHref(tabPatterns.about),  ported: true },
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

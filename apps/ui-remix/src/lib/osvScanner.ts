/**
 * UI adapter over @factstack/scanners' OSV client.
 *
 * The shared OSV implementation lives in
 * `packages/scanners/src/vulnerabilities.ts` and is used by both the
 * UI (this file) and the CLI's `scan-vulns` subcommand. The single
 * implementation guarantees the UI's "live re-query" path and the
 * CLI's analyze-time path produce identical OsvResult shapes — and
 * write the same `Vulnerability[]` rows to the artifact when persisted.
 *
 * What this thin adapter adds on top of the shared client:
 *   1. A `localStorageCache` adapter satisfying the shared `CacheStore`
 *      interface. 6-hour TTL. Persists across reloads. CLI uses a
 *      filesystem cache instead — same `CacheStore` shape, different
 *      backend; the client doesn't care.
 *   2. A `parseNpmManifestForOsv(text)` helper for the paste flow.
 *      Reuses the shared `scanDependencyManifest` + `buildOsvQueries`
 *      so the parser drift between paste-flow and analyze-flow is zero.
 *
 * The severity bucketer, fixed-version picker and graded/label helpers are
 * re-exported unchanged: the dashboard grades a live or weekly OSV result
 * with exactly the code the CLI and MCP use (INV7) — never a local copy.
 * Only the Vulnerabilities route imports this module (a lazy tab chunk), so
 * the main bundle never carries it.
 */

import {
  queryOsvBatch as sharedQueryOsvBatch,
  scanDependencyManifest,
  buildOsvQueries,
  bucketSeverity,
  pickFixedVersion,
  pickAdvisoryUrl,
  isGradedVulnerability,
  vulnerabilityLabels,
  VULN_LABEL_TEXT,
  makeCacheKey,
  type CacheStore,
  type DependencyScope,
  type ManifestWithResolved,
  type OsvQuery,
  type OsvResult,
  type OsvVuln,
  type BatchOptions,
  type VersionSource,
} from '@factstack/scanners';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_PREFIX = 'factstack:osv:';

/* Re-export the canonical types so route + nested components have one
 * import surface for "OSV stuff." The route already imports these
 * type-only at the top of its file; this re-export keeps that working
 * unchanged after the adapter switch. */
export type { OsvQuery, OsvResult, OsvVuln, BatchOptions, DependencyScope, VersionSource };
export type { ManifestEcosystem, VulnerabilitySeverity } from '@factstack/spec';
export {
  bucketSeverity,
  pickFixedVersion,
  pickAdvisoryUrl,
  isGradedVulnerability,
  vulnerabilityLabels,
  VULN_LABEL_TEXT,
};

/* ─────────── localStorage cache adapter ─────────── */

interface CacheEntry {
  ts: number;
  results: OsvResult[];
}

export const localStorageCache: CacheStore = {
  get(key: string): OsvResult[] | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() - entry.ts > CACHE_TTL_MS) {
        localStorage.removeItem(CACHE_PREFIX + key);
        return null;
      }
      return entry.results;
    } catch {
      return null;
    }
  },
  set(key: string, results: OsvResult[]): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const entry: CacheEntry = { ts: Date.now(), results };
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
    } catch {
      /* Quota / private mode — silently swallow. In-memory results still
         work for this scan; subsequent scans will re-query. */
    }
  },
};

/**
 * Query OSV using the shared client + the localStorage cache. Most
 * UI callers want this combo; pass `{ bypassCache: true }` to force
 * a fresh query.
 */
export function queryOsvBatch(
  queries: OsvQuery[],
  opts: Omit<BatchOptions, 'cache'> = {},
): Promise<OsvResult[]> {
  return sharedQueryOsvBatch(queries, { ...opts, cache: localStorageCache });
}

/* ─────────── paste-flow manifest parser ─────────── */

/**
 * Parse a pasted package.json into OSV queries. Reuses the shared
 * `scanDependencyManifest` so the paste flow and the analyze flow
 * produce identical dep extraction — when you paste the same file
 * the CLI analyzes, you get identical query sets.
 *
 * Returns [] for non-JSON or non-npm manifests. The route surfaces
 * "no deps extracted" rather than silently failing.
 *
 * The shared parser picks the ecosystem from the file NAME, and a paste has
 * none — `pasted-manifest` matched nothing, so every paste came back empty.
 * The text is parsed as a package.json and the queries are labelled with
 * `sourcePath`. Queries come from `buildOsvQueries` (aliases resolved,
 * x-ranges padded, `declared-range` / `dev` labels set), as in the CLI.
 */
export function parseNpmManifestForOsv(text: string, sourcePath = 'pasted-manifest'): OsvQuery[] {
  const asFile = sourcePath.split('/').pop() === 'package.json' ? sourcePath : 'package.json';
  const manifest = scanDependencyManifest(asFile, text);
  if (!manifest || manifest.ecosystem !== 'npm') return [];
  const labelled = { ...manifest, path: sourcePath } as ManifestWithResolved;
  return buildOsvQueries([labelled]).queries;
}

/* ─────────── result summary ─────────── */

export interface OsvSummary {
  /** GRADED advisories per severity bucket (direct runtime deps and
   *  unlabelled legacy queries — isGradedVulnerability). */
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
  /** Every advisory, graded or not. */
  total: number;
  /** Advisories on dev / transitive packages: shown, not graded. */
  ungraded: number;
  cleanPackages: number;
  vulnerablePackages: number;
  /** Advisories whose detail fetch failed (id only, severity 'unknown'). */
  degraded: number;
}

/** Counts for a live or weekly OSV result set. Severity comes from the
 *  shared `bucketSeverity`, so a live re-check grades an advisory exactly as
 *  the CLI's artifact does. */
export function summarizeOsvResults(results: readonly OsvResult[]): OsvSummary {
  const s: OsvSummary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    total: 0,
    ungraded: 0,
    cleanPackages: 0,
    vulnerablePackages: 0,
    degraded: 0,
  };
  for (const r of results) {
    s.degraded += r.detailsFailed ?? 0;
    if (r.vulns.length === 0) {
      s.cleanPackages++;
      continue;
    }
    s.vulnerablePackages++;
    s.total += r.vulns.length;
    if (!isGradedVulnerability(r.query)) {
      s.ungraded += r.vulns.length;
      continue;
    }
    for (const v of r.vulns) s[bucketSeverity(v)]++;
  }
  return s;
}

/* ─────────── weekly self-refresh ───────────
 *
 * A deployed dashboard is a snapshot: its advisories are as old as the last
 * `factstack scan-vulns` that ran before the build. OSV publishes daily, so a
 * site that is not redeployed for a month is quietly telling every visitor
 * that a month-old answer is current.
 *
 * So the page re-checks itself. When the baked scan is older than a week, the
 * Security tab re-queries OSV for the dependency manifests the analyzer
 * already extracted (no paste, no server) and shows that result instead,
 * labelled with where it came from. The answer is cached per visitor for a
 * week, so a returning reader costs nothing and OSV sees one request set per
 * browser per week — an hour, when OSV answered only in part.
 *
 * The baked scan stays in the artifact as the offline answer — this only
 * supersedes it in a live browser that could reach OSV.
 */

/** Default staleness threshold. Matches the CLI's own `scan-vulns` cadence. */
export const AUTO_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a PARTIAL answer (advisories whose details loaded id-only) is
 *  reused: an hour, not a week. Severity 'unknown' is never served for seven
 *  days, and an advisory whose detail never loads costs one request set an
 *  hour instead of one per page view (SCN-16 / UI-R3). */
export const AUTO_REFRESH_PARTIAL_MS = 60 * 60 * 1000;
const AUTO_KEY = 'factstack:osv:auto';

/** True when an OSV answer holds advisories whose details did not load. */
export function isPartialAnswer(results: readonly OsvResult[]): boolean {
  return results.some((r) => (r.detailsFailed ?? 0) > 0);
}

export interface AutoRefreshRecord {
  /** When this browser last completed a refresh. */
  at: number;
  /** Fingerprint of the manifest set, so a redeploy with changed deps re-queries. */
  fingerprint: string;
  results: OsvResult[];
}

/**
 * Should this page re-check OSV right now?
 *
 * Pure on purpose: the decision is the whole feature — "re-check weekly,
 * never more often, never when the build is already current" — and it is
 * worth more as something a test can pin than as three conditions inside a
 * component.
 *
 *   - `use-cache`  a refresh from this browser is still inside the week
 *                  (inside the hour, when that refresh was partial).
 *   - `refresh`    the baked scan has aged past the window; ask OSV.
 *   - `skip`       the build's scan is current, or nothing to ask about,
 *                  or this browser says it is offline.
 */
export function weeklyRefreshDecision(input: {
  /** Epoch ms of the scan baked at build time; 0 or undefined when none ran. */
  bakedAt?: number | undefined;
  /** Epoch ms of this browser's last refresh for the same dependency set. */
  cachedAt?: number | undefined;
  /** That refresh held advisories whose details did not load (isPartialAnswer). */
  cachedPartial?: boolean | undefined;
  now: number;
  online: boolean;
  queryCount: number;
  windowMs?: number;
  partialWindowMs?: number;
}): 'refresh' | 'use-cache' | 'skip' {
  const windowMs = input.windowMs ?? AUTO_REFRESH_AFTER_MS;
  const cacheWindow = input.cachedPartial
    ? (input.partialWindowMs ?? AUTO_REFRESH_PARTIAL_MS)
    : windowMs;
  if (input.queryCount === 0) return 'skip';
  if (input.cachedAt && input.now - input.cachedAt < cacheWindow) {
    /* Only worth showing if it is actually newer than what was baked. */
    return input.cachedAt > (input.bakedAt ?? 0) ? 'use-cache' : 'skip';
  }
  if (!input.online) return 'skip';
  const bakedAge = input.bakedAt ? input.now - input.bakedAt : Infinity;
  return bakedAge >= windowMs ? 'refresh' : 'skip';
}

/** Stable fingerprint of what we are about to ask about. */
export function manifestFingerprint(queries: OsvQuery[]): string {
  return queries
    .map((q) => `${q.ecosystem}:${q.name}@${q.version}`)
    .sort()
    .join('|');
}

export function readAutoRefresh(fingerprint: string): AutoRefreshRecord | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as AutoRefreshRecord;
    if (rec.fingerprint !== fingerprint) return null;
    if (!Array.isArray(rec.results) || typeof rec.at !== 'number') return null;
    return rec;
  } catch {
    return null;
  }
}

export function writeAutoRefresh(rec: AutoRefreshRecord): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AUTO_KEY, JSON.stringify(rec));
  } catch {
    /* Quota / private mode: the refresh still applies to this page view. */
  }
}

/**
 * OSV queries for the manifests the analyzer already parsed — built by the
 * same `buildOsvQueries` that `factstack scan-vulns` and the MCP refresh use
 * (INV7), so the weekly re-check asks about exactly what the artifact's scan
 * asked about: installed versions the artifact carried (`resolved`), npm
 * aliases under their real name, one query per package@version across a
 * monorepo, and `scope` / `versionSource` labels on every query.
 *
 * Workspace / file / git protocol versions are unqueryable and are skipped —
 * the same ones `factstack scan-vulns` reports as "not queryable". The browser
 * has no lockfile text, so transitive packages are not re-checked here.
 */
export function queriesFromManifests(
  manifests: ReadonlyArray<{
    path: string;
    ecosystem: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>,
): OsvQuery[] {
  /* Raw dataset JSON may omit either dep map; buildOsvQueries tolerates that. */
  return buildOsvQueries(manifests as readonly ManifestWithResolved[]).queries;
}

/* ─────────── re-exports for cache-key helpers ─────────── */

export { makeCacheKey };

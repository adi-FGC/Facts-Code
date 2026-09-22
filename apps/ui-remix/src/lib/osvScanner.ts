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
 *      Reuses the shared `scanDependencyManifest` + `normalizeNpmVersion`
 *      so the parser drift between paste-flow and analyze-flow is zero.
 *
 * Dynamic-importable: the route's `<Vulnerabilities>` route type-only
 * imports the OsvQuery / OsvResult / OsvVuln types, then dynamic-imports
 * THIS module on the Scan button click. Main bundle pays type-only cost.
 */

import {
  queryOsvBatch as sharedQueryOsvBatch,
  scanDependencyManifest,
  normalizeNpmVersion,
  bucketSeverity,
  pickFixedVersion,
  pickAdvisoryUrl,
  makeCacheKey,
  type CacheStore,
  type OsvQuery,
  type OsvResult,
  type OsvVuln,
  type BatchOptions,
} from '@factstack/scanners';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_PREFIX = 'factstack:osv:';

/* Re-export the canonical types so route + nested components have one
 * import surface for "OSV stuff." The route already imports these
 * type-only at the top of its file; this re-export keeps that working
 * unchanged after the adapter switch. */
export type { OsvQuery, OsvResult, OsvVuln, BatchOptions };
export type { ManifestEcosystem, VulnerabilitySeverity } from '@factstack/spec';
/* Legacy alias for the previous `SeverityBucket` name used by the route. */
export type SeverityBucket = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
export { bucketSeverity, pickFixedVersion, pickAdvisoryUrl };

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
 */
export function parseNpmManifestForOsv(text: string, sourcePath = 'pasted-manifest'): OsvQuery[] {
  const manifest = scanDependencyManifest(sourcePath, text);
  if (!manifest || manifest.ecosystem !== 'npm') return [];
  const out: OsvQuery[] = [];
  const merged: Record<string, string> = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  for (const [name, raw] of Object.entries(merged)) {
    const version = normalizeNpmVersion(raw);
    if (!version) continue;
    out.push({
      ecosystem: 'npm',
      name,
      version,
      manifestPath: sourcePath,
    });
  }
  return out;
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
 * browser per week.
 *
 * The baked scan stays in the artifact as the offline answer — this only
 * supersedes it in a live browser that could reach OSV.
 */

/** Default staleness threshold. Matches the CLI's own `scan-vulns` cadence. */
export const AUTO_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_KEY = 'factstack:osv:auto';

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
 *   - `use-cache`  a refresh from this browser is still inside the week.
 *   - `refresh`    the baked scan has aged past the window; ask OSV.
 *   - `skip`       the build's scan is current, or nothing to ask about,
 *                  or this browser says it is offline.
 */
export function weeklyRefreshDecision(input: {
  /** Epoch ms of the scan baked at build time; 0 or undefined when none ran. */
  bakedAt?: number | undefined;
  /** Epoch ms of this browser's last refresh for the same dependency set. */
  cachedAt?: number | undefined;
  now: number;
  online: boolean;
  queryCount: number;
  windowMs?: number;
}): 'refresh' | 'use-cache' | 'skip' {
  const windowMs = input.windowMs ?? AUTO_REFRESH_AFTER_MS;
  if (input.queryCount === 0) return 'skip';
  if (input.cachedAt && input.now - input.cachedAt < windowMs) {
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
 * OSV queries for the manifests the analyzer already parsed. Mirrors
 * `parseNpmManifestForOsv`, but reads the structured `dependencyManifests[]`
 * from the dataset instead of pasted text, so the auto-refresh asks about
 * exactly what the artifact reports.
 *
 * Workspace / file / git protocol versions are unqueryable and are skipped —
 * the same ones `factstack scan-vulns` reports as "not queryable".
 */
export function queriesFromManifests(
  manifests: ReadonlyArray<{
    path: string;
    ecosystem: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>,
): OsvQuery[] {
  const out: OsvQuery[] = [];
  const seen = new Set<string>();
  for (const m of manifests) {
    if (m.ecosystem !== 'npm') continue; // the only ecosystem the parser covers today
    const merged = { ...(m.dependencies ?? {}), ...(m.devDependencies ?? {}) };
    for (const [name, raw] of Object.entries(merged)) {
      const version = normalizeNpmVersion(raw);
      if (!version) continue;
      const key = `${name}@${version}`;
      if (seen.has(key)) continue; // a monorepo pins the same dep in many manifests
      seen.add(key);
      out.push({ ecosystem: 'npm', name, version, manifestPath: m.path });
    }
  }
  return out;
}

/* ─────────── re-exports for cache-key helpers ─────────── */

export { makeCacheKey };

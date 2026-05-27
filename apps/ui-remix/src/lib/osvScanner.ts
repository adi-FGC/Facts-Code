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

interface CacheEntry { ts: number; results: OsvResult[]; }

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

/* ─────────── re-exports for cache-key helpers ─────────── */

export { makeCacheKey };

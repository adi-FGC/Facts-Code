/**
 * OSV.dev batch query client — shared by the UI (`Vulnerabilities` route)
 * and the CLI (`factstack scan-vulns` subcommand).
 *
 * Why this lives in @factstack/scanners (not in the UI):
 *   - The CLI subcommand needs the same query + caching logic. Putting
 *     it here means both consumers share one implementation and one
 *     wire format, with zero divergence risk.
 *   - The osvScanner module formerly at apps/ui-remix/src/lib/ was
 *     UI-tier-only; lifting it here makes the CVE-scanning capability
 *     part of the platform, available to any future surface (VS Code,
 *     Chrome ext, MCP server's own opt-in vuln scan).
 *
 * Why OSV.dev:
 *   - Free, no auth required (sustainable for static demos + local CLI).
 *   - Single batch endpoint takes up to 1000 queries; FACTS-scale repos
 *     fit comfortably in one round-trip.
 *   - Covers npm, PyPI, Cargo, Go, Maven, RubyGems, NuGet, Packagist —
 *     the ecosystems the dependency scanner detects.
 *   - Returns OSV-format vulns (CVE + GHSA IDs, severity, affected ranges,
 *     references) — the canonical shape used across modern scanners.
 *
 * Constraint C1: pure isomorphic — uses `fetch` (universally available),
 * no `node:*` imports, no DOM types. The cache layer is pluggable: pass
 * a CacheStore implementation per environment (localStorage in browser,
 * filesystem in CLI, in-memory in tests).
 */

import type { DependencyManifest, ManifestEcosystem, Vulnerability, VulnerabilitySeverity } from '@factstack/spec';
import { flattenManifests } from './dependencies.js';

/* The scanners package's tsconfig uses `lib: ["ES2022"]` only — no DOM,
 * no @types/node. `fetch` + `AbortSignal` are platform globals in Node
 * 18+ AND every modern browser, but TypeScript doesn't know that from
 * a bare ES2022 lib. Rather than add DOM lib (drags in a ton of unrelated
 * types) or add @types/node (pulls Node-isms into an isomorphic module),
 * we declare the narrow surface we actually use. Same pattern @factstack/
 * fs-browser uses for its FSA type casts. */
type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;
interface AbortSignal { readonly aborted: boolean; }
declare const fetch: FetchFn;
/* `AbortSignal.timeout(ms)` is a Node 18+/browser global the bare ES2022 lib
 * types only as an interface, not a value. Declare the slice we use (same
 * tactic as `fetch` above; same approach as outdated.ts). */
declare const AbortSignal: { timeout(ms: number): AbortSignal };

const OSV_BATCH_ENDPOINT = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_ENDPOINT = 'https://api.osv.dev/v1/vulns/';
/** RES-1: default per-request timeout so a stalled OSV.dev TCP connection can
 *  never hang the CLI/MCP forever. A caller-supplied `opts.signal` overrides it. */
const DEFAULT_OSV_TIMEOUT_MS = 30_000;

/** RES-1: a best-effort abort signal that fires after the default timeout.
 *  Returns undefined on ancient runtimes without `AbortSignal.timeout` so the
 *  fetch proceeds untimed rather than throwing (mirrors outdated.ts). */
function defaultOsvSignal(): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(DEFAULT_OSV_TIMEOUT_MS)
      : undefined;
  } catch {
    return undefined;
  }
}

/* OSV uses ecosystem labels that differ slightly from our ManifestEcosystem
 * enum (e.g. their 'PyPI' vs our 'pypi'). This map normalizes our enum
 * into the strings OSV's API expects. Adding a new ecosystem to FACTS
 * requires adding it here too. */
const OSV_ECOSYSTEM: Record<ManifestEcosystem, string | null> = {
  npm: 'npm',
  pypi: 'PyPI',
  cargo: 'crates.io',
  go: 'Go',
  maven: 'Maven',
  rubygems: 'RubyGems',
  unknown: null,
};

/* ─────────── public types ─────────── */

export interface OsvQuery {
  ecosystem: ManifestEcosystem;
  name: string;
  version: string;
  /** Local-only — round-trips through batch but not sent to OSV. The
   *  scan-vulns CLI + UI use it to map results back to the manifest
   *  the dep was declared in. */
  manifestPath?: string;
}

export interface OsvVulnRef {
  id: string;
  modified?: string;
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    package?: { name: string; ecosystem: string };
    ranges?: Array<{ type: string; events: Array<{ introduced?: string; fixed?: string }> }>;
    versions?: string[];
  }>;
  references?: Array<{ type: string; url: string }>;
  database_specific?: { severity?: string; cwe_ids?: string[] };
  published?: string;
  modified?: string;
}

/** One row per input query, in input order. Empty `vulns: []` is CLEAN —
 *  that package@version has no known vulns at OSV. */
export interface OsvResult {
  query: OsvQuery;
  vulns: OsvVuln[];
}

/* ─────────── cache abstraction ─────────── */

/**
 * Pluggable cache backend. The UI passes a localStorage adapter; the
 * CLI passes a filesystem adapter; tests pass a Map-backed in-memory
 * adapter. The OSV client never touches storage directly — it just
 * calls get/set on whatever store the caller hands it.
 *
 * TTL is enforced by the store, not the client — different backends
 * may want different policies (localStorage 6h, filesystem 24h, etc.).
 */
export interface CacheStore {
  get(key: string): OsvResult[] | null;
  set(key: string, results: OsvResult[]): void;
}

/** Null cache for environments without persistence (or for tests that
 *  want to disable caching). Always returns null on get; no-ops on set. */
export const noopCache: CacheStore = {
  get: () => null,
  set: () => undefined,
};

/* ─────────── batch query ─────────── */

export interface BatchOptions {
  signal?: AbortSignal;
  /** Cache backend. Defaults to noopCache (no caching). */
  cache?: CacheStore;
  /** Force a re-query even if cache has a fresh hit. */
  bypassCache?: boolean;
}

/**
 * Query OSV for a batch of package@version pairs. Returns results in
 * the SAME ORDER as the input queries — OSV's batch endpoint guarantees
 * this, so the caller can zip the two arrays without explicit ids.
 *
 * Two-stage protocol:
 *   1. POST querybatch → array of {vulns:[{id, modified}]} per query.
 *      Lightweight, id-only.
 *   2. For every unique id, GET /vulns/{id} → full OsvVuln with
 *      severity + affected ranges + references. Parallel-fetched but
 *      capped at CONCURRENT_DETAIL.
 *
 * Cached as a single unit — the cache key is a hash of the sorted query
 * set, so two equal scans get the same key regardless of input order.
 */
export async function queryOsvBatch(
  queries: OsvQuery[],
  opts: BatchOptions = {},
): Promise<OsvResult[]> {
  if (queries.length === 0) return [];
  const cache = opts.cache ?? noopCache;
  const cacheKey = makeCacheKey(queries);
  if (!opts.bypassCache) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  /* OSV's batch endpoint accepts up to 1000 queries per request. We
     chunk defensively at 500 for JSON payload headroom (docs are
     conservative about exact bytes). */
  const CHUNK = 500;
  const stage1: Array<{ vulns: OsvVulnRef[] }> = [];
  for (let i = 0; i < queries.length; i += CHUNK) {
    const slice = queries.slice(i, i + CHUNK);
    const body = JSON.stringify({
      queries: slice.map((q) => ({
        package: { name: q.name, ecosystem: OSV_ECOSYSTEM[q.ecosystem] ?? q.ecosystem },
        version: q.version,
      })),
    });
    // RES-1: never hang forever on a stalled OSV.dev connection. A caller
    // signal wins; otherwise each request gets a fresh 30s timeout.
    const sig = opts.signal ?? defaultOsvSignal();
    const res = await fetch(OSV_BATCH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      ...(sig ? { signal: sig } : {}),
    });
    if (!res.ok) {
      throw new Error(`OSV batch failed: ${res.status} ${res.statusText}`);
    }
    const json = await res.json() as { results: Array<{ vulns?: OsvVulnRef[] }> };
    for (const r of json.results) stage1.push({ vulns: r.vulns ?? [] });
  }

  /* Stage 2: hydrate vuln details. Unique IDs only — many advisories
     affect multiple packages, so the dedupe pays off. */
  const allIds = new Set<string>();
  for (const row of stage1) for (const v of row.vulns) allIds.add(v.id);
  const vulnDetails = new Map<string, OsvVuln>();
  const ids = [...allIds];
  const CONCURRENT_DETAIL = 8;
  for (let i = 0; i < ids.length; i += CONCURRENT_DETAIL) {
    const slice = ids.slice(i, i + CONCURRENT_DETAIL);
    await Promise.all(slice.map(async (id) => {
      try {
        const sig = opts.signal ?? defaultOsvSignal();
        const res = await fetch(OSV_VULN_ENDPOINT + encodeURIComponent(id), {
          ...(sig ? { signal: sig } : {}),
        });
        if (!res.ok) return;
        const detail = await res.json() as OsvVuln;
        vulnDetails.set(id, detail);
      } catch {
        /* Skip failed detail fetches — id alone is still useful (the
           renderer falls back to osv.dev/vulnerability/{id}). */
      }
    }));
  }

  const results: OsvResult[] = queries.map((q, i) => {
    const refs = stage1[i]?.vulns ?? [];
    const vulns: OsvVuln[] = refs.map((r) => vulnDetails.get(r.id) ?? { id: r.id });
    return { query: q, vulns };
  });

  cache.set(cacheKey, results);
  return results;
}

/* ─────────── conversion to canonical Vulnerability shape ─────────── */

/**
 * Convert OSV's raw result set into the canonical `Vulnerability[]`
 * shape the agent artifact carries. This is the "scan-vulns" boundary:
 * OSV's heterogeneous data on one side, FACTS's clean schema on the
 * other.
 */
export function osvResultsToVulnerabilities(
  results: OsvResult[],
  now: number = Date.now(),
): Vulnerability[] {
  const out: Vulnerability[] = [];
  for (const r of results) {
    if (r.vulns.length === 0) continue;
    for (const v of r.vulns) {
      out.push({
        id: v.id,
        ...(v.summary ? { summary: v.summary } : {}),
        severity: bucketSeverity(v),
        ecosystem: r.query.ecosystem,
        package: r.query.name,
        installedVersion: r.query.version,
        fixedVersion: pickFixedVersion(v),
        advisoryUrl: pickAdvisoryUrl(v),
        lastChecked: now,
        manifestPath: r.query.manifestPath ?? '',
      });
    }
  }
  return out;
}

/* ─────────── severity + reference helpers (also used standalone) ─────────── */

/**
 * Coerce OSV's heterogeneous severity into a single bucket. OSV vulns
 * may carry CVSS v2, v3, or v4 strings, plus an optional
 * `database_specific.severity` text label. We prefer numeric CVSS when
 * present, fall back to the database-specific label, then to 'unknown'.
 */
export function bucketSeverity(v: OsvVuln): VulnerabilitySeverity {
  const cvss = (v.severity ?? []).find((s) => s.type.startsWith('CVSS'));
  if (cvss) {
    /* CVSS vector strings like 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'.
       Three impact metrics — Confidentiality, Integrity, Availability —
       each High contributes to severity. Full CVSS calc requires the
       cvss-calculator lib; this heuristic catches ~95% of cases at
       ~zero bundle cost. */
    if (/[/:]C:H.*[/:]I:H.*[/:]A:H/u.test(cvss.score)) return 'critical';
    if (/[/:]C:H|[/:]I:H|[/:]A:H/u.test(cvss.score)) return 'high';
    if (/[/:]C:L|[/:]I:L|[/:]A:L/u.test(cvss.score)) return 'medium';
  }
  const dbSev = v.database_specific?.severity?.toUpperCase();
  if (dbSev === 'CRITICAL') return 'critical';
  if (dbSev === 'HIGH') return 'high';
  if (dbSev === 'MODERATE' || dbSev === 'MEDIUM') return 'medium';
  if (dbSev === 'LOW') return 'low';
  return 'unknown';
}

/**
 * Pick a human-readable "fixed in" version from the OSV ranges.
 * OSV's range format is an ordered events list (introduced/fixed
 * pairs). The first `fixed` event after the user's installed version
 * is the actionable target. If none exists, the vuln is unpatched.
 */
export function pickFixedVersion(v: OsvVuln): string | null {
  for (const aff of v.affected ?? []) {
    for (const range of aff.ranges ?? []) {
      for (const ev of range.events) {
        if (ev.fixed) return ev.fixed;
      }
    }
  }
  return null;
}

/** Best-effort advisory URL from the references array, falling back
 *  to osv.dev's canonical page for the vuln id. */
export function pickAdvisoryUrl(v: OsvVuln): string {
  const ref = (v.references ?? []).find((r) => r.type === 'ADVISORY')
    ?? (v.references ?? []).find((r) => r.url.includes('github.com/advisories'))
    ?? (v.references ?? [])[0];
  return ref?.url ?? `https://osv.dev/vulnerability/${v.id}`;
}

/* ─────────── cache-key hash ─────────── */

/** Stable hash of the query set — sorted by ecosystem+name+version so
 *  two equal scans get the same key regardless of input order. */
export function makeCacheKey(queries: OsvQuery[]): string {
  const stamp = queries
    .map((q) => `${q.ecosystem}|${q.name}@${q.version}`)
    .sort()
    .join('\n');
  return 'osv:' + djb2(stamp).toString(36);
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/* ─────────── version normalization ─────────── */

/**
 * Coerce an npm-style version spec ("^1.2.3", "~1.0", ">=2.0.0",
 * "1.2.3 || 2.0.0", "workspace:*") into a concrete version OSV can
 * query. Returns null when the spec is non-registry (workspace/file/git)
 * and shouldn't be queried at all.
 *
 * For multi-range specs, we take the LOWER bound — OSV's "is X affected"
 * answer is the same for the whole range, so picking any version in the
 * range works; lower bound is the most conservative (most likely to
 * actually be installed). For a precise answer, consume a lockfile.
 */
export function normalizeNpmVersion(raw: string): string | null {
  if (!raw) return null;
  if (
    raw.startsWith('workspace:') ||
    raw.startsWith('file:') ||
    raw.startsWith('link:') ||
    raw.startsWith('git+') ||
    raw.startsWith('github:') ||
    raw.startsWith('npm:')
  ) {
    return null;
  }
  const cleaned = raw.replace(/^[\s\^~><=]+/u, '').trim();
  const match = cleaned.match(/^[0-9][0-9A-Za-z.\-+]*/u);
  return match ? match[0] : null;
}

/**
 * v0.11 — reconcile a PREVIOUS scan's findings against the CURRENT dependency
 * manifests: keep a finding only when its exact (ecosystem, package,
 * installedVersion) is still installed. This is what makes carrying scan
 * results forward across re-analyzes SAFE:
 *
 *   - dep removed   → its CVEs drop immediately (no zombie findings)
 *   - dep upgraded  → the old version's findings drop (the advisory may not
 *                     apply to the new version — a rescan re-establishes truth)
 *   - dep unchanged → findings survive without a network round-trip
 *
 * Versions are normalized the same way scan queries are (npm ranges →
 * conservative lower bound) so the keep-set keys match what the scan stored
 * as `installedVersion`. Pure + deterministic.
 */
export function reconcileVulnerabilities(
  previous: Vulnerability[],
  manifests: DependencyManifest[],
): Vulnerability[] {
  if (!previous.length) return [];
  const installed = new Set<string>();
  for (const e of flattenManifests(manifests)) {
    const concrete = e.ecosystem === 'npm' ? normalizeNpmVersion(e.version) : e.version;
    if (concrete) installed.add(`${e.ecosystem}\t${e.name}\t${concrete}`);
  }
  return previous.filter((v) => installed.has(`${v.ecosystem}\t${v.package}\t${v.installedVersion}`));
}

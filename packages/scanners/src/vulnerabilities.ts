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

import {
  VulnerabilitySchema,
  VulnerabilityScanSchema,
  type DependencyManifest,
  type ManifestEcosystem,
  type Vulnerability,
  type VulnerabilityScan,
  type VulnerabilitySeverity,
} from '@factstack/spec';
import {
  isRegistrySpec,
  parseNpmAlias,
  resolveInstalled,
  type ParsedLockfile,
} from './lockfiles.js';
import { compareSemver } from './outdated.js';

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
interface AbortSignal {
  readonly aborted: boolean;
}
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

/** How a scanned package is reached. `direct` runtime deps are graded;
 *  `dev` and `transitive` findings are shown but not graded (owner call).
 *  SCN-P2-05: derived from the spec's `Vulnerability.scope` so the two
 *  literal sets cannot drift. */
export type DependencyScope = NonNullable<Vulnerability['scope']>;

/** Where a queried version came from. `lockfile` = what is installed;
 *  `declared-range` = the manifest range's lower bound, not a resolved
 *  version, so the installed one may differ — surfaces label it "declared
 *  range". Derived from the spec's `Vulnerability.versionSource`. */
export type VersionSource = NonNullable<Vulnerability['versionSource']>;

export interface OsvQuery {
  ecosystem: ManifestEcosystem;
  name: string;
  version: string;
  /** Local-only — round-trips through batch but not sent to OSV. The
   *  scan-vulns CLI + UI use it to map results back to the manifest
   *  the dep was declared in (the lockfile, for a transitive package). */
  manifestPath?: string;
  /** Local-only, like manifestPath. Absent on legacy callers' queries. */
  scope?: DependencyScope;
  /** Local-only, like manifestPath. Absent on legacy callers' queries. */
  versionSource?: VersionSource;
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
  /** EH-3: how many of this query's advisories had their stage-2 detail fetch
   *  fail (so they degraded to id-only / severity 'unknown'). Present only when
   *  > 0, so a clean scan is distinguishable from a degraded one. */
  detailsFailed?: number;
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
    const hit = Array.isArray(cached) ? rebindCached(queries, cached) : null;
    if (hit) return hit;
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
    const json = (await res.json()) as { results: Array<{ vulns?: OsvVulnRef[] }> };
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
    await Promise.all(
      slice.map(async (id) => {
        try {
          const sig = opts.signal ?? defaultOsvSignal();
          const res = await fetch(OSV_VULN_ENDPOINT + encodeURIComponent(id), {
            ...(sig ? { signal: sig } : {}),
          });
          if (!res.ok) return;
          const detail: unknown = await res.json();
          // SCN-P2-02: a non-object body counts as a failed detail fetch
          // (degraded to id-only), never a record conversion would throw on.
          if (!isRecord(detail)) return;
          const d = detail as Partial<OsvVuln>;
          vulnDetails.set(id, typeof d.id === 'string' ? (d as OsvVuln) : { ...d, id });
        } catch {
          /* Skip failed detail fetches — id alone is still useful (the
           renderer falls back to osv.dev/vulnerability/{id}). */
        }
      }),
    );
  }

  // EH-3: ids whose detail fetch failed (non-ok or threw) never made it into
  // vulnDetails — they degrade to id-only below. Track them so each result can
  // report how many of its advisories are degraded (silent before).
  const failedIds = new Set(ids.filter((id) => !vulnDetails.has(id)));
  const results: OsvResult[] = queries.map((q, i) => {
    const refs = stage1[i]?.vulns ?? [];
    const vulns: OsvVuln[] = refs.map((r) => vulnDetails.get(r.id) ?? { id: r.id });
    const detailsFailed = refs.reduce((n, r) => n + (failedIds.has(r.id) ? 1 : 0), 0);
    return detailsFailed > 0 ? { query: q, vulns, detailsFailed } : { query: q, vulns };
  });

  // SCN-16: never persist a degraded scan. An id-only row (severity 'unknown',
  // no summary/fix) cached for the store's TTL would hide a transient 429 or
  // timeout for hours; the next scan retries instead.
  if (!results.some((r) => (r.detailsFailed ?? 0) > 0)) cache.set(cacheKey, results);
  return results;
}

/** The cache key covers (ecosystem, name, version) only, so a hit is re-bound
 *  to the CURRENT queries: their order and local-only labels (manifestPath,
 *  scope, versionSource) may differ from the scan that filled the cache.
 *  Null — treated as a miss — when any query is absent from the cached set.
 *
 *  SCN-P2-03: the store is persisted (localStorage, filesystem), so a row is
 *  trusted only when its `vulns` is an array of id-bearing objects. A corrupt
 *  or stale-shape row leaves its query unmatched → a miss and a refetch, not
 *  a conversion that throws on every scan until the TTL expires. */
function rebindCached(queries: OsvQuery[], cached: OsvResult[]): OsvResult[] | null {
  const key = (q: OsvQuery) => `${q.ecosystem}|${q.name}@${q.version}`;
  const byKey = new Map<string, OsvResult>();
  for (const r of cached) {
    if (!isRecord(r) || !isRecord(r.query) || !Array.isArray(r.vulns)) continue;
    if (!r.vulns.every((v) => isRecord(v) && typeof v.id === 'string')) continue;
    byKey.set(key(r.query), r);
  }
  const out: OsvResult[] = [];
  for (const q of queries) {
    const r = byKey.get(key(q));
    if (!r) return null;
    out.push({ ...r, query: q });
  }
  return out;
}

/* ─────────── conversion to canonical Vulnerability shape ─────────── */

/** A Vulnerability carrying the query's provenance labels. SCN-P2-05: the
 *  spec's Vulnerability now has `scope` / `versionSource`, so this is a
 *  compatibility alias for it. */
export type ScannedVulnerability = Vulnerability;

/**
 * Convert OSV's raw result set into the canonical `Vulnerability[]`
 * shape the agent artifact carries. This is the "scan-vulns" boundary:
 * OSV's heterogeneous data on one side, FACTS's clean schema on the
 * other. The query's `scope` / `versionSource` labels ride along when set.
 */
export function osvResultsToVulnerabilities(
  results: OsvResult[],
  now: number = Date.now(),
): ScannedVulnerability[] {
  const out: ScannedVulnerability[] = [];
  for (const r of results) {
    if (r.vulns.length === 0) continue;
    for (const v of r.vulns) {
      out.push({
        id: v.id,
        ...(typeof v.summary === 'string' && v.summary ? { summary: v.summary } : {}),
        severity: bucketSeverity(v),
        ecosystem: r.query.ecosystem,
        package: r.query.name,
        installedVersion: r.query.version,
        fixedVersion: pickFixedVersion(v, r.query.name, r.query.version),
        advisoryUrl: pickAdvisoryUrl(v),
        lastChecked: now,
        manifestPath: r.query.manifestPath ?? '',
        ...(r.query.scope ? { scope: r.query.scope } : {}),
        ...(r.query.versionSource ? { versionSource: r.query.versionSource } : {}),
      });
    }
  }
  return out;
}

/** Owner call: only direct runtime findings cost health-grade points; `dev`
 *  and `transitive` ones are shown, not graded. Untagged (pre-lockfile)
 *  findings came from direct manifest deps, so they stay graded. */
export function isGradedVulnerability(
  // `object &` keeps a plain spec Vulnerability (no `scope` key yet) assignable.
  v: object & { scope?: DependencyScope | undefined },
): boolean {
  return v.scope === undefined || v.scope === 'direct';
}

/** Shared wording for the provenance labels, so the CLI, MCP server and
 *  dashboard describe the same finding the same way (INV7). */
export const VULN_LABEL_TEXT = {
  // SCN-P2-04: "declared-range" also covers a lockfile that doesn't lock the
  // dep, and the lower bound can miss a vuln as well as flag a patched one.
  declaredRange: 'declared range (not resolved from a lockfile — installed version may differ)',
  notGraded: 'shown, not graded',
} as const;

/** The notes a surface shows beside a finding (or query): the declared-range
 *  caveat when its version came from the manifest range, and
 *  `<scope>: shown, not graded` for dev/transitive. Empty for a graded row
 *  resolved from a lockfile, and for a legacy unlabelled row. */
export function vulnerabilityLabels(
  v: object & { scope?: DependencyScope | undefined; versionSource?: VersionSource | undefined },
): string[] {
  const out: string[] = [];
  if (v.versionSource === 'declared-range') out.push(VULN_LABEL_TEXT.declaredRange);
  if (!isGradedVulnerability(v)) out.push(`${v.scope}: ${VULN_LABEL_TEXT.notGraded}`);
  return out;
}

/* ─────────── severity + reference helpers (also used standalone) ─────────── */

/**
 * Coerce OSV's heterogeneous severity into a single bucket. OSV vulns
 * may carry CVSS v2, v3, or v4 strings, plus an optional
 * `database_specific.severity` text label.
 *
 * SCN-08: the reviewed label (GHSA's CRITICAL/HIGH/MODERATE/LOW) wins — it
 * is what the advisory's maintainers graded. Without one, a CVSS v3.x vector
 * is graded by its real base score (the old "C:H/I:H/A:H ⇒ critical"
 * heuristic ignored AV/AC/PR/UI and graded a 7.2 as critical), then a v4
 * vector by impact-metric heuristic, then a v2 vector by its base score.
 */
export function bucketSeverity(v: OsvVuln): VulnerabilitySeverity {
  const label: unknown = v.database_specific?.severity;
  const dbSev = typeof label === 'string' ? label.toUpperCase() : undefined;
  if (dbSev === 'CRITICAL') return 'critical';
  if (dbSev === 'HIGH') return 'high';
  if (dbSev === 'MODERATE' || dbSev === 'MEDIUM') return 'medium';
  if (dbSev === 'LOW') return 'low';

  // CVE-R4: stage-2 detail JSON is unvalidated — skip entries whose score
  // isn't a string so one malformed record grades 'unknown', never throws.
  const sev = (Array.isArray(v.severity) ? v.severity : []).filter(
    (s): s is { type: string; score: string } =>
      s !== null && typeof s === 'object' && typeof s.score === 'string',
  );
  const v3 = sev.find((s) => s.type === 'CVSS_V3' || /^CVSS:3\./.test(s.score));
  const v3Score = v3 ? cvss3BaseScore(v3.score) : null;
  if (v3Score !== null) return scoreBucket(v3Score);

  const v4 = sev.find((s) => s.type === 'CVSS_V4' || /^CVSS:4/.test(s.score));
  if (v4) {
    /* CVSS v4 renames the impact metrics to VC/VI/VA (vulnerable system
       Confidentiality/Integrity/Availability). Its score needs the spec's
       macro-vector lookup table, so this stays an impact heuristic. */
    const sc = v4.score;
    if (/\bVC:H/.test(sc) && /\bVI:H/.test(sc) && /\bVA:H/.test(sc)) return 'critical';
    if (/\bV[CIA]:H/.test(sc)) return 'high';
    if (/\bV[CIA]:L/.test(sc)) return 'medium';
  }

  const v2 = sev.find((s) => s.type === 'CVSS_V2');
  const v2Score = v2 ? cvss2BaseScore(v2.score) : null;
  // CVSS v2 has no critical band (NVD: 7.0–10.0 is High).
  if (v2Score !== null) return v2Score >= 7 ? 'high' : scoreBucket(v2Score);
  return 'unknown';
}

/** CVSS qualitative rating of a base score (0.0 "none" folds into low). */
function scoreBucket(score: number): VulnerabilitySeverity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/** Parse `A:B/C:D` vector metrics (the `CVSS:3.x` prefix is skipped). */
function vectorMetrics(vector: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of vector.trim().split('/')) {
    const [k, val] = part.split(':');
    if (k && val !== undefined && k !== 'CVSS') m.set(k, val);
  }
  return m;
}

/**
 * CVSS v3.0/v3.1 base score from a vector string, per the FIRST spec
 * (weights, scope-changed privilege weights, Roundup). Null when the vector
 * is missing a base metric or carries an unknown value. Pure — no library.
 */
export function cvss3BaseScore(vector: string): number | null {
  const m = vectorMetrics(vector);
  const changed = m.get('S') === 'C';
  if (!changed && m.get('S') !== 'U') return null;
  const w = (k: string, table: Record<string, number>): number | null => {
    const val = m.get(k);
    return val !== undefined && Object.hasOwn(table, val) ? table[val]! : null;
  };
  const av = w('AV', { N: 0.85, A: 0.62, L: 0.55, P: 0.2 });
  const ac = w('AC', { L: 0.77, H: 0.44 });
  const pr = w('PR', changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 });
  const ui = w('UI', { N: 0.85, R: 0.62 });
  const cia = { H: 0.56, L: 0.22, N: 0 };
  const c = w('C', cia);
  const i = w('I', cia);
  const a = w('A', cia);
  if (av === null || ac === null || pr === null || ui === null) return null;
  if (c === null || i === null || a === null) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  return roundUp1(Math.min((changed ? 1.08 : 1) * (impact + exploitability), 10));
}

/** CVSS 3.1 Roundup: smallest one-decimal number >= x, float-noise safe. */
function roundUp1(x: number): number {
  const n = Math.round(x * 100000);
  return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
}

/** CVSS v2 base score (`AV:N/AC:L/Au:N/C:P/I:P/A:P`); null when malformed. */
function cvss2BaseScore(vector: string): number | null {
  const m = vectorMetrics(vector);
  const pick = (k: string, table: Record<string, number>): number | null => {
    const val = m.get(k);
    return val !== undefined && Object.hasOwn(table, val) ? table[val]! : null;
  };
  const av = pick('AV', { L: 0.395, A: 0.646, N: 1 });
  const ac = pick('AC', { H: 0.35, M: 0.61, L: 0.71 });
  const au = pick('Au', { M: 0.45, S: 0.56, N: 0.704 });
  const cia = { N: 0, P: 0.275, C: 0.66 };
  const c = pick('C', cia);
  const i = pick('I', cia);
  const a = pick('A', cia);
  if (av === null || ac === null || au === null || c === null || i === null || a === null)
    return null;
  const impact = 10.41 * (1 - (1 - c) * (1 - i) * (1 - a));
  const exploitability = 20 * av * ac * au;
  const f = impact === 0 ? 0 : 1.176;
  return Math.round((0.6 * impact + 0.4 * exploitability - 1.5) * f * 10) / 10;
}

/**
 * Pick a human-readable "fixed in" version from the OSV ranges.
 * OSV's range format is an events list of introduced/fixed pairs, and one
 * advisory often covers several release lines (ws: 2.1.0→5.2.4, 6→6.2.3,
 * 7→7.5.10, 8→8.17.1).
 *
 * SCN-07: with the `installed` version, return the `fixed` of the line that
 * contains it (introduced <= installed < fixed); failing that, the smallest
 * fix above it; and null — never a downgrade — when every fix is below it.
 * Without a comparable installed version, the first fix (legacy behaviour).
 *
 * SCN-P2-02: the detail JSON is unvalidated (as for severity, CVE-R4) —
 * non-array `affected`/`ranges`/`events`, non-object entries and non-string
 * versions are skipped, so one odd advisory never aborts the whole scan.
 */
export function pickFixedVersion(v: OsvVuln, pkgName?: string, installed?: string): string | null {
  const affected = arrayOf(v.affected).filter(isRecord);
  /* A single OSV advisory often lists multiple affected packages (the same
     CVE/GHSA across siblings/ecosystems), and the FIRST entry is frequently
     not the one we queried — so scope to the queried package and only fall
     back to all entries when there's no match. */
  const scoped = pkgName ? affected.filter((a) => a.package?.name === pkgName) : affected;
  let first: string | null = null;
  let nextAbove: string | null = null;
  let comparable = false;
  for (const aff of scoped.length > 0 ? scoped : affected) {
    for (const range of arrayOf(aff.ranges)) {
      if (!isRecord(range)) continue;
      let introduced = '0';
      for (const ev of arrayOf(range.events)) {
        if (!isRecord(ev)) continue;
        if (typeof ev.introduced === 'string') introduced = ev.introduced;
        const fixed = typeof ev.fixed === 'string' ? ev.fixed : '';
        if (!fixed) continue;
        first ??= fixed;
        // GIT ranges carry commit hashes, not versions.
        if (!installed || range.type === 'GIT') continue;
        const vsFix = compareSemver(installed, fixed);
        if (vsFix === null) continue;
        comparable = true;
        if (vsFix >= 0) continue; // already at/after this line's fix
        const vsIntro = introduced === '0' ? -1 : compareSemver(introduced, installed);
        if (vsIntro !== null && vsIntro <= 0) return fixed; // the installed line's fix
        if (nextAbove === null || (compareSemver(fixed, nextAbove) ?? 0) < 0) {
          nextAbove = fixed;
        }
      }
    }
  }
  if (nextAbove !== null) return nextAbove;
  return comparable ? null : first;
}

/** SEC-1: allowlist http(s) URLs only. A poisoned OSV record could carry a
 *  `javascript:`/`data:` reference URL; rejecting non-http(s) here stops it
 *  from flowing into the artifact (and any href the CLI/UI renders). */
function isHttpUrl(s: unknown): s is string {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

/** A non-null object — the guard for unvalidated OSV / cached JSON. */
function isRecord<T>(x: T): x is T & object {
  return x !== null && typeof x === 'object';
}

/** The value when it is an array, else [] (unvalidated OSV JSON). */
function arrayOf<T>(x: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(x) ? x : [];
}

/** Best-effort advisory URL from the references array, falling back to osv.dev's
 *  canonical page for the vuln id. Only http(s) references are considered (SEC-1);
 *  the osv.dev fallback is always a safe https URL. */
export function pickAdvisoryUrl(v: OsvVuln): string {
  // SCN-P2-02: a non-array `references` or a null entry is skipped, not thrown on.
  const refs = arrayOf(v.references).filter(isRecord);
  const ref =
    refs.find((r) => r.type === 'ADVISORY' && isHttpUrl(r.url)) ??
    refs.find((r) => isHttpUrl(r.url) && r.url.includes('github.com/advisories')) ??
    refs.find((r) => isHttpUrl(r.url));
  return ref?.url ?? `https://osv.dev/vulnerability/${v.id}`;
}

/* ─────────── cache-key hash ─────────── */

/** Stable hash of the query set — sorted by ecosystem+name+version so
 *  two equal scans get the same key regardless of input order.
 *
 *  CONC-3: the old key used a 32-bit djb2 hash. As a persisted (UI localStorage)
 *  cache key spanning many projects, 32 bits collides at the ~birthday bound of
 *  a few tens of thousands of distinct query sets — a collision silently returns
 *  another project's scan. cyrb53 gives a 53-bit space (same sync, isomorphic,
 *  no crypto), making collision astronomically unlikely for realistic caches.
 *  The `v2:` namespace prevents an old 32-bit-keyed entry from ever matching a
 *  new key (old entries simply expire by TTL). */
export function makeCacheKey(queries: OsvQuery[]): string {
  const stamp = queries
    .map((q) => `${q.ecosystem}|${q.name}@${q.version}`)
    .sort()
    .join('\n');
  return 'osv:v2:' + cyrb53(stamp);
}

/** cyrb53 — a fast 53-bit string hash (public domain, by bryc). Sync and
 *  isomorphic (Math.imul only), so it runs identically in Node + the browser. */
function cyrb53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36);
}

/* ─────────── version normalization ─────────── */

/**
 * Coerce an npm-style version spec ("^1.2.3", "~1.0", ">=2.0.0",
 * "1.2.3 || 2.0.0", "workspace:*") into a concrete version OSV can
 * query. Returns null when the spec is non-registry (workspace/file/git/
 * catalog) or names no version (`*`, `latest`, an upper bound alone).
 *
 * This is the no-lockfile FALLBACK: it takes the range's LOWER bound, which
 * may not be what is installed (`^5.0.0` checks 5.0.0 while 5.4.x is on
 * disk), so queries built from it are labelled `declared-range`. With a
 * lockfile, buildOsvQueries uses the installed version instead.
 *
 * correctness#3: x-ranges and partials pad to a valid semver (`1.x`, `~1.0`
 * → 1.0.0) and a leading `v` is dropped. A strict `>X` floors at the next
 * version above X (SCN-P2-06), never at the excluded X itself.
 *
 * CVE-R2: an `npm:<pkg>@<range>` alias stays null HERE — legacy callers pair
 * this with the manifest KEY (the alias), so a version would query OSV/the
 * registry under the wrong name. buildOsvQueries resolves aliases itself.
 */
export function normalizeNpmVersion(raw: string): string | null {
  const spec = (raw ?? '').trim();
  if (!spec || spec.startsWith('npm:') || !isRegistrySpec(spec)) return null;
  // CVE-R6: the first `||` comparator set that has a floor.
  for (const set of spec.split('||')) {
    const floor = comparatorSetFloor(set.trim());
    if (floor) return floor;
  }
  return null;
}

/** One comparator set's first comparator → concrete version, or null. */
function comparatorSetFloor(set: string): string | null {
  let first = set;
  // `<=X` includes X; a strict upper bound alone (`<X`) has no floor.
  if (first.startsWith('<=')) first = first.slice(2);
  else if (first.startsWith('<')) return null;
  // SCN-P2-06: a strict `>X` excludes X, so its floor is the next version up.
  const strict = first.startsWith('>') && !first.startsWith('>=');
  const cleaned = first.replace(/^[\s^~>=]+/u, '').replace(/^v/iu, '');
  const m = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?/u.exec(cleaned);
  if (!m) return null;
  const minor = m[2] !== undefined && /^\d+$/u.test(m[2]) ? m[2] : null;
  const patch = minor !== null && m[3] !== undefined && /^\d+$/u.test(m[3]) ? m[3] : null;
  if (strict) {
    // `>1.2.3-rc.1` → 1.2.3 (the release is above its prerelease);
    // `>1.2.3` → 1.2.4; `>1.2` / `>1.2.x` → 1.3.0; `>1` / `>1.x` → 2.0.0.
    if (patch !== null) return `${m[1]}.${minor}.${m[4] ? patch : Number(patch) + 1}`;
    if (minor !== null) return `${m[1]}.${Number(minor) + 1}.0`;
    return `${Number(m[1]) + 1}.0.0`;
  }
  // A prerelease tag only belongs to a full X.Y.Z; build metadata is dropped.
  return `${m[1]}.${minor ?? '0'}.${patch ?? '0'}${patch !== null ? (m[4] ?? '') : ''}`;
}

/* ─────────── query building (lockfile-aware) ─────────── */

/** A manifest that may carry lockfile-resolved direct-dep versions (see
 *  attachResolvedVersions). SCN-P2-01/05: the spec's DependencyManifest now
 *  carries the optional `resolved` map itself, so this is a compatibility
 *  alias — a separate `resolved?: Record` broke under
 *  exactOptionalPropertyTypes once the spec's became `… | undefined`. */
export type ManifestWithResolved = DependencyManifest;

/** Query counts per provenance label — the "N direct · N dev · N transitive,
 *  N on declared ranges" summary scan-vulns and the MCP refresh print. */
export interface OsvQueryLabels {
  scope: Record<DependencyScope, number>;
  versionSource: Record<VersionSource, number>;
}

export interface OsvQueryPlan {
  queries: OsvQuery[];
  /** Distinct declared deps with no queryable version: non-registry specs
   *  (workspace:/file:/git:/catalog:) and ones naming no version (`*`,
   *  `latest`, an upper bound alone). */
  skipped: number;
  labels: OsvQueryLabels;
}

const SCOPE_RANK: Record<DependencyScope, number> = { direct: 0, dev: 1, transitive: 2 };

/**
 * security#8 — the ONE place every surface (CLI scan-vulns, MCP refresh,
 * dashboard, reconcile) turns manifests into OSV queries, so they agree.
 *
 *   - Direct deps query the lockfile's INSTALLED version when a lockfile
 *     covers the manifest (`versionSource: 'lockfile'`), else the declared
 *     range's lower bound (`'declared-range'`).
 *   - npm aliases (`"x": "npm:lodash@^4"`) query the real package.
 *   - Every package a lockfile installs is queried too, tagged `transitive`.
 *   - `scope`: `direct` (dependencies/peer/optional), `dev`, `transitive` —
 *     one query per package@version, the strongest scope winning.
 *
 * Pure — lockfile TEXT is parsed by the caller (parseLockfile); no I/O, no
 * network (INV6: analyze may call this; only queryOsvBatch touches OSV).
 */
export function buildOsvQueries(
  manifests: readonly ManifestWithResolved[],
  lockfiles: readonly ParsedLockfile[] = [],
): OsvQueryPlan {
  type Labelled = OsvQuery & { scope: DependencyScope; versionSource: VersionSource };
  const byKey = new Map<string, Labelled>();
  const skipped = new Set<string>();
  const put = (q: Labelled): void => {
    const key = `${q.ecosystem}|${q.name}@${q.version}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, q);
      return;
    }
    const keep = SCOPE_RANK[q.scope] < SCOPE_RANK[prev.scope] ? q : prev;
    const locked = q.versionSource === 'lockfile' || prev.versionSource === 'lockfile';
    byKey.set(key, { ...keep, versionSource: locked ? 'lockfile' : 'declared-range' });
  };
  for (const m of manifests) {
    const seen = new Set<string>(); // a dep in both maps counts as runtime
    for (const [deps, scope] of [
      [m.dependencies, 'direct'],
      [m.devDependencies, 'dev'],
    ] as const) {
      // `?? {}`: legacy/raw dataset JSON (the dashboard) may omit either map.
      for (const [key, declared] of Object.entries(deps ?? {})) {
        if (seen.has(key)) continue;
        seen.add(key);
        const target = resolveDeclared(m, key, declared, lockfiles);
        if (target) put({ ecosystem: m.ecosystem, ...target, manifestPath: m.path, scope });
        else skipped.add(`${m.ecosystem}|${key}@${declared}`);
      }
    }
  }
  for (const lock of lockfiles) {
    for (const p of lock.packages) {
      put({
        ecosystem: 'npm',
        name: p.name,
        version: p.version,
        manifestPath: lock.path,
        scope: 'transitive',
        versionSource: 'lockfile',
      });
    }
  }
  const queries = [...byKey.values()];
  const labels: OsvQueryLabels = {
    scope: { direct: 0, dev: 0, transitive: 0 },
    versionSource: { lockfile: 0, 'declared-range': 0 },
  };
  for (const q of queries) {
    labels.scope[q.scope]++;
    labels.versionSource[q.versionSource]++;
  }
  return { queries, skipped: skipped.size, labels };
}

/** One declared dep → the package + version to query, or null (unqueryable). */
function resolveDeclared(
  m: ManifestWithResolved,
  key: string,
  declared: string,
  lockfiles: readonly ParsedLockfile[],
): { name: string; version: string; versionSource: VersionSource } | null {
  if (m.ecosystem !== 'npm') {
    return declared ? { name: key, version: declared, versionSource: 'declared-range' } : null;
  }
  const locked = resolveInstalled(lockfiles, m.path, key, declared);
  if (locked) return { name: locked.name, version: locked.version, versionSource: 'lockfile' };
  const alias = parseNpmAlias(declared);
  const name = alias?.name ?? key;
  // Versions an artifact carried from analyze time (attachResolvedVersions).
  const carried = m.resolved && Object.hasOwn(m.resolved, key) ? m.resolved[key] : undefined;
  if (typeof carried === 'string' && /^\d+\.\d+\.\d+/u.test(carried)) {
    return { name, version: carried, versionSource: 'lockfile' };
  }
  // An alias queries its RANGE under the real name (CVE-R2).
  const version = normalizeNpmVersion(alias ? alias.range : declared);
  return version ? { name, version, versionSource: 'declared-range' } : null;
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
 * The keep-set is built by buildOsvQueries — the same resolution the scan
 * used — so pass the same lockfiles: a finding at the lockfile-installed
 * version (or on a transitive package) only survives while the lockfile
 * still installs it. Pure + deterministic.
 *
 * CVE-R3: a row with no `versionSource` label came from a legacy query
 * builder that queried the declared range's lower bound; it also survives at
 * that declared-range version, so a manifest carrying `resolved` (or a
 * lockfile) never silently empties a legacy scan into "0 findings".
 *
 * Labels (audit correctness#3): a kept row that carries `scope` /
 * `versionSource` takes them from the CURRENT query plan, not the scan that
 * wrote it — a dev dep moved into `dependencies` is graded at once, without
 * a rescan. A fully unlabelled legacy row stays unlabelled (graded, and the
 * CVE-R3 fallback keeps applying to it); a row the fallback keeps gets the
 * current scope only, since its version is still the declared lower bound.
 * Returns new row objects; `previous` is not mutated.
 */
export function reconcileVulnerabilities<V extends Vulnerability>(
  previous: V[],
  manifests: readonly ManifestWithResolved[],
  lockfiles: readonly ParsedLockfile[] = [],
): V[] {
  if (!previous.length) return [];
  const plan = (ms: readonly ManifestWithResolved[], ls: readonly ParsedLockfile[]) =>
    new Map(
      buildOsvQueries(ms, ls).queries.map((q) => [`${q.ecosystem}\t${q.name}\t${q.version}`, q]),
    );
  const installed = plan(manifests, lockfiles);
  let declared: Map<string, OsvQuery> | null = null; // built only when a legacy row needs it
  const out: V[] = [];
  for (const v of previous) {
    const key = `${v.ecosystem}\t${v.package}\t${v.installedVersion}`;
    const hit = installed.get(key);
    if (hit) {
      out.push(relabel(v, hit));
      continue;
    }
    if (v.versionSource !== undefined) continue;
    // Same manifests with no carried installed versions and no lockfiles.
    declared ??= plan(
      manifests.map((m) => (m.resolved ? { ...m, resolved: {} } : m)),
      [],
    );
    const legacy = declared.get(key);
    if (legacy) out.push(relabel(v, legacy));
  }
  return out;
}

/** What carryVulnerabilityScan hands back. `warning` is set whenever
 *  anything was dropped or does not add up — never silent. */
export type CarriedVulnerabilityScan =
  | { carried: false; warning?: string }
  | {
      carried: true;
      scan: VulnerabilityScan;
      vulnerabilities: Vulnerability[];
      warning?: string;
    };

/**
 * Carry the last vulnerability scan across a re-analyze — the ONE rule the
 * CLI carry-forward and the MCP restore share, so they cannot drift (INV7).
 * `prev` is the previous agent.json, raw-parsed: it may predate the current
 * schema, so the scan metadata and EACH row are validated here.
 *
 *   - no scan → nothing to carry, silently;
 *   - scan metadata that fails the schema, or no `vulnerabilities` ARRAY
 *     (null, {}, a string, missing) → dropped with a warning. Every writer
 *     stores the array, empty when clean; without one the scan would carry
 *     as "scanned and clean", findings 0 (mcp-rev-2);
 *   - a malformed row costs only itself (reported);
 *   - a recorded `findings` that differs from the row count means rows were
 *     lost or added since the scan (reported);
 *   - kept rows are reconciled against the fresh manifests + `lockfiles()`
 *     (reconcileVulnerabilities: no zombie CVEs).
 *
 * The carried scan's `findings` mirrors the reconciled rows; scannedAt,
 * packagesQueried, lockfiles and `unscanned` stay the original scan's —
 * carrying never makes a scan look fresher or more complete than it was.
 * `rescanHint` ends every warning: each surface names its own rescan.
 * Pure (C1); `lockfiles` is called only when there is a scan to reconcile.
 */
export function carryVulnerabilityScan(
  prev: { vulnerabilityScan?: unknown; vulnerabilities?: unknown } | null | undefined,
  manifests: readonly ManifestWithResolved[],
  lockfiles: () => readonly ParsedLockfile[],
  rescanHint: string,
): CarriedVulnerabilityScan {
  if (!prev?.vulnerabilityScan) return { carried: false };
  const scan = VulnerabilityScanSchema.safeParse(prev.vulnerabilityScan);
  const rows: unknown = prev.vulnerabilities;
  if (!scan.success || !Array.isArray(rows)) {
    return {
      carried: false,
      warning: `the previous vulnerability scan has an unexpected shape (an older FACTS?) — dropped; ${rescanHint}`,
    };
  }
  const valid = rows.flatMap((v: unknown) => {
    const r = VulnerabilitySchema.safeParse(v);
    return r.success ? [r.data] : [];
  });
  let vulnerabilities: Vulnerability[];
  try {
    // With the lockfiles: a finding at the INSTALLED version survives.
    vulnerabilities = reconcileVulnerabilities(valid, manifests, lockfiles());
  } catch (err) {
    return {
      carried: false,
      warning: `could not reconcile the previous vulnerability scan (${(err as Error).message}); ${rescanHint}`,
    };
  }
  const problems: string[] = [];
  const dropped = rows.length - valid.length;
  if (dropped > 0) {
    problems.push(
      `${dropped} malformed vulnerability row${dropped === 1 ? '' : 's'} in the previous scan dropped`,
    );
  }
  const recorded = scan.data.findings;
  if (recorded !== rows.length) {
    problems.push(
      `the previous scan recorded ${recorded} finding${recorded === 1 ? '' : 's'} but held ` +
        `${rows.length} row${rows.length === 1 ? '' : 's'}`,
    );
  }
  return {
    carried: true,
    scan: { ...scan.data, findings: vulnerabilities.length },
    vulnerabilities,
    ...(problems.length > 0 ? { warning: `${problems.join('; ')}; ${rescanHint}` } : {}),
  };
}

/** A kept row with the labels it carries refreshed from the current query.
 *  An unlabelled legacy row is returned as-is (it stays legacy). */
function relabel<V extends Vulnerability>(v: V, q: OsvQuery): V {
  if (v.scope === undefined && v.versionSource === undefined) return v;
  const next: V = { ...v };
  if (v.scope !== undefined && q.scope !== undefined) next.scope = q.scope;
  if (v.versionSource !== undefined && q.versionSource !== undefined) {
    next.versionSource = q.versionSource;
  }
  return next;
}

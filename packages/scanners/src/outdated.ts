/**
 * npm-registry freshness client — backs `factstack outdated` (ft-4).
 *
 * Compares each installed dependency against the registry's `latest`
 * dist-tag and flags the ones that have moved on: the "are we behind?"
 * counterpart to scan-vulns' "are we vulnerable?". Like scan-vulns it's a
 * separate, network-touching, opt-in step — FACTS' analyze pass makes zero
 * network calls by design, so freshness can't live there.
 *
 * npm-only for now: the `latest` dist-tag + the `registry.npmjs.org/<pkg>/
 * latest` shape are npm-specific. PyPI/crates/etc. have equivalents behind
 * the same ecosystem switch — left as a follow-up.
 *
 * Constraint C1: pure isomorphic — `fetch` only, no `node:*`, no DOM types.
 * `fetch` is injectable so tests run offline against a stub registry; the
 * CLI lets the module bind Node 18+'s global fetch.
 */

import type { ManifestEcosystem } from '@factstack/spec';

/* The scanners tsconfig uses `lib: ["ES2022"]` only — `fetch` is a platform
 * global in Node 18+ AND every modern browser, but TS can't see it from a
 * bare ES2022 lib. Declare the narrow surface we use (same approach as
 * vulnerabilities.ts) rather than dragging in DOM or @types/node. */
type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignalLike },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
declare const fetch: FetchFn;

/* `AbortSignal.timeout(ms)` is a Node 18+/browser global the bare ES2022 lib
 * doesn't type. Declare the slice we use (same tactic as `fetch` above). */
interface AbortSignalLike { readonly aborted: boolean }
declare const AbortSignal: { timeout(ms: number): AbortSignalLike };

const REGISTRY = 'https://registry.npmjs.org/';
/** Per-request abort floor so one stalled registry call can't hang the whole
 *  run (or the `/api/deps-outdated` request that serves the dashboard chip). */
const DEFAULT_TIMEOUT_MS = 10_000;

/* ─────────── public types ─────────── */

export interface OutdatedQuery {
  ecosystem: ManifestEcosystem;
  name: string;
  /** Declared/installed version — may carry a `^`/`~`/range marker, cleaned here. */
  current: string;
}

export interface OutdatedResult {
  ecosystem: ManifestEcosystem;
  name: string;
  /** `current` with any leading range operator stripped. */
  current: string;
  /** The registry's `latest` version, or null when unknown (error / not found / non-npm). */
  latest: string | null;
  isOutdated: boolean;
  error?: string;
}

export interface CheckOutdatedOptions {
  /** Override the registry fetch (tests inject a stub; CLI omits to use the global). */
  fetch?: FetchFn;
  /** Max concurrent registry requests. Default 8. */
  concurrency?: number;
  /** Per-request timeout (ms) before the fetch is aborted and the dep is
   *  marked errored. Default 10000. A stalled registry must never hang the
   *  whole run — that's a denial-of-service on `factstack outdated` and on
   *  the `/api/deps-outdated` endpoint serving the dashboard. */
  timeoutMs?: number;
}

/** Strip a leading semver range operator so `^4.17.20` → `4.17.20`. Mirrors
 *  the cleaning facts-tree's `/api/deps-outdated` did before comparing. */
export function cleanVersion(v: string): string {
  return String(v).replace(/^[\^~>=<\s]+/, '').trim();
}

/** SemVer §2/§9 numeric identifier: `0`, or a non-zero digit followed by more
 *  digits — i.e. a non-negative integer with NO leading zeroes (`01` is not). */
function isNumericId(s: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(s);
}

/* ─────────── semver comparison ─────────── */

interface SemVer {
  release: [number, number, number];
  /** Dot-separated prerelease identifiers, e.g. `['beta', '1']`. Empty for a
   *  release proper. A prerelease sorts BELOW the same release (SemVer §11). */
  prerelease: string[];
}

/** Parse a semver-ish string into comparable parts, or null when the release
 *  core isn't `X[.Y[.Z]]` numeric. Build metadata (`+…`) is ignored. Returning
 *  null (rather than guessing) lets the caller treat the version as unknown —
 *  so a `latest` dist-tag like `next` or a `workspace:*` leftover is reported
 *  as errored, not silently "outdated". */
export function parseSemver(v: string): SemVer | null {
  const cleaned = cleanVersion(v);
  if (cleaned === '') return null;
  const core = cleaned.split('+')[0]!;            // drop build metadata
  const dashAt = core.indexOf('-');               // split release / prerelease
  const releaseStr = dashAt >= 0 ? core.slice(0, dashAt) : core;
  const preStr = dashAt >= 0 ? core.slice(dashAt + 1) : '';
  const nums = releaseStr.split('.');
  if (nums.length === 0 || nums.length > 3) return null;
  const release: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < nums.length; i++) {
    const part = nums[i]!;
    // SemVer §2: numeric identifiers are non-negative ints with NO leading
    // zeroes ('01' is invalid). Reject so a malformed version reports as
    // unknown (null) per this fn's contract, not as a silently-valid release.
    if (!isNumericId(part)) return null;
    release[i] = Number(part);
  }
  const prerelease = preStr ? preStr.split('.') : [];
  for (const id of prerelease) {
    // SemVer §9: each prerelease identifier is non-empty alphanumeric/hyphen;
    // a PURELY numeric one also forbids leading zeroes.
    if (id === '' || !/^[0-9A-Za-z-]+$/.test(id)) return null;
    if (/^[0-9]+$/.test(id) && !isNumericId(id)) return null;
  }
  return { release, prerelease };
}

/** Compare two semver-ish strings: negative (a<b), 0 (equal), positive (a>b),
 *  or null when either side is unparseable (the caller decides). Implements
 *  SemVer §11 precedence enough for freshness checks: numeric release fields,
 *  then "a prerelease is lower than its release", then per-identifier. */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.release[i] !== pb.release[i]) return pa.release[i]! - pb.release[i]!;
  }
  // Equal release core. A version WITH a prerelease ranks below one without.
  const aPre = pa.prerelease.length > 0;
  const bPre = pb.prerelease.length > 0;
  if (aPre !== bPre) return aPre ? -1 : 1;
  if (!aPre) return 0;
  // Both prerelease — compare identifiers left to right (SemVer §11.4).
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;                // shorter prerelease set is lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1;                           // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** A best-effort abort signal that fires after `ms`. Returns undefined when
 *  `AbortSignal.timeout` isn't available (very old runtimes) so the fetch
 *  proceeds untimed rather than throwing. */
function timeoutSignal(ms: number): AbortSignalLike | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Query the npm registry's `latest` dist-tag for each dependency and flag
 * the outdated ones. Offline-tolerant: a failed/timed-out request yields
 * `{ latest: null, isOutdated: false, error }` for that dep rather than
 * throwing, so a flaky network never fails the whole run. Results preserve
 * input order. Concurrency-limited via a shared cursor; each request is
 * abort-bounded by `timeoutMs`.
 */
export async function checkOutdated(
  queries: OutdatedQuery[],
  opts: CheckOutdatedOptions = {},
): Promise<OutdatedResult[]> {
  const doFetch: FetchFn | undefined =
    opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const results = new Array<OutdatedResult>(queries.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= queries.length) return;
      const q = queries[i]!;
      const current = cleanVersion(q.current);
      const base = { ecosystem: q.ecosystem, name: q.name, current };

      if (q.ecosystem !== 'npm') {
        results[i] = { ...base, latest: null, isOutdated: false, error: 'non-npm ecosystem' };
        continue;
      }
      if (!doFetch) {
        results[i] = { ...base, latest: null, isOutdated: false, error: 'no fetch available' };
        continue;
      }
      try {
        const sig = timeoutSignal(timeoutMs);
        const res = await doFetch(
          REGISTRY + encodeURIComponent(q.name) + '/latest',
          sig ? { signal: sig } : {},
        );
        if (!res.ok) {
          results[i] = { ...base, latest: null, isOutdated: false, error: 'HTTP ' + res.status };
          continue;
        }
        const body = (await res.json()) as { version?: string };
        const latest = typeof body.version === 'string' ? body.version : null;
        /* Semver-aware: ONLY a version strictly behind `latest` is outdated.
           A bare string `!==` flagged a version NEWER than latest (a pinned
           RC, brief registry lag) as outdated — which could trip a `--fail-on`
           CI gate on a perfectly current tree. An unparseable version on
           either side is unknown, so it's reported errored, not outdated. */
        let isOutdated = false;
        let cmpError: string | undefined;
        if (latest !== null && current !== '') {
          const cmp = compareSemver(current, latest);
          if (cmp === null) cmpError = 'unparseable version';
          else isOutdated = cmp < 0;
        }
        results[i] = { ...base, latest, isOutdated, ...(cmpError ? { error: cmpError } : {}) };
      } catch (e) {
        results[i] = {
          ...base,
          latest: null,
          isOutdated: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }

  const lanes = Math.min(concurrency, Math.max(1, queries.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

/** Count + partition results for a summary line / CI gate. */
export function summarizeOutdated(results: OutdatedResult[]): {
  total: number;
  outdated: OutdatedResult[];
  errored: number;
} {
  return {
    total: results.length,
    outdated: results.filter((r) => r.isOutdated),
    errored: results.filter((r) => r.error !== undefined).length,
  };
}

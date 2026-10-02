/**
 * @factstack/core — pure diff function.
 *
 * Takes two AgentArtifacts and returns a structured DiffArtifact.
 * File-path-level only (no content diff); that's what agents actually
 * need for "what changed since my last session?" queries.
 */

import { sha256hex } from '@factstack/factspack';
import { SECRET_RULES_REV } from '@factstack/scanners';
import { NEVER_TEXT_EXTENSIONS, SECRET_SCAN_MAX_BYTES } from '@factstack/spec';
import type { AgentArtifact, DiffArtifact, Risk } from '@factstack/spec';

/**
 * Stable identity of a risk across two runs, WITHOUT the line number (lines
 * shift on any edit above the finding). Only ever lives in memory — outputs
 * carry paths and counts.
 *
 * A graded secret carries a one-way `fingerprint` of its value (scanners);
 * with `useDigest` that, with rule + file, IS the identity: every private key
 * shares one preview (`----***--`) and one entropy, so only the digest tells a
 * key swapped for another in the same file (new) from the same key moved
 * (not). Otherwise the old identity: rule + file + redacted preview + the
 * technical message, which distinguishes two findings of the same rule in one
 * file (e.g. two different unresolved specifiers) — except for the one-per-
 * file categories whose message embeds a measurement (a byte count): there
 * rule + file is the identity, or every edit of an already-flagged file would
 * read as a new finding.
 */
export function riskFingerprint(r: Risk, useDigest = true): string {
  if (useDigest && r.fingerprint) {
    return [r.category, r.rule, r.file ?? '', `#${r.fingerprint}`].join('\u0000');
  }
  const message = PER_FILE_CATEGORIES.has(r.category) ? '' : (r.messageTechnical ?? r.message);
  return [r.category, r.rule, r.file ?? '', r.preview ?? '', message].join('\u0000');
}

const PER_FILE_CATEGORIES = new Set<Risk['category']>(['large-file', 'read-error', 'parse-error']);

/** A risk as every surface outside agent.json sees it: without the secret
 *  `fingerprint`, which exists only to diff two agent.json files (SV-8). A
 *  fingerprint lets anyone holding a candidate key confirm it is in the repo,
 *  and no reader needs it. */
export function withoutFingerprint<T extends { fingerprint?: string | undefined }>(
  r: T,
): Omit<T, 'fingerprint'> {
  if (!('fingerprint' in r)) return r;
  const { fingerprint: _omit, ...rest } = r;
  return rest;
}

const hasDigest = (risks: Risk[]): boolean => risks.some((r) => r.fingerprint != null);

export interface DiffRiskSetsOptions {
  /** Match secrets by their `fingerprint`. Default: only when BOTH sides
   *  carry fingerprints — against a side from a scanner that had none, a
   *  digest could never match, so the old (preview) identity is used.
   *  The default is only safe when both sides were scanned under the same
   *  rules: fingerprints from another SECRET_GRADING_REV may use another
   *  scheme, and every secret would read as new + fixed. Callers holding
   *  both artifacts pass `useDigest: secretGrading(before, after).graded`. */
  useDigest?: boolean;
}

/** Risks present in `after` but not `before` (`new`) and the reverse
 *  (`fixed`), matched as a MULTISET by riskFingerprint: a swapped secret is
 *  one new + one fixed (a net count reads 0), the same finding moved to
 *  another line is neither, and two identical findings count twice. With
 *  digests, a secret that left one file and arrived in another under the
 *  same rule and fingerprint is the same key, moved (a rename): neither. */
export function diffRiskSets(
  before: Risk[],
  after: Risk[],
  opts: DiffRiskSetsOptions = {},
): { new: Risk[]; fixed: Risk[] } {
  const useDigest = opts.useDigest ?? (hasDigest(before) && hasDigest(after));
  const matched = multisetDelta(before, after, (r) => riskFingerprint(r, useDigest));
  if (!useDigest) return matched;
  /* SV-7 — pair only what the per-file match left over, so a key COPIED to
     a second file (still in the first) reads as new. */
  return multisetDelta(matched.fixed, matched.new, movedKey);
}

/** A secret's identity across files: rule + fingerprint, no path. */
function movedKey(r: Risk): string | null {
  return r.fingerprint ? [r.category, r.rule, `#${r.fingerprint}`].join('\u0000') : null;
}

/** `after` minus `before` (`new`) and the reverse (`fixed`) as multisets by
 *  `key`, order kept. A null key never matches. */
function multisetDelta(
  before: Risk[],
  after: Risk[],
  key: typeof movedKey,
): { new: Risk[]; fixed: Risk[] } {
  const count = (rs: Risk[]) => {
    const m = new Map<string, number>();
    for (const r of rs) {
      const k = key(r);
      if (k != null) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const unmatched = (rs: Risk[], other: Map<string, number>) =>
    rs.filter((r) => {
      const k = key(r);
      const n = k == null ? 0 : (other.get(k) ?? 0);
      if (n > 0) other.set(k!, n - 1);
      return n === 0;
    });
  return { new: unmatched(after, count(before)), fixed: unmatched(before, count(after)) };
}

/** Why secret deltas between two artifacts cannot be graded:
 *  - `base-older`    — the base was scanned by an older secret scanner (no
 *                      rules revision, no fingerprints) than the head;
 *  - `head-older`    — the reverse;
 *  - `rules-changed` — both record a revision, and they differ.
 *  Under other rules, a key the newer rules can see — committed long ago —
 *  would read as "new". */
export type SecretGradingReason = 'base-older' | 'head-older' | 'rules-changed';
export type SecretGrading = { graded: true } | { graded: false; reason: SecretGradingReason };

/** Bump when analyze() changes which secret findings are exposed without
 *  touching an input hashed into SECRET_GRADING_REV: the test/fixture path
 *  heuristic (isTestFixturePath → `low`, never graded), which files get the
 *  secret pass, or how a secret Risk's severity or fingerprint is set. The
 *  pinned coverage table in diff.test.ts fails when the fixture heuristic
 *  moves. */
const SECRET_COVERAGE_SCHEME = 1;

/**
 * What analyze() stamps as `secretRulesRev`: the graded scanner rules and
 * fingerprint scheme (SECRET_RULES_REV) plus the analyzer's secret coverage —
 * the too-large secret-pass ceiling, the never-text formats it skips, and
 * SECRET_COVERAGE_SCHEME. A coverage change makes already-committed keys
 * visible (or exposed) as surely as a rule change, so it must also stop a
 * review from grading them as new (SV-9).
 */
export const SECRET_GRADING_REV: string = sha256hex(
  JSON.stringify([
    SECRET_RULES_REV,
    SECRET_COVERAGE_SCHEME,
    SECRET_SCAN_MAX_BYTES,
    [...NEVER_TEXT_EXTENSIONS].sort(),
  ]),
).slice(0, 12);

/**
 * Whether secret deltas between `before` and `after` can be graded: both were
 * scanned under the same graded rules (`secretRulesRev`). When neither side
 * records a revision, an older base is still recognised by exposed secrets
 * with no fingerprints next to a head whose secrets have them; two artifacts
 * that both predate revisions are compared as they always were.
 */
export function secretGrading(before: AgentArtifact, after: AgentArtifact): SecretGrading {
  const b = before.secretRulesRev;
  const h = after.secretRulesRev;
  if (b !== h) {
    const reason = b == null ? 'base-older' : h == null ? 'head-older' : 'rules-changed';
    return { graded: false, reason };
  }
  if (b == null) {
    const bs = before.risks.filter(isExposedSecret);
    const hs = after.risks.filter(isExposedSecret);
    if (bs.length > 0 && !hasDigest(bs) && hasDigest(hs)) {
      return { graded: false, reason: 'base-older' };
    }
    if (hs.length > 0 && !hasDigest(hs) && hasDigest(bs)) {
      return { graded: false, reason: 'head-older' };
    }
  }
  return { graded: true };
}

/** An exposed secret: the set health.secrets grades. Test/fixture matches
 *  (`low`) and generic "possible secret" heuristics (`info`, owner decision
 *  2026-09-24) stay out of it. */
export function isExposedSecret(r: Pick<Risk, 'category' | 'severity'>): boolean {
  return r.category === 'secret' && r.severity !== 'low' && r.severity !== 'info';
}

/**
 * Set-based finding deltas between two FULL artifacts (both carry risks[]):
 *   - `secrets` — exposed secrets, the graded delta;
 *   - `ungradedSecrets` — exposed-secret deltas that cannot be graded, for
 *                 listing only (empty when `secretGrading.graded`);
 *   - `risks`   — every other finding except import cycles, which the
 *                 verdict compares structurally from graph.cycles.
 * `secretGrading` says whether the secret delta may be graded. When it may
 * not (the sides were scanned under different rules), secrets are matched
 * the old way (rule + file + redacted preview), and only what is new or
 * fixed under ANY rules stays graded in `secrets`: a secret in a file the
 * base did not have, or one whose file the head no longer has (SV-2). The
 * rest — secrets in files both sides have — goes to `ungradedSecrets`: a key
 * committed long ago that only the newer rules can see would read as "new".
 * Rollup snapshots have no per-finding data; callers must not use this on
 * them (a placeholder risk would read as "fixed").
 */
export function diffFindings(
  before: AgentArtifact,
  after: AgentArtifact,
): {
  secrets: { new: Risk[]; fixed: Risk[] };
  ungradedSecrets: { new: Risk[]; fixed: Risk[] };
  risks: { new: Risk[]; fixed: Risk[] };
  secretGrading: SecretGrading;
} {
  const other = (r: Risk) => !isExposedSecret(r) && r.category !== 'cycle';
  const grading = secretGrading(before, after);
  const secrets = diffRiskSets(
    before.risks.filter(isExposedSecret),
    after.risks.filter(isExposedSecret),
    grading.graded ? {} : { useDigest: false },
  );
  let ungradedSecrets: { new: Risk[]; fixed: Risk[] } = { new: [], fixed: [] };
  if (!grading.graded) {
    const inBase = new Set(before.files.map((f) => f.path));
    const inHead = new Set(after.files.map((f) => f.path));
    // Only in one side's files[]: added (or removed) under any rules.
    const onlyIn = (has: Set<string>, lacks: Set<string>) => (r: Risk) =>
      r.file != null && has.has(r.file) && !lacks.has(r.file);
    const added = onlyIn(inHead, inBase);
    const removed = onlyIn(inBase, inHead);
    ungradedSecrets = {
      new: secrets.new.filter((r) => !added(r)),
      fixed: secrets.fixed.filter((r) => !removed(r)),
    };
    secrets.new = secrets.new.filter(added);
    secrets.fixed = secrets.fixed.filter(removed);
  }
  return {
    secrets,
    ungradedSecrets,
    risks: diffRiskSets(before.risks.filter(other), after.risks.filter(other)),
    secretGrading: grading,
  };
}

/**
 * Snapshots store a rolled-up `{ todos, broken, stale, secrets, risks }`
 * object instead of the full `files[]`, so their per-category counts
 * can't be re-derived from a file-walk. Endpoints backed by a snapshot
 * pass the counts through `overrides` — every field is optional; a
 * missing field falls back to a fresh count over `artifact.files[]` /
 * `artifact.risks[]`.
 */
export interface DiffEndpointOverrides {
  todos?: number;
  broken?: number;
  stale?: number;
  secrets?: number;
}

export interface Endpoint {
  /** Artifact to diff. */
  artifact: AgentArtifact;
  /** Optional filesystem origin for the endpoint marker in the output. */
  snapshotFile?: string;
  /** Snapshot-derived headline counts; see DiffEndpointOverrides. */
  overrides?: DiffEndpointOverrides;
}

/** A stats-only snapshot rollup (the CLI synthesizes one from
 *  `.facts/snapshots/*.json`): it has no per-finding, cycle or CVE data, so
 *  set-diffs against it would report everything on the other side as new
 *  (or fixed). Also recognised when a caller passes only its `.artifact`: no
 *  files[] yet a non-zero file count is a rollup, never a real (empty)
 *  project. A `snapshotFile` on an artifact that still has files[] only
 *  records where it was loaded from. The one test diffArtifacts and the
 *  Change Verdict share. */
export function isRollupEndpoint(ep: Endpoint): boolean {
  const a = ep.artifact;
  return (
    ep.overrides != null ||
    (a.files.length === 0 && (ep.snapshotFile != null || a.stats.fileCount > 0)) ||
    a.risks.some((r) => r.rule === 'snapshot-placeholder')
  );
}

export function diffArtifacts(from: Endpoint, to: Endpoint): DiffArtifact {
  const a = from.artifact;
  const b = to.artifact;

  // Build a path → stats map for each side.
  const mapA = new Map<string, { loc: number; tokens: number }>();
  for (const f of a.files) mapA.set(f.path, { loc: f.loc, tokens: f.tokenCost });
  const mapB = new Map<string, { loc: number; tokens: number }>();
  for (const f of b.files) mapB.set(f.path, { loc: f.loc, tokens: f.tokenCost });

  // File-level delta only makes sense if BOTH sides have populated
  // `files[]`. Snapshots store stats-only rollups, so a snapshot vs a
  // live artifact would otherwise report every current file as "added"
  // (and nothing changed/removed) — actively misleading. We mark the
  // file slice incomplete instead and let consumers render appropriately.
  const filesIncomplete = a.files.length === 0 || b.files.length === 0;

  const added: string[] = [];
  const removed: string[] = [];
  const changed: DiffArtifact['files']['changed'] = [];

  if (!filesIncomplete) {
    for (const [path, bStats] of mapB) {
      const aStats = mapA.get(path);
      if (!aStats) {
        added.push(path);
        continue;
      }
      const locDelta = bStats.loc - aStats.loc;
      const tokenDelta = bStats.tokens - aStats.tokens;
      if (locDelta !== 0 || tokenDelta !== 0) {
        changed.push({ path, locDelta, tokenDelta });
      }
    }
    for (const path of mapA.keys()) {
      if (!mapB.has(path)) removed.push(path);
    }
  }

  // Sort for deterministic output.
  added.sort();
  removed.sort();
  // DET-3: tiebreak by path so equal-magnitude deltas sort deterministically
  // (matches the codebase-wide deterministic-sort convention).
  changed.sort(
    (x, y) =>
      Math.abs(y.tokenDelta) - Math.abs(x.tokenDelta) ||
      (x.path < y.path ? -1 : x.path > y.path ? 1 : 0),
  );

  const delta = (aVal: number, bVal: number) => ({ before: aVal, after: bVal, delta: bVal - aVal });

  const aRisks = a.risks.length;
  const bRisks = b.risks.length;
  const aTodos = from.overrides?.todos ?? countTodos(a);
  const bTodos = to.overrides?.todos ?? countTodos(b);
  /* Exposed secrets only — the same count as health.secrets (and the
     snapshots that feed `overrides`). Test/fixture matches are `low` and
     kept out of it; counting them here made phantom deltas between an
     artifact and its own snapshot. */
  const exposed = (x: AgentArtifact): number => x.risks.filter(isExposedSecret).length;
  const aSecrets = from.overrides?.secrets ?? exposed(a);
  const bSecrets = to.overrides?.secrets ?? exposed(b);

  /* v0.7 — vulnerability ID-set diff + severity-shift score.
   *
   * Set diff: `new` = IDs in `to` not in `from`; `fixed` = IDs in `from`
   * not in `to`. Sorted for deterministic output.
   *
   * Shift score: signed integer with weighted severity. Captures the
   * asymmetry a naive count delta misses — one new critical (+4) +
   * one fixed low (-1) = +3 net, meaning the security posture got
   * meaningfully worse even though the count moved by zero.
   *
   * a.vulnerabilities / b.vulnerabilities default to [] in the v0.6
   * schema, so this works on every artifact without optional chaining
   * gymnastics. Snapshots also default to [] in the synthetic-loader
   * path in cli.ts.
   */
  /* `unknown` (OSV gave no score, or its detail fetch failed on a 429 or a
     timeout) weighs as medium, the review verdict's rule (spec
     vulnFindingSeverity, correctness#8): at 0, a new direct advisory seen
     during an OSV outage slipped past `ci-report --fail-on-shift`. */
  const SEVERITY_SCORE: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    unknown: 2,
  };
  /* Defensive `?? []`: pre-v0.6 artifacts (and test fixtures that
     bypass Zod via `as AgentArtifact`) won't have `vulnerabilities`
     populated. The schema's .default([]) only fills it in at parse
     time, not when the artifact is constructed directly. */
  const aVulns = a.vulnerabilities ?? [];
  const bVulns = b.vulnerabilities ?? [];
  const aVulnIds = new Set(aVulns.map((v) => v.id));
  const bVulnIds = new Set(bVulns.map((v) => v.id));
  /* A snapshot rollup carries no advisory list, so the ID-level delta
     against one is UNKNOWN, not "every current advisory is new" (or every
     base advisory fixed). Same contract as `files.incomplete`: empty sets,
     zero shift, `vulns.incomplete: true`; consumers say "CVE delta
     unavailable". `stats.vulns` still counts each side's list as given. */
  const vulnsIncomplete = isRollupEndpoint(from) || isRollupEndpoint(to);
  const newVulnIds = vulnsIncomplete ? [] : [...bVulnIds].filter((id) => !aVulnIds.has(id)).sort();
  const fixedVulnIds = vulnsIncomplete
    ? []
    : [...aVulnIds].filter((id) => !bVulnIds.has(id)).sort();
  const aScore = aVulns.reduce((s, v) => s + (SEVERITY_SCORE[v.severity] ?? 0), 0);
  const bScore = bVulns.reduce((s, v) => s + (SEVERITY_SCORE[v.severity] ?? 0), 0);

  return {
    $schema: 'https://factstack.dev/schema/diff.v1.json',
    factsVersion: a.factsVersion,
    // DET-1: pure tier — derive the stamp from the 'to' artifact's own timestamp,
    // never the wall clock. Restores INV1/INV2: identical (from,to) inputs now
    // produce byte-identical output.
    generatedAt: b.generatedAt,
    from: { at: a.generatedAt, ...(from.snapshotFile ? { snapshotFile: from.snapshotFile } : {}) },
    to: { at: b.generatedAt, ...(to.snapshotFile ? { snapshotFile: to.snapshotFile } : {}) },
    stats: {
      loc: delta(a.stats.loc, b.stats.loc),
      tokens: delta(a.stats.totalTokenCost, b.stats.totalTokenCost),
      files: delta(a.stats.fileCount, b.stats.fileCount),
      risks: delta(aRisks, bRisks),
      todos: delta(aTodos, bTodos),
      secrets: delta(aSecrets, bSecrets),
      /* v0.7 — count delta. The signed-severity-shift lives on
       *  `vulns` below; this is just the raw count change for parity
       *  with the other stats fields. Against a rollup it reads
       *  `before: 0` (a snapshot keeps no advisory count), so readers must
       *  check `vulns.incomplete` before treating `delta` as added CVEs. */
      vulns: delta(aVulnIds.size, bVulnIds.size),
    },
    files: {
      added,
      removed,
      changed,
      // True when one or both endpoints lacked per-file data (typically
      // a snapshot endpoint). Consumers should suppress added/removed
      // counts and surface a "(file-level diff unavailable)" hint.
      ...(filesIncomplete ? { incomplete: true as const } : {}),
    },
    /* v0.7 — vulnerability ID-set diff + severity-shift score. See the
     *  comments next to the SEVERITY_SCORE table above for the rationale. */
    vulns: {
      new: newVulnIds,
      fixed: fixedVulnIds,
      severityShift: vulnsIncomplete ? 0 : bScore - aScore,
      ...(vulnsIncomplete ? { incomplete: true as const } : {}),
    },
  };
}

function countTodos(a: AgentArtifact): number {
  let n = 0;
  for (const f of a.files) n += f.todos.length;
  return n;
}

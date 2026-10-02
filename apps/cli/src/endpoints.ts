/**
 * Diff endpoints for `diff`, `review` and `ci-report`: loading a full
 * agent.json or a stats-only snapshot rollup from disk, picking the default
 * base, resolving the positional endpoint args, and the set-based finding
 * deltas ci-report prints.
 *
 * Owner decision 2026-09-24: the review baseline is `.facts/baseline/agent.json`
 * (BASELINE_AGENT_FILE) — the previous FULL analysis, which analyze parks
 * before replacing agent.json — and it is the default base for `review` (and
 * `diff`). A snapshot rollup has no per-finding, cycle or CVE data, so
 * comparing the head against one made every existing cycle, secret and CVE
 * look new (correctness#2 / data-model#4). Rollups remain the fallback for a
 * project whose baseline has not been written yet.
 */

import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  diffArtifacts,
  diffFindings,
  isRollupEndpoint,
  type DiffEndpoint,
  type SecretGradingReason,
} from '@factstack/core';
import { readStaleMark, type StaleMark } from '@factstack/emit';
import { isGradedVulnerability, VULN_LABEL_TEXT } from '@factstack/scanners';
import {
  BASELINE_AGENT_FILE,
  type AgentArtifact,
  type DiffArtifact,
  type Risk,
} from '@factstack/spec';
import type { CiReportFindings } from './emitters/ci-report.js';

/**
 * Load an `AgentArtifact`-shaped `DiffEndpoint` from a path on disk.
 *
 * Handles two file shapes:
 *   1. Full `.facts/agent.json` — has `files[]`. Loaded as-is.
 *   2. Compact `.facts/snapshots/<ISO>.json` — stats-only rollup, no
 *      `files[]`. Synthesized into a minimal AgentArtifact with
 *      empty `files`/`graph`/`vulnerabilities` arrays so the diff
 *      function's headline-metric paths work; per-file diffs get
 *      `incomplete: true`. Top-level rollup counts (todos, broken,
 *      stale, secrets) ride along as `overrides` so the diff doesn't
 *      report "0 → current" for them, and `snapshotFile` (with the empty
 *      `files`) marks it as a rollup for the verdict (core's isRollupEndpoint,
 *      the one test diff, review and ci-report share — data-model#35).
 *
 * Returns `null` if the path doesn't exist or doesn't parse — callers
 * (`diff`, `review`, `ci-report`) surface that as their own error message.
 */
export function loadDiffEndpoint(p: string): DiffEndpoint | null {
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    // Heuristic: full agent artifact has `files[]`; snapshot doesn't.
    if (Array.isArray(raw.files)) return { artifact: raw as AgentArtifact };
    // Snapshot → synthesize a minimal AgentArtifact.
    const synthetic: AgentArtifact = {
      $schema: 'https://factstack.dev/schema/agent.v1.json',
      factsVersion: '0.1.0',
      generatedAt: raw.at ?? new Date().toISOString(),
      project: {
        name: '',
        root: '',
        languages: [],
        frameworks: [],
        entryPoints: [],
        monorepo: null,
      },
      files: [],
      graph: {
        nodes: [],
        edges: [],
        cycles: [],
        symbolNodes: [],
        symbolEdges: [],
        entities: [],
        entityEdges: [],
      },
      routes: [],
      scripts: {},
      capabilities: [],
      docs: [],
      rationale: [],
      /* Clamp risk-count synthesis: snapshots are on-disk data we
         don't fully trust (corrupted file, mis-written by an older
         FACTS, etc.). `new Array(1e9).fill(...)` would OOM the CLI
         instantly; cap at a sane upper bound. The cap (10_000) is
         larger than any realistic risk count + small enough to be
         safe to allocate. Negative values would throw RangeError so
         the Math.max(0, …) is load-bearing too. */
      risks: new Array(Math.max(0, Math.min(Number(raw.risks) || 0, 10_000)))
        .fill(null)
        .map(() => ({
          severity: 'info' as const,
          category: 'stale' as const,
          rule: 'snapshot-placeholder',
          message: '',
        })),
      stats: {
        loc: raw.stats?.loc ?? 0,
        fileCount: raw.stats?.fileCount ?? 0,
        packageCount: 0,
        totalTokenCost: raw.stats?.totalTokenCost ?? 0,
      },
      /* Snapshots carry no dep/vuln data: the vulnerability delta against
         one is UNKNOWN, and the verdict + ci-report say so (isRollupEndpoint)
         instead of reading every current CVE as new. */
      dependencyManifests: [],
      vulnerabilities: [],
    };
    const overrides: NonNullable<DiffEndpoint['overrides']> = {};
    if (typeof raw.todos === 'number') overrides.todos = raw.todos;
    if (typeof raw.broken === 'number') overrides.broken = raw.broken;
    if (typeof raw.stale === 'number') overrides.stale = raw.stale;
    if (typeof raw.secrets === 'number') overrides.secrets = raw.secrets;
    return {
      artifact: synthetic,
      snapshotFile: p,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a user-supplied diff-endpoint argument by trying a small
 * candidate list:
 *   1. Raw arg (works if user gave a full or cwd-relative path).
 *   2. `path.resolve(arg)` (absolutize cwd-relative).
 *   3. `<snapDir>/<arg>` (bare snapshot stamp).
 *   4. `<snapDir>/<arg>.json` (snapshot stamp without extension).
 *
 * Returns the first successfully-loaded endpoint, or null.
 */
export function resolveDiffEndpointArg(arg: string, snapDir: string): DiffEndpoint | null {
  const candidates = [
    arg,
    path.resolve(arg),
    path.join(snapDir, arg),
    path.join(snapDir, arg + '.json'),
  ];
  for (const c of candidates) {
    const loaded = loadDiffEndpoint(c);
    if (loaded) return loaded;
  }
  return null;
}

/**
 * Return the lexicographically-sorted list of full snapshot JSON file
 * paths under `.facts/snapshots/`. ISO-stamp filenames make lexi-sort
 * equivalent to chrono-sort, so the last element is "most recent."
 */
export function readdirSnapshotList(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Where a default base came from, for the caller's one-line notice. */
export type BaseSource = 'baseline' | 'snapshot';

/**
 * The default base when the user names none: the review baseline
 * (`.facts/baseline/agent.json`, a full artifact) when it exists, else the
 * PREVIOUS snapshot rollup (the most recent one was written by the same
 * analyze that produced agent.json, so the second-to-last surfaces real
 * change; with a single snapshot, that one).
 */
export function defaultBaseEndpoint(
  factsDir: string,
): { endpoint: DiffEndpoint; source: BaseSource } | null {
  const baseline = loadDiffEndpoint(path.join(factsDir, ...BASELINE_AGENT_FILE.split('/')));
  if (baseline) return { endpoint: baseline, source: 'baseline' };
  const files = readdirSnapshotList(path.join(factsDir, 'snapshots'));
  const pick = files.at(-2) ?? files.at(-1);
  if (!pick) return null;
  const endpoint = loadDiffEndpoint(pick);
  return endpoint ? { endpoint, source: 'snapshot' } : null;
}

/** The pair `diff` and `review` compare; a side that could not be loaded is null. */
export interface EndpointPair {
  from: DiffEndpoint | null;
  to: DiffEndpoint | null;
  /** Set only when no base was named and a default one was found. */
  baseSource?: BaseSource;
  /** Set when `to` is the default head (.facts/agent.json) and the per-edit
   *  `analyze --minimal` hook has marked it stale: it is the last FULL
   *  analyze, not the tree as it is now. */
  headStale?: StaleMark;
}

/**
 * Resolve the positional endpoints `diff [a] [b]` and `review [base] [head]`
 * share (cli-dry-2): two args → both through resolveDiffEndpointArg; one →
 * it vs the current agent.json; none → the default base (defaultBaseEndpoint)
 * vs agent.json, with `baseSource` so a caller can say it fell back to a
 * snapshot rollup. A default head carries its stale mark (`headStale`).
 */
export function resolveEndpointPair(
  a: string | undefined,
  b: string | undefined,
  factsDir: string,
): EndpointPair {
  const snapDir = path.join(factsDir, 'snapshots');
  if (a && b) {
    return { from: resolveDiffEndpointArg(a, snapDir), to: resolveDiffEndpointArg(b, snapDir) };
  }
  const head = defaultHeadEndpoint(factsDir);
  const to = { to: head.endpoint, ...(head.stale ? { headStale: head.stale } : {}) };
  if (a) return { from: resolveDiffEndpointArg(a, snapDir), ...to };
  const base = defaultBaseEndpoint(factsDir);
  return base ? { from: base.endpoint, ...to, baseSource: base.source } : { from: null, ...to };
}

/**
 * The default head, `.facts/agent.json`, with its stale mark: after
 * the per-edit `--minimal` hook it is older than agent.pack, so a diff or
 * gate against it misses every edit made since the last full analyze.
 */
export function defaultHeadEndpoint(factsDir: string): {
  endpoint: DiffEndpoint | null;
  stale: StaleMark | null;
} {
  const endpoint = loadDiffEndpoint(path.join(factsDir, 'agent.json'));
  return { endpoint, stale: endpoint ? readStaleMark(factsDir) : null };
}

/** The endpoint with its GRADED advisories only (direct runtime deps). */
function gradedOnly(ep: DiffEndpoint): DiffEndpoint {
  const vulns = ep.artifact.vulnerabilities ?? [];
  return {
    ...ep,
    artifact: { ...ep.artifact, vulnerabilities: vulns.filter(isGradedVulnerability) },
  };
}

/**
 * The severity shift ci-report's headline and `--fail-on-shift` grade
 * (cli-r3-2). Owner decision 2026-09-24: dev/transitive advisories are
 * listed, not graded, and the verdict follows the same rule — core's
 * `vulns.severityShift` sums every advisory. Scored by core's diffArtifacts
 * on graded-only copies, so the severity weights stay core's; 0 against a
 * rollup (no CVE list), as in core.
 */
export function gradedSeverityShift(from: DiffEndpoint, to: DiffEndpoint): number {
  return diffArtifacts(gradedOnly(from), gradedOnly(to)).vulns.severityShift;
}

/**
 * Notes for the advisory IDs ci-report lists but does not grade: every row
 * carrying the ID is a dev or transitive one — new IDs looked up in the head,
 * fixed IDs in the base. Wording is the scanners' VULN_LABEL_TEXT (INV7); a
 * scope outside the known set is not echoed (the note lands in a PR comment).
 */
export function notGradedVulnNotes(
  from: DiffEndpoint,
  to: DiffEndpoint,
  diff: DiffArtifact,
): Record<string, string> {
  const notes: Record<string, string> = {};
  const add = (ids: readonly string[], artifact: AgentArtifact): void => {
    const want = new Set(ids);
    const rows = new Map<string, AgentArtifact['vulnerabilities']>();
    for (const v of artifact.vulnerabilities ?? []) {
      if (want.has(v.id)) rows.set(v.id, [...(rows.get(v.id) ?? []), v]);
    }
    for (const [id, vs] of rows) {
      if (vs.some(isGradedVulnerability)) continue;
      const scopes = [...new Set(vs.map((v) => v.scope))]
        .filter((s) => s === 'dev' || s === 'transitive')
        .sort();
      notes[id] = scopes.length
        ? `${scopes.join('/')}: ${VULN_LABEL_TEXT.notGraded}`
        : VULN_LABEL_TEXT.notGraded;
    }
  };
  add(diff.vulns.new, to.artifact);
  add(diff.vulns.fixed, from.artifact);
  return notes;
}

/** Distinct, sorted file paths of some findings — paths only, never values. */
const filesOf = (risks: Risk[]): string[] =>
  [...new Set(risks.flatMap((r) => (r.file ? [r.file] : [])))].sort();

/** Why a secret delta was not graded — the clause core's Change Verdict
 *  uses (review.ts UNGRADED_SECRETS_WHY), so review and ci-report agree. */
const UNGRADED_SECRETS_WHY: Record<SecretGradingReason, string> = {
  'base-older': 'the baseline was made by an older secret scanner',
  'head-older': 'the head was made by an older secret scanner than the baseline',
  'rules-changed': 'the secret rules changed between the baseline and the head',
};

/**
 * Set-based finding deltas for ci-report (core `diffFindings`), or null when
 * either endpoint is a rollup (core's isRollupEndpoint — a full artifact that
 * only records where it was loaded from is compared in full) — then only net
 * counts exist and ci-report falls back to them. Counts and file paths only.
 * When the two sides were scanned under different secret rules, core moves
 * secrets in files both sides have into `ungradedSecrets`; they ride along
 * with the reason instead of vanishing from the report.
 */
export function reportFindings(from: DiffEndpoint, to: DiffEndpoint): CiReportFindings | null {
  if (isRollupEndpoint(from) || isRollupEndpoint(to)) return null;
  const sets = diffFindings(from.artifact, to.artifact);
  const grading = sets.secretGrading;
  const ungraded = sets.ungradedSecrets;
  return {
    secrets: {
      new: sets.secrets.new.length,
      fixed: sets.secrets.fixed.length,
      newFiles: filesOf(sets.secrets.new),
    },
    risks: {
      new: sets.risks.new.length,
      fixed: sets.risks.fixed.length,
      newFiles: filesOf(sets.risks.new),
    },
    ...(!grading.graded && (ungraded.new.length > 0 || ungraded.fixed.length > 0)
      ? {
          ungradedSecrets: {
            new: ungraded.new.length,
            fixed: ungraded.fixed.length,
            newFiles: filesOf(ungraded.new),
            reason: UNGRADED_SECRETS_WHY[grading.reason],
          },
        }
      : {}),
  };
}

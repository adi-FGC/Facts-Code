/**
 * `since(timestamp)` — what changed since an ISO timestamp.
 *
 * The agent contract: a long-running coding agent that reconnects to
 * a project shouldn't pay 90K tokens to re-read the full `agent.json`
 * if 5KB of "what's new" answers its question. This module produces
 * that 5KB.
 *
 * Two modes, picked by what the caller has on hand:
 *
 *   1. **`sinceFromMtime(current, ts)`** — fast path. Walk
 *      `current.files[]`, find every file with `lastModifiedMs > ts`.
 *      Returns the changed file paths + their summaries (LOC, status,
 *      tokenCost). NO new-routes / new-risks fidelity here because we
 *      have no prior baseline to compare against. Use when you only
 *      have one analyze run.
 *
 *   2. **`sinceFromBaseline(current, prior, ts)`** — accurate path.
 *      Compare two artifacts. Reports added / modified / removed files,
 *      added / removed routes, added / removed risks. Filters by `ts`
 *      so the report covers ONLY the activity window the caller asked
 *      about — useful for "what changed since my last MEMORY.md
 *      generation" without dumping everything in the snapshot history.
 *
 * Pure / isomorphic. The CLI / MCP server provides the prior artifact: the
 * previous full analysis kept at `.facts/baseline/agent.json`
 * (BASELINE_AGENT_FILE in @factstack/spec), which analyze rotates in just
 * before it writes the new `agent.json`.
 */

import type { AgentArtifact, FileOutline, Risk, RouteDecl } from '@factstack/spec';
import { byCodeUnit } from '@factstack/spec';
import { diffRiskSets, secretGrading, withoutFingerprint } from './diff.js';

export interface SinceFileSummary {
  path: string;
  loc: number;
  tokenCost: number;
  status: FileOutline['status'];
  /** When `lastModifiedMs` is known, ISO timestamp of the last change.
   *  Null when unknown: the file's mtime wasn't captured, or (baseline
   *  mode) it has uncommitted edits and its timestamp is the last commit's. */
  lastModified: string | null;
  /** v0.3.8 — `'added'`, `'modified'`, or `'removed'` depending on
   *  whether this file appears in the baseline. In the mtime-only mode
   *  this is always `'modified'` (we can't tell added vs modified
   *  without a baseline). */
  kind: 'added' | 'modified' | 'removed';
}

export interface SinceReport {
  /** ISO timestamp the report was generated at. */
  generatedAt: string;
  /** ISO timestamp the caller asked about — the lower bound. */
  since: string;
  /** Whether a prior baseline was available; affects the fidelity of
   *  the `kind` field on file summaries. */
  hasBaseline: boolean;
  /** Files changed since `since`. Sorted by lastModified desc. */
  files: SinceFileSummary[];
  /** Routes added since `since`. Empty when no baseline. */
  routesAdded: RouteDecl[];
  /** Routes removed since `since`. Empty when no baseline. */
  routesRemoved: RouteDecl[];
  /** Risks added since `since`. Empty when no baseline. */
  risksAdded: Risk[];
  /** Risks removed since `since`. Empty when no baseline. */
  risksRemoved: Risk[];
  /** New top-level declarations across the changed files. Aggregated
   *  for the agent's quick-look — full per-file detail still lives
   *  in `current.files[]`. */
  declarationsAdded: number;
  /** Total token cost of files changed in this window. Lets agents
   *  decide "is this update small enough to read fully, or do I just
   *  read the headlines?" */
  tokenCostInWindow: number;
}

const EMPTY: SinceReport = {
  generatedAt: '',
  since: '',
  hasBaseline: false,
  files: [],
  routesAdded: [],
  routesRemoved: [],
  risksAdded: [],
  risksRemoved: [],
  declarationsAdded: 0,
  tokenCostInWindow: 0,
};

function toIso(ms: number | null): string | null {
  if (ms == null) return null;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/* ─────────────────────────────────────────────────────────────────
 * Mode 1: mtime-only. No baseline; returns "files changed since" only.
 * ─────────────────────────────────────────────────────────────── */

export function sinceFromMtime(current: AgentArtifact, since: string): SinceReport {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) {
    // DET-2: pure tier — derive the stamp from the input artifact, never the
    // wall clock (matches the success path below, keeps output deterministic).
    return { ...EMPTY, generatedAt: current.generatedAt, since };
  }

  const files: SinceFileSummary[] = [];
  let tokenCostInWindow = 0;
  let declarationsAdded = 0;

  for (const f of current.files) {
    if (f.lastModifiedMs == null) continue;
    if (f.lastModifiedMs <= sinceMs) continue;
    files.push({
      path: f.path,
      loc: f.loc,
      tokenCost: f.tokenCost,
      status: f.status,
      lastModified: toIso(f.lastModifiedMs),
      kind: 'modified', // can't distinguish without a baseline
    });
    tokenCostInWindow += f.tokenCost;
    declarationsAdded += f.declarations.length;
  }
  // Most recent first.
  // DI-1: code-unit (not locale) for INV2 byte-determinism
  files.sort((a, b) => byCodeUnit(b.lastModified ?? '', a.lastModified ?? ''));

  return {
    generatedAt: current.generatedAt,
    since,
    hasBaseline: false,
    files,
    routesAdded: [],
    routesRemoved: [],
    risksAdded: [],
    risksRemoved: [],
    declarationsAdded,
    tokenCostInWindow,
  };
}

/* ─────────────────────────────────────────────────────────────────
 * Mode 2: baseline-aware. Real diff between two artifacts, scoped to
 * activity since `since`. The baseline gives us added/removed; the
 * timestamp filter keeps the report focused.
 * ─────────────────────────────────────────────────────────────── */

function fileKey(p: string): string {
  // Normalize path separator just in case the baseline came from
  // Windows and the current came from Posix (or vice-versa).
  return p.replace(/\\/g, '/');
}

function routeKey(r: RouteDecl): string {
  return `${r.framework}|${r.method ?? ''}|${r.path}|${r.handlerFile}`;
}

export function sinceFromBaseline(
  current: AgentArtifact,
  prior: AgentArtifact,
  since: string,
): SinceReport {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) {
    // DET-2: pure tier — derive the stamp from the input artifact, never the
    // wall clock (matches the success path below, keeps output deterministic).
    return { ...EMPTY, generatedAt: current.generatedAt, since };
  }

  const priorByPath = new Map(prior.files.map((f) => [fileKey(f.path), f]));
  const currentByPath = new Map(current.files.map((f) => [fileKey(f.path), f]));

  const files: SinceFileSummary[] = [];
  let tokenCostInWindow = 0;
  let declarationsAdded = 0;

  /* A baseline taken at or after the cutoff means every difference from it
     happened inside the window, whatever the file's timestamp says — and
     that timestamp is the git COMMIT time when git was mined, so an
     uncommitted edit to a tracked file carries an old one. Only a baseline
     older than the cutoff needs the timestamp to place a change. */
  const priorAt = Date.parse(prior.generatedAt);
  const baselineInWindow = Number.isFinite(priorAt) && priorAt >= sinceMs;

  // Added + modified — only if their mtime is after the cutoff.
  for (const f of current.files) {
    const k = fileKey(f.path);
    const wasInPrior = priorByPath.has(k);
    const mtimeOK =
      baselineInWindow || f.lastModifiedMs == null ? true : f.lastModifiedMs > sinceMs;
    if (!wasInPrior) {
      if (!mtimeOK) continue;
      files.push({
        path: f.path,
        loc: f.loc,
        tokenCost: f.tokenCost,
        status: f.status,
        lastModified: toIso(f.lastModifiedMs),
        kind: 'added',
      });
      tokenCostInWindow += f.tokenCost;
      declarationsAdded += f.declarations.length;
    } else {
      // Touched in window. Cheap proxy for "modified": mtime is after
      // the cutoff. Could deepen this with content hash later.
      const beforeF = priorByPath.get(k)!;
      const changed = f.bytes !== beforeF.bytes || f.loc !== beforeF.loc;
      /* Content moved but the timestamp did not: it is the last COMMIT's,
         and the edit is uncommitted. It happened after the baseline, and the
         timestamp cannot say whether before or after the cutoff — report it
         (time unknown) rather than hide the edit the caller asked about. */
      const stale =
        changed && f.lastModifiedMs != null && f.lastModifiedMs === beforeF.lastModifiedMs;
      if (changed && (mtimeOK || stale)) {
        files.push({
          path: f.path,
          loc: f.loc,
          tokenCost: f.tokenCost,
          status: f.status,
          lastModified: stale ? null : toIso(f.lastModifiedMs),
          kind: 'modified',
        });
        tokenCostInWindow += f.tokenCost;
        declarationsAdded += Math.max(0, f.declarations.length - beforeF.declarations.length);
      }
    }
  }

  // Removed files: in prior but not in current. We have no mtime to
  // gate by, so report them all — the caller already asked since this
  // timestamp; if it predated the analysis, they'll see legacy
  // removals once.
  for (const f of prior.files) {
    const k = fileKey(f.path);
    if (currentByPath.has(k)) continue;
    files.push({
      path: f.path,
      loc: f.loc,
      tokenCost: f.tokenCost,
      status: f.status,
      lastModified: toIso(f.lastModifiedMs),
      kind: 'removed',
    });
  }

  // Routes diff. Static AST decisions — added/removed are exact.
  const priorRoutes = new Map(prior.routes.map((r) => [routeKey(r), r]));
  const currentRoutes = new Map(current.routes.map((r) => [routeKey(r), r]));
  const routesAdded: RouteDecl[] = [];
  const routesRemoved: RouteDecl[] = [];
  for (const [k, r] of currentRoutes) if (!priorRoutes.has(k)) routesAdded.push(r);
  for (const [k, r] of priorRoutes) if (!currentRoutes.has(k)) routesRemoved.push(r);

  // Risks diff: matched one by one on the full fingerprint (a truncated
  // message key merged distinct risks, e.g. every 2-file cycle under src/),
  // without the line so a finding that merely moved is not "new". Secret
  // fingerprints are trusted only between artifacts scanned under the same
  // secret rules revision (SV-6): across a scheme or coverage change every
  // secret would read as removed + added.
  // Same rule as diffFindings: graded keeps the default (digests only when
  // both sides carry them).
  const riskSets = diffRiskSets(
    prior.risks,
    current.risks,
    secretGrading(prior, current).graded ? {} : { useDigest: false },
  );
  // The report goes to agents (MCP `since`): the fingerprint used to match
  // secrets above stays behind (SV-8).
  const risksAdded: Risk[] = riskSets.new.map(withoutFingerprint);
  const risksRemoved: Risk[] = riskSets.fixed.map(withoutFingerprint);

  // Sort files: added first, then modified, then removed.
  // Within each group, most recent first.
  files.sort((a, b) => {
    const order = { added: 0, modified: 1, removed: 2 };
    if (a.kind !== b.kind) return order[a.kind] - order[b.kind];
    return byCodeUnit(b.lastModified ?? '', a.lastModified ?? '');
  });

  return {
    generatedAt: current.generatedAt,
    since,
    hasBaseline: true,
    files,
    routesAdded,
    routesRemoved,
    risksAdded,
    risksRemoved,
    declarationsAdded,
    tokenCostInWindow,
  };
}

/** Top-level convenience that picks the right mode based on whether
 *  a baseline was supplied. */
export function since(
  current: AgentArtifact,
  sinceTs: string,
  baseline?: AgentArtifact,
): SinceReport {
  // A baseline only supports a file-level diff if it actually carries files[].
  // Rolled-up "stats only" snapshots (what the MCP server writes on every boot)
  // omit it; guarding here keeps sinceFromBaseline's `prior.files.map(...)` from
  // throwing a TypeError for any caller that hands us a fileless artifact — we
  // degrade to mtime-only mode instead of crashing. (The MCP server also asks
  // readLatestSnapshot for requireFull=true; this is the defense-in-depth layer.)
  if (baseline && Array.isArray(baseline.files))
    return sinceFromBaseline(current, baseline, sinceTs);
  return sinceFromMtime(current, sinceTs);
}

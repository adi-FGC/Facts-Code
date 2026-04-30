/**
 * @factstack/core — pure diff function.
 *
 * Takes two AgentArtifacts and returns a structured DiffArtifact.
 * File-path-level only (no content diff); that's what agents actually
 * need for "what changed since my last session?" queries.
 */

import type { AgentArtifact, DiffArtifact } from '@factstack/spec';

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
      if (!aStats) { added.push(path); continue; }
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
  changed.sort((x, y) => Math.abs(y.tokenDelta) - Math.abs(x.tokenDelta));

  const delta = (aVal: number, bVal: number) => ({ before: aVal, after: bVal, delta: bVal - aVal });

  const aRisks = a.risks.length;
  const bRisks = b.risks.length;
  const aTodos = from.overrides?.todos ?? countTodos(a);
  const bTodos = to.overrides?.todos ?? countTodos(b);
  const aSecrets = from.overrides?.secrets ?? a.risks.filter((r) => r.category === 'secret').length;
  const bSecrets = to.overrides?.secrets ?? b.risks.filter((r) => r.category === 'secret').length;

  return {
    $schema: 'https://factstack.dev/schema/diff.v1.json',
    factsVersion: a.factsVersion,
    generatedAt: new Date().toISOString(),
    from: { at: a.generatedAt, ...(from.snapshotFile ? { snapshotFile: from.snapshotFile } : {}) },
    to:   { at: b.generatedAt, ...(to.snapshotFile   ? { snapshotFile: to.snapshotFile   } : {}) },
    stats: {
      loc:     delta(a.stats.loc, b.stats.loc),
      tokens:  delta(a.stats.totalTokenCost, b.stats.totalTokenCost),
      files:   delta(a.stats.fileCount, b.stats.fileCount),
      risks:   delta(aRisks, bRisks),
      todos:   delta(aTodos, bTodos),
      secrets: delta(aSecrets, bSecrets),
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
  };
}

function countTodos(a: AgentArtifact): number {
  let n = 0;
  for (const f of a.files) n += f.todos.length;
  return n;
}

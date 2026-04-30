/**
 * @factstack/graph — caller index (reverse dependency).
 *
 * Inverts the file-level edge list so you can ask "who imports this
 * file?" in O(1). The answer lands on each GraphNode's optional
 * `callers` field when the core pipeline calls `buildCallerIndex`
 * after `buildDependencyGraph`.
 *
 * Type-only edges are INCLUDED here — callers want the full set
 * (even type imports count as "this file is referenced from there"
 * for refactoring questions). Cycles are also present; this is just
 * a reverse map over the same edge set.
 */

import type { DependencyGraph } from './dependency.js';

export type CallerIndex = Map<string, string[]>;

/**
 * Build a reverse adjacency map from a DependencyGraph.
 *   Key:   file path
 *   Value: sorted, deduped list of file paths that import the key
 */
export function buildCallerIndex(graph: Pick<DependencyGraph, 'edges'>): CallerIndex {
  const inverted = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const bucket = inverted.get(edge.to) ?? new Set<string>();
    bucket.add(edge.from);
    inverted.set(edge.to, bucket);
  }
  const out: CallerIndex = new Map();
  for (const [to, callers] of inverted) {
    out.set(to, [...callers].sort());
  }
  return out;
}

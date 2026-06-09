/**
 * @factstack/graph — graph analytics (F5): PageRank importance + label-
 * propagation communities over the file-level dependency graph.
 *
 * Pure / isomorphic (INV1): no node:* imports, no wall-clock, no randomness.
 * Deterministic (INV2): fixed iteration counts (never loop-until-converge),
 * path-sorted processing, sorted adjacency (so floating-point addition order is
 * stable regardless of edge insertion order), lowest-id tie-breaks, and
 * fixed-precision rounding. Two runs over the same graph produce byte-identical
 * maps.
 *
 * Semantics: edges point importer → imported, so PageRank flows rank TO the
 * files that are depended upon — a heavily-imported utility ranks high. That
 * matches "key files: read these first", but weighted (a file imported by
 * other important files is itself more important than raw in-degree implies).
 */

import type { DependencyGraph } from './dependency.js';

export interface GraphMetrics {
  /** node path → normalized PageRank in [0,1] (the top node = 1.0), rounded to
   *  4 decimals. Relative importance, good for ranking + a 0..1 dashboard bar. */
  importance: Map<string, number>;
  /** node path → community id. Communities are renumbered by smallest-member
   *  path so an existing cluster's id is stable as the graph grows. */
  community: Map<string, number>;
}

const PAGERANK_ITERS = 30;   // fixed — determinism over convergence-stopping
const DAMPING = 0.85;
const LABELPROP_PASSES = 10; // fixed
const PRECISION = 1e4;       // 4 decimal places

function round4(x: number): number {
  return Math.round(x * PRECISION) / PRECISION;
}

const asc = (a: number, b: number): number => a - b;

/**
 * Compute importance (PageRank) + community (label propagation) for a file
 * dependency graph. Returns maps keyed by node path. An empty graph yields
 * empty maps; a single isolated node gets importance 1.0 and community 0.
 */
export function computeMetrics(graph: Pick<DependencyGraph, 'nodes' | 'edges'>): GraphMetrics {
  // Process in path-sorted order so the whole computation is independent of the
  // analyzer's file-enumeration order (INV2).
  const ids = graph.nodes.map((n) => n.path).sort();
  const N = ids.length;
  if (N === 0) return { importance: new Map(), community: new Map() };

  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));

  // Build adjacency as Sets first (dedup multi-edges: the same from→to via
  // `import` + `type-import` counts once), then freeze into SORTED arrays so
  // every later traversal visits neighbors in the same order on every run.
  const outSet: Set<number>[] = ids.map(() => new Set());
  const undirSet: Set<number>[] = ids.map(() => new Set());
  for (const e of graph.edges) {
    const f = index.get(e.from);
    const t = index.get(e.to);
    if (f === undefined || t === undefined || f === t) continue;
    outSet[f]!.add(t);
    undirSet[f]!.add(t);
    undirSet[t]!.add(f);
  }
  const out: number[][] = outSet.map((s) => [...s].sort(asc));
  const undirected: number[][] = undirSet.map((s) => [...s].sort(asc));
  const outDeg = out.map((a) => a.length);

  // ── PageRank: power method, fixed iterations, uniform dangling redistribution.
  let rank = new Array<number>(N).fill(1 / N);
  for (let iter = 0; iter < PAGERANK_ITERS; iter++) {
    const base = (1 - DAMPING) / N;
    const next = new Array<number>(N).fill(base);
    // Dangling nodes (no out-edges) leak their mass; redistribute it uniformly
    // so the total stays 1 and rank doesn't silently drain.
    let dangling = 0;
    for (let i = 0; i < N; i++) if (outDeg[i] === 0) dangling += rank[i]!;
    const danglingShare = (DAMPING * dangling) / N;
    for (let i = 0; i < N; i++) next[i]! += danglingShare;
    // Push each node's rank evenly along its (sorted) out-edges.
    for (let i = 0; i < N; i++) {
      const deg = outDeg[i]!;
      if (deg === 0) continue;
      const share = (DAMPING * rank[i]!) / deg;
      for (const j of out[i]!) next[j]! += share;
    }
    rank = next;
  }
  // Normalize by the max so the most important node = 1.0.
  let maxRank = 0;
  for (let i = 0; i < N; i++) if (rank[i]! > maxRank) maxRank = rank[i]!;
  const importance = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    importance.set(ids[i]!, maxRank > 0 ? round4(rank[i]! / maxRank) : 0);
  }

  // ── Communities: deterministic asynchronous label propagation.
  // Each node starts as its own community. In path-sorted order it adopts the
  // most frequent label among undirected neighbors; ties broken by the lowest
  // label value (so the result is independent of tally order). Async: updates
  // are visible within the same pass. Fixed pass count; early-out on no change.
  const label = new Array<number>(N);
  for (let i = 0; i < N; i++) label[i] = i;
  for (let pass = 0; pass < LABELPROP_PASSES; pass++) {
    let changed = false;
    for (let i = 0; i < N; i++) {
      const nbrs = undirected[i]!;
      if (nbrs.length === 0) continue;
      const counts = new Map<number, number>();
      for (const j of nbrs) counts.set(label[j]!, (counts.get(label[j]!) ?? 0) + 1);
      let best = label[i]!;
      let bestCount = -1;
      for (const [lab, cnt] of counts) {
        if (cnt > bestCount || (cnt === bestCount && lab < best)) {
          best = lab;
          bestCount = cnt;
        }
      }
      if (best !== label[i]) {
        label[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Renumber: first label encountered (in path-sorted order) becomes community
  // 0, the next new one community 1, etc. Smallest-member path ⇒ stable id.
  const renumber = new Map<number, number>();
  let nextCid = 0;
  const community = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const lab = label[i]!;
    let cid = renumber.get(lab);
    if (cid === undefined) {
      cid = nextCid++;
      renumber.set(lab, cid);
    }
    community.set(ids[i]!, cid);
  }

  return { importance, community };
}

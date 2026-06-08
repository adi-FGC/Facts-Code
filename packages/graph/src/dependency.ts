/**
 * @factstack/graph — dependency graph builder.
 *
 * Takes per-file imports + resolver context, produces a GraphSchema-compatible
 * { nodes, edges, cycles } triple. Cycles are detected with a single DFS.
 */

import type { FileOutline, Confidence } from '@factstack/spec';
import type { RawImport } from '@factstack/extractors';
import { resolveSpecifier, type ResolverContext } from './resolver.js';

export interface DependencyGraph {
  // `callers` is optional and populated by `buildCallerIndex` after the
  // graph is built — mirrors the `GraphNodeSchema` shape in @factstack/spec.
  nodes: Array<{ id: string; path: string; language: string; loc: number; tokenCost: number; status: FileOutline['status']; callers?: string[] }>;
  edges: Array<{ from: string; to: string; kind: 'import' | 'dynamic-import' | 'type-import'; confidence: Confidence; confidenceScore?: number }>;
  cycles: string[][];
}

export function buildDependencyGraph(
  outlines: FileOutline[],
  importsByFile: Map<string, RawImport[]>,
  ctx: ResolverContext,
): DependencyGraph {
  const nodes: DependencyGraph['nodes'] = outlines.map((o) => ({
    id: o.path,
    path: o.path,
    language: o.language,
    loc: o.loc,
    tokenCost: o.tokenCost,
    status: o.status,
  }));

  const edges: DependencyGraph['edges'] = [];
  const seen = new Set<string>();      // dedupe by `from|to|kind`

  for (const [from, imports] of importsByFile) {
    for (const imp of imports) {
      const to = resolveSpecifier(imp.specifier, from, ctx);
      if (!to) continue;                 // external or unresolved
      if (to === from) continue;         // self-loop
      const kind: DependencyGraph['edges'][number]['kind'] =
        imp.kind === 'dynamic-import' ? 'dynamic-import'
        : imp.kind === 'type-import' ? 'type-import'
        : 'import';
      const key = from + '|' + to + '|' + kind;
      if (seen.has(key)) continue;
      seen.add(key);
      // F1 — import edges are read directly from source, so always `extracted`.
      // Score omitted (implicitly 1.0); F2 sets it for inferred/ambiguous edges.
      edges.push({ from, to, kind, confidence: 'extracted' });
    }
  }

  // Cycle detection via iterative DFS — node-ids → adjacency
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === 'type-import') continue;     // type-only imports aren't runtime cycles
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  const cycles = findCycles(adj);

  return { nodes, edges, cycles };
}

/**
 * Tarjan's SCC: returns strongly-connected components with size > 1 (real cycles).
 * A self-loop would also be a cycle, but we filter those out at edge build time.
 */
function findCycles(adj: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  const strongconnect = (v: string) => {
    // Iterative Tarjan to avoid stack overflow on deep trees.
    const work: Array<{ node: string; it: number }> = [];
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    work.push({ node: v, it: 0 });

    while (work.length) {
      const top = work[work.length - 1]!;
      const neighbors = adj.get(top.node) ?? [];
      if (top.it < neighbors.length) {
        const w = neighbors[top.it]!;
        top.it++;
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlinks.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, it: 0 });
        } else if (onStack.has(w)) {
          lowlinks.set(top.node, Math.min(lowlinks.get(top.node)!, indices.get(w)!));
        }
      } else {
        if (lowlinks.get(top.node) === indices.get(top.node)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== top.node);
          if (scc.length > 1) result.push(scc);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1]!;
          lowlinks.set(parent.node, Math.min(lowlinks.get(parent.node)!, lowlinks.get(top.node)!));
        }
      }
    }
  };

  for (const node of adj.keys()) {
    if (!indices.has(node)) strongconnect(node);
  }
  return result;
}

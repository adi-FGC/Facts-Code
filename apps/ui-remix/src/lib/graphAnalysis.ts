/**
 * Pure graph-analysis primitives shared by every Graph-tab subview.
 *
 * What lives here:
 *   - `tarjanSCC` — strongly-connected components (cycle finder).
 *   - `layerByLongestPath` — Kahn-topological layer assignment after
 *     SCC collapse.
 *   - `orderByBarycenter` — within-layer vertex ordering that
 *     minimizes edge crossings (Sugiyama step 3).
 *   - `buildSugiyamaLayout` — composes all of the above into the
 *     `{ layers, positions, edges }` shape the SVG renderer wants.
 *   - `buildHeatmap`, `buildHubs`, `buildCouplings` — folder-level +
 *     file-level summaries that feed the existing tables.
 *
 * What does NOT live here:
 *   - SVG / DOM code — keeps this file isomorphic + testable.
 *   - Dataset shape coupling — every function takes plain edge lists
 *     and adjacency maps. Routes adapt their Dataset → these inputs
 *     once at the top of the render.
 *
 * History: tarjanSCC + layerByLongestPath were originally inline in
 * routes/Dag.tsx; the Heatmap math lived in routes/GraphRoute.tsx.
 * Both routes are merging into a single Graph tab with view-mode
 * switching, so the math moves to one shared module.
 */

/* ─────────── cycle detection ─────────── */

/**
 * Tarjan's strongly-connected-components, iterative version. Returns
 * SCCs as arrays of node ids. Iterative because some monorepos have
 * dependency depths > 10K which blow the call stack on the recursive
 * variant in V8.
 */
export function tarjanSCC(nodes: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  type Frame = { node: string; iter: number };
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Frame[] = [{ node: start, iter: 0 }];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const succ = adj.get(top.node) ?? [];
      if (top.iter < succ.length) {
        const w = succ[top.iter]!;
        top.iter++;
        if (!index.has(w)) {
          index.set(w, counter);
          lowlink.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, iter: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(top.node, Math.min(lowlink.get(top.node)!, index.get(w)!));
        }
      } else {
        if (lowlink.get(top.node) === index.get(top.node)) {
          const comp: string[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            if (w === top.node) break;
          }
          sccs.push(comp);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!;
          lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(top.node)!));
        }
      }
    }
  }
  return sccs;
}

/** Filter SCCs to actual cycles: components with > 1 node, OR a
 *  single-node SCC with a self-loop. */
export function findCycles(sccs: string[][], adj: Map<string, string[]>): string[][] {
  return sccs.filter((c) => {
    if (c.length > 1) return true;
    const v = c[0]!;
    return (adj.get(v) ?? []).includes(v);
  });
}

/* ─────────── layering ─────────── */

/**
 * Longest-path layering: layer(v) = 1 + max(layer(u)) over all u → v.
 * Source nodes (no incoming edges) are layer 0. Cycles must be removed
 * first; the Sugiyama composition below does that via SCC collapse.
 *
 * Uses a precomputed reverse-adjacency map for the predecessor walk —
 * the previous version (in routes/Dag.tsx) walked all nodes for each
 * vertex (O(V²) per layer assignment). The reverse-map flips it to
 * O(V + E) total.
 */
export function layerByLongestPath(
  nodes: string[],
  adj: Map<string, string[]>,
): Map<string, number> {
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  const radj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [from, succ] of adj) {
    for (const to of succ) {
      indeg.set(to, (indeg.get(to) ?? 0) + 1);
      const r = radj.get(to);
      if (r) r.push(from);
    }
  }

  // Kahn's topological order.
  const queue: string[] = [];
  for (const n of nodes) if ((indeg.get(n) ?? 0) === 0) queue.push(n);
  const order: string[] = [];
  const local = new Map<string, number>(indeg);
  while (queue.length > 0) {
    const v = queue.shift()!;
    order.push(v);
    for (const w of adj.get(v) ?? []) {
      const d = (local.get(w) ?? 0) - 1;
      local.set(w, d);
      if (d === 0) queue.push(w);
    }
  }

  const layer = new Map<string, number>();
  for (const v of order) {
    let max = -1;
    for (const u of radj.get(v) ?? []) {
      const lu = layer.get(u);
      if (lu != null && lu > max) max = lu;
    }
    layer.set(v, max + 1);
  }
  return layer;
}

/* ─────────── Sugiyama vertex ordering ─────────── */

/**
 * Within-layer vertex ordering using the barycenter heuristic. For
 * each downward sweep, every node in layer L gets a barycenter equal
 * to the mean position of its predecessors in layer L-1; nodes in L
 * are then re-sorted by barycenter. Up sweep does the symmetric thing
 * with successors.
 *
 * 6 sweeps (3 down + 3 up) is the textbook minimum that converges on
 * graphs up to a few hundred nodes; more sweeps yield diminishing
 * returns. We stop early if a sweep produces zero ordering changes.
 *
 * Returns: positions map keyed by node id. Position is the integer
 * index within the layer (0-based, left-to-right).
 */
export function orderByBarycenter(
  layers: string[][],
  adj: Map<string, string[]>,
): Map<string, number> {
  const radj = new Map<string, string[]>();
  for (const [from, succ] of adj) {
    for (const to of succ) {
      const r = radj.get(to) ?? [];
      r.push(from);
      radj.set(to, r);
    }
  }

  /* Working copy — we mutate in place across sweeps. */
  const work: string[][] = layers.map((l) => l.slice());
  /* Position lookup updated after each sweep so the next sweep sees
     the latest x's. */
  const pos = new Map<string, number>();
  for (const layer of work) {
    layer.forEach((n, i) => pos.set(n, i));
  }

  function barycenter(node: string, neighbors: string[]): number {
    if (neighbors.length === 0) return pos.get(node) ?? 0;
    let sum = 0;
    let count = 0;
    for (const n of neighbors) {
      const p = pos.get(n);
      if (p == null) continue;
      sum += p;
      count++;
    }
    return count > 0 ? sum / count : pos.get(node) ?? 0;
  }

  function sweep(downward: boolean): boolean {
    let changed = false;
    /* Down sweep visits layers 1..N-1 (referencing layer L-1).
       Up sweep visits layers N-2..0 (referencing layer L+1). */
    const range = downward
      ? Array.from({ length: work.length - 1 }, (_, i) => i + 1)
      : Array.from({ length: work.length - 1 }, (_, i) => work.length - 2 - i);

    for (const L of range) {
      const layer = work[L]!;
      const ref = downward ? radj : adj;
      const newOrder = layer
        .map((node) => ({ node, b: barycenter(node, ref.get(node) ?? []) }))
        /* Stable sort by barycenter — nodes with no neighbors keep their
           previous position (b === pos.get(node)). */
        .sort((a, b) => a.b - b.b)
        .map((x) => x.node);
      for (let i = 0; i < newOrder.length; i++) {
        if (newOrder[i] !== layer[i]) changed = true;
        layer[i] = newOrder[i]!;
        pos.set(newOrder[i]!, i);
      }
    }
    return changed;
  }

  for (let i = 0; i < 6; i++) {
    const changed = sweep(i % 2 === 0);
    if (!changed) break;
  }

  return pos;
}

/* ─────────── full Sugiyama layout ─────────── */

export interface SugiyamaNode {
  id: string;
  layer: number;
  /** 0-based column position within the layer, after barycenter ordering. */
  order: number;
  /** Total in + out degree across the WHOLE graph (not just visible
   *  edges) — used to size nodes in the SVG. */
  degree: number;
}

export interface SugiyamaEdge {
  from: string;
  to: string;
  /** True for edges that span more than one layer — they need bend
   *  points (or just longer curves). */
  long: boolean;
}

export interface SugiyamaLayout {
  nodes: Map<string, SugiyamaNode>;
  edges: SugiyamaEdge[];
  /** Number of layers (max layer + 1). 0 if the graph is empty. */
  layerCount: number;
  /** Maximum nodes in any one layer — used for sizing the SVG width. */
  maxLayerWidth: number;
}

/**
 * Compose the four Sugiyama steps over a node set + edge list:
 *
 *   1. Cycle removal — collapse SCCs to a representative node so the
 *      layering is well-defined. Original nodes inherit their rep's layer.
 *   2. Layer assignment — longest-path on the collapsed graph.
 *   3. Vertex ordering — barycenter sweeps on the original nodes.
 *   4. (Coordinate assignment — done in the SVG renderer using `order`
 *      directly. We deliberately don't pre-bake pixel x,y here so the
 *      renderer can choose the gap/scale.)
 *
 * Caller is expected to pre-filter nodes if rendering would be too
 * dense; this function will happily lay out 5,000 nodes — it just
 * won't fit on a screen.
 */
export function buildSugiyamaLayout(
  nodes: string[],
  edges: ReadonlyArray<{ from: string; to: string }>,
): SugiyamaLayout {
  if (nodes.length === 0) {
    return { nodes: new Map(), edges: [], layerCount: 0, maxLayerWidth: 0 };
  }

  /* Build adjacency on ALL nodes once. */
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
  }

  /* Step 1: SCC + collapse. The repOf map projects every original node
     onto its SCC representative; the collapsed graph contains one node
     per SCC. */
  const sccs = tarjanSCC(nodes, adj);
  const repOf = new Map<string, string>();
  for (const c of sccs) {
    const rep = c[0]!;
    for (const n of c) repOf.set(n, rep);
  }
  const collapsedNodes = Array.from(new Set(repOf.values()));
  const collapsedAdj = new Map<string, string[]>(collapsedNodes.map((n) => [n, []]));
  for (const [from, succ] of adj) {
    const cFrom = repOf.get(from)!;
    for (const to of succ) {
      const cTo = repOf.get(to)!;
      if (cFrom !== cTo) collapsedAdj.get(cFrom)!.push(cTo);
    }
  }

  /* Step 2: layer the collapsed graph, then project layers back. */
  const repLayer = layerByLongestPath(collapsedNodes, collapsedAdj);
  const layerOf = new Map<string, number>();
  for (const n of nodes) layerOf.set(n, repLayer.get(repOf.get(n)!) ?? 0);

  /* Group originals by layer for the barycenter step. */
  const maxLayer = Math.max(0, ...Array.from(layerOf.values()));
  const layerArrays: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) layerArrays[layerOf.get(n) ?? 0]!.push(n);

  /* Initial in-layer ordering: by descending degree. Higher-degree
     nodes anchor the layer; barycenter then refines. */
  const degOf = new Map<string, number>();
  for (const n of nodes) degOf.set(n, (adj.get(n) ?? []).length);
  for (const e of edges) degOf.set(e.to, (degOf.get(e.to) ?? 0) + 1);
  for (const layer of layerArrays) {
    layer.sort((a, b) => (degOf.get(b) ?? 0) - (degOf.get(a) ?? 0));
  }

  /* Step 3: barycenter sweeps. */
  const positions = orderByBarycenter(layerArrays, adj);

  /* Build the result. */
  const out = new Map<string, SugiyamaNode>();
  for (const n of nodes) {
    out.set(n, {
      id: n,
      layer: layerOf.get(n) ?? 0,
      order: positions.get(n) ?? 0,
      degree: degOf.get(n) ?? 0,
    });
  }
  const outEdges: SugiyamaEdge[] = edges
    .filter((e) => out.has(e.from) && out.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      long: Math.abs((layerOf.get(e.to) ?? 0) - (layerOf.get(e.from) ?? 0)) > 1,
    }));

  const maxLayerWidth = Math.max(0, ...layerArrays.map((l) => l.length));
  return { nodes: out, edges: outEdges, layerCount: maxLayer + 1, maxLayerWidth };
}

/* ─────────── folder × folder heatmap ─────────── */

export interface HeatmapResult {
  folders: string[];
  matrix: number[][]; // matrix[from][to] = edge count
  maxCell: number;
  totalEdges: number;
  crossEdges: number;
}

/** Get the top-level directory ("apps", "packages", "src") for a path. */
export function topLevelFolder(path: string): string {
  const i = path.indexOf('/');
  if (i < 0) return '·';
  return path.slice(0, i);
}

export function buildHeatmap(
  files: ReadonlyArray<{ path: string }>,
  edges: ReadonlyArray<{ from: string; to: string }>,
): HeatmapResult {
  const folderCount = new Map<string, number>();
  for (const f of files) {
    const k = topLevelFolder(f.path);
    folderCount.set(k, (folderCount.get(k) ?? 0) + 1);
  }
  const folders = Array.from(folderCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const folderIdx = new Map<string, number>(folders.map((f, i) => [f, i]));

  const matrix: number[][] = folders.map(() => folders.map(() => 0));
  for (const e of edges) {
    const i = folderIdx.get(topLevelFolder(e.from));
    const j = folderIdx.get(topLevelFolder(e.to));
    if (i == null || j == null) continue;
    matrix[i]![j]!++;
  }

  let maxCell = 0;
  let crossEdges = 0;
  for (let i = 0; i < folders.length; i++) {
    for (let j = 0; j < folders.length; j++) {
      const v = matrix[i]![j]!;
      if (v > maxCell) maxCell = v;
      if (i !== j) crossEdges += v;
    }
  }

  return { folders, matrix, maxCell, totalEdges: edges.length, crossEdges };
}

/* ─────────── hubs + couplings ─────────── */

export interface HubEntry {
  path: string;
  in: number;
  out: number;
  total: number;
}

export function buildHubs(
  files: ReadonlyArray<{ path: string }>,
  edges: ReadonlyArray<{ from: string; to: string }>,
  limit = 10,
): HubEntry[] {
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  return files
    .map((f) => ({
      path: f.path,
      in: inDeg.get(f.path) ?? 0,
      out: outDeg.get(f.path) ?? 0,
      total: (inDeg.get(f.path) ?? 0) + (outDeg.get(f.path) ?? 0),
    }))
    .filter((h) => h.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export interface Coupling {
  from: string;
  to: string;
  count: number;
}

export function buildCouplings(heatmap: HeatmapResult, limit = 20): Coupling[] {
  const out: Coupling[] = [];
  const { folders, matrix } = heatmap;
  for (let i = 0; i < folders.length; i++) {
    for (let j = 0; j < folders.length; j++) {
      if (i === j) continue;
      const c = matrix[i]![j]!;
      if (c > 0) out.push({ from: folders[i]!, to: folders[j]!, count: c });
    }
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, limit);
}

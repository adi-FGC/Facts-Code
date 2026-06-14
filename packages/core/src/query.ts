/**
 * Query engine for the MCP `query_graph` tool + the CLI `factstack query`
 * subcommand. Pure data manipulation over a cached AgentArtifact — no
 * I/O, no mutation. Same verb set (`callers`, `imports`, `cycles`,
 * `orphans`) drives both entry points so behavior can't drift.
 */

import type {
  AgentArtifact,
  Confidence,
  QueryVerb,
  GraphQuery,
  NodeSelector,
} from '@factstack/spec';

export interface QueryResult {
  verb: QueryVerb;
  target?: string;
  count: number;
  results: unknown;
}

export interface QueryOptions {
  verb: QueryVerb;
  path?: string;
  /** F3 — destination endpoint for `path-between`. */
  to?: string;
  /** F3 — traversal direction for `neighbors` (defaults to `both`). */
  direction?: 'out' | 'in' | 'both';
  filter?: string;     // glob-style, falls back to substring
  limit?: number;
  depth?: number;
  /** F1 — keep only edges at least this certain (`extracted` > `inferred` >
   *  `ambiguous`). Omit for all edges. */
  minConfidence?: Confidence;
}

/** F3 — edge kinds that constitute the file-level import graph. The
 *  `neighbors`/`path-between` verbs traverse ALL kinds; `references` /
 *  `implementers` restrict to the symbol-graph subsets below. */
const SYMBOL_REFERENCE_KINDS = ['call', 'read', 'jsx', 'type-ref'] as const;
const SYMBOL_IMPL_KINDS = ['implements', 'extends'] as const;

/** Confidence rank: lower = more certain. Mirrors the spec enum order
 *  (`extracted` < `inferred` < `ambiguous`). */
const CONF_RANK: Record<Confidence, number> = { extracted: 0, inferred: 1, ambiguous: 2 };

export function executeQuery(agent: AgentArtifact, opts: QueryOptions): QueryResult {
  const limit = opts.limit ?? 200;
  // F1 — narrow to edges at least as certain as `minConfidence` before any
  // verb runs. No-op today (every edge is `extracted`); the plumbing lands now
  // so F2's inferred/ambiguous edges become filterable without a re-design.
  const a = applyMinConfidence(agent, opts.minConfidence);

  switch (opts.verb) {
    case 'callers':       return callersOf(a, opts.path ?? '', limit, opts.filter);
    case 'imports':       return importsOf(a, opts.path ?? '', limit, opts.filter, opts.depth ?? 1);
    case 'cycles':        return allCycles(a, limit, opts.filter);
    case 'orphans':       return allOrphans(a, limit, opts.filter);
    // F3 — declarative-engine verbs (operate over file + symbol edges).
    case 'neighbors':     return neighborsOf(a, opts.path ?? '', opts.direction ?? 'both', opts.depth ?? 1, limit, opts.filter);
    case 'references':    return referencesOf(a, opts.path ?? '', opts.depth ?? 1, limit, opts.filter);
    case 'implementers':  return implementersOf(a, opts.path ?? '', limit, opts.filter);
    case 'path-between':  return pathBetween(a, opts.path ?? '', opts.to ?? '', limit);
    case 'impact':        return impactOf(a, opts.path ?? '', opts.depth ?? 3, limit, opts.filter);
  }
}

/**
 * A view of `agent` whose graph keeps only edges at least as certain as `min`.
 * Pure — never mutates input. Returns the original when there's nothing to do
 * (no `min`, the loosest threshold, or no edge removed) so the common path
 * allocates nothing. When it does filter, the cached path-only `node.callers`
 * is dropped so `callersOf` recomputes from the filtered edges — the fast path
 * is pre-confidence and can't honor the threshold. `cycles` is unaffected (it
 * reads precomputed SCCs, not edges).
 */
function applyMinConfidence(agent: AgentArtifact, min?: Confidence): AgentArtifact {
  if (!min || min === 'ambiguous') return agent;
  const maxRank = CONF_RANK[min];
  const edges = agent.graph.edges.filter((e) => CONF_RANK[e.confidence ?? 'extracted'] <= maxRank);
  if (edges.length === agent.graph.edges.length) return agent;
  return {
    ...agent,
    graph: {
      ...agent.graph,
      edges,
      nodes: agent.graph.nodes.map((n) => (n.callers ? { ...n, callers: undefined } : n)),
    },
  };
}

function callersOf(agent: AgentArtifact, path: string, limit: number, filter?: string): QueryResult {
  if (!path) return { verb: 'callers', target: path, count: 0, results: [] };
  // Prefer the cached `callers` on the graph node (v0.2 addition); fall
  // back to walking edges for older artifacts.
  const node = agent.graph.nodes.find((n) => n.path === path);
  let callers = Array.isArray(node?.callers)
    ? [...node!.callers]
    : agent.graph.edges.filter((e) => e.to === path).map((e) => e.from);
  if (filter) callers = callers.filter((p) => matches(p, filter));
  callers.sort();
  return {
    verb: 'callers',
    target: path,
    count: callers.length,
    results: callers.slice(0, limit),
  };
}

function importsOf(agent: AgentArtifact, path: string, limit: number, filter?: string, depth = 1): QueryResult {
  if (!path) return { verb: 'imports', target: path, count: 0, results: [] };
  // Breadth-first traversal of outgoing edges up to `depth` levels.
  // Build an adjacency map once so each depth pass is O(E_from_frontier)
  // instead of O(E_total). The previous version kept accumulating the
  // frontier instead of replacing it — O(depth × V × E) on large repos.
  const adj = new Map<string, string[]>();
  for (const e of agent.graph.edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to); else adj.set(e.from, [e.to]);
  }
  const visited = new Set<string>([path]);
  let frontier: string[] = [path];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const from of frontier) {
      const outs = adj.get(from);
      if (!outs) continue;
      for (const to of outs) {
        if (!visited.has(to)) {
          visited.add(to);
          next.push(to);
        }
      }
    }
    if (!next.length) break;
    frontier = next;                           // replace — don't accumulate
  }
  visited.delete(path);
  let out = [...visited];
  if (filter) out = out.filter((p) => matches(p, filter));
  out.sort();
  return { verb: 'imports', target: path, count: out.length, results: out.slice(0, limit) };
}

function allCycles(agent: AgentArtifact, limit: number, filter?: string): QueryResult {
  let cycles = agent.graph.cycles.map((c) => [...c]);
  if (filter) cycles = cycles.filter((c) => c.some((p) => matches(p, filter)));
  return { verb: 'cycles', count: cycles.length, results: cycles.slice(0, limit) };
}

function allOrphans(agent: AgentArtifact, limit: number, filter?: string): QueryResult {
  // A file is an "orphan" if it has no incoming edges AND participates in
  // the import graph at all. Three prior surprises we filter:
  //
  //  1. Manifests + dotfiles (package.json, tsconfig.json, .gitignore) were
  //     reported as orphans because they live in `graph.nodes`, even though
  //     they don't participate in JS/TS import edges. CXOs and AI agents
  //     reading the artifact see "package.json is orphan" and waste a
  //     query trying to figure out what's wrong. → `isSourceModule` filter.
  //
  //  2. Genuine entrypoints (src/cli.ts, app/page.tsx, etc.) have zero
  //     incoming edges by definition. They're not "dead code" — they're
  //     reached by the runtime, not by another module's import. We
  //     suppress them by checking `agent.project.entryPoints` and the
  //     declared route handler files.
  //
  //  3. Test files (vitest, jest, pytest) have zero JS-import callers
  //     because the runner invokes them via filesystem glob, not via
  //     import. Listing them as orphans makes "0 dead code" projects
  //     look noisy. → `isTestPath` filter.
  //
  // The escape hatch is still `filter` for callers who want the wider
  // set (e.g. a security audit might want every uncalled file). If you
  // want test files included, pass `--filter '*test*'` and they're back.
  const incoming = new Set(agent.graph.edges.map((e) => e.to));
  const outgoing = new Set(agent.graph.edges.map((e) => e.from));
  const entryPaths = new Set([
    ...agent.project.entryPoints,
    ...agent.routes.map((r) => r.handlerFile).filter(Boolean) as string[],
  ]);
  let orphans = agent.graph.nodes
    .filter((n) => isSourceModule(n.path, n.language))
    .filter((n) => !isTestPath(n.path))
    .filter((n) => !incoming.has(n.path))
    .filter((n) => !entryPaths.has(n.path))
    // True orphans should at minimum have an outgoing import — a leaf
    // node with no edges at all is most likely a config file we missed
    // classifying. If you want pure leaves, pass `--filter '*'`.
    .filter((n) => outgoing.has(n.path))
    .map((n) => n.path);
  if (filter) orphans = orphans.filter((p) => matches(p, filter));
  orphans.sort();
  return { verb: 'orphans', count: orphans.length, results: orphans.slice(0, limit) };
}

/* ─────────── F3: declarative graph-query engine ───────────
 *
 * One traversal primitive over a UNIFIED adjacency built from both edge sets —
 * file import edges (`graph.edges`) + symbol edges (`graph.symbolEdges`). The
 * two id-spaces (file paths vs `path#name@line` symbol ids) never share an
 * edge, so a file seed walks import edges and a symbol seed walks symbol edges;
 * `edgeKinds` narrows further. Pure + deterministic: every list is id-sorted,
 * ties break on id. `callers`/`imports`/`cycles`/`orphans` keep their tuned
 * implementations above; a parity test asserts the engine reproduces them.
 */

export interface SubgraphResult {
  /** Connected node ids (seeds + reached), id-sorted. */
  nodes: string[];
  /** Edges traversed to reach them, sorted by (from,to,kind). */
  edges: Array<{ from: string; to: string; kind: string; confidence: Confidence }>;
  /** True when `limit` dropped nodes/edges — the FactsPack converter emits a
   *  marker row so the cap is never silent. */
  truncated: boolean;
}

interface EdgeLite { from: string; to: string; kind: string; confidence: Confidence; }
interface NodeMeta { id: string; path: string; name: string; kind: string; }

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Flatten file + symbol edges into one list with a normalized confidence. */
function allEdgesLite(agent: AgentArtifact): EdgeLite[] {
  const out: EdgeLite[] = [];
  for (const e of agent.graph.edges) {
    out.push({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence ?? 'extracted' });
  }
  for (const e of agent.graph.symbolEdges ?? []) {
    out.push({ from: e.from, to: e.to, kind: e.kind, confidence: e.confidence ?? 'extracted' });
  }
  return out;
}

/** id → metadata for every file node and symbol node. Files get kind `file`
 *  and a basename `name`; symbols carry their declaration kind + name. */
function buildNodeIndex(agent: AgentArtifact): Map<string, NodeMeta> {
  const idx = new Map<string, NodeMeta>();
  for (const n of agent.graph.nodes) {
    idx.set(n.path, { id: n.path, path: n.path, name: baseName(n.path), kind: 'file' });
  }
  for (const s of agent.graph.symbolNodes ?? []) {
    idx.set(s.id, { id: s.id, path: s.path, name: s.name, kind: s.kind });
  }
  return idx;
}

/** Strict selector resolution: AND of every provided field. */
function resolveSelector(idx: Map<string, NodeMeta>, sel: NodeSelector): string[] {
  const ids: string[] = [];
  const wantName = sel.name?.toLowerCase();
  for (const meta of idx.values()) {
    if (sel.id && meta.id !== sel.id) continue;
    if (sel.glob && !matches(meta.id, sel.glob) && !matches(meta.path, sel.glob)) continue;
    if (wantName && meta.name.toLowerCase() !== wantName) continue;
    if (sel.kind && meta.kind !== sel.kind) continue;
    ids.push(meta.id);
  }
  ids.sort();
  return ids;
}

/** Forgiving single-target resolution for the verb tool's `path` string:
 *  exact id → symbol/file name (case-insensitive) → path suffix. Returns the
 *  first non-empty tier, id-sorted. */
function resolveTarget(idx: Map<string, NodeMeta>, target: string): string[] {
  if (!target) return [];
  if (idx.has(target)) return [target];
  const lower = target.toLowerCase();
  const byName: string[] = [];
  const bySuffix: string[] = [];
  for (const meta of idx.values()) {
    if (meta.name.toLowerCase() === lower) byName.push(meta.id);
    if (meta.path === target || meta.path.endsWith('/' + target)) bySuffix.push(meta.id);
  }
  if (byName.length) { byName.sort(); return byName; }
  if (bySuffix.length) { bySuffix.sort(); return bySuffix; }
  return [];
}

/** Direction-aware adjacency, optionally filtered by edge kind + confidence.
 *  Each entry keeps the originating edge so a subgraph can report it. */
function adjacency(
  edges: EdgeLite[],
  direction: 'out' | 'in' | 'both',
  allowed?: Set<string>,
  maxRank?: number,
): Map<string, Array<{ to: string; edge: EdgeLite }>> {
  const adj = new Map<string, Array<{ to: string; edge: EdgeLite }>>();
  const add = (a: string, b: string, edge: EdgeLite): void => {
    const l = adj.get(a);
    if (l) l.push({ to: b, edge }); else adj.set(a, [{ to: b, edge }]);
  };
  for (const e of edges) {
    if (allowed && !allowed.has(e.kind)) continue;
    if (maxRank != null && CONF_RANK[e.confidence] > maxRank) continue;
    if (direction === 'out' || direction === 'both') add(e.from, e.to, e);
    if (direction === 'in' || direction === 'both') add(e.to, e.from, e);
  }
  return adj;
}

/** BFS from seeds up to maxDepth; collects reached nodes + traversed edges. */
function bfs(
  seeds: string[],
  adj: Map<string, Array<{ to: string; edge: EdgeLite }>>,
  maxDepth: number,
): { nodes: Set<string>; edges: EdgeLite[] } {
  const visited = new Set<string>(seeds);
  const edges: EdgeLite[] = [];
  const edgeSeen = new Set<string>();
  let frontier = [...seeds];
  for (let d = 0; d < maxDepth; d++) {
    const next: string[] = [];
    for (const from of frontier) {
      const outs = adj.get(from);
      if (!outs) continue;
      for (const { to, edge } of outs) {
        const ek = `${edge.from}\t${edge.to}\t${edge.kind}`;
        if (!edgeSeen.has(ek)) { edgeSeen.add(ek); edges.push(edge); }
        if (!visited.has(to)) { visited.add(to); next.push(to); }
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return { nodes: visited, edges };
}

const edgeSort = (
  a: { from: string; to: string; kind: string },
  b: { from: string; to: string; kind: string },
): number =>
  (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
  (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
  (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);

/**
 * Interpret a declarative `GraphQuery` and return a connected subgraph. This is
 * the engine the new `query` MCP tool + free-text mapper drive; the verb
 * functions below share its helpers.
 */
export function runGraphQuery(agent: AgentArtifact, q: GraphQuery): SubgraphResult {
  const idx = buildNodeIndex(agent);
  const seeds = resolveSelector(idx, q.start);
  const direction = q.traverse?.direction ?? 'out';
  const maxDepth = q.traverse?.maxDepth ?? 1;
  const allowed = q.traverse?.edgeKinds && q.traverse.edgeKinds.length
    ? new Set<string>(q.traverse.edgeKinds)
    : undefined;
  const maxRank = q.where?.minConfidence != null ? CONF_RANK[q.where.minConfidence] : undefined;

  const adj = adjacency(allEdgesLite(agent), direction, allowed, maxRank);
  const reached = bfs(seeds, adj, maxDepth);

  let nodeIds = [...reached.nodes];
  if (q.where?.kind || q.where?.pathGlob) {
    const wk = q.where.kind;
    const wg = q.where.pathGlob;
    nodeIds = nodeIds.filter((id) => {
      const m = idx.get(id);
      if (!m) return false;
      if (wk && m.kind !== wk) return false;
      if (wg && !matches(m.path, wg)) return false;
      return true;
    });
  }
  nodeIds.sort();

  const limit = q.limit ?? 200;
  let truncated = false;
  let outNodes = nodeIds;
  if (outNodes.length > limit) { outNodes = outNodes.slice(0, limit); truncated = true; }

  const nodeSet = new Set(outNodes);
  let outEdges = [...reached.edges]
    .sort(edgeSort)
    .filter((e) => nodeSet.has(e.from) && nodeSet.has(e.to));
  if (q.select === 'edges' && outEdges.length > limit) {
    outEdges = outEdges.slice(0, limit);
    truncated = true;
  }

  return { nodes: outNodes, edges: outEdges, truncated };
}

/**
 * F4 — expand `seeds` outward up to `maxHops`, recording the hop distance of
 * every reached node (seeds = 0) and the edges traversed. The hop distance is
 * the proximity signal the context ranker weights; the edges feed the emitted
 * subgraph. Reuses the same unified file+symbol adjacency as `runGraphQuery`,
 * so context expansion can't drift from query traversal. Pure + deterministic:
 * BFS records each node's FIRST-reached depth, edges are (from,to,kind)-sorted.
 */
export interface HopExpansion {
  /** node id → minimum hops from any seed (seeds map to 0). */
  hops: Map<string, number>;
  /** edges traversed during expansion, sorted by (from,to,kind). */
  edges: SubgraphResult['edges'];
}

export function expandWithHops(
  agent: AgentArtifact,
  seeds: string[],
  maxHops: number,
  direction: 'out' | 'in' | 'both' = 'both',
): HopExpansion {
  // Deliberately ALL edge kinds + ALL confidences: context assembly wants the
  // fullest connected neighborhood (even `inferred`/`ambiguous` links are useful
  // "you might also need this" signal). Relevance is then sorted out by the
  // ranker, not by pre-filtering the graph — unlike the precise query verbs,
  // which expose `minConfidence`.
  const adj = adjacency(allEdgesLite(agent), direction);
  const hops = new Map<string, number>();
  for (const s of seeds) hops.set(s, 0);
  const edges: EdgeLite[] = [];
  const edgeSeen = new Set<string>();
  let frontier = [...seeds];
  for (let d = 0; d < maxHops; d++) {
    const next: string[] = [];
    for (const from of frontier) {
      const outs = adj.get(from);
      if (!outs) continue;
      for (const { to, edge } of outs) {
        const ek = `${edge.from}\t${edge.to}\t${edge.kind}`;
        if (!edgeSeen.has(ek)) { edgeSeen.add(ek); edges.push(edge); }
        if (!hops.has(to)) { hops.set(to, d + 1); next.push(to); }
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return { hops, edges: edges.sort(edgeSort) };
}

/** F3 — public entity resolution for the free-text mapper: exact id → name →
 *  path-suffix, id-sorted. Empty when nothing matches. */
export function findEntities(agent: AgentArtifact, term: string): string[] {
  return resolveTarget(buildNodeIndex(agent), term);
}

/** F3 — ranked "did you mean" candidates: node ids whose id / name / path
 *  contains `term` (case-insensitive), id-sorted and capped. */
export function suggestEntities(agent: AgentArtifact, term: string, limit = 10): string[] {
  const t = term.toLowerCase();
  if (!t) return [];
  const out: string[] = [];
  for (const m of buildNodeIndex(agent).values()) {
    if (m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t) || m.path.toLowerCase().includes(t)) {
      out.push(m.id);
    }
  }
  out.sort();
  return out.slice(0, limit);
}

/* ─────────── F3 verb implementations (engine-backed) ─────────── */

function neighborsOf(
  agent: AgentArtifact,
  target: string,
  direction: 'out' | 'in' | 'both',
  depth: number,
  limit: number,
  filter?: string,
): QueryResult {
  const idx = buildNodeIndex(agent);
  const seeds = resolveTarget(idx, target);
  const { nodes } = bfs(seeds, adjacency(allEdgesLite(agent), direction), depth);
  const seedSet = new Set(seeds);
  let result = [...nodes].filter((id) => !seedSet.has(id));
  if (filter) result = result.filter((p) => matches(p, filter));
  result.sort();
  return { verb: 'neighbors', target, count: result.length, results: result.slice(0, limit) };
}

function referencesOf(
  agent: AgentArtifact,
  target: string,
  depth: number,
  limit: number,
  filter?: string,
): QueryResult {
  // "Who references this symbol?" → in-edges among the reference kinds.
  const idx = buildNodeIndex(agent);
  const seeds = resolveTarget(idx, target);
  const adj = adjacency(allEdgesLite(agent), 'in', new Set<string>(SYMBOL_REFERENCE_KINDS));
  const { nodes } = bfs(seeds, adj, depth);
  const seedSet = new Set(seeds);
  let result = [...nodes].filter((id) => !seedSet.has(id));
  if (filter) result = result.filter((p) => matches(p, filter));
  result.sort();
  return { verb: 'references', target, count: result.length, results: result.slice(0, limit) };
}

function implementersOf(
  agent: AgentArtifact,
  target: string,
  limit: number,
  filter?: string,
): QueryResult {
  // "What implements/extends this symbol?" → in-edges among class-relation kinds.
  const idx = buildNodeIndex(agent);
  const seeds = resolveTarget(idx, target);
  const adj = adjacency(allEdgesLite(agent), 'in', new Set<string>(SYMBOL_IMPL_KINDS));
  const { nodes } = bfs(seeds, adj, 1);
  const seedSet = new Set(seeds);
  let result = [...nodes].filter((id) => !seedSet.has(id));
  if (filter) result = result.filter((p) => matches(p, filter));
  result.sort();
  return { verb: 'implementers', target, count: result.length, results: result.slice(0, limit) };
}

/**
 * F5 — blast radius. "What is affected if I change the target?" = reverse
 * reachability: every node that transitively reaches the target by following
 * in-edges (importers / callers). For a file seed we restrict to import kinds;
 * a symbol seed walks all symbol kinds. Depth-bounded (default 3) so a hub
 * doesn't return the whole repo. Deterministic: results id-sorted.
 */
function impactOf(
  agent: AgentArtifact,
  target: string,
  depth: number,
  limit: number,
  filter?: string,
): QueryResult {
  const idx = buildNodeIndex(agent);
  const seeds = resolveTarget(idx, target);
  // File seeds (no `#`) traverse import edges; symbol seeds traverse all kinds.
  const isFileSeed = seeds.length > 0 && seeds.every((id) => !id.includes('#'));
  const allowed = isFileSeed ? new Set<string>(['import', 'dynamic-import', 'type-import']) : undefined;
  const adj = adjacency(allEdgesLite(agent), 'in', allowed);
  const { nodes } = bfs(seeds, adj, depth);
  const seedSet = new Set(seeds);
  let result = [...nodes].filter((id) => !seedSet.has(id));
  if (filter) result = result.filter((p) => matches(p, filter));
  result.sort();
  return { verb: 'impact', target, count: result.length, results: result.slice(0, limit) };
}

/**
 * Shortest directed path from `from` to `to` over out-edges (the "depends-on"
 * direction). Deterministic: multi-source BFS explores neighbors in id order,
 * so the reconstructed path is stable. Returns the ordered node sequence, or
 * an empty result when `to` is unreachable from `from`.
 */
function pathBetween(agent: AgentArtifact, from: string, to: string, limit: number): QueryResult {
  const idx = buildNodeIndex(agent);
  const fromIds = resolveTarget(idx, from);
  const fromSet = new Set(fromIds);
  const toSet = new Set(resolveTarget(idx, to));
  const adj = adjacency(allEdgesLite(agent), 'out');

  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const s of [...fromIds].sort()) if (!prev.has(s)) { prev.set(s, null); queue.push(s); }

  let hit: string | undefined;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    if (toSet.has(cur) && !fromSet.has(cur)) { hit = cur; break; }
    const outs = (adj.get(cur) ?? []).map((x) => x.to).sort();
    for (const nx of outs) if (!prev.has(nx)) { prev.set(nx, cur); queue.push(nx); }
  }

  const label = `${from}→${to}`;
  if (!hit) return { verb: 'path-between', target: label, count: 0, results: [] };

  const path: string[] = [];
  let cur: string | null | undefined = hit;
  while (cur != null) { path.push(cur); cur = prev.get(cur) ?? null; }
  path.reverse();
  return { verb: 'path-between', target: label, count: path.length, results: path.slice(0, limit) };
}

/**
 * Path-shape predicate for "this file is a test, not application code."
 * Mirrors the route extractor's `isTestOrFixturePath` but inlined here
 * to keep `@factstack/core` from depending on `@factstack/extractors`
 * (currently a one-way dep). Catches:
 *
 *   - `*.test.*` / `*.spec.*` (vitest, jest, mocha)
 *   - `__tests__/`, `__test__/` (jest convention)
 *   - `tests/`, `test/` (pytest, go test, cargo test convention)
 *   - `cypress/integration/`, `e2e/`, `playwright/` (e2e suites)
 *   - `examples/`, `fixtures/` (sample/golden code)
 *
 * If your test layout differs, pass `--filter` to override on the CLI.
 */
function isTestPath(p: string): boolean {
  const n = p.toLowerCase().replace(/\\/g, '/');
  if (/(?:^|\/)(?:__tests__|__test__|tests|test|cypress|e2e|playwright|examples|fixtures)\//.test(n)) return true;
  if (/\.(test|spec)\.[a-z]+$/.test(n)) return true;
  return false;
}

/**
 * True if a graph node is an importable source module. Excludes manifests
 * (package.json, tsconfig.json), dotfiles (.gitignore, .editorconfig),
 * and lockfiles. We use `language` from the analyzer when present and
 * fall back to extension matching.
 */
function isSourceModule(path: string, language: string): boolean {
  const lang = language.toLowerCase();
  if (['typescript', 'javascript', 'tsx', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'ruby', 'php', 'svelte', 'vue'].includes(lang)) return true;
  if (lang === 'json' || lang === 'yaml' || lang === 'toml' || lang === 'markdown' || lang === 'html' || lang === 'css' || lang === 'gitignore' || lang === 'dockerignore') return false;
  // Fallback: look at the extension.
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.svelte', '.vue'].includes(ext);
}

/**
 * Simple glob → regex converter, or plain substring match when the
 * pattern has no glob chars. Supports `*` and `?` only; anything more
 * complex is beyond v0.2's needs.
 */
function matches(s: string, pattern: string): boolean {
  if (!pattern) return true;
  if (!/[*?]/.test(pattern)) return s.includes(pattern);
  const re = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$',
  );
  return re.test(s);
}

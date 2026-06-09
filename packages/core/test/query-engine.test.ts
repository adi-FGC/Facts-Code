import { describe, expect, it } from 'vitest';
import { executeQuery, runGraphQuery } from '../src/query.js';
import type { AgentArtifact, GraphQuery, SymbolNode, SymbolEdge } from '@factstack/spec';

/**
 * F3 — declarative graph-query engine + the symbol-graph verbs
 * (neighbors / references / implementers / path-between) and `runGraphQuery`.
 *
 * Two anchors here: (1) PARITY — the engine reproduces the tuned
 * callers/imports verbs on a file-only graph, so the verb set can't drift from
 * the engine; (2) the symbol-graph verbs + the declarative subgraph/where/
 * truncation/determinism behavior on a mixed file+symbol fixture.
 */

function sym(id: string, path: string, name: string, kind: string, start: number, end = start): SymbolNode {
  return { id, path, name, kind: kind as SymbolNode['kind'], startLine: start, endLine: end, exported: true };
}
function sedge(from: string, to: string, kind: SymbolEdge['kind'], confidence: SymbolEdge['confidence'] = 'extracted', score?: number): SymbolEdge {
  return score != null ? { from, to, kind, confidence, confidenceScore: score } : { from, to, kind, confidence };
}

function makeArtifact(graph: Partial<AgentArtifact['graph']>): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-06-08T00:00:00Z',
    project: { name: 't', root: '/t', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [],
    graph: { nodes: [], edges: [], cycles: [], symbolNodes: [], symbolEdges: [], ...graph },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  } as AgentArtifact;
}

function fileNode(path: string) {
  return { id: path, path, language: 'typescript', loc: 10, tokenCost: 50, status: 'ok' as const };
}
function fileEdge(from: string, to: string) {
  return { from, to, kind: 'import' as const, confidence: 'extracted' as const };
}

// A 3-file chain c → b → a (import direction), plus a symbol graph layered on:
//   b#useHelper calls a#helper (inferred 0.9)
//   c#Derived extends c#Base (extracted)
const mixed = makeArtifact({
  nodes: [fileNode('src/a.ts'), fileNode('src/b.ts'), fileNode('src/c.ts')],
  edges: [fileEdge('src/b.ts', 'src/a.ts'), fileEdge('src/c.ts', 'src/b.ts')],
  cycles: [],
  symbolNodes: [
    sym('src/a.ts#helper@1', 'src/a.ts', 'helper', 'function', 1, 3),
    sym('src/b.ts#useHelper@1', 'src/b.ts', 'useHelper', 'function', 1, 5),
    sym('src/c.ts#Base@1', 'src/c.ts', 'Base', 'class', 1, 4),
    sym('src/c.ts#Derived@5', 'src/c.ts', 'Derived', 'class', 5, 9),
  ],
  symbolEdges: [
    sedge('src/b.ts#useHelper@1', 'src/a.ts#helper@1', 'call', 'inferred', 0.9),
    sedge('src/c.ts#Derived@5', 'src/c.ts#Base@1', 'extends', 'extracted'),
  ],
});

describe('F3 — verb parity (engine reproduces the tuned verbs)', () => {
  const fileOnly = makeArtifact({
    nodes: [fileNode('src/a.ts'), fileNode('src/b.ts'), fileNode('src/c.ts')],
    edges: [fileEdge('src/b.ts', 'src/a.ts'), fileEdge('src/c.ts', 'src/a.ts'), fileEdge('src/c.ts', 'src/b.ts')],
    cycles: [],
  });

  it('neighbors(in) == callers', () => {
    const callers = executeQuery(fileOnly, { verb: 'callers', path: 'src/a.ts' });
    const neigh = executeQuery(fileOnly, { verb: 'neighbors', path: 'src/a.ts', direction: 'in' });
    expect(neigh.results).toEqual(callers.results);
    expect(neigh.results).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('neighbors(out, depth) == imports', () => {
    const imports = executeQuery(fileOnly, { verb: 'imports', path: 'src/c.ts', depth: 2 });
    const neigh = executeQuery(fileOnly, { verb: 'neighbors', path: 'src/c.ts', direction: 'out', depth: 2 });
    expect(neigh.results).toEqual(imports.results);
    expect(neigh.results).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('F3 — symbol-graph verbs', () => {
  it('references: who references a symbol (in-edges, reference kinds)', () => {
    const r = executeQuery(mixed, { verb: 'references', path: 'src/a.ts#helper@1' });
    expect(r.results).toEqual(['src/b.ts#useHelper@1']);
  });

  it('references resolves a bare symbol NAME to its id', () => {
    const r = executeQuery(mixed, { verb: 'references', path: 'helper' });
    expect(r.results).toEqual(['src/b.ts#useHelper@1']);
  });

  it('implementers: what extends/implements a symbol', () => {
    const r = executeQuery(mixed, { verb: 'implementers', path: 'src/c.ts#Base@1' });
    expect(r.results).toEqual(['src/c.ts#Derived@5']);
  });

  it('implementers excludes plain call/read edges', () => {
    // helper is only *called*, never implemented → no implementers.
    const r = executeQuery(mixed, { verb: 'implementers', path: 'src/a.ts#helper@1' });
    expect(r.count).toBe(0);
  });

  it('path-between: shortest directed path over import edges', () => {
    const r = executeQuery(mixed, { verb: 'path-between', path: 'src/c.ts', to: 'src/a.ts' });
    expect(r.results).toEqual(['src/c.ts', 'src/b.ts', 'src/a.ts']);
  });

  it('path-between: empty when unreachable', () => {
    const r = executeQuery(mixed, { verb: 'path-between', path: 'src/a.ts', to: 'src/c.ts' });
    expect(r.count).toBe(0);
    expect(r.results).toEqual([]);
  });

  it('impact: reverse reachability — everything that transitively imports the target', () => {
    // edges: b→a, c→b. Changing a.ts affects b (imports a) and c (imports b).
    const deep = executeQuery(mixed, { verb: 'impact', path: 'src/a.ts', depth: 3 });
    expect(deep.results).toEqual(['src/b.ts', 'src/c.ts']);
    // depth 1 only reaches the direct importer.
    const shallow = executeQuery(mixed, { verb: 'impact', path: 'src/a.ts', depth: 1 });
    expect(shallow.results).toEqual(['src/b.ts']);
    // OMITTED depth defaults to 3 (impact's blast-radius default), NOT 1 —
    // guards the MCP schema fix (the shared depth default must not pin impact to 1).
    const defaulted = executeQuery(mixed, { verb: 'impact', path: 'src/a.ts' });
    expect(defaulted.results).toEqual(['src/b.ts', 'src/c.ts']);
    // a leaf that nothing imports has empty blast radius.
    const leaf = executeQuery(mixed, { verb: 'impact', path: 'src/c.ts', depth: 3 });
    expect(leaf.count).toBe(0);
  });
});

describe('F3 — runGraphQuery (declarative)', () => {
  it('returns a connected subgraph (nodes + edges)', () => {
    const q: GraphQuery = {
      start: { id: 'src/c.ts' },
      traverse: { direction: 'out', maxDepth: 2 },
      select: 'subgraph',
      limit: 200,
    };
    const r = runGraphQuery(mixed, q);
    expect(r.nodes).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(r.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['src/b.ts->src/a.ts', 'src/c.ts->src/b.ts']);
    expect(r.truncated).toBe(false);
  });

  it('where.kind filters to a symbol kind', () => {
    const q: GraphQuery = {
      start: { glob: 'src/c.ts#*' },
      where: { kind: 'class' },
      select: 'nodes',
      limit: 200,
    };
    const r = runGraphQuery(mixed, q);
    expect(r.nodes).toEqual(['src/c.ts#Base@1', 'src/c.ts#Derived@5']);
  });

  it('where.minConfidence drops low-certainty edges during traversal', () => {
    // The only outgoing symbol edge from useHelper is the inferred call (0.9).
    // Requiring `extracted` removes it → helper is unreachable.
    const q: GraphQuery = {
      start: { id: 'src/b.ts#useHelper@1' },
      traverse: { direction: 'out', edgeKinds: ['call', 'read', 'jsx', 'type-ref'], maxDepth: 1 },
      where: { minConfidence: 'extracted' },
      select: 'nodes',
      limit: 200,
    };
    const r = runGraphQuery(mixed, q);
    expect(r.nodes).toEqual(['src/b.ts#useHelper@1']); // only the seed survives
  });

  it('marks truncated when limit drops nodes (no silent cap)', () => {
    const q: GraphQuery = {
      start: { id: 'src/c.ts' },
      traverse: { direction: 'out', maxDepth: 2 },
      select: 'nodes',
      limit: 2,
    };
    const r = runGraphQuery(mixed, q);
    expect(r.nodes).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('is deterministic — two runs are byte-identical', () => {
    const q: GraphQuery = {
      start: { id: 'src/c.ts' },
      traverse: { direction: 'out', maxDepth: 5 },
      select: 'subgraph',
      limit: 200,
    };
    expect(JSON.stringify(runGraphQuery(mixed, q))).toBe(JSON.stringify(runGraphQuery(mixed, q)));
  });
});

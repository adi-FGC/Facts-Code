import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/metrics.js';
import type { DependencyGraph } from '../src/dependency.js';

/**
 * F5 — PageRank importance + label-propagation communities. Edges point
 * importer → imported, so PageRank flows rank to depended-upon files (a
 * heavily-imported util ranks highest). Determinism (INV2) is the headline:
 * fixed iterations + sorted adjacency ⇒ byte-identical output even if the edge
 * list is reordered.
 */

function g(nodes: string[], edges: Array<[string, string]>): Pick<DependencyGraph, 'nodes' | 'edges'> {
  return {
    nodes: nodes.map((p) => ({ id: p, path: p, language: 'typescript', loc: 1, tokenCost: 1, status: 'ok' as const })),
    edges: edges.map(([from, to]) => ({ from, to, kind: 'import' as const, confidence: 'extracted' as const })),
  };
}

describe('computeMetrics — importance (PageRank)', () => {
  it('ranks a heavily-imported file above its importers', () => {
    // a→b, a→c, b→c : c imported by {a,b}, b by {a}, a by none.
    const m = computeMetrics(g(['a.ts', 'b.ts', 'c.ts'], [['a.ts', 'b.ts'], ['a.ts', 'c.ts'], ['b.ts', 'c.ts']]));
    const c = m.importance.get('c.ts')!;
    const b = m.importance.get('b.ts')!;
    const a = m.importance.get('a.ts')!;
    expect(c).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(a);
    expect(c).toBe(1); // normalized: the top node is 1.0
    for (const v of m.importance.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('two-node a→b: the imported node is most important', () => {
    const m = computeMetrics(g(['a.ts', 'b.ts'], [['a.ts', 'b.ts']]));
    expect(m.importance.get('b.ts')).toBe(1);
    expect(m.importance.get('a.ts')!).toBeLessThan(1);
    expect(m.importance.get('a.ts')!).toBeGreaterThan(0);
  });

  it('empty graph → empty maps', () => {
    const m = computeMetrics(g([], []));
    expect(m.importance.size).toBe(0);
    expect(m.community.size).toBe(0);
  });

  it('single isolated node → importance 1.0, community 0', () => {
    const m = computeMetrics(g(['solo.ts'], []));
    expect(m.importance.get('solo.ts')).toBe(1);
    expect(m.community.get('solo.ts')).toBe(0);
  });

  it('ignores self-loops and edges touching unknown nodes', () => {
    const m = computeMetrics(g(['a.ts', 'b.ts'], [['a.ts', 'a.ts'], ['a.ts', 'ghost.ts'], ['a.ts', 'b.ts']]));
    expect(m.importance.get('b.ts')).toBe(1);
    expect(m.importance.has('ghost.ts')).toBe(false);
  });
});

describe('computeMetrics — communities (label propagation)', () => {
  it('groups a connected cluster into one community', () => {
    const m = computeMetrics(g(['a.ts', 'b.ts', 'c.ts'], [['a.ts', 'b.ts'], ['b.ts', 'c.ts'], ['c.ts', 'a.ts']]));
    const cids = new Set([m.community.get('a.ts'), m.community.get('b.ts'), m.community.get('c.ts')]);
    expect(cids.size).toBe(1);
  });

  it('separates two disconnected clusters, numbered by smallest member path', () => {
    const m = computeMetrics(g(
      ['a.ts', 'b.ts', 'x.ts', 'y.ts'],
      [['a.ts', 'b.ts'], ['b.ts', 'a.ts'], ['x.ts', 'y.ts'], ['y.ts', 'x.ts']],
    ));
    // {a,b} holds the lexicographically-smallest path 'a.ts' ⇒ community 0.
    expect(m.community.get('a.ts')).toBe(0);
    expect(m.community.get('b.ts')).toBe(0);
    expect(m.community.get('x.ts')).toBe(1);
    expect(m.community.get('y.ts')).toBe(1);
  });
});

describe('computeMetrics — determinism (INV2)', () => {
  it('is byte-identical across runs AND independent of edge order', () => {
    const nodes = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const e1: Array<[string, string]> = [['a.ts', 'b.ts'], ['b.ts', 'c.ts'], ['c.ts', 'd.ts'], ['d.ts', 'b.ts'], ['a.ts', 'c.ts']];
    const e2 = [...e1].reverse();
    const ser = (m: ReturnType<typeof computeMetrics>) =>
      JSON.stringify({ imp: [...m.importance].sort(), com: [...m.community].sort() });
    const m1 = computeMetrics(g(nodes, e1));
    expect(ser(computeMetrics(g(nodes, e1)))).toBe(ser(m1));      // re-run identical
    expect(ser(computeMetrics(g(nodes, e2)))).toBe(ser(m1));      // edge order irrelevant
  });
});

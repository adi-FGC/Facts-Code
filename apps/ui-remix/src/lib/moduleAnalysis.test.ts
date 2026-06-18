import { describe, expect, it } from 'vitest';
import { buildModuleView } from './moduleAnalysis.ts';
import type { Dataset, DatasetFile } from './loadArtifacts.ts';

/**
 * F5 module-view derivation. The contract: it AGGREGATES the core-computed
 * metrics (importance/community on `nodeMetrics`) into ranked key files +
 * communities — it never recomputes PageRank in the browser. These tests pin
 * the ranking, the community grouping/naming, and the pre-F5 empty state.
 */

function file(path: string, tokens: number): DatasetFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    name,
    path,
    ext: '.ts',
    language: { id: 'typescript', label: 'TypeScript', iconColor: '#3178c6', tag: 'TS' },
    size: 100,
    gzip: null,
    loc: 10,
    tokens,
    todos: 0,
    todoEntries: [],
    status: 'ok',
    mtime: 0,
  };
}

function ds(over: Partial<Dataset> = {}): Dataset {
  return {
    generatedAt: '2026-06-09T00:00:00Z',
    project: { name: 't', root: '.', languages: [], frameworks: [] },
    summary: { oneLiner: '', description: '', capabilities: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0 } },
    stats: { files: 4, loc: 40, size: 0, gzip: 0, tokens: 400 },
    tree: { name: '', path: '', files: [file('a.ts', 100), file('b.ts', 50), file('c.ts', 70), file('d.ts', 90)], children: [] },
    edges: [],
    entryPoints: [],
    risks: [],
    ...over,
  } as Dataset;
}

describe('buildModuleView', () => {
  it('returns hasMetrics=false when the dataset predates F5 (no nodeMetrics)', () => {
    const v = buildModuleView(ds());
    expect(v.hasMetrics).toBe(false);
    expect(v.keyFiles).toEqual([]);
    expect(v.modules).toEqual([]);
  });

  it('ranks key files by importance (consuming core metrics, not recomputing)', () => {
    const v = buildModuleView(ds({
      edges: [{ from: 'b.ts', to: 'a.ts', kind: 'import' }],
      nodeMetrics: [
        { path: 'a.ts', importance: 1.0, community: 0 },
        { path: 'b.ts', importance: 0.3, community: 0 },
        { path: 'c.ts', importance: 0.5, community: 1 },
        { path: 'd.ts', importance: 0.9, community: 1 },
      ],
    }));
    expect(v.hasMetrics).toBe(true);
    expect(v.keyFiles.map((k) => k.path)).toEqual(['a.ts', 'd.ts', 'c.ts', 'b.ts']);
    // metadata joined from the tree + in-degree from edges.
    const a = v.keyFiles.find((k) => k.path === 'a.ts')!;
    expect(a.tokens).toBe(100);
    expect(a.inDegree).toBe(1);
    expect(a.importance).toBe(1.0);
  });

  it('groups files into modules named by their most-important member', () => {
    const v = buildModuleView(ds({
      nodeMetrics: [
        { path: 'a.ts', importance: 1.0, community: 0 },
        { path: 'b.ts', importance: 0.3, community: 0 },
        { path: 'c.ts', importance: 0.5, community: 1 },
        { path: 'd.ts', importance: 0.9, community: 1 },
      ],
    }));
    expect(v.modules).toHaveLength(2);
    // community 0 → named a.ts (1.0 > 0.3); community 1 → named d.ts (0.9 > 0.5).
    expect(v.modules[0]!.name).toBe('a.ts');
    expect(v.modules[0]!.memberCount).toBe(2);
    expect(v.modules[0]!.totalTokens).toBe(150); // a(100) + b(50)
    expect(v.modules[1]!.name).toBe('d.ts');
    expect(v.modules[1]!.totalTokens).toBe(160); // c(70) + d(90)
  });

  it('excludes single-file communities (a module needs ≥2 files)', () => {
    const v = buildModuleView(ds({
      nodeMetrics: [
        { path: 'a.ts', importance: 1.0, community: 0 },
        { path: 'b.ts', importance: 0.3, community: 0 },
        { path: 'c.ts', importance: 0.5, community: 9 }, // lone member
      ],
    }));
    expect(v.modules).toHaveLength(1);
    expect(v.modules[0]!.name).toBe('a.ts');
  });
});

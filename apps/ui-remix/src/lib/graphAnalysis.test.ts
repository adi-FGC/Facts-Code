import { describe, expect, it } from 'vitest';
import {
  buildHeatmap,
  capHeatmap,
  moduleLeaf,
  moduleOf,
  topLevelFolder,
} from './graphAnalysis.ts';

describe('moduleOf', () => {
  it('buckets a monorepo file by its workspace package, not the top-level dir', () => {
    expect(moduleOf('apps/ui-remix/src/App.tsx')).toBe('apps/ui-remix');
    expect(moduleOf('packages/spec/src/index.ts')).toBe('packages/spec');
    expect(moduleOf('packages/core/src/emit/pure.ts')).toBe('packages/core');
  });

  it('groups package-root config files with their package', () => {
    expect(moduleOf('apps/ui-remix/package.json')).toBe('apps/ui-remix');
  });

  it('falls back to a second-level module in a single-package repo', () => {
    expect(moduleOf('src/lib/foo.ts')).toBe('src/lib');
    expect(moduleOf('src/routes/Home.tsx')).toBe('src/routes');
  });

  it('uses the lone directory when only one level deep', () => {
    expect(moduleOf('src/App.tsx')).toBe('src');
  });

  it('groups root-level files under "·"', () => {
    expect(moduleOf('README.md')).toBe('·');
    expect(moduleOf('tsconfig.json')).toBe('·');
  });
});

describe('buildHeatmap granularity', () => {
  const files = [
    { path: 'apps/web/src/main.ts' },
    { path: 'apps/web/src/util.ts' },
    { path: 'packages/core/src/index.ts' },
    { path: 'packages/spec/src/index.ts' },
  ];
  const edges = [
    { from: 'apps/web/src/main.ts', to: 'packages/core/src/index.ts' },
    { from: 'apps/web/src/main.ts', to: 'packages/spec/src/index.ts' },
    { from: 'packages/core/src/index.ts', to: 'packages/spec/src/index.ts' },
    { from: 'apps/web/src/main.ts', to: 'apps/web/src/util.ts' }, // intra-module
  ];

  it('collapses to a useless 2-bucket graph at top-level granularity (the bug)', () => {
    const h = buildHeatmap(files, edges); // defaults to topLevelFolder
    expect(h.folders).toEqual(['apps', 'packages']);
    // Every cross-folder edge funnels into the single apps→packages cell.
    expect(h.crossEdges).toBe(2);
  });

  it('resolves real package-to-package flow at module granularity (the fix)', () => {
    const h = buildHeatmap(files, edges, moduleOf);
    expect(h.folders).toContain('apps/web');
    expect(h.folders).toContain('packages/core');
    expect(h.folders).toContain('packages/spec');

    const idx = (f: string) => h.folders.indexOf(f);
    const web = idx('apps/web');
    const core = idx('packages/core');
    const spec = idx('packages/spec');

    expect(h.matrix[web]![core]).toBe(1); // apps/web → packages/core
    expect(h.matrix[web]![spec]).toBe(1); // apps/web → packages/spec
    expect(h.matrix[core]![spec]).toBe(1); // packages/core → packages/spec
    expect(h.matrix[web]![web]).toBe(1); // intra-module (diagonal) preserved
    // Three distinct cross-module couplings now, not one collapsed band.
    expect(h.crossEdges).toBe(3);
  });

  it('keeps the default key backward-compatible with topLevelFolder', () => {
    const a = buildHeatmap(files, edges);
    const b = buildHeatmap(files, edges, topLevelFolder);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('dropIsolated removes modules with no edges (docs/config dirs)', () => {
    const withDoc = [...files, { path: 'docs/readme.md' }, { path: '.github/ci.yml' }];
    const h = buildHeatmap(withDoc, edges, moduleOf, { dropIsolated: true });
    expect(h.folders).not.toContain('docs');
    expect(h.folders).not.toContain('.github');
    // The real code modules survive.
    expect(h.folders).toContain('apps/web');
    expect(h.folders).toContain('packages/spec');
    // Matrix stays square against the filtered folder list.
    expect(h.matrix.length).toBe(h.folders.length);
    for (const row of h.matrix) expect(row.length).toBe(h.folders.length);
  });

  it('dropIsolated keeps a module that only self-couples', () => {
    const f = [{ path: 'pkg/a/x.ts' }, { path: 'pkg/a/y.ts' }];
    const e = [{ from: 'pkg/a/x.ts', to: 'pkg/a/y.ts' }]; // intra-module only
    const h = buildHeatmap(f, e, moduleOf, { dropIsolated: true });
    expect(h.folders).toEqual(['pkg/a']);
    expect(h.matrix[0]![0]).toBe(1);
  });
});

describe('capHeatmap', () => {
  const files = [
    { path: 'a/x.ts' },
    { path: 'b/x.ts' },
    { path: 'c/x.ts' },
    { path: 'd/x.ts' },
  ];
  // a is the hub (in+out to everyone); d is the weakest (one edge).
  const edges = [
    { from: 'a/x.ts', to: 'b/x.ts' },
    { from: 'a/x.ts', to: 'c/x.ts' },
    { from: 'b/x.ts', to: 'a/x.ts' },
    { from: 'c/x.ts', to: 'a/x.ts' },
    { from: 'd/x.ts', to: 'a/x.ts' },
  ];
  const h = buildHeatmap(files, edges, moduleOf);

  it('is a no-op when folders already fit', () => {
    expect(capHeatmap(h, 10)).toBe(h);
  });

  it('keeps the top-N modules by total degree', () => {
    const c = capHeatmap(h, 3);
    expect(c.folders.length).toBe(3);
    expect(c.folders).toContain('a'); // the hub always survives
    expect(c.folders).not.toContain('d'); // the weakest is dropped
    expect(c.matrix.length).toBe(3);
    for (const row of c.matrix) expect(row.length).toBe(3);
  });

  it('recomputes crossEdges/maxCell over the kept submatrix (hand-checked)', () => {
    // Degrees: a=5 (hub), b=c=2, d=1 → top-2 by degree, name-tiebreak = [a, b].
    const c = capHeatmap(h, 2);
    expect(c.folders).toEqual(['a', 'b']);
    // Kept edges among {a,b} are exactly a→b and b→a; a→c, c→a, d→a are pruned.
    expect(c.crossEdges).toBe(2); // independently computed, NOT re-summed from c.matrix
    expect(c.crossEdges).toBeLessThan(h.crossEdges); // full graph had 5 cross edges
    expect(c.maxCell).toBe(1); // every cell here is a single edge
    expect(c.totalEdges).toBe(h.totalEdges); // project-wide count preserved, not shrunk
  });
});

describe('moduleLeaf', () => {
  it('returns the last path segment', () => {
    expect(moduleLeaf('packages/spec')).toBe('spec');
    expect(moduleLeaf('apps/ui-remix')).toBe('ui-remix');
  });
  it('passes through a single segment', () => {
    expect(moduleLeaf('src')).toBe('src');
    expect(moduleLeaf('·')).toBe('·');
  });
});

import { describe, expect, it } from 'vitest';
import { GraphEdgeSchema } from '@factstack/spec';
import { buildDependencyGraph } from '../src/dependency.js';
import { buildCallerIndex } from '../src/callers.js';
import { isRelative, isNodeBuiltin } from '../src/resolver.js';

/**
 * Tests for the graph builders. Cycle detection is the critical
 * piece — Tarjan's SCC powers `factstack query cycles` and the Risks
 * tab's import-cycle warnings.
 */

function file(path: string) {
  return {
    path, language: 'typescript', loc: 10, bytes: 200, bundleSize: null, tokenCost: 50,
    imports: [], exports: [], declarations: [], routes: [], components: [], tests: [], todos: [],
    complexity: { cyclomatic: 1, cognitive: 1 }, status: 'ok' as const,
    lastModifiedMs: null, churnScore: null,
  };
}
function rawImport(specifier: string, kind: 'import' | 'dynamic-import' | 'type-import' = 'import') {
  return { specifier, kind, line: 1 };
}

const emptyCtx = { files: new Set<string>(['a.ts', 'b.ts', 'c.ts', 'd.ts']), workspaces: new Map() };

describe('buildDependencyGraph', () => {
  it('builds nodes from outlines', () => {
    const g = buildDependencyGraph([file('a.ts'), file('b.ts')], new Map(), emptyCtx);
    expect(g.nodes.map((n) => n.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('builds edges from importsByFile when resolver succeeds', () => {
    const importsByFile = new Map([['a.ts', [rawImport('./b')]]]);
    const g = buildDependencyGraph([file('a.ts'), file('b.ts')], importsByFile, emptyCtx);
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.edges[0]).toMatchObject({ from: 'a.ts', to: 'b.ts' });
  });

  it('F1: tags import edges with confidence "extracted" (read directly from source)', () => {
    const importsByFile = new Map([['a.ts', [rawImport('./b')]]]);
    const g = buildDependencyGraph([file('a.ts'), file('b.ts')], importsByFile, emptyCtx);
    expect(g.edges[0]?.confidence).toBe('extracted');
    // Score omitted for extracted edges (implicitly 1.0); F2 sets it for inferred/ambiguous.
    expect(g.edges[0]?.confidenceScore).toBeUndefined();
  });

  it('skips edges when target is not in files set', () => {
    const ctx = { files: new Set(['a.ts']), workspaces: new Map() };
    const importsByFile = new Map([['a.ts', [rawImport('./missing')]]]);
    const g = buildDependencyGraph([file('a.ts')], importsByFile, ctx);
    expect(g.edges).toHaveLength(0);
  });

  it('detects a 2-node import cycle (a → b → a)', () => {
    const ctx = { files: new Set(['a.ts', 'b.ts']), workspaces: new Map() };
    const importsByFile = new Map([
      ['a.ts', [rawImport('./b')]],
      ['b.ts', [rawImport('./a')]],
    ]);
    const g = buildDependencyGraph([file('a.ts'), file('b.ts')], importsByFile, ctx);
    expect(g.cycles.length).toBeGreaterThan(0);
    const flat = g.cycles.flat();
    expect(flat).toContain('a.ts');
    expect(flat).toContain('b.ts');
  });

  it('detects a 3-node cycle (a → b → c → a)', () => {
    const ctx = { files: new Set(['a.ts', 'b.ts', 'c.ts']), workspaces: new Map() };
    const importsByFile = new Map([
      ['a.ts', [rawImport('./b')]],
      ['b.ts', [rawImport('./c')]],
      ['c.ts', [rawImport('./a')]],
    ]);
    const g = buildDependencyGraph([file('a.ts'), file('b.ts'), file('c.ts')], importsByFile, ctx);
    expect(g.cycles.length).toBeGreaterThan(0);
    expect(g.cycles[0]?.length).toBeGreaterThanOrEqual(3);
  });

  it('returns no cycles for an acyclic graph', () => {
    const ctx = { files: new Set(['a.ts', 'b.ts', 'c.ts']), workspaces: new Map() };
    const importsByFile = new Map([
      ['a.ts', [rawImport('./b')]],
      ['b.ts', [rawImport('./c')]],
    ]);
    const g = buildDependencyGraph([file('a.ts'), file('b.ts'), file('c.ts')], importsByFile, ctx);
    expect(g.cycles).toEqual([]);
  });

  it('handles multiple disjoint cycles', () => {
    const ctx = { files: new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts']), workspaces: new Map() };
    const importsByFile = new Map([
      ['a.ts', [rawImport('./b')]],
      ['b.ts', [rawImport('./a')]],
      ['c.ts', [rawImport('./d')]],
      ['d.ts', [rawImport('./c')]],
    ]);
    const g = buildDependencyGraph([file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts')], importsByFile, ctx);
    expect(g.cycles.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves edge kind (import / dynamic-import / type-import)', () => {
    const ctx = { files: new Set(['a.ts', 'b.ts']), workspaces: new Map() };
    const importsByFile = new Map([
      ['a.ts', [rawImport('./b', 'dynamic-import')]],
    ]);
    const g = buildDependencyGraph([file('a.ts'), file('b.ts')], importsByFile, ctx);
    expect(g.edges[0]?.kind).toBe('dynamic-import');
  });
});

describe('buildCallerIndex', () => {
  it('inverts edges into a callers map', () => {
    const callers = buildCallerIndex({
      edges: [
        { from: 'a.ts', to: 'shared.ts', kind: 'import' },
        { from: 'b.ts', to: 'shared.ts', kind: 'import' },
      ],
    });
    expect(callers.get('shared.ts')?.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('returns empty map for no edges', () => {
    expect(buildCallerIndex({ edges: [] }).size).toBe(0);
  });

  it('dedupes when the same edge appears twice (e.g. import + dynamic-import)', () => {
    const callers = buildCallerIndex({
      edges: [
        { from: 'a.ts', to: 'shared.ts', kind: 'import' },
        { from: 'a.ts', to: 'shared.ts', kind: 'dynamic-import' },
      ],
    });
    expect(callers.get('shared.ts')).toEqual(['a.ts']);
  });
});

describe('F1 — GraphEdgeSchema confidence (INV4 backward-compat)', () => {
  it('defaults a legacy edge (no confidence field) to "extracted" on parse', () => {
    const parsed = GraphEdgeSchema.parse({ from: 'a.ts', to: 'b.ts', kind: 'import' });
    expect(parsed.confidence).toBe('extracted');
    expect(parsed.confidenceScore).toBeUndefined();
  });
  it('preserves an explicit inferred confidence + score (what F2 will write)', () => {
    const parsed = GraphEdgeSchema.parse({ from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'inferred', confidenceScore: 0.9 });
    expect(parsed.confidence).toBe('inferred');
    expect(parsed.confidenceScore).toBe(0.9);
  });
  it('rejects an out-of-range confidenceScore', () => {
    expect(() => GraphEdgeSchema.parse({ from: 'a', to: 'b', kind: 'import', confidenceScore: 1.5 })).toThrow();
  });
});

describe('resolver helpers', () => {
  it('isRelative detects ./ and ../', () => {
    expect(isRelative('./foo')).toBe(true);
    expect(isRelative('../foo')).toBe(true);
    expect(isRelative('./')).toBe(true);
    expect(isRelative('react')).toBe(false);
    expect(isRelative('@scope/pkg')).toBe(false);
    expect(isRelative('/absolute')).toBe(false);
  });

  it('isNodeBuiltin detects node:* and bare builtins', () => {
    expect(isNodeBuiltin('node:fs')).toBe(true);
    expect(isNodeBuiltin('node:path')).toBe(true);
    expect(isNodeBuiltin('fs')).toBe(true);
    expect(isNodeBuiltin('path')).toBe(true);
    expect(isNodeBuiltin('react')).toBe(false);
    expect(isNodeBuiltin('./local')).toBe(false);
  });
});

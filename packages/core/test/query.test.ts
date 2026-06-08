import { describe, expect, it } from 'vitest';
import { executeQuery } from '../src/query.js';
import type { AgentArtifact } from '@factstack/spec';

/**
 * Tests for `executeQuery` — the verb engine shared by the CLI's
 * `factstack query` command and the MCP server's `query_graph` tool.
 *
 * Covers: callers / imports / cycles / orphans, the glob matcher,
 * limit + filter + depth options, and the v0.2 noise-filtering
 * (orphans skips manifests, dotfiles, lockfiles, test paths,
 * declared entry points).
 */

// Tiny artifact builder that lets each test focus on the bits it cares
// about. All fields default to safe empty values so tests can pass a
// partial. Shape mirrors @factstack/spec/AgentArtifact.
function makeArtifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-01T00:00:00Z',
    project: {
      name: 'test',
      root: '/test',
      languages: [],
      frameworks: [],
      entryPoints: [],
      monorepo: null,
    },
    files: [],
    graph: { nodes: [], edges: [], cycles: [] },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
    ...overrides,
  } as AgentArtifact;
}

function node(path: string, language: string = 'typescript', extra: Record<string, unknown> = {}) {
  return { id: path, path, language, loc: 10, tokenCost: 50, status: 'ok' as const, ...extra };
}
function edge(from: string, to: string, kind: 'import' | 'dynamic-import' | 'type-import' = 'import') {
  return { from, to, kind };
}
function edgeC(from: string, to: string, confidence: 'extracted' | 'inferred' | 'ambiguous') {
  return { from, to, kind: 'import' as const, confidence };
}

describe('executeQuery — callers verb', () => {
  it('returns files that import the target', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('src/auth.ts'), node('src/login.ts'), node('src/api.ts')],
        edges: [edge('src/login.ts', 'src/auth.ts'), edge('src/api.ts', 'src/auth.ts')],
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'callers', path: 'src/auth.ts' });
    expect(r.count).toBe(2);
    expect(r.results).toEqual(['src/api.ts', 'src/login.ts']);
  });

  it('prefers cached `callers` index when present (v0.2 perf path)', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [
          node('src/auth.ts', 'typescript', { callers: ['src/cached-only.ts'] }),
          node('src/cached-only.ts'),
        ],
        edges: [], // edges intentionally empty — proves the cache is preferred
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'callers', path: 'src/auth.ts' });
    expect(r.results).toEqual(['src/cached-only.ts']);
  });

  it('returns empty when target has no callers', () => {
    const agent = makeArtifact({
      graph: { nodes: [node('src/orphan.ts')], edges: [], cycles: [] },
    });
    const r = executeQuery(agent, { verb: 'callers', path: 'src/orphan.ts' });
    expect(r.count).toBe(0);
    expect(r.results).toEqual([]);
  });

  it('returns empty when path is missing', () => {
    const r = executeQuery(makeArtifact(), { verb: 'callers' });
    expect(r.count).toBe(0);
    expect(r.results).toEqual([]);
  });

  it('respects limit', () => {
    const callers = Array.from({ length: 10 }, (_, i) => `src/c${i}.ts`);
    const agent = makeArtifact({
      graph: {
        nodes: [node('src/auth.ts'), ...callers.map((c) => node(c))],
        edges: callers.map((c) => edge(c, 'src/auth.ts')),
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'callers', path: 'src/auth.ts', limit: 3 });
    expect(r.count).toBe(10);
    expect((r.results as string[]).length).toBe(3);
  });
});

describe('executeQuery — imports verb', () => {
  it('returns direct imports at depth 1', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('a.ts'), node('b.ts'), node('c.ts')],
        edges: [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts')],
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'imports', path: 'a.ts', depth: 1 });
    expect(r.results).toEqual(['b.ts']);
  });

  it('walks transitively at depth 2+', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('a.ts'), node('b.ts'), node('c.ts'), node('d.ts')],
        edges: [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts'), edge('c.ts', 'd.ts')],
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'imports', path: 'a.ts', depth: 3 });
    // a's transitive imports = b, c, d (sorted alphabetically by the verb)
    expect(r.results).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('does not revisit nodes (cycle-safe)', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('a.ts'), node('b.ts')],
        edges: [edge('a.ts', 'b.ts'), edge('b.ts', 'a.ts')], // cycle
        cycles: [['a.ts', 'b.ts']],
      },
    });
    const r = executeQuery(agent, { verb: 'imports', path: 'a.ts', depth: 5 });
    // Should not include 'a.ts' in its own transitive imports
    expect(r.results).toEqual(['b.ts']);
  });

  it('returns empty when target has no outgoing edges', () => {
    const agent = makeArtifact({
      graph: { nodes: [node('a.ts')], edges: [], cycles: [] },
    });
    const r = executeQuery(agent, { verb: 'imports', path: 'a.ts' });
    expect(r.results).toEqual([]);
  });

  it('respects limit', () => {
    const targets = Array.from({ length: 6 }, (_, i) => `t${i}.ts`);
    const agent = makeArtifact({
      graph: {
        nodes: [node('a.ts'), ...targets.map((t) => node(t))],
        edges: targets.map((t) => edge('a.ts', t)),
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'imports', path: 'a.ts', limit: 2 });
    expect(r.count).toBe(6);
    expect((r.results as string[]).length).toBe(2);
  });
});

describe('executeQuery — cycles verb', () => {
  it('returns all cycles unfiltered', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [],
        edges: [],
        cycles: [['a.ts', 'b.ts'], ['c.ts', 'd.ts', 'e.ts']],
      },
    });
    const r = executeQuery(agent, { verb: 'cycles' });
    expect(r.count).toBe(2);
  });

  it('filters cycles whose participants match', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [],
        edges: [],
        cycles: [['src/a.ts', 'src/b.ts'], ['lib/c.ts', 'lib/d.ts']],
      },
    });
    const r = executeQuery(agent, { verb: 'cycles', filter: 'src' });
    expect(r.count).toBe(1);
    expect((r.results as string[][])[0]).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('executeQuery — orphans verb (v0.2 noise filtering)', () => {
  it('skips non-source files (manifests, lockfiles, dotfiles)', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [
          node('src/index.ts', 'typescript'),
          node('package.json', 'json'),
          node('.gitignore', 'gitignore'),
          node('tsconfig.json', 'json'),
          node('pnpm-lock.yaml', 'yaml'),
        ],
        edges: [edge('src/index.ts', 'src/lib.ts')],
        cycles: [],
      },
      files: [],
    });
    const r = executeQuery(agent, { verb: 'orphans' });
    // Only TypeScript file (src/index.ts) should be considered;
    // it has an outgoing edge so qualifies as a real orphan.
    expect(r.results).toEqual(['src/index.ts']);
  });

  it('skips files in declared entryPoints', () => {
    const agent = makeArtifact({
      project: {
        name: 'test', root: '/test', languages: [], frameworks: [],
        entryPoints: ['src/index.ts'], monorepo: null,
      },
      graph: {
        nodes: [node('src/index.ts'), node('src/lib.ts')],
        edges: [edge('src/index.ts', 'src/lib.ts')],
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'orphans' });
    // src/index.ts is a declared entry point → not an orphan
    expect(r.results).toEqual([]);
  });

  it('skips files that are route handlers', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('src/api/login.ts')],
        edges: [edge('src/api/login.ts', 'src/lib.ts')],
        cycles: [],
      },
      routes: [
        { framework: 'express', method: 'POST', path: '/login', handlerFile: 'src/api/login.ts', handlerSymbol: null },
      ],
    });
    const r = executeQuery(agent, { verb: 'orphans' });
    expect(r.results).toEqual([]);
  });

  it('skips test files (regression for v0.2.1 polish)', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [
          node('src/lib.ts'),
          node('src/lib.test.ts'),
          node('test/auth.test.ts'),
          node('__tests__/util.ts'),
          node('cypress/integration/e2e.ts'),
        ],
        edges: [
          edge('src/lib.test.ts', 'src/lib.ts'),
          edge('test/auth.test.ts', 'src/lib.ts'),
          edge('__tests__/util.ts', 'src/lib.ts'),
          edge('cypress/integration/e2e.ts', 'src/lib.ts'),
        ],
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'orphans' });
    // None of the test files should appear as orphans even though they
    // have no callers (test runners invoke them, not other code).
    expect(r.results).toEqual([]);
  });

  it('requires at least one outgoing import (skips bare leaves)', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('src/leaf.ts')], // no edges anywhere
        edges: [],
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'orphans' });
    // Bare leaves are likely config files or noise — excluded by default.
    expect(r.results).toEqual([]);
  });

  it('reports a true orphan: source file with imports but no callers', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('src/dead.ts'), node('src/util.ts')],
        edges: [edge('src/dead.ts', 'src/util.ts')], // dead.ts imports util but nothing imports dead
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'orphans' });
    expect(r.results).toEqual(['src/dead.ts']);
  });

  it('respects filter glob', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('src/a.ts'), node('lib/b.ts')],
        edges: [edge('src/a.ts', 'src/x.ts'), edge('lib/b.ts', 'lib/y.ts')],
        cycles: [],
      },
    });
    const r = executeQuery(agent, { verb: 'orphans', filter: 'src/*' });
    expect(r.results).toEqual(['src/a.ts']);
  });
});

describe('executeQuery — glob matcher', () => {
  // Indirect testing via filter param.
  it('substring fallback when no glob chars', () => {
    const agent = makeArtifact({
      graph: { nodes: [], edges: [], cycles: [['src/auth.ts', 'src/login.ts']] },
    });
    expect(executeQuery(agent, { verb: 'cycles', filter: 'auth' }).count).toBe(1);
    expect(executeQuery(agent, { verb: 'cycles', filter: 'nope' }).count).toBe(0);
  });

  it('star wildcard', () => {
    const agent = makeArtifact({
      graph: { nodes: [], edges: [], cycles: [['a/x.ts', 'a/y.ts'], ['b/c.ts', 'b/d.ts']] },
    });
    expect(executeQuery(agent, { verb: 'cycles', filter: 'a/*.ts' }).count).toBe(1);
  });

  it('? matches single char (anchored), substring matches contains', () => {
    const agent = makeArtifact({
      graph: { nodes: [], edges: [], cycles: [['x.ts'], ['xx.ts']] },
    });
    // Plain 'x.ts' is substring → matches both 'x.ts' and 'xx.ts'
    expect(executeQuery(agent, { verb: 'cycles', filter: 'x.ts' }).count).toBe(2);
    // '?.ts' is glob → anchored single-char + literal '.ts', matches only 'x.ts'
    expect(executeQuery(agent, { verb: 'cycles', filter: '?.ts' }).count).toBe(1);
  });
});

describe('executeQuery — minConfidence filter (F1)', () => {
  // a.ts imports b (extracted), c (inferred), d (ambiguous).
  function mixed(): AgentArtifact {
    return makeArtifact({
      graph: {
        nodes: [node('a.ts'), node('b.ts'), node('c.ts'), node('d.ts')],
        edges: [
          edgeC('a.ts', 'b.ts', 'extracted'),
          edgeC('a.ts', 'c.ts', 'inferred'),
          edgeC('a.ts', 'd.ts', 'ambiguous'),
        ],
        cycles: [],
      },
    });
  }

  it('no threshold returns every edge', () => {
    expect(executeQuery(mixed(), { verb: 'imports', path: 'a.ts' }).results)
      .toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('minConfidence=extracted keeps only the most certain edge', () => {
    expect(executeQuery(mixed(), { verb: 'imports', path: 'a.ts', minConfidence: 'extracted' }).results)
      .toEqual(['b.ts']);
  });

  it('minConfidence=inferred keeps extracted + inferred', () => {
    expect(executeQuery(mixed(), { verb: 'imports', path: 'a.ts', minConfidence: 'inferred' }).results)
      .toEqual(['b.ts', 'c.ts']);
  });

  it('minConfidence=ambiguous is the loosest threshold (keeps everything)', () => {
    expect(executeQuery(mixed(), { verb: 'imports', path: 'a.ts', minConfidence: 'ambiguous' }).results)
      .toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('callers: a threshold bypasses the cached path-only callers index so the filter applies', () => {
    const agent = makeArtifact({
      graph: {
        nodes: [node('b.ts', 'typescript', { callers: ['a.ts'] }), node('a.ts')],
        edges: [edgeC('a.ts', 'b.ts', 'ambiguous')],
        cycles: [],
      },
    });
    // No threshold → the cached caller index wins (fast path).
    expect(executeQuery(agent, { verb: 'callers', path: 'b.ts' }).results).toEqual(['a.ts']);
    // Threshold drops the only (ambiguous) edge → no callers survive.
    expect(executeQuery(agent, { verb: 'callers', path: 'b.ts', minConfidence: 'extracted' }).results).toEqual([]);
  });

  it('is pure — never mutates the input agent', () => {
    const agent = mixed();
    executeQuery(agent, { verb: 'imports', path: 'a.ts', minConfidence: 'extracted' });
    expect(agent.graph.edges.map((e) => e.to)).toEqual(['b.ts', 'c.ts', 'd.ts']);
    expect(agent.graph.nodes.every((n) => n.callers === undefined)).toBe(true); // untouched
  });
});

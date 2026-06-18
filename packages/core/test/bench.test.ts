import { describe, expect, it } from 'vitest';
import { runBench, runBenchTask, naiveReadSet } from '../src/bench.js';
import type { AgentArtifact } from '@factstack/spec';

/**
 * F13 — bench harness arithmetic. Hand-built artifact so every number is
 * checkable by hand: naive = Σ tokenCost of path-substring hits; facts = the
 * F4 assembler's totalTokens; savings/recall formulas pinned exactly.
 */

function fnode(path: string, importance: number, tokenCost: number) {
  return { id: path, path, language: 'typescript', loc: 50, tokenCost, status: 'ok' as const, importance };
}
function foutline(path: string, tokenCost: number) {
  return {
    path, language: 'typescript', loc: 50, bytes: 1500, bundleSize: null, tokenCost,
    imports: [], exports: [], declarations: [], todos: [],
    complexity: { cyclomatic: 0, cognitive: 0 }, status: 'ok' as const,
    lastModifiedMs: null, churnScore: null,
  };
}
function edge(from: string, to: string) {
  return { from, to, kind: 'import', confidence: 'extracted' as const };
}

/** user-api/user-model both contain "user"; orders imports user-model. */
function makeAgent(): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-06-10T00:00:00Z',
    project: { name: 'bench-fixture', root: '/t', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [
      foutline('src/user-api.ts', 300),
      foutline('src/user-model.ts', 200),
      foutline('src/orders.ts', 400),
      foutline('src/db.ts', 100),
    ],
    graph: {
      nodes: [
        fnode('src/user-api.ts', 0.6, 300),
        fnode('src/user-model.ts', 1.0, 200),
        fnode('src/orders.ts', 0.3, 400),
        fnode('src/db.ts', 0.8, 100),
      ],
      edges: [
        edge('src/user-api.ts', 'src/user-model.ts'),
        edge('src/orders.ts', 'src/user-model.ts'),
        edge('src/user-model.ts', 'src/db.ts'),
      ],
      cycles: [], symbolNodes: [], symbolEdges: [], entities: [], entityEdges: [],
    },
    routes: [], scripts: {}, capabilities: [], risks: [],
    stats: { loc: 200, fileCount: 4, packageCount: 1, totalTokenCost: 1000 },
  } as AgentArtifact;
}

const TASK = {
  id: 'user-task',
  query: 'update the user model',
  expectedAnchors: ['src/user-model.ts', 'src/db.ts'],
};

describe('naiveReadSet (F13)', () => {
  it('substring-greps content words against paths, sorted', () => {
    // tokens: "update" is a stopword; "user" + "model" remain.
    expect(naiveReadSet(makeAgent(), 'update the user model')).toEqual([
      'src/user-api.ts', // contains "user"
      'src/user-model.ts', // contains both
    ]);
  });

  it('is empty when the query has no content words', () => {
    expect(naiveReadSet(makeAgent(), 'the and for')).toEqual([]);
  });
});

describe('runBenchTask (F13)', () => {
  const r = runBenchTask(makeAgent(), TASK);

  it('naive side: tokens are the sum of matched files, one turn per file', () => {
    expect(r.naive.files).toEqual(['src/user-api.ts', 'src/user-model.ts']);
    expect(r.naive.tokens).toBe(500); // 300 + 200
    expect(r.naive.turns).toBe(2);
  });

  it('naive recall misses the graph-only dependency', () => {
    // db.ts has no "user"/"model" in its path — grep can't find it.
    expect(r.naive.recall).toBe(0.5);
  });

  it('facts side: one turn, finds the dependency through the graph', () => {
    expect(r.facts.turns).toBe(1);
    expect(r.facts.anchors).toContain('src/user-model.ts');
    expect(r.facts.anchors).toContain('src/db.ts'); // 1 hop from the seed
    expect(r.facts.recall).toBe(1);
  });

  it('savingsPct follows the formula against the naive total', () => {
    const expected = Math.round(((500 - r.facts.tokens) / 500) * 1000) / 10;
    expect(r.savingsPct).toBe(expected);
  });

  it('savingsPct is 0 when the naive side read nothing', () => {
    const none = runBenchTask(makeAgent(), { id: 'x', query: 'zzznomatch', expectedAnchors: [] });
    expect(none.naive.tokens).toBe(0);
    expect(none.savingsPct).toBe(0);
  });
});

describe('runBench (F13)', () => {
  it('aggregates sums + mean recalls and carries corpus stats', () => {
    const report = runBench(makeAgent(), [TASK]);
    expect(report.corpus).toEqual({ files: 4, loc: 200, totalTokens: 1000 });
    expect(report.aggregate.naiveTokens).toBe(500);
    expect(report.aggregate.factsTokens).toBe(report.tasks[0]!.facts.tokens);
    expect(report.aggregate.meanFactsRecall).toBe(1);
    expect(report.aggregate.meanNaiveRecall).toBe(0.5);
  });

  it('is byte-deterministic across runs (committable expected.json)', () => {
    const a = runBench(makeAgent(), [TASK]);
    const b = runBench(makeAgent(), [TASK]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

import { describe, expect, it } from 'vitest';
import { assembleContext } from '../src/context.js';
import type { AgentArtifact } from '@factstack/spec';

/**
 * F4 — `assembleContext` unit coverage. A hand-built artifact lets us pin the
 * exact ranking + budget behavior the DoD calls out: seeds always present,
 * budget respected, truncation visible, deterministic order, cold-start
 * fallback. Fixtures are loose (`as AgentArtifact`) — the function only reads
 * graph.nodes / files / graph.edges / graph.symbolNodes.
 */

const SNAP = '2026-06-09T00:00:00Z';

/** A graph file node: importance + tokenCost are what the ranker/budget read. */
function fnode(path: string, importance: number, tokenCost: number) {
  return { id: path, path, language: 'typescript', loc: 50, tokenCost, status: 'ok' as const, importance };
}

/** A files[] entry: churnScore (recency) + loc/tokenCost (symbol estimate). */
function foutline(path: string, churnScore: number, tokenCost: number, loc = 50) {
  return {
    path,
    language: 'typescript',
    loc,
    bytes: loc * 30,
    bundleSize: null,
    tokenCost,
    imports: [],
    exports: [],
    declarations: [],
    todos: [],
    complexity: { cyclomatic: 0, cognitive: 0 },
    status: 'ok' as const,
    lastModifiedMs: 1_700_000_000_000,
    churnScore,
  };
}

function edge(from: string, to: string, kind = 'import') {
  return { from, to, kind, confidence: 'extracted' as const };
}

/**
 * Five files. auth is the most important hub; util reaches auth; db is a sink.
 * Edges: auth→user, auth→db, user→db, util→auth.  (unrelated is disconnected,
 * only reachable as a cold-start seed.)
 */
function makeAgent(over: Partial<AgentArtifact['graph']> = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: SNAP,
    project: { name: 't', root: '/t', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [
      foutline('src/auth.ts', 5, 300),
      foutline('src/user.ts', 2, 200),
      foutline('src/db.ts', 1, 400),
      foutline('src/util.ts', 0, 100),
      foutline('src/unrelated.ts', 0, 5000, 1000),
    ],
    graph: {
      nodes: [
        fnode('src/auth.ts', 1.0, 300),
        fnode('src/user.ts', 0.5, 200),
        fnode('src/db.ts', 0.8, 400),
        fnode('src/util.ts', 0.2, 100),
        fnode('src/unrelated.ts', 0.1, 5000),
      ],
      edges: [
        edge('src/auth.ts', 'src/user.ts'),
        edge('src/auth.ts', 'src/db.ts'),
        edge('src/user.ts', 'src/db.ts'),
        edge('src/util.ts', 'src/auth.ts'),
      ],
      cycles: [],
      symbolNodes: [],
      symbolEdges: [],
      ...over,
    },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  } as AgentArtifact;
}

describe('assembleContext (F4)', () => {
  it('resolves a seed from the task and always includes it', () => {
    const r = assembleContext(makeAgent(), { query: 'add a role field to user' });
    expect(r.seeds).toContain('src/user.ts');
    const user = r.items.find((i) => i.id === 'src/user.ts');
    expect(user).toBeDefined();
    expect(user!.isSeed).toBe(true);
    expect(user!.hops).toBe(0);
  });

  it('ranks the seed highest and orders by descending score', () => {
    const r = assembleContext(makeAgent(), { query: 'user' });
    // user (seed, name-match, proximity 1) should top auth (importance 1 but 2 hops).
    expect(r.items[0]!.id).toBe('src/user.ts');
    for (let i = 1; i < r.items.length; i++) {
      expect(r.items[i - 1]!.score).toBeGreaterThanOrEqual(r.items[i]!.score);
    }
  });

  it('respects the token budget for non-seed candidates + marks truncation', () => {
    // user(seed,200) + auth(300) = 500 fits; db(400)/util(100) are dropped.
    const r = assembleContext(makeAgent(), { query: 'user', budgetTokens: 500 });
    expect(r.totalTokens).toBeLessThanOrEqual(500);
    expect(r.truncated).toBe(true);
    expect(r.items.map((i) => i.id)).toContain('src/auth.ts');
    expect(r.items.map((i) => i.id)).not.toContain('src/db.ts');
  });

  it('floor: returns the top anchor even when it exceeds the budget', () => {
    // Budget 50 < the matched anchor's 200 token cost. An inferred seed is
    // budget-gated, but the floor keeps the single best hit so we never return
    // nothing for a real match.
    const r = assembleContext(makeAgent(), { query: 'user', budgetTokens: 50 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.id).toBe('src/user.ts');
    expect(r.totalTokens).toBeGreaterThan(50);
    expect(r.truncated).toBe(true);
  });

  it('explicit seeds are sacred — kept even over budget', () => {
    // db(400) + util(100) = 500 ≫ budget 50, but explicit seeds are never dropped.
    const r = assembleContext(makeAgent(), { query: 'nothing', seeds: ['src/db.ts', 'src/util.ts'], budgetTokens: 50 });
    const ids = r.items.map((i) => i.id);
    expect(ids).toContain('src/db.ts');
    expect(ids).toContain('src/util.ts');
    expect(r.totalTokens).toBeGreaterThan(50);
    expect(r.truncated).toBe(true);
  });

  it('includes everything under a generous budget with no truncation', () => {
    const r = assembleContext(makeAgent(), { query: 'user', budgetTokens: 100_000 });
    expect(r.truncated).toBe(false);
    expect(r.totalTokens).toBe(1000); // user200 + auth300 + db400 + util100
    expect(r.items).toHaveLength(4); // unrelated is disconnected → not reached
  });

  it('cold start: no match → top-importance fallback, flagged', () => {
    const r = assembleContext(makeAgent(), { query: 'zzznomatch quux', budgetTokens: 100_000 });
    expect(r.coldStart).toBe(true);
    // Highest-importance file (auth = 1.0) leads the brief.
    expect(r.items[0]!.id).toBe('src/auth.ts');
    expect(r.seeds).toContain('src/auth.ts');
  });

  it('cold start stays non-empty on a pre-F5 artifact with no importance (INV4)', () => {
    const agent = makeAgent();
    // Simulate a pre-F5 artifact: strip importance from every graph node.
    for (const n of agent.graph.nodes) delete (n as { importance?: number }).importance;
    const r = assembleContext(agent, { query: 'zzznomatch', budgetTokens: 100_000 });
    expect(r.coldStart).toBe(true);
    expect(r.items.length).toBeGreaterThan(0); // brief is non-empty even without importance
    // No importance to rank by → fallback selects source files in path order;
    // all five source files become seeds (capped at COLD_START_FILES=10).
    expect(r.seeds).toEqual(['src/auth.ts', 'src/db.ts', 'src/unrelated.ts', 'src/user.ts', 'src/util.ts']);
  });

  it('is deterministic — identical inputs yield a byte-identical result', () => {
    const a = assembleContext(makeAgent(), { query: 'user role', budgetTokens: 600 });
    const b = assembleContext(makeAgent(), { query: 'user role', budgetTokens: 600 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('honors maxHops — a 0-hop request returns only the seed neighborhood', () => {
    const r = assembleContext(makeAgent(), { query: 'user', maxHops: 0, budgetTokens: 100_000 });
    // No expansion: only the seed itself.
    expect(r.items.every((i) => i.hops === 0)).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(['src/user.ts']);
  });

  it('accepts explicit seeds and unions them with query-derived ones', () => {
    const r = assembleContext(makeAgent(), { query: 'nothing', seeds: ['src/db.ts'], budgetTokens: 100_000 });
    expect(r.seeds).toContain('src/db.ts');
    expect(r.coldStart).toBe(false); // an explicit seed resolved → not cold
  });

  it('edges connect only included anchors', () => {
    const r = assembleContext(makeAgent(), { query: 'user', budgetTokens: 100_000 });
    const ids = new Set(r.items.map((i) => i.id));
    for (const e of r.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it('recentEntities give a session-recency bonus that lifts an anchor (F9)', () => {
    const base = assembleContext(makeAgent(), { query: 'user', budgetTokens: 100_000 });
    const boosted = assembleContext(makeAgent(), { query: 'user', budgetTokens: 100_000, recentEntities: ['src/db.ts'] });
    const dbBase = base.items.find((i) => i.id === 'src/db.ts')!.score;
    const dbBoost = boosted.items.find((i) => i.id === 'src/db.ts')!.score;
    expect(dbBoost).toBeGreaterThan(dbBase);
    expect(dbBoost).toBeLessThanOrEqual(1); // bonus clamped into [0,1]
  });
});

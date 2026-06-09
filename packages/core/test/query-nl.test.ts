import { describe, expect, it } from 'vitest';
import { planFromQuestion } from '../src/query-nl.js';
import type { AgentArtifact, SymbolNode, SymbolEdge } from '@factstack/spec';

/**
 * F3 — free-text → plan mapper. Deterministic, INV3 (no model): it only maps a
 * handful of keyword-cued shapes against REAL entity names in the graph, and
 * returns a candidate list when it can't map confidently.
 */

function sym(id: string, path: string, name: string, kind: string, s: number): SymbolNode {
  return { id, path, name, kind: kind as SymbolNode['kind'], startLine: s, endLine: s + 2, exported: true };
}
function makeArtifact(graph: Partial<AgentArtifact['graph']>): AgentArtifact {
  return {
    $schema: 'x', factsVersion: '0.1.0', generatedAt: '2026-06-08T00:00:00Z',
    project: { name: 't', root: '/t', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [], graph: { nodes: [], edges: [], cycles: [], symbolNodes: [], symbolEdges: [], ...graph },
    routes: [], scripts: {}, capabilities: [], risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  } as AgentArtifact;
}
function fileNode(path: string) {
  return { id: path, path, language: 'typescript', loc: 10, tokenCost: 50, status: 'ok' as const };
}

const agent = makeArtifact({
  nodes: [fileNode('src/auth.ts'), fileNode('src/login.ts'), fileNode('src/api.ts')],
  edges: [
    { from: 'src/login.ts', to: 'src/auth.ts', kind: 'import', confidence: 'extracted' },
    { from: 'src/api.ts', to: 'src/auth.ts', kind: 'import', confidence: 'extracted' },
  ],
  cycles: [],
  symbolNodes: [
    sym('src/auth.ts#buildMemory@10', 'src/auth.ts', 'buildMemory', 'function', 10),
    sym('src/login.ts#doLogin@4', 'src/login.ts', 'doLogin', 'function', 4),
  ],
  symbolEdges: [
    { from: 'src/login.ts#doLogin@4', to: 'src/auth.ts#buildMemory@10', kind: 'call', confidence: 'inferred', confidenceScore: 0.9 } as SymbolEdge,
  ],
});

describe('planFromQuestion — directional cues', () => {
  it('"who calls buildMemory" → incoming traversal seeded at the symbol', () => {
    const r = planFromQuestion(agent, 'who calls buildMemory');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entities).toEqual(['src/auth.ts#buildMemory@10']);
    expect(r.plan.graphQuery?.traverse?.direction).toBe('in');
    expect(r.plan.graphQuery?.start.id).toBe('src/auth.ts#buildMemory@10');
  });

  it('"what does login.ts import" → outgoing traversal', () => {
    const r = planFromQuestion(agent, 'what does login.ts import');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entities).toEqual(['src/login.ts']);
    expect(r.plan.graphQuery?.traverse?.direction).toBe('out');
  });

  it('"what depends on auth.ts" → incoming (who-depends beats the depends-on cue)', () => {
    const r = planFromQuestion(agent, 'what depends on auth.ts');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entities).toEqual(['src/auth.ts']);
    expect(r.plan.graphQuery?.traverse?.direction).toBe('in');
  });
});

describe('planFromQuestion — verb templates', () => {
  it('"find unused files" → orphans verb', () => {
    const r = planFromQuestion(agent, 'find unused files');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.verb).toBe('orphans');
    expect(r.plan.entities).toEqual([]);
  });

  it('"are there any circular dependencies" → cycles verb', () => {
    const r = planFromQuestion(agent, 'are there any circular dependencies');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.verb).toBe('cycles');
  });

  it('"path between login.ts and auth.ts" → path-between with both endpoints', () => {
    const r = planFromQuestion(agent, 'path between login.ts and auth.ts');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.verb).toBe('path-between');
    expect(r.plan.path).toBe('src/login.ts');
    expect(r.plan.to).toBe('src/auth.ts');
  });
});

describe('planFromQuestion — did-you-mean fallback', () => {
  it('returns candidates when no entity resolves', () => {
    const r = planFromQuestion(agent, 'who calls nonexistentThing');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Array.isArray(r.candidates)).toBe(true);
  });

  it('suggests on a partial name', () => {
    const r = planFromQuestion(agent, 'who calls build'); // partial of buildMemory
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.candidates).toContain('src/auth.ts#buildMemory@10');
  });

  it('is deterministic', () => {
    const a = planFromQuestion(agent, 'who calls buildMemory');
    const b = planFromQuestion(agent, 'who calls buildMemory');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

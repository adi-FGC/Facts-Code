/**
 * Tests for v0.3.2 — `since(timestamp)` MCP tool foundation.
 *
 * Cover both modes:
 *   1. mtime-only: walks current.files looking at lastModifiedMs > cutoff
 *   2. baseline-aware: real diff between two artifacts, scoped to the
 *      window after `since`
 */

import { describe, expect, it } from 'vitest';
import { since, sinceFromMtime, sinceFromBaseline } from '../src/since.js';
import type { AgentArtifact, FileOutline, Risk, RouteDecl } from '@factstack/spec';
import { FACTS_SCHEMA_VERSION } from '@factstack/spec';

const baseAgent: AgentArtifact = {
  $schema: 'https://factstack.dev/schema/agent.v1.json',
  factsVersion: FACTS_SCHEMA_VERSION,
  generatedAt: '2026-05-02T12:00:00.000Z',
  project: {
    name: 'test',
    root: '.',
    languages: ['TypeScript'],
    frameworks: [],
    entryPoints: [],
    monorepo: null,
  },
  files: [],
  graph: { nodes: [], edges: [], cycles: [], callerIndex: {}, workspaces: [] },
  routes: [],
  scripts: {},
  capabilities: [],
  risks: [],
  stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
};

function file(path: string, lastModifiedMs: number, opts: Partial<FileOutline> = {}): FileOutline {
  return {
    path,
    language: 'typescript',
    loc: 50,
    bytes: 1000,
    bundleSize: null,
    tokenCost: 200,
    imports: [],
    exports: [],
    declarations: [],
    todos: [],
    complexity: { cyclomatic: 0, cognitive: 0 },
    status: 'ok',
    lastModifiedMs,
    churnScore: null,
    ...opts,
  };
}

function risk(rule: string, file?: string, line?: number, message = 'msg'): Risk {
  return {
    severity: 'medium',
    category: 'broken-import',
    rule,
    message,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
  };
}

function route(p: string, method: string | null = 'GET'): RouteDecl {
  return { framework: 'express', method, path: p, handlerFile: 'src/x.ts', handlerSymbol: null };
}

describe('since — deterministic generatedAt on an invalid timestamp (DET-2)', () => {
  it('sinceFromMtime stamps from the input artifact, not the wall clock', () => {
    const r = sinceFromMtime(baseAgent, 'not-a-date');
    expect(r.generatedAt).toBe(baseAgent.generatedAt);
  });

  it('sinceFromBaseline stamps from the input artifact, not the wall clock', () => {
    const r = sinceFromBaseline(baseAgent, baseAgent, 'not-a-date');
    expect(r.generatedAt).toBe(baseAgent.generatedAt);
  });
});

describe('sinceFromMtime — mtime-only mode', () => {
  it('returns no files when none have lastModifiedMs after the cutoff', () => {
    const current = {
      ...baseAgent,
      files: [
        file('a.ts', Date.parse('2026-04-01T00:00:00Z')),
        file('b.ts', Date.parse('2026-04-15T00:00:00Z')),
      ],
    };
    const r = sinceFromMtime(current, '2026-05-01T00:00:00Z');
    expect(r.files).toEqual([]);
    expect(r.hasBaseline).toBe(false);
  });

  it('returns files with mtime strictly greater than the cutoff', () => {
    const current = {
      ...baseAgent,
      files: [
        file('a.ts', Date.parse('2026-04-01T00:00:00Z')),  // before
        file('b.ts', Date.parse('2026-05-02T00:00:00Z')),  // after
        file('c.ts', Date.parse('2026-05-03T00:00:00Z')),  // after
      ],
    };
    const r = sinceFromMtime(current, '2026-05-01T00:00:00Z');
    expect(r.files.map((f) => f.path)).toEqual(['c.ts', 'b.ts']);  // most recent first
    expect(r.files.every((f) => f.kind === 'modified')).toBe(true);
  });

  it('skips files with null lastModifiedMs', () => {
    const current = {
      ...baseAgent,
      files: [
        file('a.ts', Date.parse('2026-05-02T00:00:00Z')),
        { ...file('b.ts', 0), lastModifiedMs: null },
      ],
    };
    const r = sinceFromMtime(current, '2026-05-01T00:00:00Z');
    expect(r.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('returns an empty report on a malformed timestamp', () => {
    const r = sinceFromMtime({ ...baseAgent, files: [file('a.ts', Date.now())] }, 'not-a-date');
    expect(r.files).toEqual([]);
  });

  it('aggregates tokenCostInWindow across changed files', () => {
    const current = {
      ...baseAgent,
      files: [
        file('a.ts', Date.parse('2026-05-02T00:00:00Z'), { tokenCost: 100 }),
        file('b.ts', Date.parse('2026-05-02T01:00:00Z'), { tokenCost: 250 }),
      ],
    };
    const r = sinceFromMtime(current, '2026-05-01T00:00:00Z');
    expect(r.tokenCostInWindow).toBe(350);
  });
});

describe('sinceFromBaseline — diff mode', () => {
  it('classifies new files as added', () => {
    const prior = { ...baseAgent, files: [file('a.ts', Date.parse('2026-04-01T00:00:00Z'))] };
    const current = {
      ...baseAgent,
      files: [
        file('a.ts', Date.parse('2026-04-01T00:00:00Z')),
        file('b.ts', Date.parse('2026-05-02T00:00:00Z')),
      ],
    };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.files.map((f) => `${f.kind}:${f.path}`)).toEqual(['added:b.ts']);
  });

  it('classifies removed files', () => {
    const prior = {
      ...baseAgent,
      files: [
        file('a.ts', Date.parse('2026-04-01T00:00:00Z')),
        file('b.ts', Date.parse('2026-04-15T00:00:00Z')),
      ],
    };
    const current = { ...baseAgent, files: [file('a.ts', Date.parse('2026-04-01T00:00:00Z'))] };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.files.find((f) => f.kind === 'removed')?.path).toBe('b.ts');
  });

  it('classifies modified files', () => {
    const prior = { ...baseAgent, files: [file('a.ts', Date.parse('2026-04-01T00:00:00Z'), { loc: 50, bytes: 1000 })] };
    const current = {
      ...baseAgent,
      files: [file('a.ts', Date.parse('2026-05-02T00:00:00Z'), { loc: 75, bytes: 1500 })],
    };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.files.map((f) => `${f.kind}:${f.path}`)).toEqual(['modified:a.ts']);
  });

  it('skips modified files whose mtime is before the cutoff', () => {
    const prior = { ...baseAgent, files: [file('a.ts', Date.parse('2026-04-01T00:00:00Z'), { loc: 50 })] };
    // Same file, different content, but mtime BEFORE cutoff (e.g.,
    // edited last month and unchanged since).
    const current = { ...baseAgent, files: [file('a.ts', Date.parse('2026-04-15T00:00:00Z'), { loc: 75, bytes: 1500 })] };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.files.find((f) => f.kind === 'modified')).toBeUndefined();
  });

  it('reports added routes', () => {
    const prior = { ...baseAgent, routes: [route('/health')] };
    const current = { ...baseAgent, routes: [route('/health'), route('/users', 'POST')] };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.routesAdded).toHaveLength(1);
    expect(r.routesAdded[0]?.path).toBe('/users');
  });

  it('reports removed routes', () => {
    const prior = { ...baseAgent, routes: [route('/health'), route('/legacy')] };
    const current = { ...baseAgent, routes: [route('/health')] };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.routesRemoved.map((rt) => rt.path)).toEqual(['/legacy']);
  });

  it('reports added + removed risks', () => {
    const prior = { ...baseAgent, risks: [risk('aws-key', 'a.ts', 1, 'old')] };
    const current = { ...baseAgent, risks: [risk('stripe-key', 'b.ts', 1, 'new')] };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.risksAdded.map((x) => x.rule)).toEqual(['stripe-key']);
    expect(r.risksRemoved.map((x) => x.rule)).toEqual(['aws-key']);
  });

  it('preserves baseline awareness in the report', () => {
    const r = sinceFromBaseline(baseAgent, baseAgent, '2026-05-01T00:00:00Z');
    expect(r.hasBaseline).toBe(true);
  });
});

describe('since — top-level dispatch', () => {
  it('uses mtime mode when no baseline is supplied', () => {
    const current = { ...baseAgent, files: [file('a.ts', Date.parse('2026-05-02T00:00:00Z'))] };
    const r = since(current, '2026-05-01T00:00:00Z');
    expect(r.hasBaseline).toBe(false);
    expect(r.files).toHaveLength(1);
  });

  it('uses baseline mode when a baseline is supplied', () => {
    const prior = { ...baseAgent, files: [] };
    const current = { ...baseAgent, files: [file('a.ts', Date.parse('2026-05-02T00:00:00Z'))] };
    const r = since(current, '2026-05-01T00:00:00Z', prior);
    expect(r.hasBaseline).toBe(true);
    expect(r.files[0]?.kind).toBe('added');
  });
});

describe('determinism', () => {
  it('produces the same output across two runs', () => {
    const current = {
      ...baseAgent,
      files: [
        file('a.ts', Date.parse('2026-05-02T00:00:00Z')),
        file('b.ts', Date.parse('2026-05-02T01:00:00Z')),
      ],
    };
    const a = sinceFromMtime(current, '2026-05-01T00:00:00Z');
    const b = sinceFromMtime(current, '2026-05-01T00:00:00Z');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

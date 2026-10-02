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
import { analyze } from '../src/index.js';
import { memoryFS } from '@factstack/fs-memory';
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
  graph: {
    nodes: [],
    edges: [],
    cycles: [],
    symbolNodes: [],
    symbolEdges: [],
    entities: [],
    entityEdges: [],
  },
  routes: [],
  scripts: {},
  capabilities: [],
  risks: [],
  stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  dependencyManifests: [],
  vulnerabilities: [],
  docs: [],
  rationale: [],
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
        file('a.ts', Date.parse('2026-04-01T00:00:00Z')), // before
        file('b.ts', Date.parse('2026-05-02T00:00:00Z')), // after
        file('c.ts', Date.parse('2026-05-03T00:00:00Z')), // after
      ],
    };
    const r = sinceFromMtime(current, '2026-05-01T00:00:00Z');
    expect(r.files.map((f) => f.path)).toEqual(['c.ts', 'b.ts']); // most recent first
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
    const prior = {
      ...baseAgent,
      files: [file('a.ts', Date.parse('2026-04-01T00:00:00Z'), { loc: 50, bytes: 1000 })],
    };
    const current = {
      ...baseAgent,
      files: [file('a.ts', Date.parse('2026-05-02T00:00:00Z'), { loc: 75, bytes: 1500 })],
    };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.files.map((f) => `${f.kind}:${f.path}`)).toEqual(['modified:a.ts']);
  });

  it('skips modified files whose mtime is before the cutoff (baseline older than the cutoff)', () => {
    // The baseline predates the cutoff, so only the timestamp can say
    // whether the change fell inside the window.
    const prior = {
      ...baseAgent,
      generatedAt: '2026-04-10T00:00:00.000Z',
      files: [file('a.ts', Date.parse('2026-04-01T00:00:00Z'), { loc: 50 })],
    };
    // Same file, different content, but mtime BEFORE cutoff (e.g.,
    // edited last month and unchanged since).
    const current = {
      ...baseAgent,
      files: [file('a.ts', Date.parse('2026-04-15T00:00:00Z'), { loc: 75, bytes: 1500 })],
    };
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

  it('reports an uncommitted edit whose timestamp is the old git commit time (HUNT-CORE-03)', () => {
    // git-mined lastModifiedMs is the last COMMIT (09-01); the working-tree
    // edit happened after a baseline taken inside the window.
    const commit = Date.parse('2026-09-01T00:00:00Z');
    const prior = {
      ...baseAgent,
      generatedAt: '2026-09-02T13:00:00.000Z',
      files: [file('src/a.ts', commit, { loc: 2, bytes: 40 })],
    };
    const current = {
      ...baseAgent,
      generatedAt: '2026-09-03T10:00:00.000Z',
      files: [
        file('src/a.ts', commit, { loc: 3, bytes: 60 }),
        file('src/new.ts', Date.parse('2026-09-03T09:00:00Z')),
      ],
    };
    const r = sinceFromBaseline(current, prior, '2026-09-02T12:00:00Z');
    expect(r.files.map((f) => `${f.kind}:${f.path}`)).toEqual([
      'added:src/new.ts',
      'modified:src/a.ts',
    ]);
  });

  it('reports an uncommitted edit against a baseline OLDER than the cutoff (CORE-R4, the MCP shape)', () => {
    // MCP `since` only passes a baseline taken at or before `ts`. The file's
    // git commit time (09-01) did not move since that baseline, yet its
    // content did: the edit is uncommitted, so its timestamp cannot place it.
    const commit = Date.parse('2026-09-01T00:00:00Z');
    const prior = {
      ...baseAgent,
      generatedAt: '2026-09-02T10:00:00.000Z',
      files: [
        file('src/a.ts', commit, { loc: 2, bytes: 40 }),
        file('src/b.ts', commit, { loc: 2, bytes: 40 }),
        file('src/c.ts', commit, { loc: 2, bytes: 40 }),
      ],
    };
    const current = {
      ...baseAgent,
      generatedAt: '2026-09-03T10:00:00.000Z',
      files: [
        file('src/a.ts', commit, { loc: 3, bytes: 60 }), // edited, not committed
        file('src/b.ts', commit, { loc: 2, bytes: 40 }), // untouched
        // Committed between the baseline and the cutoff: the timestamp moved
        // and places the change before the window.
        file('src/c.ts', Date.parse('2026-09-02T11:00:00Z'), { loc: 5, bytes: 90 }),
      ],
    };
    const r = sinceFromBaseline(current, prior, '2026-09-02T12:00:00Z');
    expect(r.files.map((f) => `${f.kind}:${f.path}`)).toEqual(['modified:src/a.ts']);
    // The commit time is not when the edit happened: report it as unknown.
    expect(r.files[0]!.lastModified).toBeNull();
  });

  it('lists an edited-but-uncommitted file across two real analyze runs (CORE-R4 end-to-end)', async () => {
    // Git-mined stats pin every file to its last commit, as the CLI/MCP do.
    const commit = Date.parse('2026-09-01T00:00:00Z');
    const gitStats = new Map(
      ['src/a.ts', 'src/b.ts'].map((p) => [
        p,
        { lastModifiedMs: commit, churnScore: 0, authorCount: 1 },
      ]),
    );
    const run = (a: string, generatedAt: string) =>
      analyze(memoryFS({ 'src/a.ts': a, 'src/b.ts': 'export const b = 1;\n' }), {
        root: '.',
        projectName: 'p',
        gitStats,
        generatedAt,
      });
    const base = (await run('export const a = 1;\n', '2026-09-02T10:00:00.000Z')).agent;
    const head = (
      await run('export const a = 1;\nexport const a2 = 2;\n', '2026-09-03T10:00:00.000Z')
    ).agent;
    // The MCP tool's rule: the baseline predates the asked-about moment.
    const ts = '2026-09-02T12:00:00.000Z';
    expect(Date.parse(base.generatedAt) <= Date.parse(ts)).toBe(true);
    const r = since(head, ts, base);
    expect(r.files.map((f) => `${f.kind}:${f.path}`)).toEqual(['modified:src/a.ts']);
  });

  it('keeps distinct risks whose messages share a long prefix (HUNT-CORE-13)', () => {
    const unresolved = (spec: string) => ({
      ...risk('unresolved-import', 'src/App.tsx', undefined, `Unresolved import: "${spec}"`),
    });
    const cycle = (members: string) => ({
      ...risk('import-cycle', undefined, undefined, `Import cycle across 2 files: ${members}.`),
      category: 'cycle' as const,
    });
    const prior = {
      ...baseAgent,
      risks: [unresolved('./components/Button'), cycle('src/a.ts → src/b.ts')],
    };
    const current = {
      ...baseAgent,
      risks: [
        unresolved('./components/Button'),
        unresolved('./components/Card'),
        cycle('src/a.ts → src/b.ts'),
        cycle('src/c.ts → src/d.ts'),
      ],
    };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.risksAdded.map((x) => x.messageTechnical ?? x.message)).toEqual([
      'Unresolved import: "./components/Card"',
      'Import cycle across 2 files: src/c.ts → src/d.ts.',
    ]);
    expect(r.risksRemoved).toEqual([]);
  });

  it('does not report a risk that only moved to another line as added + removed', () => {
    const prior = { ...baseAgent, risks: [risk('todo-fixme', 'a.ts', 10, 'FIXME: x')] };
    const current = { ...baseAgent, risks: [risk('todo-fixme', 'a.ts', 14, 'FIXME: x')] };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.risksAdded).toEqual([]);
    expect(r.risksRemoved).toEqual([]);
  });

  it('does not trust secret fingerprints across a secret rules revision change (SV-6)', () => {
    /* The same key in the same file, scanned under two rules revisions whose
       fingerprint schemes differ: digests could never match, so with the
       digest identity every secret read as removed + added. */
    const key = (fingerprint: string): Risk => ({
      severity: 'high',
      category: 'secret',
      rule: 'private-key',
      file: 'deploy/id_rsa',
      line: 1,
      message: 'Private key detected.',
      preview: '----***--',
      fingerprint,
    });
    const prior = { ...baseAgent, secretRulesRev: '111111111111', risks: [key('aaaaaaaaaaaa')] };
    const current = { ...baseAgent, secretRulesRev: '222222222222', risks: [key('bbbbbbbbbbbb')] };
    const r = sinceFromBaseline(current, prior, '2026-05-01T00:00:00Z');
    expect(r.risksAdded).toEqual([]);
    expect(r.risksRemoved).toEqual([]);
    // Same revision: the digests are comparable, and a swap is a swap.
    const same = sinceFromBaseline(
      { ...current, secretRulesRev: '111111111111' },
      prior,
      '2026-05-01T00:00:00Z',
    );
    expect(same.risksAdded.map((x) => x.file)).toEqual(['deploy/id_rsa']);
    expect(same.risksRemoved.map((x) => x.file)).toEqual(['deploy/id_rsa']);
    // The report goes to agents: the digest that matched them stays behind (SV-8).
    expect(JSON.stringify(same)).not.toContain('fingerprint');
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

  it('falls back to mtime-only when the baseline lacks files[] (stats-only rollup)', () => {
    // Reproduces the MCP `since` P1: the server writes a rolled-up "stats only"
    // snapshot each boot (no files[]). Handing that to since() must NOT throw a
    // TypeError on prior.files.map(...); it degrades to mtime-only mode.
    const current = { ...baseAgent, files: [file('a.ts', Date.parse('2026-05-02T00:00:00Z'))] };
    const rollup = { at: '2026-05-01T00:00:00Z', stats: { loc: 0 } } as unknown as AgentArtifact;
    expect(() => since(current, '2026-05-01T00:00:00Z', rollup)).not.toThrow();
    const r = since(current, '2026-05-01T00:00:00Z', rollup);
    expect(r.hasBaseline).toBe(false);
    expect(r.files.map((f) => f.path)).toEqual(['a.ts']);
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

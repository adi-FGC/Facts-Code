import { describe, expect, it } from 'vitest';
import { diffArtifacts, type Endpoint } from '../src/diff.js';
import type { AgentArtifact } from '@factstack/spec';

/**
 * Tests for `diffArtifacts` — the snapshot/artifact comparison
 * function backing `factstack diff`. Covers added/removed/changed
 * files, stats deltas, and the `incomplete: true` flag for snapshot
 * endpoints (where files[] is empty).
 */

function makeArtifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-01T00:00:00Z',
    project: { name: 'test', root: '/test', languages: [], frameworks: [], entryPoints: [], monorepo: null },
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

function file(path: string, loc: number, tokenCost: number, todos: Array<{ kind: string; line: number; text: string; authoredAt: null }> = []) {
  return {
    path, language: 'typescript', loc, bytes: loc * 30,
    bundleSize: null, tokenCost, imports: [], exports: [], declarations: [],
    routes: [], components: [], tests: [], todos,
    complexity: { cyclomatic: 1, cognitive: 1 }, status: 'ok' as const,
    lastModifiedMs: null, churnScore: null,
  };
}

describe('diffArtifacts — file-level changes', () => {
  it('detects added files', () => {
    const a = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const b = makeArtifact({ files: [file('a.ts', 10, 50), file('b.ts', 20, 100)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.added).toEqual(['b.ts']);
    expect(d.files.removed).toEqual([]);
  });

  it('detects removed files', () => {
    const a = makeArtifact({ files: [file('a.ts', 10, 50), file('b.ts', 20, 100)] });
    const b = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.removed).toEqual(['b.ts']);
    expect(d.files.added).toEqual([]);
  });

  it('detects changed files (loc or token delta)', () => {
    const a = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const b = makeArtifact({ files: [file('a.ts', 25, 120)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.changed).toHaveLength(1);
    expect(d.files.changed[0]).toMatchObject({ path: 'a.ts', locDelta: 15, tokenDelta: 70 });
  });

  it('orders changed files by absolute token delta desc', () => {
    const a = makeArtifact({ files: [file('a.ts', 10, 50), file('b.ts', 10, 50), file('c.ts', 10, 50)] });
    const b = makeArtifact({ files: [file('a.ts', 10, 60), file('b.ts', 10, 200), file('c.ts', 10, 30)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    // Order: |b: 150| > |c: -20| > |a: 10|
    expect(d.files.changed.map((c) => c.path)).toEqual(['b.ts', 'c.ts', 'a.ts']);
  });

  it('does not flag files with zero delta', () => {
    const a = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const b = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.changed).toEqual([]);
  });

  it('returns sorted added/removed lists for determinism', () => {
    const a = makeArtifact({ files: [file('a.ts', 1, 1), file('z.ts', 1, 1)] });
    const b = makeArtifact({ files: [file('m.ts', 1, 1), file('a.ts', 1, 1)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.removed).toEqual(['z.ts']);
    expect(d.files.added).toEqual(['m.ts']);
  });
});

describe('diffArtifacts — incomplete flag (snapshot endpoints)', () => {
  it('sets incomplete: true when from.files is empty', () => {
    const a = makeArtifact({ files: [], stats: { loc: 100, fileCount: 5, packageCount: 1, totalTokenCost: 500 } });
    const b = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.incomplete).toBe(true);
    // No phantom "added" entries
    expect(d.files.added).toEqual([]);
    expect(d.files.removed).toEqual([]);
    expect(d.files.changed).toEqual([]);
  });

  it('sets incomplete: true when to.files is empty', () => {
    const a = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const b = makeArtifact({ files: [] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.incomplete).toBe(true);
  });

  it('omits incomplete when both sides have files', () => {
    const a = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const b = makeArtifact({ files: [file('a.ts', 10, 50)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.incomplete).toBeUndefined();
  });
});

describe('diffArtifacts — stats deltas', () => {
  it('computes before/after/delta for each headline metric', () => {
    const a = makeArtifact({
      stats: { loc: 100, fileCount: 5, packageCount: 1, totalTokenCost: 500 },
    });
    const b = makeArtifact({
      stats: { loc: 130, fileCount: 6, packageCount: 1, totalTokenCost: 700 },
    });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.stats.loc).toEqual({ before: 100, after: 130, delta: 30 });
    expect(d.stats.tokens).toEqual({ before: 500, after: 700, delta: 200 });
    expect(d.stats.files).toEqual({ before: 5, after: 6, delta: 1 });
  });

  it('counts todos from files[] by default', () => {
    const todoEntry = { kind: 'TODO', line: 1, text: 'fix me', authoredAt: null };
    const a = makeArtifact({ files: [file('a.ts', 10, 50, [todoEntry])] });
    const b = makeArtifact({ files: [file('a.ts', 10, 50, [todoEntry, todoEntry])] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.stats.todos).toEqual({ before: 1, after: 2, delta: 1 });
  });

  it('uses overrides.todos when provided (snapshot path)', () => {
    const a = makeArtifact({ files: [] }); // empty files but overrides supplies the count
    const b = makeArtifact({ files: [] });
    const d = diffArtifacts(
      { artifact: a, overrides: { todos: 30, secrets: 0 } },
      { artifact: b, overrides: { todos: 35, secrets: 1 } },
    );
    expect(d.stats.todos).toEqual({ before: 30, after: 35, delta: 5 });
    expect(d.stats.secrets).toEqual({ before: 0, after: 1, delta: 1 });
  });

  it('counts secrets from risks[] by category default', () => {
    const a = makeArtifact({
      risks: [{ severity: 'high', category: 'secret', rule: 'r', message: 'm' }],
    });
    const b = makeArtifact({
      risks: [
        { severity: 'high', category: 'secret', rule: 'r', message: 'm' },
        { severity: 'high', category: 'secret', rule: 'r', message: 'm2' },
      ],
    });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.stats.secrets).toEqual({ before: 1, after: 2, delta: 1 });
  });
});

describe('diffArtifacts — endpoint markers', () => {
  it('includes snapshotFile in from/to when provided', () => {
    const a = makeArtifact();
    const b = makeArtifact();
    const d = diffArtifacts(
      { artifact: a, snapshotFile: '.facts/snapshots/old.json' },
      { artifact: b, snapshotFile: '.facts/snapshots/new.json' },
    );
    expect(d.from.snapshotFile).toBe('.facts/snapshots/old.json');
    expect(d.to.snapshotFile).toBe('.facts/snapshots/new.json');
  });

  it('omits snapshotFile when not provided', () => {
    const a = makeArtifact({ generatedAt: '2026-04-01T00:00:00Z' });
    const b = makeArtifact({ generatedAt: '2026-05-01T00:00:00Z' });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.from.snapshotFile).toBeUndefined();
    expect(d.from.at).toBe('2026-04-01T00:00:00Z');
    expect(d.to.at).toBe('2026-05-01T00:00:00Z');
  });
});

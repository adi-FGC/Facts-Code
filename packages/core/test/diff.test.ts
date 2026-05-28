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

/**
 * v0.7 — vulnerability ID-set diff + severity-shift score.
 *
 * The diff exposes two signals: a sorted `new` / `fixed` ID set
 * (what changed) and a signed `severityShift` (how much the posture
 * moved, weighted by severity). The asymmetric-mix case is the
 * load-bearing one — it's what justifies the shift score over a
 * pure count delta.
 *
 * The "pre-v0.6 artifact" case exercises the defensive `?? []`
 * fallback in diff.ts: `makeArtifact` here bypasses Zod via
 * `as AgentArtifact`, so the `.default([])` on the schema's
 * `vulnerabilities` field never fires and the runtime value is
 * literally `undefined`. Real fixtures behave this way.
 */
function vuln(
  id: string,
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown' = 'high',
) {
  return {
    id,
    severity,
    ecosystem: 'npm' as const,
    package: 'pkg',
    installedVersion: '1.0.0',
    fixedVersion: '1.0.1',
    advisoryUrl: `https://example.test/${id}`,
    lastChecked: 0,
    manifestPath: 'package.json',
  };
}

describe('diffArtifacts — vulnerability delta', () => {
  it('returns empty arrays + zero shift when both sides have no vulns', () => {
    const a = makeArtifact({ vulnerabilities: [] });
    const b = makeArtifact({ vulnerabilities: [] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.vulns.new).toEqual([]);
    expect(d.vulns.fixed).toEqual([]);
    expect(d.vulns.severityShift).toBe(0);
    expect(d.stats.vulns).toEqual({ before: 0, after: 0, delta: 0 });
  });

  it('flags new vuln IDs as `new` with positive severity shift', () => {
    const a = makeArtifact({ vulnerabilities: [] });
    const b = makeArtifact({
      vulnerabilities: [vuln('GHSA-1', 'critical'), vuln('GHSA-2', 'high')],
    });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.vulns.new).toEqual(['GHSA-1', 'GHSA-2']);
    expect(d.vulns.fixed).toEqual([]);
    // critical (4) + high (3) - 0 = +7
    expect(d.vulns.severityShift).toBe(7);
    expect(d.stats.vulns).toEqual({ before: 0, after: 2, delta: 2 });
  });

  it('flags removed vuln IDs as `fixed` with negative severity shift', () => {
    const a = makeArtifact({
      vulnerabilities: [vuln('GHSA-1', 'high'), vuln('GHSA-2', 'medium')],
    });
    const b = makeArtifact({ vulnerabilities: [] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.vulns.new).toEqual([]);
    expect(d.vulns.fixed).toEqual(['GHSA-1', 'GHSA-2']);
    // 0 - (high 3 + medium 2) = -5
    expect(d.vulns.severityShift).toBe(-5);
    expect(d.stats.vulns).toEqual({ before: 2, after: 0, delta: -2 });
  });

  it('captures asymmetric mix: 1 added critical + 1 fixed low = +3 shift, 0 count delta', () => {
    /* The load-bearing case: count delta is 0 (one in, one out), but
     * posture got meaningfully worse. severityShift must surface that. */
    const a = makeArtifact({ vulnerabilities: [vuln('OLD-1', 'low')] });
    const b = makeArtifact({ vulnerabilities: [vuln('NEW-1', 'critical')] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.vulns.new).toEqual(['NEW-1']);
    expect(d.vulns.fixed).toEqual(['OLD-1']);
    // critical (4) - low (1) = +3
    expect(d.vulns.severityShift).toBe(3);
    expect(d.stats.vulns).toEqual({ before: 1, after: 1, delta: 0 });
  });

  it('severityShift reflects severity upgrades on the same ID (posture got worse)', () => {
    /* Contract: `new` / `fixed` answer "which IDs changed"; the shift
     * score answers "how bad". Score is computed over the FULL vuln
     * list on each side, so when an advisory's severity gets upgraded
     * mid-flight (e.g., GitHub re-classifies GHSA-X from low → critical),
     * the ID set is unchanged but the shift correctly surfaces the
     * worse posture. */
    const a = makeArtifact({ vulnerabilities: [vuln('GHSA-X', 'low')] });
    const b = makeArtifact({ vulnerabilities: [vuln('GHSA-X', 'critical')] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.vulns.new).toEqual([]);
    expect(d.vulns.fixed).toEqual([]);
    // critical (4) - low (1) = +3 even though ID set is identical
    expect(d.vulns.severityShift).toBe(3);
  });

  it('handles pre-v0.6 artifacts (no vulnerabilities field) without throwing', () => {
    /* Pre-v0.6 fixtures bypass Zod and have `vulnerabilities`
     * literally undefined. The `?? []` fallback in diff.ts means
     * this stays a no-op rather than a crash. */
    const a = makeArtifact({ vulnerabilities: undefined as unknown as [] });
    const b = makeArtifact({ vulnerabilities: undefined as unknown as [] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.vulns.new).toEqual([]);
    expect(d.vulns.fixed).toEqual([]);
    expect(d.vulns.severityShift).toBe(0);
  });

  it('returns IDs sorted for deterministic diff output', () => {
    const a = makeArtifact({
      vulnerabilities: [vuln('ZZZ-1'), vuln('AAA-1'), vuln('MMM-1')],
    });
    const b = makeArtifact({
      vulnerabilities: [vuln('YYY-2'), vuln('BBB-2'), vuln('NNN-2')],
    });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.vulns.fixed).toEqual(['AAA-1', 'MMM-1', 'ZZZ-1']);
    expect(d.vulns.new).toEqual(['BBB-2', 'NNN-2', 'YYY-2']);
  });
});

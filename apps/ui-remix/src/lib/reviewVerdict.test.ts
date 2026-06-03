import { describe, expect, it } from 'vitest';
import { buildReviewVerdict, type ReviewBaseline } from './reviewVerdict.ts';
import type { Dataset } from './loadArtifacts.ts';

/**
 * Tests for the browser-side review verdict. The OUTPUT is the contract:
 * severity scoring is delegated to @factstack/core, so these assertions
 * double as a guard that the UI stays in lockstep with the CLI/MCP verdict.
 */

function ds(over: Partial<Dataset> = {}): Dataset {
  return {
    generatedAt: '2026-06-01T00:00:00Z',
    project: { name: 't', root: '.', languages: [], frameworks: [] },
    summary: { oneLiner: '', description: '', capabilities: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0 } },
    stats: { files: 2, loc: 20, size: 0, gzip: 0, tokens: 80 },
    tree: { name: '', path: '', files: [], children: [] },
    edges: [],
    entryPoints: [],
    risks: [],
    vulnerabilities: [],
    history: [],
    ...over,
  } as Dataset;
}

const secretRisk = { severity: 'high', category: 'secret', rule: 'aws-key', message: 'leaked' };

describe('buildReviewVerdict — posture', () => {
  it('is "none" on a clean dataset', () => {
    const v = buildReviewVerdict(ds(), null);
    expect(v.severity).toBe('none');
    expect(v.findings).toEqual([]);
    expect(v.posture).toEqual({ secrets: 0, vulnerabilities: 0, cycles: 0, topHub: null });
  });

  it('flags secrets as high', () => {
    const v = buildReviewVerdict(ds({ risks: [secretRisk] as Dataset['risks'] }), null);
    expect(v.severity).toBe('high');
    expect(v.posture.secrets).toBe(1);
    expect(v.findings.find((f) => f.kind === 'secret')?.severity).toBe('high');
  });

  it('detects a dependency cycle (a↔b) and scores it medium', () => {
    const edges: Dataset['edges'] = [
      { from: 'a.ts', to: 'b.ts', kind: 'import' },
      { from: 'b.ts', to: 'a.ts', kind: 'import' },
    ];
    const v = buildReviewVerdict(ds({ edges }), null);
    expect(v.posture.cycles).toBe(1);
    expect(v.findings.find((f) => f.kind === 'cycle')?.severity).toBe('medium');
    expect(v.severity).toBe('medium');
  });

  it('inherits the worst vulnerability severity', () => {
    const v = buildReviewVerdict(
      ds({ vulnerabilities: [{ id: 'CVE-1', severity: 'medium' }, { id: 'CVE-2', severity: 'critical' }] as NonNullable<Dataset['vulnerabilities']> }),
      null,
    );
    expect(v.posture.vulnerabilities).toBe(2);
    expect(v.findings.find((f) => f.kind === 'vulnerability')?.severity).toBe('critical');
    expect(v.severity).toBe('critical');
  });

  it('computes blast radius (transitive dependents) but only flags a hotspot past the threshold', () => {
    // Chain c → b → a: a has 2 transitive dependents (below HOTSPOT_LOW=5).
    const edges: Dataset['edges'] = [
      { from: 'b.ts', to: 'a.ts', kind: 'import' },
      { from: 'c.ts', to: 'b.ts', kind: 'import' },
    ];
    const v = buildReviewVerdict(ds({ edges }), null);
    expect(v.posture.topHub).toEqual({ file: 'a.ts', reach: 2 });
    expect(v.findings.find((f) => f.kind === 'hotspot')).toBeUndefined();
  });

  it('flags a hub once enough modules depend on one file', () => {
    // 5 files all import hub.ts → reach 5 ≥ HOTSPOT_LOW.
    const edges: Dataset['edges'] = ['a', 'b', 'c', 'd', 'e'].map((f) => ({
      from: `${f}.ts`,
      to: 'hub.ts',
      kind: 'import' as const,
    }));
    const v = buildReviewVerdict(ds({ edges }), null);
    expect(v.posture.topHub).toEqual({ file: 'hub.ts', reach: 5 });
    expect(v.findings.find((f) => f.kind === 'hotspot')?.severity).toBe('low');
  });
});

describe('buildReviewVerdict — trend', () => {
  const baseline: ReviewBaseline = { at: '2026-05-01T00:00:00Z', loc: 10, tokens: 40, files: 1, risks: 2, todos: 1 };

  it('reports count deltas vs the baseline', () => {
    const v = buildReviewVerdict(
      ds({ risks: [secretRisk, secretRisk, secretRisk, secretRisk, secretRisk] as Dataset['risks'], stats: { files: 3, loc: 30, size: 0, gzip: 0, tokens: 120 } }),
      baseline,
    );
    expect(v.trend).not.toBeNull();
    expect(v.trend!.risks).toEqual({ before: 2, after: 5, delta: 3 });
    expect(v.trend!.files).toEqual({ before: 1, after: 3, delta: 2 });
    // Risk-up since baseline produces a low risk finding on top of the secrets.
    expect(v.findings.find((f) => f.kind === 'risk')?.severity).toBe('low');
  });

  it('has no trend when no baseline is given', () => {
    const v = buildReviewVerdict(ds(), null);
    expect(v.trend).toBeNull();
  });
});

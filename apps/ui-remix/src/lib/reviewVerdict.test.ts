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
    summary: {
      oneLiner: '',
      description: '',
      capabilities: [],
      health: { broken: 0, stale: 0, todos: 0, secrets: 0 },
    },
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

  it('lists a test/fixture secret as its own low finding, never as exposed', () => {
    const fixture = { ...secretRisk, severity: 'low', file: 'test/keys.ts' };
    const v = buildReviewVerdict(ds({ risks: [fixture] as Dataset['risks'] }), null);
    expect(v.posture.secrets).toBe(0);
    const f = v.findings.filter((x) => x.kind === 'secret');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('low');
    expect(f[0]!.title).toBe('1 secret in test/fixture files');
    expect(v.severity).toBe('low');
  });

  /* "shown but never graded" (secretClass.ts): a possible secret is
     listed after the roll-up, marked not graded, so it never sets the level
     and never wears a LOW chip beside its own "not graded" title. */
  it('lists a possible (generic, info) secret as its own ungraded finding, never as exposed', () => {
    const possible = { ...secretRisk, severity: 'info', rule: 'env-secret-pair', file: '.env' };
    const v = buildReviewVerdict(ds({ risks: [possible, secretRisk] as Dataset['risks'] }), null);
    expect(v.posture.secrets).toBe(1); // only the provider-shaped one
    const f = v.findings.filter((x) => x.kind === 'secret');
    expect(f.map((x) => x.title)).toEqual(['1 exposed secret', '1 possible secret, not graded']);
    expect(f.map((x) => x.graded)).toEqual([undefined, false]);
    const alone = buildReviewVerdict(ds({ risks: [possible] as Dataset['risks'] }), null);
    expect(alone.posture.secrets).toBe(0);
    expect(alone.severity).toBe('none');
    expect(alone.findings.map((x) => x.graded)).toEqual([false]);
    expect(alone.headline).toBe('No risk: 1 possible secret, not graded.');
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
      ds({
        vulnerabilities: [
          { id: 'CVE-1', severity: 'medium' },
          { id: 'CVE-2', severity: 'critical' },
        ] as NonNullable<Dataset['vulnerabilities']>,
      }),
      null,
    );
    expect(v.posture.vulnerabilities).toBe(2);
    expect(v.findings.find((f) => f.kind === 'vulnerability')?.severity).toBe('critical');
    expect(v.severity).toBe('critical');
  });

  /* correctness#8 / CG-R4 — an advisory OSV gave no score for (or whose
     detail fetch failed) grades as medium here too, as in the CLI/MCP verdict
     (INV7): the page must never call it low. */
  it.each([
    ['direct', { id: 'CVE-U', severity: 'unknown', scope: 'direct' }],
    ['unlabelled', { id: 'CVE-U', severity: 'unknown' }],
  ])('grades a %s advisory of unknown severity as medium', (_label, row) => {
    const v = buildReviewVerdict(
      ds({ vulnerabilities: [row] as NonNullable<Dataset['vulnerabilities']> }),
      null,
    );
    expect(v.posture.vulnerabilities).toBe(1);
    const f = v.findings.filter((x) => x.kind === 'vulnerability');
    expect(f.map((x) => x.severity)).toEqual(['medium']);
    expect(f[0]!.graded).toBeUndefined();
    expect(v.severity).toBe('medium');
  });

  /* Owner call: dev / transitive advisories are listed, not counted toward
     the verdict level. A dev-only CRITICAL used to read "Critical risk". */
  it('lists dev / transitive advisories without letting them set the verdict', () => {
    const vulnerabilities = [
      { id: 'CVE-DEV', severity: 'critical', scope: 'dev' },
      { id: 'CVE-TRANS', severity: 'high', scope: 'transitive' },
    ] as NonNullable<Dataset['vulnerabilities']>;
    const v = buildReviewVerdict(ds({ vulnerabilities }), null);
    expect(v.severity).toBe('none');
    expect(v.posture.vulnerabilities).toBe(0);
    const f = v.findings.filter((x) => x.kind === 'vulnerability');
    expect(f.map((x) => x.title)).toEqual(['2 dev/transitive advisories (shown, not graded)']);
    expect(f[0]!.severity).toBe('low');
    /* The `low` is a schema placeholder: the marker tells the page to show
       "not graded" instead of a LOW chip (UI-R3-REV-03). */
    expect(f[0]!.graded).toBe(false);
    expect(f[0]!.evidence).toEqual({ count: 2, ids: ['CVE-DEV', 'CVE-TRANS'] });
    expect(v.headline).toBe('No risk: 2 dev/transitive advisories (shown, not graded).');

    /* Beside graded ones (direct, or a legacy row with no scope), only those
       score; an id with ANY direct row is graded (core review.ts's rule), and
       the listed-only finding comes last, after the roll-up. */
    const mixed = buildReviewVerdict(
      ds({
        vulnerabilities: [
          ...vulnerabilities,
          { id: 'CVE-DIRECT', severity: 'medium', scope: 'direct' },
          { id: 'CVE-DIRECT', severity: 'critical', scope: 'dev' },
          { id: 'CVE-LEGACY', severity: 'low' },
        ] as NonNullable<Dataset['vulnerabilities']>,
      }),
      null,
    );
    expect(mixed.severity).toBe('medium');
    expect(mixed.posture.vulnerabilities).toBe(2);
    expect(mixed.findings.map((x) => x.title)).toEqual([
      '2 known vulnerabilities',
      '2 dev/transitive advisories (shown, not graded)',
    ]);
    expect(mixed.findings[0]!.evidence).toEqual({ count: 2, ids: ['CVE-DIRECT', 'CVE-LEGACY'] });
    // Only the listed-only finding carries the marker; graded ones never do.
    expect(mixed.findings.map((x) => x.graded)).toEqual([undefined, false]);
  });

  it('marks nothing but listed-only advisories and possible secrets as not graded', () => {
    const fixture = { ...secretRisk, severity: 'low', file: 'test/keys.ts' };
    const possible = { ...secretRisk, severity: 'info', rule: 'env-secret-pair', file: '.env' };
    const edges: Dataset['edges'] = [
      { from: 'a.ts', to: 'b.ts', kind: 'import' },
      { from: 'b.ts', to: 'a.ts', kind: 'import' },
    ];
    const v = buildReviewVerdict(
      ds({
        edges,
        risks: [secretRisk, fixture, possible] as Dataset['risks'],
        vulnerabilities: [{ id: 'CVE-1', severity: 'high' }] as NonNullable<
          Dataset['vulnerabilities']
        >,
      }),
      null,
    );
    expect(v.findings.length).toBeGreaterThan(0);
    const ungraded = v.findings.filter((f) => f.graded !== undefined);
    expect(ungraded.map((f) => [f.title, f.graded])).toEqual([
      ['1 possible secret, not graded', false],
    ]);
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
  const baseline: ReviewBaseline = {
    at: '2026-05-01T00:00:00Z',
    loc: 10,
    tokens: 40,
    files: 1,
    risks: 2,
    todos: 1,
  };

  it('reports count deltas vs the baseline', () => {
    const v = buildReviewVerdict(
      ds({
        risks: [secretRisk, secretRisk, secretRisk, secretRisk, secretRisk] as Dataset['risks'],
        stats: { files: 3, loc: 30, size: 0, gzip: 0, tokens: 120 },
      }),
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

import { describe, expect, it } from 'vitest';
import {
  diffArtifacts,
  diffFindings,
  diffRiskSets,
  isRollupEndpoint,
  riskFingerprint,
  SECRET_GRADING_REV,
  secretGrading,
  type Endpoint,
} from '../src/diff.js';
import { isTestFixturePath } from '../src/index.js';
import { SECRET_RULES_REV } from '@factstack/scanners';
import {
  DiffArtifactSchema,
  type AgentArtifact,
  type FileOutline,
  type Risk,
} from '@factstack/spec';

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

function file(
  path: string,
  loc: number,
  tokenCost: number,
  todos: FileOutline['todos'] = [],
): FileOutline {
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
    routes: [],
    components: [],
    tests: [],
    todos,
    complexity: { cyclomatic: 1, cognitive: 1 },
    status: 'ok' as const,
    lastModifiedMs: null,
    churnScore: null,
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
    const a = makeArtifact({
      files: [file('a.ts', 10, 50), file('b.ts', 10, 50), file('c.ts', 10, 50)],
    });
    const b = makeArtifact({
      files: [file('a.ts', 10, 60), file('b.ts', 10, 200), file('c.ts', 10, 30)],
    });
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
    const a = makeArtifact({
      files: [],
      stats: { loc: 100, fileCount: 5, packageCount: 1, totalTokenCost: 500 },
    });
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

describe('diffArtifacts — deterministic generatedAt (DET-1)', () => {
  it('derives generatedAt from the "to" artifact, never the wall clock', () => {
    const a = makeArtifact({ generatedAt: '2026-05-01T00:00:00Z', files: [file('a.ts', 10, 50)] });
    const b = makeArtifact({ generatedAt: '2026-05-09T08:30:00Z', files: [file('a.ts', 12, 60)] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.generatedAt).toBe('2026-05-09T08:30:00Z');
  });

  it('produces byte-identical output across repeated calls (INV2)', () => {
    const a = makeArtifact({ generatedAt: '2026-05-01T00:00:00Z', files: [file('a.ts', 10, 50)] });
    const b = makeArtifact({ generatedAt: '2026-05-09T08:30:00Z', files: [file('a.ts', 12, 60)] });
    const d1 = diffArtifacts({ artifact: a }, { artifact: b });
    const d2 = diffArtifacts({ artifact: a }, { artifact: b });
    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2));
  });

  it('tiebreaks equal-magnitude token deltas by path (DET-3)', () => {
    // c.ts and b.ts both move by |20|; a.ts by |10|. The |20| pair must order
    // by path (b before c) so the sort is total and deterministic.
    const a = makeArtifact({
      files: [file('a.ts', 10, 50), file('b.ts', 10, 50), file('c.ts', 10, 50)],
    });
    const b = makeArtifact({
      files: [file('a.ts', 10, 60), file('b.ts', 10, 70), file('c.ts', 10, 30)],
    });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.files.changed.map((c) => c.path)).toEqual(['b.ts', 'c.ts', 'a.ts']);
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
    const todoEntry: FileOutline['todos'][number] = {
      kind: 'TODO',
      line: 1,
      text: 'fix me',
      authoredAt: null,
    };
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
function vuln(id: string, severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown' = 'high') {
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

  it('weighs an advisory of unknown severity at least as medium (CG-R2)', () => {
    /* OSV gives no score, or its detail fetch failed (429 / timeout): the
       advisory is still new, and `ci-report --fail-on-shift` must see it. */
    const a = makeArtifact({ vulnerabilities: [] });
    const b = makeArtifact({ vulnerabilities: [vuln('GHSA-U', 'unknown')] });
    const d = diffArtifacts({ artifact: a }, { artifact: b });
    expect(d.vulns.new).toEqual(['GHSA-U']);
    expect(d.vulns.severityShift).toBeGreaterThanOrEqual(2);
    // Fixing it moves the posture back by the same weight.
    expect(diffArtifacts({ artifact: b }, { artifact: a }).vulns.severityShift).toBe(
      -d.vulns.severityShift,
    );
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
    expect(d.vulns.incomplete).toBeUndefined();
  });
});

/* correctness#2 (JSON half) — a stats-only snapshot rollup carries no
   advisory list, so `factstack diff --json` / `ci-report --json` against one
   must not report every current advisory as new (or every base one fixed):
   the ID-level delta is unknown, flagged like `files.incomplete`. */
describe('diffArtifacts — vulnerability delta against a snapshot rollup', () => {
  /** What the CLI's loadDiffEndpoint synthesizes from .facts/snapshots/*.json. */
  const snapshot = (): Endpoint => ({
    artifact: makeArtifact({
      stats: { loc: 100, fileCount: 5, packageCount: 0, totalTokenCost: 500 },
      vulnerabilities: [],
      risks: [{ severity: 'info', category: 'stale', rule: 'snapshot-placeholder', message: '' }],
    }),
    snapshotFile: '.facts/snapshots/2026-09-01T00-00-00Z.json',
    overrides: { todos: 3, secrets: 0 },
  });
  const full = () =>
    makeArtifact({
      files: [file('a.ts', 10, 50)],
      stats: { loc: 10, fileCount: 1, packageCount: 1, totalTokenCost: 50 },
      vulnerabilities: [vuln('GHSA-1', 'critical'), vuln('GHSA-2', 'high')],
    });

  it('reports no new advisories and zero shift against a rollup base, flagged incomplete', () => {
    const d = diffArtifacts(snapshot(), { artifact: full() });
    expect(d.vulns).toEqual({ new: [], fixed: [], severityShift: 0, incomplete: true });
    // The count row still shows each side's list as given.
    expect(d.stats.vulns).toEqual({ before: 0, after: 2, delta: 2 });
  });

  it('reports no fixed advisories when the head is the rollup', () => {
    const d = diffArtifacts({ artifact: full() }, snapshot());
    expect(d.vulns).toEqual({ new: [], fixed: [], severityShift: 0, incomplete: true });
  });

  it('survives the spec schema (additive, optional)', () => {
    const d = DiffArtifactSchema.parse(diffArtifacts(snapshot(), { artifact: full() }));
    expect(d.vulns.incomplete).toBe(true);
    const plain = DiffArtifactSchema.parse(
      diffArtifacts({ artifact: full() }, { artifact: full() }),
    );
    expect(plain.vulns).not.toHaveProperty('incomplete');
  });

  it('recognises each rollup marker on its own', () => {
    const bare = makeArtifact({
      stats: { loc: 1, fileCount: 2, packageCount: 0, totalTokenCost: 1 },
    });
    expect(isRollupEndpoint({ artifact: bare })).toBe(true); // no files[], fileCount > 0
    expect(isRollupEndpoint({ artifact: makeArtifact(), overrides: {} })).toBe(true);
    expect(isRollupEndpoint({ artifact: makeArtifact(), snapshotFile: 's.json' })).toBe(true);
    expect(
      isRollupEndpoint({
        artifact: makeArtifact({
          files: [file('a.ts', 1, 1)],
          risks: [
            { severity: 'info', category: 'stale', rule: 'snapshot-placeholder', message: '' },
          ],
        }),
      }),
    ).toBe(true);
    // A genuinely empty project is compared in full.
    expect(isRollupEndpoint({ artifact: makeArtifact() })).toBe(false);
    // A full artifact that only records where it was loaded from is not a rollup.
    expect(isRollupEndpoint({ artifact: full(), snapshotFile: '.facts/baseline/agent.json' })).toBe(
      false,
    );
  });

  it('still compares a full artifact that carries a snapshotFile origin', () => {
    const d = diffArtifacts(
      { artifact: makeArtifact({ files: [file('a.ts', 10, 50)] }), snapshotFile: 'base.json' },
      { artifact: full() },
    );
    expect(d.vulns.new).toEqual(['GHSA-1', 'GHSA-2']);
    expect(d.vulns.incomplete).toBeUndefined();
  });
});

/* correctness#1 — every private key previews as `----***--` with the same
   entropy, so keyed on the preview a key swapped for another in the same file
   read as "no change". Graded secrets carry a one-way `fingerprint`. */
describe('diffRiskSets — secret fingerprints (correctness#1)', () => {
  const key = (fingerprint: string | undefined, line = 3): Risk => ({
    severity: 'high',
    category: 'secret',
    rule: 'private-key-header',
    file: 'deploy/id_rsa',
    line,
    message: 'Private key block detected (entropy 3.38). Rotate and remove from source.',
    preview: '----***--',
    ...(fingerprint ? { fingerprint } : {}),
  });

  it('reads a private key swapped for another in the same file as one new + one fixed', () => {
    const d = diffRiskSets([key('aaaaaaaaaaaa')], [key('bbbbbbbbbbbb')]);
    expect(d.new.map((r) => r.fingerprint)).toEqual(['bbbbbbbbbbbb']);
    expect(d.fixed.map((r) => r.fingerprint)).toEqual(['aaaaaaaaaaaa']);
  });

  it('does not flag the same key that only moved lines', () => {
    expect(diffRiskSets([key('aaaaaaaaaaaa', 3)], [key('aaaaaaaaaaaa', 40)])).toEqual({
      new: [],
      fixed: [],
    });
  });

  it('compares the old way (rule + file + preview) unless BOTH sides carry fingerprints', () => {
    expect(diffRiskSets([key(undefined)], [key('bbbbbbbbbbbb', 9)])).toEqual({
      new: [],
      fixed: [],
    });
    expect(
      diffRiskSets([key('aaaaaaaaaaaa')], [key('bbbbbbbbbbbb')], { useDigest: false }),
    ).toEqual({ new: [], fixed: [] });
    expect(riskFingerprint(key('aaaaaaaaaaaa'))).not.toBe(riskFingerprint(key('bbbbbbbbbbbb')));
    expect(riskFingerprint(key('aaaaaaaaaaaa'), false)).toBe(riskFingerprint(key(undefined)));
  });

  /* SV-7 — the identity includes the file, so a renamed key file read as a
     new HIGH secret; the fingerprint proves it is the same key. */
  it('reads the same key moved to another file (a rename) as neither new nor fixed', () => {
    const moved = { ...key('aaaaaaaaaaaa'), file: 'ops/id_rsa' };
    expect(diffRiskSets([key('aaaaaaaaaaaa')], [moved])).toEqual({ new: [], fixed: [] });
    // A different key in the new file is still one new + one fixed.
    const other = { ...key('bbbbbbbbbbbb'), file: 'ops/id_rsa' };
    expect(diffRiskSets([key('aaaaaaaaaaaa')], [other])).toEqual({
      new: [other],
      fixed: [key('aaaaaaaaaaaa')],
    });
  });

  it('still reads a key COPIED to a second file as new', () => {
    const copy = { ...key('aaaaaaaaaaaa'), file: 'ops/id_rsa' };
    expect(diffRiskSets([key('aaaaaaaaaaaa')], [key('aaaaaaaaaaaa'), copy])).toEqual({
      new: [copy],
      fixed: [],
    });
  });

  it('never pairs files without digests: every key previews alike', () => {
    const moved = { ...key(undefined), file: 'ops/id_rsa' };
    expect(diffRiskSets([key(undefined)], [moved])).toEqual({
      new: [moved],
      fixed: [key(undefined)],
    });
    // Digests from different rules (useDigest: false) never pair either.
    const renamed = { ...key('aaaaaaaaaaaa'), file: 'ops/id_rsa' };
    const off = { useDigest: false };
    expect(diffRiskSets([key('aaaaaaaaaaaa')], [renamed], off).new).toEqual([renamed]);
  });
});

/* data-model#1 — a baseline kept from an older scanner has neither
   fingerprints nor the newer rules, so its secrets must not be graded against
   a head made by the current one. */
describe('diffFindings — secret grading across scanner revisions (data-model#1)', () => {
  const REV = 'abcdef012345';
  const secret = (preview: string, fingerprint?: string): Risk => ({
    severity: 'high',
    category: 'secret',
    rule: 'github-token',
    file: '.env',
    line: 2,
    message: 'GitHub token detected (entropy 4.9). Rotate and remove from source.',
    preview,
    ...(fingerprint ? { fingerprint } : {}),
  });

  it('grades by fingerprint when both sides carry the same rules revision', () => {
    const d = diffFindings(
      makeArtifact({ secretRulesRev: REV, risks: [secret('ghp_***Tu', 'aaaaaaaaaaaa')] }),
      makeArtifact({ secretRulesRev: REV, risks: [secret('ghp_***Tu', 'bbbbbbbbbbbb')] }),
    );
    expect(d.secretGrading).toEqual({ graded: true });
    expect(d.secrets.new).toHaveLength(1);
  });

  it('does not grade against a base with no revision, and compares it the old way', () => {
    const d = diffFindings(
      makeArtifact({ risks: [secret('ghp_***Tu')] }),
      makeArtifact({ secretRulesRev: REV, risks: [secret('ghp_***Tu', 'bbbbbbbbbbbb')] }),
    );
    expect(d.secretGrading).toEqual({ graded: false, reason: 'base-older' });
    expect(d.secrets.new).toEqual([]);
  });

  it('does not grade when the two sides were scanned under different rules', () => {
    expect(
      secretGrading(
        makeArtifact({ secretRulesRev: REV }),
        makeArtifact({ secretRulesRev: '0123456789ab' }),
      ),
    ).toEqual({ graded: false, reason: 'rules-changed' });
    expect(secretGrading(makeArtifact({ secretRulesRev: REV }), makeArtifact())).toEqual({
      graded: false,
      reason: 'head-older',
    });
  });

  it('spots an older base by its unfingerprinted secrets when neither side records a revision', () => {
    expect(
      secretGrading(
        makeArtifact({ risks: [secret('ghp_***Tu')] }),
        makeArtifact({ risks: [secret('ghp_***Tu', 'bbbbbbbbbbbb')] }),
      ),
    ).toEqual({ graded: false, reason: 'base-older' });
  });

  it('keeps grading two artifacts from the same pre-fingerprint scanner (both unrevised)', () => {
    expect(
      secretGrading(
        makeArtifact({ risks: [secret('ghp_***Tu')] }),
        makeArtifact({ risks: [secret('ghp_***Xy')] }),
      ),
    ).toEqual({ graded: true });
  });

  /* SV-2 — not graded used to mean nothing graded: a brand-new key in a
     brand-new file scored 'none' on every upgrade or rules change. A file
     only one side has is added or removed under ANY rules. */
  it('keeps grading secrets in added and removed files when the rules differ', () => {
    const at = (path: string, preview: string, fingerprint?: string): Risk => ({
      ...secret(preview, fingerprint),
      file: path,
    });
    const base = makeArtifact({
      files: [file('.env', 3, 10), file('old/keys.ts', 5, 20)],
      risks: [at('.env', 'ghp_***Tu'), at('old/keys.ts', 'ghp_***Ab')],
    });
    const head = makeArtifact({
      secretRulesRev: REV,
      files: [file('.env', 3, 10), file('src/config.ts', 8, 30)],
      risks: [
        at('.env', '***', 'aaaaaaaaaaaa'), // same key, masked differently by the new scanner
        at('src/config.ts', 'ghp_***Zz', 'bbbbbbbbbbbb'),
      ],
    });
    const d = diffFindings(base, head);
    expect(d.secretGrading).toEqual({ graded: false, reason: 'base-older' });
    expect(d.secrets.new.map((r) => r.file)).toEqual(['src/config.ts']);
    expect(d.secrets.fixed.map((r) => r.file)).toEqual(['old/keys.ts']);
    expect(d.ungradedSecrets.new.map((r) => r.file)).toEqual(['.env']);
    expect(d.ungradedSecrets.fixed.map((r) => r.file)).toEqual(['.env']);
    // Same rules: nothing is set aside.
    const graded = diffFindings({ ...base, secretRulesRev: REV }, head);
    expect(graded.ungradedSecrets).toEqual({ new: [], fixed: [] });
  });
});

/* SV-9 — which files get a secret pass and which count as fixtures decide
   what is graded as surely as the rules do. The stamped revision covers them. */
describe('SECRET_GRADING_REV — rules plus analyzer coverage', () => {
  it('extends the scanner rules revision and is pinned', () => {
    expect(SECRET_GRADING_REV).toMatch(/^[0-9a-f]{12}$/);
    expect(SECRET_GRADING_REV).not.toBe(SECRET_RULES_REV);
    /* If this fails, a graded rule, the fingerprint scheme, the secret-pass
       ceiling or the never-text formats changed: update the pin. Reviews
       against an older baseline then list secrets in existing files as not
       graded until the baseline is re-saved. */
    expect(SECRET_GRADING_REV).toBe('43492b81e362');
  });

  it('pins the fixture-path heuristic it does not hash (bump SECRET_COVERAGE_SCHEME when it moves)', () => {
    const probe = [
      'src/config.ts',
      'test/fixtures/keys.json',
      'src/app.test.ts',
      '__tests__/a.ts',
      'pkg/foo_test.go',
      'tests/test_api.py',
      'conftest.py',
      'spec/models/user_spec.rb',
      'fixtures/data.json',
      'e2e/login.spec.ts',
      'testing/helpers.ts',
      '.env.test.local',
      'docker-compose.test.yml',
      'deploy/id_rsa',
    ];
    expect(probe.filter(isTestFixturePath)).toEqual([
      'test/fixtures/keys.json',
      'src/app.test.ts',
      '__tests__/a.ts',
      'pkg/foo_test.go',
      'tests/test_api.py',
      'conftest.py',
      'spec/models/user_spec.rb',
      'fixtures/data.json',
      'e2e/login.spec.ts',
    ]);
  });
});

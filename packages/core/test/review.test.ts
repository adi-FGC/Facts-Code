import { describe, expect, it } from 'vitest';
import { buildChangeVerdict, renderVerdictMarkdown } from '../src/review.js';
import { isExposedSecret } from '../src/diff.js';
import type { AgentArtifact } from '@factstack/spec';

/**
 * Tests for buildChangeVerdict — the Change Verdict composition.
 *
 * Philosophy mirrors diff.test.ts / diagram.test.ts: every assertion fails
 * for a stated reason, the OUTPUT is the contract, and determinism is
 * enforced. `generatedAt` is the only field we never assert (wall clock).
 *
 * Fixtures bypass Zod via `as AgentArtifact`, so each object carries only
 * the fields buildChangeVerdict actually reads: files[] (path/loc/tokenCost),
 * risks[] (category), vulnerabilities[] (id/severity), graph.{edges,cycles}.
 */

type FileLite = { path: string; loc: number; tokenCost: number; todos: unknown[] };
type Graph = AgentArtifact['graph'];
/** Overrides may pass a graph with only the fields read (nodes/edges/cycles). */
type AgentOverrides = Omit<Partial<AgentArtifact>, 'graph'> & {
  graph?: Pick<Graph, 'nodes' | 'edges' | 'cycles'> & Partial<Graph>;
};

function makeAgent({ graph, ...overrides }: AgentOverrides = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-01T00:00:00Z',
    project: {
      name: 'demo',
      root: '.',
      languages: [],
      frameworks: [],
      entryPoints: [],
      monorepo: null,
    },
    files: [],
    graph: { nodes: [], edges: [], cycles: [], ...graph },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    vulnerabilities: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
    ...overrides,
  } as AgentArtifact;
}

function file(path: string, loc = 10, tokenCost = 40): FileLite {
  return { path, loc, tokenCost, todos: [] };
}

/** A plain `import` edge (`from` imports `to`), extracted as every import edge is. */
function edge(from: string, to: string): Graph['edges'][number] {
  return { from, to, kind: 'import', confidence: 'extracted' };
}

/** A base with two files and one import edge (b imports a). */
function base(): AgentArtifact {
  return makeAgent({
    files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
    stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
    graph: { nodes: [], edges: [edge('b.ts', 'a.ts')], cycles: [] },
  });
}

describe('buildChangeVerdict — no-op change', () => {
  it('reports severity "none" and no findings when nothing risk-relevant moved', () => {
    const v = buildChangeVerdict(base(), base());
    expect(v.severity).toBe('none');
    expect(v.findings).toEqual([]);
    expect(v.headline).toContain('No risk');
    expect(v.summary.secretsAdded).toBe(0);
  });
});

describe('buildChangeVerdict — secrets', () => {
  it('flags an added secret as high severity', () => {
    const head = makeAgent({
      files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
      stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
      graph: { nodes: [], edges: [edge('b.ts', 'a.ts')], cycles: [] },
      risks: [{ category: 'secret', severity: 'high' }] as AgentArtifact['risks'],
    });
    const v = buildChangeVerdict(base(), head);
    expect(v.severity).toBe('high');
    const secret = v.findings.find((f) => f.kind === 'secret');
    expect(secret).toBeDefined();
    expect(secret?.severity).toBe('high');
    expect(v.summary.secretsAdded).toBe(1);
    expect(v.headline).toContain('High risk');
  });
});

describe('buildChangeVerdict — vulnerabilities', () => {
  it('inherits the worst severity among newly introduced advisories', () => {
    const head = makeAgent({
      files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
      stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
      graph: { nodes: [], edges: [], cycles: [] },
      vulnerabilities: [
        { id: 'CVE-1', severity: 'medium' },
        { id: 'CVE-2', severity: 'critical' },
      ] as AgentArtifact['vulnerabilities'],
    });
    const v = buildChangeVerdict(base(), head);
    const vuln = v.findings.find((f) => f.kind === 'vulnerability');
    expect(vuln?.severity).toBe('critical'); // worst of medium + critical
    expect(v.summary.vulnsNew).toBe(2);
    expect(vuln?.evidence?.ids).toEqual(['CVE-1', 'CVE-2']);
    expect(v.severity).toBe('critical');
  });
});

/* Owner decision 2026-09-24 — dev and transitive advisories are shown, not
   graded: the verdict lists them but they never set its level (the rule
   health.ts applies to the grade). */
describe('buildChangeVerdict — dev/transitive advisories are listed, not graded', () => {
  const withVulns = (vulnerabilities: unknown[]) =>
    makeAgent({
      files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
      stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
      graph: { nodes: [], edges: [], cycles: [] },
      vulnerabilities: vulnerabilities as AgentArtifact['vulnerabilities'],
    });

  it('does not raise the level for a dev-only critical, but lists it', () => {
    const v = buildChangeVerdict(
      base(),
      withVulns([
        { id: 'GHSA-dev', severity: 'critical', scope: 'dev' },
        { id: 'GHSA-deep', severity: 'high', scope: 'transitive' },
      ]),
    );
    expect(v.severity).toBe('none');
    expect(v.headline).toMatch(/^No risk: /);
    const vulns = v.findings.filter((f) => f.kind === 'vulnerability');
    expect(vulns).toHaveLength(1);
    expect(vulns[0]?.severity).toBe('low');
    expect(vulns[0]?.title).toBe('Lists 2 new dev/transitive advisories (shown, not graded)');
    expect(vulns[0]?.evidence?.ids).toEqual(['GHSA-deep', 'GHSA-dev']);
    // The scoreboard still counts every new advisory.
    expect(v.summary.vulnsNew).toBe(2);
    const md = renderVerdictMarkdown(v);
    expect(md).toContain('FACTS Change Verdict — NONE');
    expect(md).toContain('GHSA-dev');
  });

  it('grades direct (and untagged) advisories, listing ungraded ones last', () => {
    const v = buildChangeVerdict(
      base(),
      withVulns([
        { id: 'GHSA-run', severity: 'medium', scope: 'direct' },
        { id: 'GHSA-old', severity: 'low' }, // pre-lockfile row: direct manifest dep
        { id: 'GHSA-dev', severity: 'critical', scope: 'dev' },
      ]),
    );
    expect(v.severity).toBe('medium');
    const vulns = v.findings.filter((f) => f.kind === 'vulnerability');
    expect(vulns.map((f) => [f.severity, f.evidence?.ids])).toEqual([
      ['medium', ['GHSA-old', 'GHSA-run']],
      ['low', ['GHSA-dev']],
    ]);
    expect(vulns[0]?.title).toBe('Adds 2 new known vulnerabilities');
    expect(v.findings.at(-1)?.title).toContain('shown, not graded');
  });

  it('grades an advisory any direct row carries, at that row severity', () => {
    // One advisory, two manifests: direct runtime in one, dev in the other.
    const v = buildChangeVerdict(
      base(),
      withVulns([
        { id: 'GHSA-x', severity: 'critical', scope: 'dev', manifestPath: 'tools/package.json' },
        { id: 'GHSA-x', severity: 'high', scope: 'direct', manifestPath: 'package.json' },
      ]),
    );
    expect(v.severity).toBe('high');
    const vulns = v.findings.filter((f) => f.kind === 'vulnerability');
    expect(vulns).toHaveLength(1);
    expect(vulns[0]?.evidence?.ids).toEqual(['GHSA-x']);
  });

  /* core-r3-2 — one lockfile refresh can add dozens of dev/transitive
     advisories; the PR comment names 8 and counts the rest. */
  it('caps the ids a finding names at 8, keeping the full count', () => {
    const ids = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}`);
    const v = buildChangeVerdict(
      base(),
      withVulns([
        ...ids('GHSA-dev', 12).map((id) => ({ id, severity: 'high', scope: 'transitive' })),
        ...ids('GHSA-run', 10).map((id) => ({ id, severity: 'medium', scope: 'direct' })),
      ]),
    );
    const [graded, listed] = v.findings.filter((f) => f.kind === 'vulnerability');
    expect(graded?.title).toBe('Adds 10 new known vulnerabilities');
    expect(graded?.evidence).toEqual({ ids: ids('GHSA-run', 8), count: 10 });
    expect(graded?.detail).toContain('GHSA-run-07 … and 2 more.');
    expect(graded?.detail).not.toContain('GHSA-run-08');
    expect(listed?.title).toBe('Lists 12 new dev/transitive advisories (shown, not graded)');
    expect(listed?.evidence).toEqual({ ids: ids('GHSA-dev', 8), count: 12 });
    expect(listed?.detail).toContain('GHSA-dev-07 … and 4 more.');
    expect(renderVerdictMarkdown(v)).not.toContain('GHSA-dev-11');
    // Short lists are named in full, with no "more" suffix.
    const short = buildChangeVerdict(base(), withVulns([{ id: 'GHSA-1', severity: 'low' }]));
    expect(short.findings[0]?.detail).toBe(
      'New advisories matched against dependency manifests: GHSA-1.',
    );
  });

  /* core-r3-5 — the id diff alone missed an advisory that moved from a
     dev/transitive-only dep to a direct runtime one: same id, new grade. */
  it('grades a known advisory promoted from dev/transitive to direct runtime', () => {
    const v = buildChangeVerdict(
      withVulns([{ id: 'GHSA-x', severity: 'high', scope: 'transitive' }]),
      withVulns([
        { id: 'GHSA-x', severity: 'high', scope: 'transitive' },
        { id: 'GHSA-x', severity: 'high', scope: 'direct' },
      ]),
    );
    expect(v.severity).toBe('high');
    expect(v.summary.vulnsNew).toBe(0);
    const vulns = v.findings.filter((f) => f.kind === 'vulnerability');
    expect(vulns).toEqual([
      {
        kind: 'vulnerability',
        severity: 'high',
        title: 'Promotes 1 dev/transitive advisory to a direct runtime dependency',
        detail:
          'Known advisories the base reached only through dev or transitive dependencies now reach a direct runtime dependency, so they are graded: GHSA-x.',
        evidence: { ids: ['GHSA-x'], count: 1 },
      },
    ]);
  });

  /* correctness#8 end to end — an advisory OSV gave no score for (or whose
     detail fetch failed) is not "low": `review --fail-on medium` must trip on
     a new graded one, and the scoreboard's shift must move with it (CG-R2). */
  it.each([
    ['direct', { id: 'GHSA-u', severity: 'unknown', scope: 'direct' }],
    ['unlabelled', { id: 'GHSA-u', severity: 'unknown' }],
  ])('grades a new %s advisory of unknown severity as medium', (_label, row) => {
    const v = buildChangeVerdict(base(), withVulns([row]));
    const vulns = v.findings.filter((f) => f.kind === 'vulnerability');
    expect(vulns.map((f) => [f.title, f.severity])).toEqual([
      ['Adds 1 new known vulnerability', 'medium'],
    ]);
    expect(v.severity).toBe('medium');
    expect(v.summary.severityShift).toBeGreaterThanOrEqual(2);
  });

  it('grades an unknown-severity advisory promoted from dev to direct as medium', () => {
    const v = buildChangeVerdict(
      withVulns([{ id: 'GHSA-u', severity: 'unknown', scope: 'dev' }]),
      withVulns([{ id: 'GHSA-u', severity: 'unknown', scope: 'direct' }]),
    );
    const vulns = v.findings.filter((f) => f.kind === 'vulnerability');
    expect(vulns.map((f) => [f.title, f.severity])).toEqual([
      ['Promotes 1 dev/transitive advisory to a direct runtime dependency', 'medium'],
    ]);
    expect(v.severity).toBe('medium');
  });

  it('does not flag an advisory that stays ungraded, was already graded, or is demoted', () => {
    const cases: Array<[unknown[], unknown[]]> = [
      // Still dev-only.
      [
        [{ id: 'GHSA-x', severity: 'high', scope: 'dev' }],
        [{ id: 'GHSA-x', severity: 'high', scope: 'dev' }],
      ],
      // A legacy unlabelled base row was already graded.
      [[{ id: 'GHSA-x', severity: 'high' }], [{ id: 'GHSA-x', severity: 'high', scope: 'direct' }]],
      // Direct → dev is an improvement, not a finding.
      [
        [{ id: 'GHSA-x', severity: 'high', scope: 'direct' }],
        [{ id: 'GHSA-x', severity: 'high', scope: 'dev' }],
      ],
    ];
    for (const [before, after] of cases) {
      const v = buildChangeVerdict(withVulns(before), withVulns(after));
      expect(v.severity).toBe('none');
      expect(v.findings).toEqual([]);
    }
  });
});

describe('buildChangeVerdict — new cycle', () => {
  it('flags a cycle present in head but not base as medium', () => {
    const head = makeAgent({
      files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
      stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
      graph: {
        nodes: [],
        edges: [edge('b.ts', 'a.ts'), edge('a.ts', 'b.ts')],
        cycles: [['a.ts', 'b.ts']],
      },
    });
    const v = buildChangeVerdict(base(), head);
    const cycle = v.findings.find((f) => f.kind === 'cycle');
    expect(cycle?.severity).toBe('medium');
    expect(v.summary.cyclesNew).toBe(1);
    // A pre-existing cycle (same set, any order) must NOT be flagged as new.
    const stable = buildChangeVerdict(head, head);
    expect(stable.summary.cyclesNew).toBe(0);
  });
});

describe('buildChangeVerdict — blast radius', () => {
  it('computes transitive dependents of a changed file', () => {
    // Chain: c → b → a. Changing a.ts has 2 transitive dependents (b, c).
    const from = makeAgent({
      files: [file('a.ts'), file('b.ts'), file('c.ts')] as AgentArtifact['files'],
      stats: { loc: 30, fileCount: 3, packageCount: 1, totalTokenCost: 120 },
      graph: {
        nodes: [],
        edges: [edge('b.ts', 'a.ts'), edge('c.ts', 'b.ts')],
        cycles: [],
      },
    });
    // Head: a.ts grew (token delta) → it's a "changed" file.
    const head = makeAgent({
      files: [file('a.ts', 15, 60), file('b.ts'), file('c.ts')] as AgentArtifact['files'],
      stats: { loc: 35, fileCount: 3, packageCount: 1, totalTokenCost: 140 },
      graph: from.graph,
    });
    const v = buildChangeVerdict(from, head);
    expect(v.blastRadius.topFile).toBe('a.ts');
    expect(v.blastRadius.maxReach).toBe(2);
    const hotspot = v.findings.find((f) => f.kind === 'hotspot');
    // reach 2 is below HOTSPOT_LOW (5) → no hotspot finding.
    expect(hotspot).toBeUndefined();
  });
});

describe('renderVerdictMarkdown', () => {
  it('renders a PR-comment block with the severity title, findings, and a summary table', () => {
    const head = makeAgent({
      files: [file('a.ts')] as AgentArtifact['files'],
      stats: { loc: 10, fileCount: 1, packageCount: 1, totalTokenCost: 40 },
      risks: [{ category: 'secret', severity: 'high' }] as AgentArtifact['risks'],
    });
    const md = renderVerdictMarkdown(buildChangeVerdict(base(), head));
    expect(md).toContain('### ');
    expect(md).toContain('FACTS Change Verdict — HIGH');
    expect(md).toContain('Introduces 1 new secret');
    expect(md).toContain('| files | secrets |'); // table header
    // The verdict carries counts only — never a raw secret value.
    expect(md).not.toMatch(/sk-[a-zA-Z0-9]/);
  });

  it('renders a clean "no risk" block when nothing moved', () => {
    const md = renderVerdictMarkdown(buildChangeVerdict(base(), base()));
    expect(md).toContain('NONE');
    expect(md).not.toContain('#### Findings');
  });
});

describe('buildChangeVerdict — determinism', () => {
  it('produces identical output (modulo generatedAt) for identical input', () => {
    const head = makeAgent({
      files: [file('a.ts')] as AgentArtifact['files'],
      stats: { loc: 10, fileCount: 1, packageCount: 1, totalTokenCost: 40 },
      risks: [{ category: 'secret', severity: 'high' }] as AgentArtifact['risks'],
    });
    const a = buildChangeVerdict(base(), head);
    const b = buildChangeVerdict(base(), head);
    const strip = (v: typeof a) => ({ ...v, generatedAt: '' });
    expect(strip(a)).toEqual(strip(b));
  });
});

describe('buildChangeVerdict — set-based findings (correctness#6, HUNT-CORE-07)', () => {
  const secret = (file: string, preview: string) =>
    ({
      severity: 'high',
      category: 'secret',
      rule: 'aws-access-key',
      file,
      line: 3,
      message: 'AWS access key detected (entropy 3.9). Rotate and remove from source.',
      preview,
    }) as AgentArtifact['risks'][number];
  const unresolved = (spec: string) =>
    ({
      severity: 'medium',
      category: 'broken-import',
      rule: 'unresolved-import',
      file: 'src/a.ts',
      message: `Unresolved import: "${spec}"`,
    }) as AgentArtifact['risks'][number];
  const cycleRisk = (n: number) =>
    ({
      severity: 'low',
      category: 'cycle',
      rule: 'import-cycle',
      message: `Import cycle across ${n} files: …`,
    }) as AgentArtifact['risks'][number];
  const withState = (risks: AgentArtifact['risks'], cycles: string[][] = []) =>
    makeAgent({
      files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
      stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
      graph: { nodes: [], edges: [], cycles },
      risks,
    });

  it('flags a secret swapped for a different one as a new secret (net count 0)', () => {
    const v = buildChangeVerdict(
      withState([secret('src/config.ts', 'AKIA…QX7Z')]),
      withState([secret('src/other.ts', 'AKIA…M2PL')]),
    );
    expect(v.severity).toBe('high');
    expect(v.summary.secretsAdded).toBe(1);
    const f = v.findings.find((x) => x.kind === 'secret');
    expect(f?.evidence?.files).toEqual(['src/other.ts']);
    // Paths and counts only — never the (redacted) value.
    expect(JSON.stringify(v)).not.toContain('M2PL');
  });

  it('does not flag the same secret that only moved to another line', () => {
    const moved = { ...secret('src/config.ts', 'AKIA…QX7Z'), line: 9 };
    const v = buildChangeVerdict(
      withState([secret('src/config.ts', 'AKIA…QX7Z')]),
      withState([moved]),
    );
    expect(v.summary.secretsAdded).toBe(0);
    expect(v.severity).toBe('none');
  });

  it('flags a swapped risk finding (one fixed, one new) as a new risk', () => {
    const v = buildChangeVerdict(
      withState([unresolved('./old')]),
      withState([unresolved('./new')]),
    );
    const f = v.findings.find((x) => x.kind === 'risk');
    expect(f?.title).toBe('Adds 1 new risk finding');
    expect(f?.detail).toContain('unresolved-import');
  });

  it('does not report an already-flagged large file as new when only its size changed', () => {
    const big = (bytes: number) =>
      ({
        severity: 'low',
        category: 'large-file',
        rule: 'file-size-cap',
        file: 'data/dump.sql',
        message: `File exceeds size cap (${bytes} bytes) — skipped, but still scanned for secrets.`,
      }) as AgentArtifact['risks'][number];
    const v = buildChangeVerdict(withState([big(2_000_000)]), withState([big(2_500_000)]));
    expect(v.findings.some((x) => x.kind === 'risk')).toBe(false);
  });

  it('does not report a shrunk cycle as new, and does not double-count cycle risks', () => {
    const v = buildChangeVerdict(
      withState([cycleRisk(3)], [['a.ts', 'b.ts', 'c.ts']]),
      withState(
        [cycleRisk(2), cycleRisk(2)],
        [
          ['a.ts', 'b.ts'],
          ['r.ts', 's.ts'],
        ],
      ),
    );
    expect(v.summary.cyclesNew).toBe(1);
    const cycles = v.findings.filter((x) => x.kind === 'cycle');
    expect(cycles.map((c) => c.title)).toEqual(['Introduces 1 new dependency cycle']);
    expect(cycles[0]?.evidence?.files).toEqual(['r.ts', 's.ts']);
    // The cycle risks are already the cycle finding — not "new risk findings".
    expect(v.findings.some((x) => x.kind === 'risk')).toBe(false);
  });

  it('reports a grown cycle as growth, not as a new cycle', () => {
    const v = buildChangeVerdict(
      withState([], [['a.ts', 'b.ts']]),
      withState([], [['a.ts', 'b.ts', 'c.ts']]),
    );
    expect(v.summary.cyclesNew).toBe(0);
    expect(v.findings.map((x) => x.title)).toEqual(['Grows 1 existing dependency cycle']);
  });

  it('compares a stats-only snapshot base by counts only: no phantom cycles or CVEs', () => {
    const head = makeAgent({
      files: [file('a.ts')] as AgentArtifact['files'],
      graph: { nodes: [], edges: [], cycles: [['a.ts', 'b.ts']] },
      risks: [secret('src/config.ts', 'AKIA…QX7Z'), cycleRisk(2)],
      vulnerabilities: [{ id: 'CVE-1', severity: 'high' }] as AgentArtifact['vulnerabilities'],
    });
    const rollupBase = makeAgent({
      risks: [0, 1].map(() => ({
        severity: 'info',
        category: 'stale',
        rule: 'snapshot-placeholder',
        message: '',
      })) as AgentArtifact['risks'],
    });
    const v = buildChangeVerdict(
      { artifact: rollupBase, snapshotFile: 'snap.json', overrides: { secrets: 1 } },
      head,
    );
    expect(v.severity).toBe('none');
    expect(v.summary.cyclesNew).toBe(0);
    expect(v.summary.vulnsNew).toBe(0);
    expect(v.summary.secretsAdded).toBe(0);
    expect(v.headline).toContain('stats-only snapshot');
  });

  it('recognises a rollup passed as a bare artifact (files[] empty, fileCount > 0)', () => {
    const head = makeAgent({
      files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
      graph: { nodes: [], edges: [], cycles: [['a.ts', 'b.ts']] },
    });
    const rollupBase = makeAgent({
      stats: { loc: 20, fileCount: 2, packageCount: 0, totalTokenCost: 80 },
    });
    const v = buildChangeVerdict(rollupBase, head);
    expect(v.summary.cyclesNew).toBe(0);
    expect(v.headline).toContain('stats-only snapshot');
    // A genuinely empty base (fileCount 0) is still compared in full.
    expect(buildChangeVerdict(makeAgent(), head).summary.cyclesNew).toBe(1);
  });

  /* core-r3-6 — `review <base> <snapshot>` passes the rollup as the head:
     the headline names the side that is stats-only. */
  it('names which side is the stats-only snapshot', () => {
    const full = makeAgent({ files: [file('a.ts')] as AgentArtifact['files'] });
    const snap = { artifact: makeAgent(), snapshotFile: 'snap.json' };
    const tail = ': cycles, vulnerabilities and individual findings were not compared.';
    expect(buildChangeVerdict(snap, full).headline).toMatch(
      new RegExp(` Baseline is a stats-only snapshot${tail}$`),
    );
    expect(buildChangeVerdict(full, snap).headline).toMatch(
      new RegExp(` Head is a stats-only snapshot${tail}$`),
    );
    expect(buildChangeVerdict(snap, snap).headline).toMatch(
      new RegExp(` Both sides are stats-only snapshots${tail}$`),
    );
    expect(buildChangeVerdict(full, full).headline).not.toContain('stats-only');
  });
});

/* Owner decision 2026-09-24 — a generic "possible secret" (`info`) is
   ungraded: a head that adds one does not "introduce a new secret" (HIGH);
   it is a new risk finding like any other scanner finding. */
describe('buildChangeVerdict — possible secrets are not exposed secrets', () => {
  const possible = {
    severity: 'info',
    category: 'secret',
    rule: 'generic-secret',
    file: 'src/db.ts',
    line: 4,
    message:
      'Possible secret (secret-named field) (entropy 3.9) — not graded; verify whether it is a real credential.',
    preview: '***',
  } as AgentArtifact['risks'][number];
  const withRisks = (risks: AgentArtifact['risks']) =>
    makeAgent({
      files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
      stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
      risks,
    });

  it('reports an added possible secret as a new risk finding, never as a new secret', () => {
    const v = buildChangeVerdict(withRisks([]), withRisks([possible]));
    expect(v.summary.secretsAdded).toBe(0);
    expect(v.findings.some((f) => f.kind === 'secret')).toBe(false);
    const risk = v.findings.find((f) => f.kind === 'risk');
    expect(risk?.title).toBe('Adds 1 new risk finding');
    expect(risk?.detail).toContain('generic-secret');
    expect(v.severity).not.toBe('high');
  });

  it('keeps isExposedSecret to graded detectors only', () => {
    expect(isExposedSecret({ category: 'secret', severity: 'high' })).toBe(true);
    expect(isExposedSecret({ category: 'secret', severity: 'low' })).toBe(false);
    expect(isExposedSecret({ category: 'secret', severity: 'info' })).toBe(false);
    expect(isExposedSecret({ category: 'license', severity: 'high' })).toBe(false);
  });
});

/* correctness#1 + data-model#1 — secrets are matched by a one-way fingerprint
   when both sides carry one; a baseline from an older scanner (no rules
   revision) or from different rules is listed, not graded. */
describe('buildChangeVerdict — secret fingerprints and scanner upgrades', () => {
  const REV = 'abcdef012345';
  type RiskRow = AgentArtifact['risks'][number];
  const key = (fingerprint?: string, line = 3): RiskRow => ({
    severity: 'high',
    category: 'secret',
    rule: 'private-key-header',
    file: 'deploy/id_rsa',
    line,
    message: 'Private key block detected (entropy 3.38). Rotate and remove from source.',
    preview: '----***--',
    ...(fingerprint ? { fingerprint } : {}),
  });
  const token = (rule: string, preview: string, fingerprint?: string): RiskRow => ({
    severity: 'high',
    category: 'secret',
    rule,
    file: '.env',
    line: 2,
    message: 'Token detected (entropy 4.1). Rotate and remove from source.',
    preview,
    ...(fingerprint ? { fingerprint } : {}),
  });
  const FILES = ['a.ts', '.env', 'deploy/id_rsa'];
  const at = (risks: RiskRow[], rev?: string, paths = FILES) =>
    makeAgent({
      files: paths.map((p) => file(p)) as AgentArtifact['files'],
      stats: {
        loc: 10 * paths.length,
        fileCount: paths.length,
        packageCount: 1,
        totalTokenCost: 80,
      },
      risks,
      ...(rev ? { secretRulesRev: rev } : {}),
    });
  const awsKey = (path: string, fingerprint?: string): RiskRow => ({
    ...token('aws-access-key', 'AKIA***Q7', fingerprint),
    file: path,
  });

  it('flags a private key swapped for another in the SAME file as a new secret', () => {
    const v = buildChangeVerdict(at([key('aaaaaaaaaaaa')], REV), at([key('bbbbbbbbbbbb')], REV));
    expect(v.severity).toBe('high');
    expect(v.summary.secretsAdded).toBe(1);
    const f = v.findings.find((x) => x.kind === 'secret');
    expect(f?.title).toBe('Introduces 1 new secret');
    expect(f?.evidence?.files).toEqual(['deploy/id_rsa']);
    expect(v.headline).not.toContain('not graded');
    // Counts and paths only: never a preview or a fingerprint.
    expect(JSON.stringify(v)).not.toContain('bbbbbbbbbbbb');
  });

  it('does not flag the same key that only moved lines', () => {
    const v = buildChangeVerdict(
      at([key('aaaaaaaaaaaa', 3)], REV),
      at([key('aaaaaaaaaaaa', 40)], REV),
    );
    expect(v.severity).toBe('none');
    expect(v.summary.secretsAdded).toBe(0);
    expect(v.findings).toEqual([]);
  });

  it('lists but does not grade secrets against a baseline from an older scanner', () => {
    /* The old scanner showed this token as 4 + 2 and had no npm rule; the new
       one masks it whole and finds the npm token that was already there. */
    const oldBase = at([token('slack-token', 'xoxb***9a')]);
    const head = at(
      [
        token('slack-token', '***', 'aaaaaaaaaaaa'),
        token('npm-token', 'npm_***Qz', 'cccccccccccc'),
      ],
      REV,
    );
    const v = buildChangeVerdict(oldBase, head);
    expect(v.severity).toBe('none');
    expect(v.headline).toMatch(/^No risk: /);
    expect(v.headline).toContain(
      'Secrets in files the baseline already had were not graded: the baseline was made by an older secret scanner',
    );
    expect(v.headline).toContain('Re-save the baseline');
    const f = v.findings.find((x) => x.kind === 'secret');
    expect(f?.severity).toBe('low');
    expect(f?.title).toBe('Lists 2 secrets not matched in the baseline (not graded)');
    expect(f?.evidence).toEqual({ count: 2, files: ['.env'] });
    expect(v.summary.secretsAdded).toBe(2);
    expect(renderVerdictMarkdown(v)).toContain('were not graded');
  });

  it('does not grade secrets when the rules revision changed between base and head', () => {
    const v = buildChangeVerdict(
      at([key('aaaaaaaaaaaa')], REV),
      at([key('bbbbbbbbbbbb')], '0123456789ab'),
    );
    expect(v.severity).toBe('none');
    expect(v.headline).toContain(
      'Secrets in files the baseline already had were not graded: the secret rules changed between the baseline and the head',
    );
    // The old comparison (rule + file + preview) sees the same key: nothing listed.
    expect(v.findings.some((x) => x.kind === 'secret')).toBe(false);
  });

  /* SV-2 — while grading was off (every upgrade, every graded-rule change), a
     brand-new key in a brand-new file scored 'none' and passed
     `review --fail-on high`. A file the base did not have is new under any
     rules, so its secrets stay graded. */
  describe('secrets in files the base did not have stay graded', () => {
    const withNewFile = [...FILES, 'src/config.ts'];
    it('against a legacy base with no secrets', () => {
      const v = buildChangeVerdict(
        at([]),
        at([awsKey('src/config.ts', 'cccccccccccc')], REV, withNewFile),
      );
      expect(v.severity).toBe('high');
      expect(v.headline).toMatch(/^High risk: introduces 1 new secret/);
      const f = v.findings.find((x) => x.kind === 'secret');
      expect(f?.severity).toBe('high');
      expect(f?.detail).toContain('in files the base did not have (src/config.ts)');
      expect(v.summary.secretsAdded).toBe(1);
      // Every secret on either side was graded: no "not graded" note.
      expect(v.headline).not.toContain('not graded');
    });

    it('against a legacy base that already had a key elsewhere', () => {
      const v = buildChangeVerdict(
        at([token('slack-token', 'xoxb***9a')]),
        at(
          [token('slack-token', '***', 'aaaaaaaaaaaa'), awsKey('src/config.ts', 'cccccccccccc')],
          REV,
          withNewFile,
        ),
      );
      expect(v.severity).toBe('high');
      const [graded, listed] = v.findings.filter((x) => x.kind === 'secret');
      expect(graded?.evidence).toEqual({ count: 1, files: ['src/config.ts'] });
      // The re-masked .env key is only listed, after the graded one.
      expect(listed?.severity).toBe('low');
      expect(listed?.evidence).toEqual({ count: 1, files: ['.env'] });
      expect(v.summary.secretsAdded).toBe(2);
      expect(v.headline).toContain('Secrets in files the baseline already had were not graded');
    });

    it('when both sides carry a rules revision and they differ', () => {
      const v = buildChangeVerdict(
        at([key('aaaaaaaaaaaa')], REV),
        at(
          [key('bbbbbbbbbbbb'), awsKey('src/config.ts', 'cccccccccccc')],
          '0123456789ab',
          withNewFile,
        ),
      );
      expect(v.severity).toBe('high');
      expect(v.summary.secretsAdded).toBe(1);
    });
  });

  /* SV-7 — the identity included the file, so renaming a key file read as a
     new HIGH secret although the fingerprint proves it is the same key. */
  it('does not flag a key file that was only renamed', () => {
    const renamed = { ...key('aaaaaaaaaaaa'), file: 'ops/id_rsa' };
    const v = buildChangeVerdict(
      at([key('aaaaaaaaaaaa')], REV),
      at([renamed], REV, ['a.ts', '.env', 'ops/id_rsa']),
    );
    expect(v.summary.secretsAdded).toBe(0);
    expect(v.findings.some((x) => x.kind === 'secret')).toBe(false);
    expect(v.severity).toBe('none');
    // A different key under the new name is still new.
    const swapped = { ...key('bbbbbbbbbbbb'), file: 'ops/id_rsa' };
    expect(
      buildChangeVerdict(
        at([key('aaaaaaaaaaaa')], REV),
        at([swapped], REV, ['a.ts', '.env', 'ops/id_rsa']),
      ).severity,
    ).toBe('high');
  });

  it('adds no note when neither side has an exposed secret', () => {
    const v = buildChangeVerdict(at([]), at([], REV));
    expect(v.headline).not.toContain('not graded');
    expect(v.severity).toBe('none');
  });

  it('keeps grading a stats-only snapshot base by counts (a rollup records no revision)', () => {
    const snap = { artifact: makeAgent(), snapshotFile: 'snap.json', overrides: { secrets: 0 } };
    const v = buildChangeVerdict(snap, at([key('aaaaaaaaaaaa')], REV));
    expect(v.severity).toBe('high');
    expect(v.headline).not.toContain('not graded');
  });
});

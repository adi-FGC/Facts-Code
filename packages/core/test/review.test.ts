import { describe, expect, it } from 'vitest';
import { buildChangeVerdict, renderVerdictMarkdown } from '../src/review.js';
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

function makeAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-01T00:00:00Z',
    project: { name: 'demo', root: '.', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [],
    graph: { nodes: [], edges: [], cycles: [] },
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

/** A base with two files and one import edge (b imports a). */
function base(): AgentArtifact {
  return makeAgent({
    files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
    stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
    graph: { nodes: [], edges: [{ from: 'b.ts', to: 'a.ts', kind: 'import' }], cycles: [] },
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
      graph: { nodes: [], edges: [{ from: 'b.ts', to: 'a.ts', kind: 'import' }], cycles: [] },
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

describe('buildChangeVerdict — new cycle', () => {
  it('flags a cycle present in head but not base as medium', () => {
    const head = makeAgent({
      files: [file('a.ts'), file('b.ts')] as AgentArtifact['files'],
      stats: { loc: 20, fileCount: 2, packageCount: 1, totalTokenCost: 80 },
      graph: {
        nodes: [],
        edges: [
          { from: 'b.ts', to: 'a.ts', kind: 'import' },
          { from: 'a.ts', to: 'b.ts', kind: 'import' },
        ],
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
        edges: [
          { from: 'b.ts', to: 'a.ts', kind: 'import' },
          { from: 'c.ts', to: 'b.ts', kind: 'import' },
        ],
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

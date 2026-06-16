import { describe, expect, it } from 'vitest';
import { computeHealth } from '../src/health.js';
import type { AgentArtifact } from '@factstack/spec';

/**
 * Tests for `computeHealth(agent)` — the v0.3 composite project-health
 * grade that replaced the plain "<N> TODOs." headline.
 *
 * Test philosophy:
 *   - Penalties are pinned to exact numbers so a weight change is caught,
 *     not silently absorbed. Every grade boundary (90/80/70/60) is tested
 *     from both sides.
 *   - Purity (INV1/INV2): the function reads only fields already on the
 *     artifact. `stale` derives from `file.status`, never `Date.now()` —
 *     so two calls on the same input are byte-identical.
 *   - The prose headline must agree with the structured counts (the
 *     RallyPro "fabricated secret" regression) and read grammatically
 *     ("1 secret exposed", not "1 secrets exposed").
 */

// ── Fixture builders — only the fields computeHealth reads ─────────────

function agentWith(parts: {
  risks?: unknown[];
  files?: unknown[];
  vulnerabilities?: unknown[];
  cycles?: unknown[];
}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-06-01T00:00:00Z',
    project: { name: 'demo', root: '/demo', languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: parts.files ?? [],
    graph: { nodes: [], edges: [], cycles: parts.cycles ?? [] },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: parts.risks ?? [],
    vulnerabilities: parts.vulnerabilities ?? [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  } as unknown as AgentArtifact;
}

const risk = (category: string, opts: Record<string, unknown> = {}) => ({
  severity: 'medium',
  category,
  rule: category,
  message: 'm',
  ...opts,
});
const secretRisk = (file: string) => risk('secret', { severity: 'high', file, rule: 'hardcoded-secret' });
const brokenRisk = (file: string) => risk('broken-import', { file });
const oversizedRisk = (file: string) => risk('large-file', { file });

const staleFile = () => ({ status: 'stale', todos: [] });
const okFile = (todoCount = 0) => ({
  status: 'ok',
  todos: Array.from({ length: todoCount }, (_, i) => ({ kind: 'TODO', line: i + 1, text: 'x' })),
});
const vuln = (severity: string) => ({
  id: 'CVE-2024-0001',
  severity,
  ecosystem: 'npm',
  package: 'p',
  installedVersion: '1.0.0',
  fixedVersion: null,
  advisoryUrl: 'https://osv.dev/x',
  lastChecked: 1,
  manifestPath: 'package.json',
});

const make = (n: number, f: () => unknown) => Array.from({ length: n }, f);
const cyclesOf = (n: number) => make(n, () => ['a', 'b']);

// ── Tests ─────────────────────────────────────────────────────────────

describe('computeHealth — pristine project', () => {
  it('scores 100 / grade A with no factors and a clean headline', () => {
    const h = computeHealth(agentWith({}));
    expect(h.score).toBe(100);
    expect(h.grade).toBe('A');
    expect(h.factors).toEqual([]);
    expect(h.headline).toBe('A · 100 — clean — no blockers detected');
    expect(h.broken).toBe(0);
    expect(h.stale).toBe(0);
    expect(h.todos).toBe(0);
    expect(h.secrets).toBe(0);
  });
});

describe('computeHealth — grade boundaries', () => {
  // Each row composes penalties to land on an exact score. Building blocks
  // (before caps): secret −25 · cycle −3 · stale −1 · oversized −2 ·
  // ⌊todos/50⌋ −1.
  const cases: Array<{
    name: string;
    secrets?: number;
    cycles?: number;
    stale?: number;
    todos?: number;
    score: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
  }> = [
    { name: 'A floor', stale: 10, score: 90, grade: 'A' },
    { name: 'B ceiling', stale: 10, todos: 50, score: 89, grade: 'B' },
    { name: 'B floor', cycles: 6, stale: 2, score: 80, grade: 'B' },
    { name: 'C ceiling', cycles: 6, stale: 3, score: 79, grade: 'C' },
    { name: 'C floor', secrets: 1, stale: 5, score: 70, grade: 'C' },
    { name: 'D ceiling', secrets: 1, stale: 6, score: 69, grade: 'D' },
    { name: 'D floor', secrets: 1, cycles: 5, score: 60, grade: 'D' },
    { name: 'F', secrets: 1, cycles: 5, stale: 1, score: 59, grade: 'F' },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.score} / ${c.grade}`, () => {
      const risks = make(c.secrets ?? 0, () => 0).map((_, i) => secretRisk(`s${i}.ts`));
      const files = [
        ...make(c.stale ?? 0, staleFile),
        ...(c.todos ? [okFile(c.todos)] : []),
      ];
      const h = computeHealth(agentWith({ risks, files, cycles: cyclesOf(c.cycles ?? 0) }));
      expect(h.score).toBe(c.score);
      expect(h.grade).toBe(c.grade);
    });
  }
});

describe('computeHealth — per-category caps', () => {
  it('secrets cap at −60 (3 × 25 = 75 raw)', () => {
    const risks = make(3, () => 0).map((_, i) => secretRisk(`s${i}.ts`));
    expect(computeHealth(agentWith({ risks })).score).toBe(40);
  });
  it('vulnerabilities cap at −50 (10 critical = 200 raw)', () => {
    expect(computeHealth(agentWith({ vulnerabilities: make(10, () => vuln('critical')) })).score).toBe(50);
  });
  it('broken imports cap at −32 (5 files × 8 = 40 raw)', () => {
    const risks = make(5, () => 0).map((_, i) => brokenRisk(`b${i}.ts`));
    expect(computeHealth(agentWith({ risks })).score).toBe(68);
  });
  it('import cycles cap at −18 (10 × 3 = 30 raw)', () => {
    expect(computeHealth(agentWith({ cycles: cyclesOf(10) })).score).toBe(82);
  });
  it('oversized cap at −10, stale cap at −10, TODOs cap at −6', () => {
    expect(computeHealth(agentWith({ risks: make(10, () => 0).map((_, i) => oversizedRisk(`o${i}.ts`)) })).score).toBe(90);
    expect(computeHealth(agentWith({ files: make(20, staleFile) })).score).toBe(90);
    expect(computeHealth(agentWith({ files: [okFile(500)] })).score).toBe(94);
  });
});

describe('computeHealth — broken-import counting', () => {
  it('counts DISTINCT files, not risk occurrences', () => {
    const risks = [brokenRisk('a.ts'), brokenRisk('a.ts'), brokenRisk('b.ts')];
    expect(computeHealth(agentWith({ risks })).broken).toBe(2);
  });
  it('excludes the unscanned-import rule (the file still builds)', () => {
    const risks = [risk('broken-import', { file: 'a.ts', rule: 'unscanned-import' })];
    const h = computeHealth(agentWith({ risks }));
    expect(h.broken).toBe(0);
    expect(h.score).toBe(100);
  });
  it('parse-error and read-error categories count as broken', () => {
    const risks = [risk('parse-error', { file: 'a.ts' }), risk('read-error', { file: 'b.ts' })];
    expect(computeHealth(agentWith({ risks })).broken).toBe(2);
  });
});

describe('computeHealth — vulnerability severity weighting', () => {
  const weights: Array<[string, number]> = [
    ['critical', 80],
    ['high', 88],
    ['medium', 95],
    ['low', 98],
    ['unknown', 98],
  ];
  for (const [sev, score] of weights) {
    it(`one ${sev} vuln → ${score}`, () => {
      expect(computeHealth(agentWith({ vulnerabilities: [vuln(sev)] })).score).toBe(score);
    });
  }
});

describe('computeHealth — factor ledger', () => {
  it('keeps the top 3 by penalty desc, drops zero-penalty factors', () => {
    const risks = [secretRisk('s.ts'), brokenRisk('b.ts')];
    const h = computeHealth(
      agentWith({ risks, files: [...make(1, staleFile), okFile(50)], cycles: cyclesOf(6) }),
    );
    // penalties: secrets 25, cycles 18, broken 8, stale 1, todos 1 → top 3
    expect(h.factors!.map((f) => f.label)).toEqual(['secrets exposed', 'import cycles', 'broken imports']);
    expect(h.factors!.map((f) => f.penalty)).toEqual([25, 18, 8]);
  });

  it('breaks penalty ties by label ascending (deterministic)', () => {
    // broken 1 file (8) and oversized 4 (8) tie; 'broken imports' < 'oversized files'.
    const risks = [brokenRisk('b.ts'), ...make(4, () => 0).map((_, i) => oversizedRisk(`o${i}.ts`)), ...make(1, staleFile).map(() => secretRisk('x'))];
    const h = computeHealth(agentWith({ risks, files: [staleFile()] }));
    const tied = h.factors!.filter((f) => f.penalty === 8).map((f) => f.label);
    expect(tied).toEqual(['broken imports', 'oversized files']);
  });
});

describe('computeHealth — headline prose', () => {
  it('uses singular grammar at count 1 ("1 secret exposed")', () => {
    const h = computeHealth(agentWith({ risks: [secretRisk('s.ts')] }));
    expect(h.secrets).toBe(1);
    expect(h.headline).toBe('C · 75 — 1 secret exposed');
    expect(h.headline).not.toMatch(/1 secrets/);
  });
  it('uses plural at count > 1 and joins factors with commas', () => {
    const risks = [secretRisk('a.ts'), secretRisk('b.ts')];
    const h = computeHealth(agentWith({ risks, cycles: cyclesOf(2) }));
    // 2 secrets = −50, 2 cycles = −6 → 44 → F. The headline shows factor
    // COUNTS (2 secrets, 2 cycles), not penalties.
    expect(h.headline).toBe('F · 44 — 2 secrets exposed, 2 import cycles');
  });
  it('never fabricates a secret from a non-secret risk (RallyPro regression)', () => {
    const h = computeHealth(agentWith({ risks: [risk('license', { rule: 'missing-license' })] }));
    expect(h.secrets).toBe(0);
    expect(h.headline).not.toMatch(/secret/i);
    expect(h.score).toBe(100); // license is not a health penalty
  });
});

describe('computeHealth — purity & determinism (INV1/INV2)', () => {
  it('derives stale from file.status, not the clock', () => {
    const fresh = computeHealth(agentWith({ files: [okFile(), okFile()] }));
    expect(fresh.stale).toBe(0);
    const stale = computeHealth(agentWith({ files: [staleFile(), okFile()] }));
    expect(stale.stale).toBe(1);
  });
  it('is a pure function — identical input yields byte-identical output', () => {
    const build = () => agentWith({ risks: [secretRisk('s.ts'), brokenRisk('b.ts')], files: [staleFile(), okFile(120)], cycles: cyclesOf(4) });
    expect(JSON.stringify(computeHealth(build()))).toBe(JSON.stringify(computeHealth(build())));
  });
  it('tolerates an agent with no vulnerabilities field (pre-v0.6 artifact)', () => {
    const bare = agentWith({});
    delete (bare as { vulnerabilities?: unknown }).vulnerabilities;
    expect(() => computeHealth(bare)).not.toThrow();
    expect(computeHealth(bare).score).toBe(100);
  });
});

/**
 * Tests for `agentToSkillSpec` — the pure artifact-to-SkillSpec
 * extractor. Mirrors the patterns from `packages/core/test/memory.test.ts`.
 *
 * What we test:
 *   - Field-by-field extraction (name, intent, languages%, frameworks,
 *     stats, capabilities, entryPoints, keyFiles, routes, openRisks,
 *     vulnerabilityCount).
 *   - Cap enforcement (every capped field must respect CAPS).
 *   - Determinism: same input → byte-identical SkillSpec (asserts via
 *     two consecutive calls + JSON-stringify equality).
 *   - Empty-fixture path produces a valid sparse spec.
 *   - High-/critical-only filter on openRisks.
 *   - Intent fallback: empty `intent` falls back to `oneLiner`.
 */

import { describe, expect, it } from 'vitest';
import { agentToSkillSpec } from '../src/extract.js';
import { CAPS, ONBOARDING_SEQUENCE } from '../src/types.js';
import { makeAgent, makeHuman } from './helpers/fixtures.js';

describe('agentToSkillSpec — identity fields', () => {
  it('carries name + factsVersion + generatedAt straight through', () => {
    const agent = makeAgent({
      project: { ...makeAgent().project, name: 'my-app' },
      factsVersion: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.name).toBe('my-app');
    expect(spec.factsVersion).toBe('0.1.0');
    expect(spec.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('prefers human.summary.intent over oneLiner when intent is non-empty', () => {
    const human = makeHuman({
      summary: {
        oneLiner: 'fallback',
        intent: 'preferred sentence',
        capabilities: [],
        entryPoints: [],
        health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'ok' },
      },
    });
    expect(agentToSkillSpec(makeAgent(), human).intent).toBe('preferred sentence');
  });

  it('falls back to oneLiner when intent is empty string', () => {
    /* Defensive: pre-v0.3.10 artifacts set intent: '' as a placeholder
       rather than omitting the field. We treat '' as "fall back" so
       those old artifacts render usefully. */
    const human = makeHuman({
      summary: {
        oneLiner: 'should be used',
        intent: '',
        capabilities: [],
        entryPoints: [],
        health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'ok' },
      },
    });
    expect(agentToSkillSpec(makeAgent(), human).intent).toBe('should be used');
  });
});

describe('agentToSkillSpec — stack fields', () => {
  it('caps frameworks at CAPS.frameworks', () => {
    const agent = makeAgent({
      project: {
        ...makeAgent().project,
        frameworks: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'],
      },
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.frameworks.length).toBe(CAPS.frameworks);
    expect(spec.frameworks).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('drops empty/falsy frameworks before capping', () => {
    const agent = makeAgent({
      project: {
        ...makeAgent().project,
        frameworks: ['react', '', 'vue', '', 'svelte'] as unknown as string[],
      },
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.frameworks).toEqual(['react', 'vue', 'svelte']);
  });

  it('computes top-3 languages by LOC with integer percentages', () => {
    const agent = makeAgent({
      files: [
        fakeFile('a.ts', 'typescript', 80),
        fakeFile('b.ts', 'typescript', 20),
        fakeFile('c.py', 'python', 50),
        fakeFile('d.json', 'json', 10),
        fakeFile('e.yaml', 'yaml', 5),
      ],
      stats: { loc: 165, fileCount: 5, packageCount: 1, totalTokenCost: 0 },
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.languages.length).toBe(3);
    expect(spec.languages[0]).toEqual({ id: 'typescript', pct: 61 }); // 100/165 ≈ 61%
    expect(spec.languages[1]).toEqual({ id: 'python', pct: 30 });     // 50/165 ≈ 30%
    expect(spec.languages[2]).toEqual({ id: 'json', pct: 6 });        // 10/165 ≈ 6%
  });

  it('returns empty languages array when no source files', () => {
    const spec = agentToSkillSpec(makeAgent(), makeHuman());
    expect(spec.languages).toEqual([]);
  });

  it('carries stats through unchanged', () => {
    const agent = makeAgent({ stats: { loc: 100, fileCount: 5, packageCount: 2, totalTokenCost: 12345 } });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.stats).toEqual({ files: 5, loc: 100, tokens: 12345 });
  });
});

describe('agentToSkillSpec — map fields', () => {
  it('caps capabilities at CAPS.capabilities', () => {
    const agent = makeAgent({ capabilities: Array.from({ length: 10 }, (_, i) => `cap-${i}`) });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.capabilities.length).toBe(CAPS.capabilities);
  });

  it('caps entryPoints at CAPS.entryPoints and drops empty', () => {
    const agent = makeAgent({
      project: {
        ...makeAgent().project,
        entryPoints: ['npm run dev', '', 'npm test', 'npm build', 'a', 'b', 'c', 'd', 'e', 'f'],
      },
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.entryPoints.length).toBe(CAPS.entryPoints);
    expect(spec.entryPoints).not.toContain('');
  });

  it('derives keyFiles from graph in-degree, capped + sorted desc', () => {
    /* 4 edges total: a→x (1), b→x (1), c→x (1), d→y (1).
       x has in-degree 3, y has in-degree 1. */
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          { from: 'a', to: 'x', kind: 'import' },
          { from: 'b', to: 'x', kind: 'import' },
          { from: 'c', to: 'x', kind: 'import' },
          { from: 'd', to: 'y', kind: 'import' },
        ],
        cycles: [],
      },
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.keyFiles.length).toBe(2);
    expect(spec.keyFiles[0]).toEqual({ path: 'x', inDegree: 3 });
    expect(spec.keyFiles[1]).toEqual({ path: 'y', inDegree: 1 });
  });

  it('caps routes at CAPS.routes total', () => {
    const agent = makeAgent({
      routes: Array.from({ length: 30 }, (_, i) => ({
        framework: 'express',
        method: 'GET',
        path: `/r/${i}`,
        handlerFile: 'a.ts',
        handlerSymbol: null,
      })),
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.routes.length).toBe(CAPS.routes);
  });
});

describe('agentToSkillSpec — risk surface', () => {
  it('only includes high + critical risks', () => {
    const agent = makeAgent({
      risks: [
        { severity: 'low' as const,      category: 'todo',   rule: 'r-low',  message: 'low' },
        { severity: 'medium' as const,   category: 'todo',   rule: 'r-med',  message: 'med' },
        { severity: 'high' as const,     category: 'secret', rule: 'r-high', message: 'hi'  },
        { severity: 'critical' as const, category: 'secret', rule: 'r-crit', message: 'cr'  },
      ],
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.openRisks.length).toBe(2);
    expect(spec.openRisks.every((r) => r.severity === 'high' || r.severity === 'critical')).toBe(true);
  });

  it('caps openRisks at CAPS.risks', () => {
    const agent = makeAgent({
      risks: Array.from({ length: 20 }, (_, i) => ({
        severity: 'high' as const,
        category: 'secret',
        rule: 'r',
        message: `m-${i}`,
      })),
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.openRisks.length).toBe(CAPS.risks);
  });

  it('surfaces vulnerabilityCount from agent.vulnerabilities.length', () => {
    const agent = makeAgent({
      vulnerabilities: [
        { id: 'CVE-1', severity: 'high',     ecosystem: 'npm', package: 'a', installedVersion: '1', fixedVersion: '2', advisoryUrl: 'u', lastChecked: 1, manifestPath: 'p' },
        { id: 'CVE-2', severity: 'critical', ecosystem: 'npm', package: 'b', installedVersion: '1', fixedVersion: '2', advisoryUrl: 'u', lastChecked: 1, manifestPath: 'p' },
      ],
    });
    expect(agentToSkillSpec(agent, makeHuman()).vulnerabilityCount).toBe(2);
  });
});

describe('agentToSkillSpec — onboarding + determinism', () => {
  it('ships ONBOARDING_SEQUENCE unchanged', () => {
    const spec = agentToSkillSpec(makeAgent(), makeHuman());
    expect(spec.onboardingSequence).toEqual([...ONBOARDING_SEQUENCE]);
  });

  it('produces deterministic output across two calls', () => {
    const a = makeAgent({
      project: { ...makeAgent().project, frameworks: ['x', 'y'], entryPoints: ['npm dev'] },
      capabilities: ['Cap A', 'Cap B'],
    });
    const h = makeHuman();
    const s1 = agentToSkillSpec(a, h);
    const s2 = agentToSkillSpec(a, h);
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });
});

describe('agentToSkillSpec — sort, tiebreak + edge cases (gap coverage)', () => {
  it('breaks equal in-degree ties alphabetically (determinism guard)', () => {
    /* The existing keyFiles test uses distinct in-degrees, so it never
       exercises the `|| a[0].localeCompare(b[0])` tiebreak — the line
       that keeps .cursorrules / AGENTS.md byte-identical across runs. */
    const agent = makeAgent({
      graph: {
        nodes: [],
        edges: [
          { from: 's1', to: 'zebra.ts', kind: 'import' },
          { from: 's2', to: 'zebra.ts', kind: 'import' },
          { from: 's3', to: 'apple.ts', kind: 'import' },
          { from: 's4', to: 'apple.ts', kind: 'import' },
          { from: 's5', to: 'mango.ts', kind: 'import' },
          { from: 's6', to: 'mango.ts', kind: 'import' },
        ],
        cycles: [],
      },
    });
    // All three share in-degree 2 → ascending path order, not insertion order.
    expect(agentToSkillSpec(agent, makeHuman()).keyFiles.map((k) => k.path)).toEqual([
      'apple.ts',
      'mango.ts',
      'zebra.ts',
    ]);
  });

  it('caps keyFiles at CAPS.keyFiles, keeping the highest in-degree', () => {
    /* The existing keyFiles test only has 2 hubs (< cap), so the
       `.slice(0, limit)` on keyFiles is never verified. */
    const edges: { from: string; to: string; kind: 'import' }[] = [];
    // hub{i} gets in-degree i+1; build CAPS.keyFiles + 2 hubs so the cap bites.
    for (let i = 0; i <= CAPS.keyFiles + 1; i++) {
      for (let j = 0; j <= i; j++) edges.push({ from: `s${i}_${j}`, to: `hub${i}.ts`, kind: 'import' });
    }
    const spec = agentToSkillSpec(makeAgent({ graph: { nodes: [], edges, cycles: [] } }), makeHuman());
    expect(spec.keyFiles).toHaveLength(CAPS.keyFiles);
    expect(spec.keyFiles[0]).toEqual({ path: `hub${CAPS.keyFiles + 1}.ts`, inDegree: CAPS.keyFiles + 2 });
  });

  it('sorts routes by framework then path (not insertion order)', () => {
    /* The existing routes test checks only the cap count, never the sort. */
    const agent = makeAgent({
      routes: [
        { framework: 'express', method: 'GET', path: '/z', handlerFile: 'h', handlerSymbol: null },
        { framework: 'express', method: 'GET', path: '/a', handlerFile: 'h', handlerSymbol: null },
        { framework: 'astro', method: 'GET', path: '/m', handlerFile: 'h', handlerSymbol: null },
      ],
    });
    expect(agentToSkillSpec(agent, makeHuman()).routes.map((r) => `${r.framework} ${r.path}`)).toEqual([
      'astro /m',
      'express /a',
      'express /z',
    ]);
  });

  it('defaults a route method to GET when absent', () => {
    const agent = makeAgent({
      routes: [
        { framework: 'express', method: undefined as unknown as string, path: '/x', handlerFile: 'h', handlerSymbol: null },
      ],
    });
    expect(agentToSkillSpec(agent, makeHuman()).routes[0]!.method).toBe('GET');
  });

  it('includes a risk file only when the finding has one', () => {
    const agent = makeAgent({
      risks: [
        { severity: 'high' as const, category: 'secret', rule: 'r1', message: 'has file', file: 'a.ts' },
        { severity: 'high' as const, category: 'cycle', rule: 'r2', message: 'no file' },
      ],
    });
    const spec = agentToSkillSpec(agent, makeHuman());
    expect(spec.openRisks[0]).toMatchObject({ file: 'a.ts' });
    expect(spec.openRisks[1]).not.toHaveProperty('file');
  });

  it('returns empty intent when both intent and oneLiner are empty', () => {
    const human = makeHuman({
      summary: { oneLiner: '', intent: '', capabilities: [], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'ok' } },
    });
    expect(agentToSkillSpec(makeAgent(), human).intent).toBe('');
  });

  it('returns no languages when files exist but total LOC is zero', () => {
    /* Distinct from the "no source files" case: files are present, but
       the totalLoc === 0 guard still short-circuits to []. */
    const spec = agentToSkillSpec(makeAgent({ files: [fakeFile('empty.ts', 'typescript', 0)] }), makeHuman());
    expect(spec.languages).toEqual([]);
  });
});

/* Helper — build a minimal file outline for the topLanguages test. */
function fakeFile(path: string, language: string, loc: number) {
  return {
    path,
    language,
    loc,
    bytes: loc * 30,
    bundleSize: null,
    tokenCost: 0,
    imports: [],
    exports: [],
    declarations: [],
    todos: [],
    complexity: { cyclomatic: 0, cognitive: 0 },
    status: 'ok' as const,
    lastModifiedMs: null,
    churnScore: null,
  };
}

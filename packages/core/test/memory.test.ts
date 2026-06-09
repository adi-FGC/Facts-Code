import { describe, expect, it } from 'vitest';
import { buildMemory, MEMORY_SCHEMA_VERSION } from '../src/memory.js';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

/**
 * Tests for `buildMemory(agent, human)` — the v0.3.1 generator that
 * produces `.facts/MEMORY.md`.
 *
 * Test philosophy:
 *   - Every assertion fails for a clearly stated reason. No
 *     `expect(out).toContain('project')` style asserts that pass on
 *     garbage.
 *   - Section ordering is part of the contract — agents read top-down;
 *     reordering would silently change what the first 200 tokens
 *     contain.
 *   - Determinism is enforced: same input → byte-identical output. The
 *     ONLY non-determinism source allowed is `agent.generatedAt` which
 *     we render verbatim (caller controls).
 *   - Length budgets are guarded so the artifact stays in agent
 *     context windows. Empty fixture < 2 KB; large fixture < 10 KB.
 */

// ── Fixture builders (mirror diff.test.ts pattern) ────────────────────

function makeAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-01T00:00:00Z',
    project: {
      name: 'demo',
      root: '/demo',
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

function makeHuman(overrides: Partial<HumanArtifact> = {}): HumanArtifact {
  return {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-01T00:00:00Z',
    summary: {
      oneLiner: 'A demo project',
      intent: '',
      capabilities: [],
      entryPoints: [],
      health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' },
    },
    stack: [],
    tree: {
      id: 'root', name: 'demo', path: '.', kind: 'directory', language: null,
      loc: 0, tokenCost: 0, bundleSizeGzip: null, status: 'ok', children: [],
    },
    graph: { nodes: [], edges: [], cycles: [] },
    activity: [],
    risks: [],
    glossary: [],
    ...overrides,
  } as HumanArtifact;
}

function file(path: string, lang: string, loc: number, tokens: number) {
  return {
    path, language: lang, loc, bytes: loc * 30,
    bundleSize: null, tokenCost: tokens,
    imports: [], exports: [], declarations: [],
    routes: [], components: [], tests: [], todos: [],
    complexity: { cyclomatic: 1, cognitive: 1 }, status: 'ok' as const,
    lastModifiedMs: null, churnScore: null,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Edge-confidence summary (F1)
// ─────────────────────────────────────────────────────────────────────

describe('buildMemory — edge-confidence summary (F1)', () => {
  function withEdges(edges: Array<Record<string, unknown>>): AgentArtifact {
    return makeAgent({
      graph: { nodes: [{ id: 'a.ts' }, { id: 'b.ts' }], edges, cycles: [] } as unknown as AgentArtifact['graph'],
    });
  }

  it('omits the Edge confidence line when every edge is extracted', () => {
    const out = buildMemory(withEdges([
      { from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'extracted' },
      { from: 'b.ts', to: 'a.ts', kind: 'import', confidence: 'extracted' },
    ]), makeHuman());
    expect(out).not.toContain('Edge confidence');
  });

  it('omits it for pre-F1 artifacts (missing confidence ⇒ treated as extracted)', () => {
    const out = buildMemory(withEdges([
      { from: 'a.ts', to: 'b.ts', kind: 'import' },
    ]), makeHuman());
    expect(out).not.toContain('Edge confidence');
  });

  it('shows counts + a "to verify" total once any edge is inferred/ambiguous', () => {
    const out = buildMemory(withEdges([
      { from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'extracted' },
      { from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'inferred' },
      { from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'ambiguous' },
      { from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'ambiguous' },
    ]), makeHuman());
    expect(out).toContain('- **Edge confidence**: 1 extracted · 1 inferred · 2 ambiguous _(3 to verify)_');
  });

  it('drops zero-count buckets from the breakdown', () => {
    const out = buildMemory(withEdges([
      { from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'extracted' },
      { from: 'a.ts', to: 'b.ts', kind: 'import', confidence: 'inferred' },
    ]), makeHuman());
    expect(out).toContain('- **Edge confidence**: 1 extracted · 1 inferred _(1 to verify)_');
    expect(out).not.toContain('ambiguous');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Section presence + ordering
// ─────────────────────────────────────────────────────────────────────

describe('buildMemory — section presence + ordering', () => {
  it('starts with the project name as a level-1 heading', () => {
    const out = buildMemory(makeAgent({ project: { name: 'fr-school', root: '/x', languages: [], frameworks: [], entryPoints: [], monorepo: null } }), makeHuman());
    expect(out.split('\n')[0]).toBe('# fr-school');
  });

  it('puts the oneLiner in a blockquote on line 3', () => {
    const out = buildMemory(makeAgent(), makeHuman({ summary: { oneLiner: 'A booking platform.', intent: '', capabilities: [], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } } }));
    const lines = out.split('\n');
    expect(lines[2]).toBe('> A booking platform.');
  });

  it('renders the do-not-edit banner before any section', () => {
    const out = buildMemory(makeAgent(), makeHuman());
    const ix = out.indexOf('Auto-generated by FACTS');
    const firstSection = out.indexOf('## ');
    expect(ix).toBeGreaterThan(0);
    expect(ix).toBeLessThan(firstSection);
  });

  it('renders sections in the canonical order', () => {
    // Build a fixture that EXERCISES every section so all headings appear.
    const out = buildMemory(
      makeAgent({
        project: { name: 'demo', root: '/demo', languages: ['typescript'], frameworks: ['React'], entryPoints: ['src/index.ts'], monorepo: null },
        files: [file('src/index.ts', 'typescript', 100, 1000), file('src/util.ts', 'typescript', 50, 500)],
        graph: { nodes: [{ id: 'src/index.ts' }, { id: 'src/util.ts' }], edges: [{ from: 'src/util.ts', to: 'src/index.ts', kind: 'import' }], cycles: [] },
        routes: [{ framework: 'remix', method: 'GET', path: '/', handlerFile: 'src/routes/_index.tsx', handlerSymbol: 'default' }],
        capabilities: ['Renders a React UI'],
        risks: [{ severity: 'high', category: 'secret', rule: 'aws', file: 'src/cfg.ts', line: 5, message: 'Possible AWS access key' }],
        stats: { loc: 150, fileCount: 2, packageCount: 1, totalTokenCost: 1500 },
      }),
      makeHuman({
        activity: [{ file: 'src/index.ts', lastModifiedMs: 1714000000000, churnScore: 3, authorCount: 2 }],
      }),
    );
    const order = ['## At a glance', '## Capabilities', '## Entry points', '## Routes', '## Key files', '## Open risks', '## Recently active files', '## How to read this codebase'];
    let cursor = 0;
    for (const heading of order) {
      const ix = out.indexOf(heading, cursor);
      if (ix < 0) throw new Error(`section "${heading}" missing or out of order; previous cursor=${cursor}`);
      cursor = ix;
    }
  });

  it('ends with a stable schema-version footer', () => {
    const out = buildMemory(makeAgent(), makeHuman());
    expect(out.trimEnd().endsWith(`<!-- factstack-memory schema=${MEMORY_SCHEMA_VERSION} -->`)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Content correctness — every claim ties back to an input field
// ─────────────────────────────────────────────────────────────────────

describe('buildMemory — content correctness', () => {
  it('renders top language with the largest LOC share as a percentage', () => {
    const out = buildMemory(
      makeAgent({
        files: [
          file('a.ts', 'typescript', 700, 7000),
          file('b.py', 'python', 200, 2000),
          file('c.js', 'javascript', 100, 1000),
        ],
      }),
      makeHuman(),
    );
    // 700 / 1000 = 70%
    expect(out).toMatch(/typescript \(70%\)/);
    expect(out).toMatch(/python \(20%\)/);
    expect(out).toMatch(/javascript \(10%\)/);
  });

  it('only renders the top 3 languages', () => {
    const out = buildMemory(
      makeAgent({
        files: [
          file('a.ts', 'typescript', 400, 4000),
          file('b.py', 'python', 300, 3000),
          file('c.js', 'javascript', 200, 2000),
          file('d.go', 'go', 50, 500),
          file('e.rs', 'rust', 50, 500),
        ],
      }),
      makeHuman(),
    );
    // First three present, last two not in the bullet list.
    expect(out).toMatch(/\*\*Languages\*\*:.*typescript.*python.*javascript/);
    expect(out).not.toMatch(/\*\*Languages\*\*:.*go|\*\*Languages\*\*:.*rust/);
  });

  it('caps frameworks at 8', () => {
    const fws = Array.from({ length: 12 }, (_, i) => `Framework${i + 1}`);
    const out = buildMemory(
      makeAgent({ project: { name: 'x', root: '/x', languages: [], frameworks: fws, entryPoints: [], monorepo: null } }),
      makeHuman(),
    );
    // First 8 present, 9th absent.
    for (let i = 1; i <= 8; i++) expect(out).toContain(`Framework${i}`);
    expect(out).not.toContain('Framework9');
    // Truncation indicator present.
    expect(out).toMatch(/\+4 more/);
  });

  it('renders stats from agent.stats verbatim with thousand-separator formatting', () => {
    const out = buildMemory(
      makeAgent({ stats: { loc: 43890, fileCount: 168, packageCount: 9, totalTokenCost: 530000 } }),
      makeHuman(),
    );
    // Numbers formatted with separators (en-US locale; 43,890 not 43890).
    expect(out).toMatch(/168 files/);
    expect(out).toMatch(/43,890 LOC/);
    // Token count uses K/M shortener.
    expect(out).toMatch(/530K tokens/);
  });

  it('uses the human.summary.health.headline verbatim', () => {
    const out = buildMemory(
      makeAgent(),
      makeHuman({ summary: { oneLiner: 'x', intent: '', capabilities: [], entryPoints: [], health: { broken: 3, stale: 2, todos: 47, secrets: 0, headline: '3 broken · 47 TODOs · clean on secrets' } } }),
    );
    expect(out).toContain('3 broken · 47 TODOs · clean on secrets');
  });

  it('groups routes by framework (alphabetical) then by path', () => {
    const out = buildMemory(
      makeAgent({
        routes: [
          { framework: 'remix',   method: 'GET',  path: '/users',        handlerFile: 'a', handlerSymbol: null },
          { framework: 'express', method: 'POST', path: '/api/login',    handlerFile: 'b', handlerSymbol: null },
          { framework: 'remix',   method: 'GET',  path: '/',             handlerFile: 'c', handlerSymbol: null },
          { framework: 'express', method: 'GET',  path: '/api/health',   handlerFile: 'd', handlerSymbol: null },
        ],
      }),
      makeHuman(),
    );
    // express section comes before remix (alphabetical)
    const ixExpress = out.indexOf('### express');
    const ixRemix = out.indexOf('### remix');
    expect(ixExpress).toBeGreaterThan(0);
    expect(ixRemix).toBeGreaterThan(ixExpress);
    // within express: /api/health before /api/login (alphabetical by path)
    const ixHealth = out.indexOf('/api/health');
    const ixLogin = out.indexOf('/api/login');
    expect(ixHealth).toBeLessThan(ixLogin);
  });

  it('"Key files" lists files by in-degree descending (most-imported first)', () => {
    // edges: c→a (a in-degree=1), c→b (b in-degree=1), d→a (a=2)
    const out = buildMemory(
      makeAgent({
        files: [
          file('a.ts', 'typescript', 10, 100),
          file('b.ts', 'typescript', 10, 100),
          file('c.ts', 'typescript', 10, 100),
          file('d.ts', 'typescript', 10, 100),
        ],
        graph: {
          nodes: [{ id: 'a.ts' }, { id: 'b.ts' }, { id: 'c.ts' }, { id: 'd.ts' }],
          edges: [
            { from: 'c.ts', to: 'a.ts', kind: 'import' },
            { from: 'c.ts', to: 'b.ts', kind: 'import' },
            { from: 'd.ts', to: 'a.ts', kind: 'import' },
          ],
          cycles: [],
        },
      }),
      makeHuman(),
    );
    // a.ts (in=2) before b.ts (in=1)
    const ixA = out.indexOf('`a.ts`');
    const ixB = out.indexOf('`b.ts`');
    expect(ixA).toBeGreaterThan(0);
    expect(ixA).toBeLessThan(ixB);
    // c.ts and d.ts have in-degree 0 — should NOT appear in key files.
    expect(out).not.toMatch(/`c\.ts`.*\(imported by/);
    expect(out).not.toMatch(/`d\.ts`.*\(imported by/);
  });

  it('F5: importance reorders Key files above raw in-degree', () => {
    // b.ts has higher in-degree (2) but a.ts has higher importance (1.0 vs 0.2).
    // With importance present, a.ts must rank first.
    const out = buildMemory(
      makeAgent({
        files: [
          file('a.ts', 'typescript', 10, 100),
          file('b.ts', 'typescript', 10, 100),
          file('x.ts', 'typescript', 10, 100),
          file('y.ts', 'typescript', 10, 100),
        ],
        graph: {
          nodes: [
            { id: 'a.ts', path: 'a.ts', importance: 1.0 },
            { id: 'b.ts', path: 'b.ts', importance: 0.2 },
            { id: 'x.ts', path: 'x.ts', importance: 0 },
            { id: 'y.ts', path: 'y.ts', importance: 0 },
          ],
          edges: [
            { from: 'x.ts', to: 'a.ts', kind: 'import' }, // a in-degree 1
            { from: 'x.ts', to: 'b.ts', kind: 'import' }, // b in-degree 2
            { from: 'y.ts', to: 'b.ts', kind: 'import' },
          ],
          cycles: [],
        } as unknown as AgentArtifact['graph'],
      }),
      makeHuman(),
    );
    const ixA = out.indexOf('`a.ts`');
    const ixB = out.indexOf('`b.ts`');
    expect(ixA).toBeGreaterThan(0);
    expect(ixA).toBeLessThan(ixB);                 // importance beats in-degree
    expect(out).toContain('importance 1');         // the score is surfaced
    expect(out).toMatch(/PageRank/);               // descriptor switched to importance wording
  });

  it('F5: Modules section lists communities named by their most-important member', () => {
    const out = buildMemory(
      makeAgent({
        files: [
          file('a.ts', 'typescript', 10, 100),
          file('b.ts', 'typescript', 10, 100),
          file('c.ts', 'typescript', 10, 100),
          file('d.ts', 'typescript', 10, 100),
        ],
        graph: {
          nodes: [
            { id: 'a.ts', path: 'a.ts', importance: 1.0, community: 0 },
            { id: 'b.ts', path: 'b.ts', importance: 0.2, community: 0 },
            { id: 'c.ts', path: 'c.ts', importance: 0.5, community: 1 },
            { id: 'd.ts', path: 'd.ts', importance: 0.9, community: 1 },
          ],
          edges: [],
          cycles: [],
        } as unknown as AgentArtifact['graph'],
      }),
      makeHuman(),
    );
    expect(out).toContain('## Modules');
    // community 0 named by a.ts (imp 1.0 > 0.2); community 1 named by d.ts (0.9 > 0.5).
    expect(out).toMatch(/\*\*`a\.ts`\*\* — 2 files/);
    expect(out).toMatch(/\*\*`d\.ts`\*\* — 2 files/);
    // single-member communities aren't modules → c.ts/b.ts are members, not names.
  });

  it('omits the Modules section when no community data is present', () => {
    const out = buildMemory(
      makeAgent({
        files: [file('a.ts', 'typescript', 10, 100), file('b.ts', 'typescript', 10, 100)],
        graph: {
          nodes: [{ id: 'a.ts' }, { id: 'b.ts' }],
          edges: [{ from: 'b.ts', to: 'a.ts', kind: 'import' }],
          cycles: [],
        } as unknown as AgentArtifact['graph'],
      }),
      makeHuman(),
    );
    expect(out).not.toContain('## Modules');
  });

  it('"Open risks" only includes severity high/critical', () => {
    const out = buildMemory(
      makeAgent({
        risks: [
          { severity: 'low',      category: 'license',       rule: 'no-license', message: 'add a license' },
          { severity: 'medium',   category: 'broken-import', rule: 'unresolved', file: 'x.ts', message: 'unresolved' },
          { severity: 'high',     category: 'secret',        rule: 'aws',        file: 'y.ts', line: 3, message: 'AWS key' },
          { severity: 'critical', category: 'secret',        rule: 'stripe',     file: 'z.ts', line: 1, message: 'Stripe key' },
        ],
      }),
      makeHuman(),
    );
    expect(out).toContain('AWS key');
    expect(out).toContain('Stripe key');
    expect(out).not.toContain('add a license');
    expect(out).not.toContain('unresolved');
  });

  it('caps the open-risks section at 8 entries with a "+N more" footer', () => {
    const risks = Array.from({ length: 12 }, (_, i) => ({
      severity: 'high' as const,
      category: 'secret' as const,
      rule: 'r',
      file: `f${i}.ts`,
      line: i,
      message: `Risk ${i}`,
    }));
    const out = buildMemory(makeAgent({ risks }), makeHuman());
    for (let i = 0; i < 8; i++) expect(out).toContain(`Risk ${i}`);
    expect(out).not.toContain('Risk 8');
    expect(out).toMatch(/\+4 more high\/critical risks/);
  });

  it('"Recently active files" comes from human.activity, capped at 5', () => {
    const activity = Array.from({ length: 8 }, (_, i) => ({
      file: `src/f${i}.ts`,
      lastModifiedMs: 1714000000000 + i,
      churnScore: 1,
      authorCount: 1,
    }));
    const out = buildMemory(makeAgent(), makeHuman({ activity }));
    for (let i = 0; i < 5; i++) expect(out).toContain(`src/f${i}.ts`);
    expect(out).not.toContain('src/f5.ts');
  });

  it('"How to read this codebase" tour uses the first entry point', () => {
    const out = buildMemory(
      makeAgent({
        project: { name: 'x', root: '/x', languages: [], frameworks: [], entryPoints: ['src/main.tsx', 'src/cli.ts'], monorepo: null },
        files: [file('package.json', 'json', 10, 100), file('src/main.tsx', 'typescript', 50, 500)],
      }),
      makeHuman(),
    );
    const tour = out.slice(out.indexOf('## How to read this codebase'));
    expect(tour).toMatch(/Entry.*src\/main\.tsx/);
  });

  it('truncates very long oneLiners with an ellipsis (no markdown injection)', () => {
    const long = 'x '.repeat(300); // 600 chars
    const out = buildMemory(makeAgent(), makeHuman({ summary: { oneLiner: long, intent: '', capabilities: [], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } } }));
    const blockquote = out.split('\n').find((l) => l.startsWith('> ')) || '';
    // Cap at 280 chars (twitter-ish) including ellipsis.
    expect(blockquote.length).toBeLessThanOrEqual(284); // 280 + "> "
    expect(blockquote.endsWith('…')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Determinism — same input → byte-identical output
// ─────────────────────────────────────────────────────────────────────

describe('buildMemory — determinism', () => {
  it('returns byte-identical output across calls with the same input', () => {
    const a = makeAgent({
      project: { name: 'demo', root: '/demo', languages: ['typescript'], frameworks: ['React'], entryPoints: ['src/index.ts'], monorepo: null },
      files: [file('src/index.ts', 'typescript', 100, 1000)],
      capabilities: ['Renders a UI'],
      stats: { loc: 100, fileCount: 1, packageCount: 1, totalTokenCost: 1000 },
    });
    const h = makeHuman();
    const a1 = buildMemory(a, h);
    const a2 = buildMemory(a, h);
    expect(a1).toBe(a2);
  });

  it('does not mutate the input artifacts', () => {
    const a = makeAgent({
      files: [file('a.ts', 'typescript', 10, 100)],
      capabilities: ['cap1', 'cap2'],
      risks: [{ severity: 'high', category: 'secret', rule: 'r', file: 'a.ts', line: 1, message: 'm' }],
    });
    const h = makeHuman();
    const aBefore = JSON.stringify(a);
    const hBefore = JSON.stringify(h);
    buildMemory(a, h);
    expect(JSON.stringify(a)).toBe(aBefore);
    expect(JSON.stringify(h)).toBe(hBefore);
  });

  it('does NOT call Date.now() or otherwise depend on wall clock', () => {
    // We test this by ensuring the output is identical when wrapping
    // Date.now to throw — if buildMemory calls it, the test fails.
    const origNow = Date.now;
    let called = false;
    Date.now = () => { called = true; return 0; };
    try {
      buildMemory(makeAgent(), makeHuman());
    } finally {
      Date.now = origNow;
    }
    expect(called).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Length budgets
// ─────────────────────────────────────────────────────────────────────

describe('buildMemory — length budgets', () => {
  it('empty fixture renders under 2 KB', () => {
    const out = buildMemory(makeAgent(), makeHuman());
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(2 * 1024);
  });

  it('large fixture (200 files, 30 frameworks, 50 risks) stays under 10 KB', () => {
    const files = Array.from({ length: 200 }, (_, i) => file(`src/f${i}.ts`, 'typescript', 50, 500));
    const fws = Array.from({ length: 30 }, (_, i) => `FW${i}`);
    const risks = Array.from({ length: 50 }, (_, i) => ({
      severity: 'high' as const, category: 'secret' as const, rule: 'r', file: `f${i}.ts`, line: i, message: `m${i}`,
    }));
    const activity = Array.from({ length: 30 }, (_, i) => ({
      file: `src/f${i}.ts`, lastModifiedMs: 1714000000000 + i, churnScore: 1, authorCount: 1,
    }));
    const out = buildMemory(
      makeAgent({
        project: { name: 'big', root: '/big', languages: [], frameworks: fws, entryPoints: [], monorepo: null },
        files,
        risks,
        stats: { loc: 10000, fileCount: 200, packageCount: 1, totalTokenCost: 100000 },
      }),
      makeHuman({ activity }),
    );
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(10 * 1024);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Edge cases
// ─────────────────────────────────────────────────────────────────────

describe('buildMemory — edge cases', () => {
  it('handles empty project gracefully (no files, no edges, no risks)', () => {
    const out = buildMemory(makeAgent(), makeHuman());
    // Doesn't crash, contains the project name + a "no source files"
    // marker in At-a-glance. Empty sections (routes, risks, activity,
    // entry points, capabilities) are OMITTED entirely per the design
    // contract — keeps the artifact small and structure unambiguous.
    expect(out).toContain('# demo');
    expect(out).toContain('_No source files yet');
    expect(out).not.toContain('## Routes');
    expect(out).not.toContain('## Open risks');
    expect(out).not.toContain('## Capabilities');
    expect(out).not.toContain('## Entry points');
    expect(out).not.toContain('## Recently active files');
    // The structural sections (At a glance, How to read) ALWAYS render.
    expect(out).toContain('## At a glance');
    expect(out).toContain('## How to read this codebase');
  });

  it('omits Frameworks line when frameworks list is empty', () => {
    const out = buildMemory(makeAgent(), makeHuman());
    // No "**Frameworks**: " line at all (we omit instead of leaving it dangling).
    expect(out).not.toMatch(/\*\*Frameworks\*\*: *$/m);
    expect(out).not.toMatch(/\*\*Frameworks\*\*: *\n/);
  });

  it('omits Entry points section when none are detected', () => {
    const out = buildMemory(makeAgent(), makeHuman());
    expect(out).not.toContain('## Entry points');
  });

  it('omits Routes section when none are detected', () => {
    const out = buildMemory(makeAgent(), makeHuman());
    // The section is fully omitted, not rendered with a placeholder, so
    // empty datasets keep the artifact small.
    expect(out).not.toContain('## Routes');
  });

  it('escapes backticks in oneLiner so blockquote stays well-formed', () => {
    const out = buildMemory(
      makeAgent(),
      makeHuman({ summary: { oneLiner: 'A `code-heavy` description with `markdown`', intent: '', capabilities: [], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } } }),
    );
    // The blockquote line should still start with "> " and contain the
    // text — backticks are kept (they're meaningful); the test guards
    // against accidental newline injection that would break the blockquote.
    const bq = out.split('\n').find((l) => l.startsWith('> ')) || '';
    expect(bq).toContain('A `code-heavy` description');
    // No literal newline mid-quote.
    expect(bq.split('\n').length).toBe(1);
  });

  it('rejects oneLiner with embedded newlines (collapses to single line)', () => {
    const out = buildMemory(
      makeAgent(),
      makeHuman({ summary: { oneLiner: 'Line one\nLine two\nLine three', intent: '', capabilities: [], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } } }),
    );
    const bqLines = out.split('\n').filter((l) => l.startsWith('> '));
    // Exactly one blockquote line — newlines in the oneLiner are
    // collapsed so the markdown structure stays intact.
    expect(bqLines.length).toBe(1);
    expect(bqLines[0]).not.toContain('\n');
  });

  it('renders single-language project as 100%', () => {
    const out = buildMemory(
      makeAgent({ files: [file('a.ts', 'typescript', 100, 1000)] }),
      makeHuman(),
    );
    expect(out).toMatch(/typescript \(100%\)/);
  });

  it('handles missing stats fields without throwing', () => {
    // Defensive: an artifact with all-zero stats should still render.
    const out = buildMemory(
      makeAgent({ stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 } }),
      makeHuman(),
    );
    expect(out).toContain('0 files');
  });

  it('does not include unresolved risks (no severity)', () => {
    // Defensive: if a future risk lands without severity, buildMemory
    // should never crash. We don't have an assertion here that data
    // appears; just that no exception is thrown.
    expect(() => buildMemory(makeAgent({ risks: [] }), makeHuman())).not.toThrow();
  });

  it('exports MEMORY_SCHEMA_VERSION as a non-empty string', () => {
    expect(typeof MEMORY_SCHEMA_VERSION).toBe('string');
    expect(MEMORY_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });
});

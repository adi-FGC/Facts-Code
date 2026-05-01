import { describe, expect, it } from 'vitest';
import { humanToViz } from '../src/viz.js';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

/**
 * Tests for `humanToViz` — the prototype's view-shape generator.
 * Critical because the dashboard renderers (Overview, Library, Routes,
 * Tests) all consume this shape; the `routes` field was missing for
 * a release before being plumbed through (v0.2 → v0.2.1 fix).
 */

function makeAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
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

function makeHuman(overrides: Partial<HumanArtifact> = {}): HumanArtifact {
  return {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-01T00:00:00Z',
    summary: {
      oneLiner: 'A test project',
      intent: '',
      capabilities: [],
      entryPoints: [],
      health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' },
    },
    stack: [],
    tree: { id: 'root', name: 'root', path: '.', kind: 'directory', language: null, loc: 0, tokenCost: 0, bundleSizeGzip: null, status: 'ok', children: [] },
    graph: { nodes: [], edges: [], cycles: [] },
    activity: [],
    risks: [],
    glossary: [],
    ...overrides,
  } as HumanArtifact;
}

describe('humanToViz — basic shape', () => {
  it('produces a viz with all top-level fields renderers expect', () => {
    const v = humanToViz(makeAgent(), makeHuman());
    expect(v.$schema).toBe('https://factstack.dev/schema/prototype.v1.json');
    expect(v.project).toBeDefined();
    expect(v.summary).toBeDefined();
    expect(v.stats).toBeDefined();
    expect(v.tree).toBeDefined();
    expect(v.edges).toBeDefined();
    expect(v.entryPoints).toBeDefined();
    expect(v.routes).toBeDefined();   // regression: v0.2 dropped this
    expect(v.risks).toBeDefined();
  });

  it('passes project.name + frameworks through unchanged', () => {
    const v = humanToViz(
      makeAgent({ project: { name: 'fr-school', root: '/x', languages: [], frameworks: ['React', 'Vite'], entryPoints: [], monorepo: null } }),
      makeHuman(),
    );
    expect(v.project.name).toBe('fr-school');
    expect(v.project.frameworks).toEqual(['React', 'Vite']);
  });
});

describe('humanToViz — routes pipeline (regression)', () => {
  it('passes agent.routes through to viz.routes', () => {
    const agent = makeAgent({
      routes: [
        { framework: 'remix', method: 'GET', path: '/', handlerFile: 'src/routes/_index.tsx', handlerSymbol: 'default' },
        { framework: 'express', method: 'POST', path: '/api/login', handlerFile: 'server.ts', handlerSymbol: null },
      ],
    });
    const v = humanToViz(agent, makeHuman());
    expect(v.routes).toHaveLength(2);
    expect(v.routes[0]).toMatchObject({ framework: 'remix', method: 'GET', path: '/' });
    expect(v.routes[1]).toMatchObject({ framework: 'express', method: 'POST', path: '/api/login' });
  });

  it('emits an empty routes array when none detected (not undefined)', () => {
    const v = humanToViz(makeAgent({ routes: [] }), makeHuman());
    expect(v.routes).toEqual([]);
  });
});

describe('humanToViz — description fallback (regression)', () => {
  it('leaves description empty when intent is empty (not duplicating oneLiner)', () => {
    // v0.2.1 fix: previously fell back to oneLiner when intent was
    // empty, causing the Overview hero to render the same sentence
    // twice (once as headline, once as dek).
    const v = humanToViz(makeAgent(), makeHuman({
      summary: { oneLiner: 'A test app', intent: '', capabilities: [], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } },
    }));
    expect(v.summary.description).toBe('');
    expect(v.summary.oneLiner).toBe('A test app');
  });

  it('uses intent as description when provided', () => {
    const v = humanToViz(makeAgent(), makeHuman({
      summary: { oneLiner: 'A short one', intent: 'A longer story about the project.', capabilities: [], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } },
    }));
    expect(v.summary.description).toBe('A longer story about the project.');
  });
});

describe('humanToViz — tree builder', () => {
  it('produces a tree node with the project name at root', () => {
    const v = humanToViz(makeAgent({ project: { name: 'my-app', root: '.', languages: [], frameworks: [], entryPoints: [], monorepo: null } }), makeHuman({
      tree: { id: 'root', name: 'my-app', path: '.', kind: 'directory', language: null, loc: 0, tokenCost: 0, bundleSizeGzip: null, status: 'ok', children: [] },
    }));
    expect(v.tree.name).toBe('my-app');
  });

  it('emits stats with files / loc / size / tokens', () => {
    const agent = makeAgent({
      stats: { loc: 100, fileCount: 5, packageCount: 1, totalTokenCost: 500 },
    });
    const v = humanToViz(agent, makeHuman());
    expect(v.stats.files).toBe(5);
    expect(v.stats.loc).toBe(100);
    expect(v.stats.tokens).toBe(500);
  });
});

describe('humanToViz — risk shape passthrough', () => {
  it('preserves severity/category/rule/message and includes file/line when present', () => {
    const v = humanToViz(makeAgent(), makeHuman({
      risks: [
        { severity: 'high', category: 'secret', rule: 'aws-access-key', message: 'Found AWS key', file: 'src/cfg.ts', line: 5 },
      ],
    }));
    expect(v.risks).toHaveLength(1);
    expect(v.risks[0]).toMatchObject({ severity: 'high', category: 'secret', rule: 'aws-access-key', file: 'src/cfg.ts', line: 5 });
  });

  it('omits file/line when not provided (no undefined leak)', () => {
    const v = humanToViz(makeAgent(), makeHuman({
      risks: [{ severity: 'low', category: 'license', rule: 'no-license', message: 'Add a license' }],
    }));
    expect(v.risks[0]).toMatchObject({ severity: 'low', category: 'license' });
    expect((v.risks[0] as any).file).toBeUndefined();
  });
});

describe('humanToViz — entryPoints passthrough', () => {
  it('maps human entryPoints to viz shape', () => {
    const v = humanToViz(makeAgent(), makeHuman({
      summary: { oneLiner: 'x', intent: '', capabilities: [], entryPoints: [
        { label: 'npm run dev', kind: 'cli-command', path: 'npm run dev', handlerFile: '', description: null },
      ], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } },
    }));
    expect(v.entryPoints[0]).toMatchObject({ label: 'npm run dev', path: 'npm run dev' });
  });
});

describe('humanToViz — capabilities head fallback (regression)', () => {
  it('handles capabilities without an em-dash separator', () => {
    // Bug fix: when a capability had no " — " separator, head was
    // undefined and the schema rejected it. Fallback to the whole
    // capability string.
    const v = humanToViz(makeAgent(), makeHuman({
      summary: { oneLiner: 'x', intent: '', capabilities: ['Renders a React UI'], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } },
    }));
    expect(v.summary.capabilities[0]?.head).toBe('Renders a React UI');
  });

  it('splits "head — sub" into separate fields', () => {
    const v = humanToViz(makeAgent(), makeHuman({
      summary: { oneLiner: 'x', intent: '', capabilities: ['Renders a UI — using React 19'], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' } },
    }));
    expect(v.summary.capabilities[0]?.head).toBe('Renders a UI');
    expect(v.summary.capabilities[0]?.sub).toBe('using React 19');
  });
});

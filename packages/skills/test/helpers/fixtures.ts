/**
 * Test fixtures: minimal valid AgentArtifact + HumanArtifact for the
 * skill-extraction tests. Same shape as the fixtures in
 * `packages/emit/test/` so a test-writer who has seen those files
 * recognizes the pattern.
 *
 * `makeAgent` / `makeHuman` accept an `overrides` object so each
 * test can poke specific fields without re-typing the whole shape.
 */

import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

export function makeAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-27T12:00:00.000Z',
    project: {
      name: 'demo',
      root: '.',
      languages: ['typescript'],
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
    dependencyManifests: [],
    vulnerabilities: [],
    ...overrides,
  } as AgentArtifact;
}

export function makeHuman(overrides: Partial<HumanArtifact> = {}): HumanArtifact {
  return {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-05-27T12:00:00.000Z',
    summary: {
      oneLiner: 'A demo project.',
      intent: '',
      capabilities: [],
      entryPoints: [],
      health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'ok' },
    },
    stack: [],
    tree: {
      id: 'root',
      name: 'root',
      path: '.',
      kind: 'directory',
      language: null,
      loc: 0,
      tokenCost: 0,
      bundleSizeGzip: null,
      status: 'ok',
      children: [],
    },
    graph: { nodes: [], edges: [], cycles: [] },
    activity: [],
    risks: [],
    ...overrides,
  } as HumanArtifact;
}

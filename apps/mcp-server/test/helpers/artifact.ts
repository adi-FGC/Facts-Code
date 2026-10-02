/**
 * A minimal AgentArtifact for the pack-converter tests, typed without a cast:
 * every required field is present, including the schema-defaulted arrays a
 * parsed artifact always carries, so a spec change that adds a required
 * field fails the test type-check instead of hiding behind `as`.
 */
import type { AgentArtifact } from '@factstack/spec';

export function makeArtifact(
  graph: Partial<AgentArtifact['graph']> = {},
  generatedAt = '2026-06-09T00:00:00Z',
): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt,
    project: {
      name: 't',
      root: '/t',
      languages: [],
      frameworks: [],
      entryPoints: [],
      monorepo: null,
    },
    files: [],
    graph: {
      nodes: [],
      edges: [],
      cycles: [],
      symbolNodes: [],
      symbolEdges: [],
      entities: [],
      entityEdges: [],
      ...graph,
    },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
    dependencyManifests: [],
    vulnerabilities: [],
    docs: [],
    rationale: [],
  };
}

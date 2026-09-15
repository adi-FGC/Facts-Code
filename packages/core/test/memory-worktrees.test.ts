/**
 * buildMemory — Worktrees section (v0.3.11). Present only when the agent
 * artifact carries a git topology; one line per checkout with branch,
 * integration/publish state, dirt, unique commits, readiness and the
 * request date; repo-level gaps on a trailing line.
 */
import { describe, expect, it } from 'vitest';
import type { AgentArtifact, GitTopology, HumanArtifact } from '@factstack/spec';
import { buildMemory } from '../src/memory.js';

function makeAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-09-06T00:00:00Z',
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

function makeHuman(): HumanArtifact {
  return {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: '0.1.0',
    generatedAt: '2026-09-06T00:00:00Z',
    summary: {
      oneLiner: 'A demo project',
      intent: '',
      capabilities: [],
      entryPoints: [],
      health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'clean' },
    },
    stack: [],
    tree: { name: 'demo', path: '.', kind: 'directory', status: 'ok', children: [] },
    graph: { nodes: [], edges: [], cycles: [] },
    activity: [],
    risks: [],
  } as unknown as HumanArtifact;
}

function worktree(
  over: Partial<GitTopology['worktrees'][number]>,
): GitTopology['worktrees'][number] {
  return {
    path: 'D:/repo',
    relPath: '.',
    kind: 'main',
    isCurrent: true,
    target: null,
    bare: false,
    locked: false,
    lockReason: null,
    prunable: false,
    branch: 'main',
    head: 'a'.repeat(40),
    headAt: '2026-09-04T01:18:31Z',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    integration: 'default',
    publish: 'pushed',
    tree: 'clean',
    inProgress: null,
    dirty: { staged: 0, modified: 0, untracked: 0, conflicts: 0 },
    compareBase: 'refs/remotes/origin/main',
    uniqueCount: 0,
    uniqueCommits: [],
    requests: [],
    sessions: 0,
    requestedAt: null,
    lastActivityAt: '2026-09-04T01:18:31Z',
    stale: false,
    features: [],
    deployTargets: ['wrangler.toml'],
    ci: true,
    testScript: true,
    readiness: {
      commit: 'nothing',
      commitReasons: ['working tree clean'],
      deploy: 'ready',
      deployReasons: ['on origin/main · wrangler.toml'],
    },
    gaps: [],
    ...over,
  };
}

function makeTopology(
  worktrees: GitTopology['worktrees'],
  gaps: GitTopology['gaps'] = [],
): GitTopology {
  return {
    scannedAt: '2026-09-06T00:00:00Z',
    repoRoot: 'D:/repo',
    currentPath: 'D:/repo',
    defaultBranch: 'main',
    originDefault: 'origin/main',
    remotes: [{ name: 'origin', url: null }],
    remoteRefsAgeDays: 1,
    stashes: 0,
    worktrees,
    branches: [],
    gaps,
    requestsCoverage: 'full',
    elapsedMs: 5,
  };
}

describe('buildMemory — Worktrees section (v0.3.11)', () => {
  it('omits the section when the artifact has no git topology', () => {
    const out = buildMemory(makeAgent(), makeHuman());
    expect(out).not.toContain('## Worktrees');
  });

  it('omits the section when the topology has no worktrees', () => {
    const out = buildMemory(makeAgent({ git: makeTopology([]) }), makeHuman());
    expect(out).not.toContain('## Worktrees');
  });

  it('lists one line per checkout with state, readiness and the request date', () => {
    const git = makeTopology(
      [
        worktree({}),
        worktree({
          path: 'D:/repo/.claude/worktrees/feature-x',
          relPath: '.claude/worktrees/feature-x',
          kind: 'linked',
          isCurrent: false,
          branch: 'feat/x',
          upstream: null,
          ahead: null,
          behind: null,
          integration: 'unmerged',
          publish: 'no-upstream',
          tree: 'dirty',
          dirty: { staged: 2, modified: 1, untracked: 3, conflicts: 0 },
          uniqueCount: 4,
          requestedAt: '2026-09-03T09:00:00Z',
          readiness: { commit: 'partial', commitReasons: [], deploy: 'blocked', deployReasons: [] },
        }),
      ],
      ['stale-remote-refs'],
    );
    const out = buildMemory(makeAgent({ git }), makeHuman());
    expect(out).toContain('## Worktrees');
    expect(out).toContain(
      '- **repo** (main, here) — main · default · pushed · clean · commit: nothing · deploy: ready',
    );
    expect(out).toContain(
      '- **.claude/worktrees/feature-x** (linked) — feat/x · unmerged · no-upstream · 2 staged, 1 modified, 3 untracked · 4 commits not in origin/main · commit: partial · deploy: blocked · requested 2026-09-03',
    );
    expect(out).toContain('- _Gaps_: stale-remote-refs');
    // Section order: after "At a glance", before any working context.
    expect(out.indexOf('## At a glance')).toBeLessThan(out.indexOf('## Worktrees'));
  });

  it('caps the list at 8 checkouts and says how many more exist', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      worktree({
        path: `D:/repo/wt${i}`,
        relPath: `wt${i}`,
        kind: 'linked',
        isCurrent: false,
        branch: `b${i}`,
      }),
    );
    const out = buildMemory(makeAgent({ git: makeTopology(many) }), makeHuman());
    expect(out.match(/^- \*\*wt\d+\*\*/gm)).toHaveLength(8);
    expect(out).toContain('(+3 more — see the Worktrees tab');
  });
});

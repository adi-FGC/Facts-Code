/**
 * Intent generator tests — every documented branch + determinism +
 * graceful-fallback to null.
 *
 * Tests build minimal but valid AgentArtifact + HumanArtifact fixtures
 * and assert the rendered sentence. Ordering MUST be stable across
 * runs (per the determinism contract); the test checks two consecutive
 * calls produce byte-identical output.
 */

import { describe, expect, it } from 'vitest';
import { inferIntent, joinList } from '../src/index.js';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { FACTS_SCHEMA_VERSION } from '@factstack/spec';

function makeAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  const base: AgentArtifact = {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: FACTS_SCHEMA_VERSION,
    generatedAt: '2026-05-02T12:00:00.000Z',
    project: {
      name: 'test',
      root: '.',
      languages: ['TypeScript'],
      frameworks: [],
      entryPoints: [],
      monorepo: null,
    },
    files: [],
    graph: { nodes: [], edges: [], cycles: [], callerIndex: {}, workspaces: [] },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  };
  /* Deep-merge `project` so callers can override just one field
     (e.g. frameworks) without restating the whole project block. */
  const merged: AgentArtifact = { ...base, ...overrides };
  if (overrides.project) {
    merged.project = { ...base.project, ...overrides.project };
  }
  return merged;
}

function makeHuman(overrides: Partial<HumanArtifact> = {}): HumanArtifact {
  const base = {
    $schema: 'https://factstack.dev/schema/human.v1.json' as const,
    factsVersion: FACTS_SCHEMA_VERSION,
    generatedAt: '2026-05-02T12:00:00.000Z',
    summary: {
      oneLiner: '',
      capabilities: [],
      entryPoints: [],
      health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: '' },
    },
    stack: [],
    tree: { name: '.', path: '.', kind: 'dir' as const, children: [] },
    graph: { nodes: [], edges: [], cycles: [], callerIndex: {}, workspaces: [] },
    activity: [],
    risks: [],
  };
  return { ...base, ...overrides } as HumanArtifact;
}

describe('inferIntent — null branches (no signal)', () => {
  it('returns null for an empty project (no frameworks, no files)', () => {
    expect(inferIntent(makeAgent(), makeHuman())).toBeNull();
  });

  it('returns null for a TypeScript-only project with no frameworks', () => {
    const agent = makeAgent({
      project: {
        name: 't', root: '.', languages: ['TypeScript'], frameworks: ['TypeScript'],
        entryPoints: [], monorepo: null,
      } as AgentArtifact['project'],
    });
    expect(inferIntent(agent, makeHuman())).toBeNull();
  });
});

describe('inferIntent — Python frameworks', () => {
  it('FastAPI service with route count', () => {
    const agent = makeAgent({
      project: {
        name: 'api', root: '.', languages: ['Python'], frameworks: ['FastAPI'],
        entryPoints: [], monorepo: null,
      } as AgentArtifact['project'],
      routes: Array.from({ length: 12 }, (_, i) => ({
        framework: 'fastapi', method: 'GET', path: `/r${i}`, handlerFile: 'main.py', handlerSymbol: null,
      })),
    });
    expect(inferIntent(agent, makeHuman())).toBe('A FastAPI service with 12 routes.');
  });

  it('FastAPI service singular when 1 route', () => {
    const agent = makeAgent({
      project: { name: 'api', root: '.', languages: ['Python'], frameworks: ['FastAPI'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
      routes: [{ framework: 'fastapi', method: 'GET', path: '/r', handlerFile: 'main.py', handlerSymbol: null }],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A FastAPI service with 1 route.');
  });

  it('FastAPI without routes still names the framework', () => {
    const agent = makeAgent({
      project: { name: 'api', root: '.', languages: ['Python'], frameworks: ['FastAPI'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A FastAPI service.');
  });

  it('Django web app naming', () => {
    const agent = makeAgent({
      project: { name: 'd', root: '.', languages: ['Python'], frameworks: ['Django'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
      routes: [{ framework: 'django', method: 'GET', path: '/', handlerFile: 'views.py', handlerSymbol: null }],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A Django web app with 1 route.');
  });

  it('Flask service', () => {
    const agent = makeAgent({
      project: { name: 'f', root: '.', languages: ['Python'], frameworks: ['Flask'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A Flask service.');
  });
});

describe('inferIntent — JS server frameworks', () => {
  it('Express with routes', () => {
    const agent = makeAgent({
      project: { name: 'e', root: '.', languages: ['JavaScript'], frameworks: ['Express'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
      routes: [
        { framework: 'express', method: 'GET', path: '/x', handlerFile: 'a.js', handlerSymbol: null },
        { framework: 'express', method: 'POST', path: '/y', handlerFile: 'b.js', handlerSymbol: null },
      ],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A Express application with 2 routes.');
  });

  it('Next.js application with routes', () => {
    const agent = makeAgent({
      project: { name: 'n', root: '.', languages: ['TypeScript'], frameworks: ['Next.js', 'React'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
      routes: [{ framework: 'next', method: null, path: '/', handlerFile: 'app/page.tsx', handlerSymbol: null }],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A Next.js application with 1 route.');
  });
});

describe('inferIntent — UI frameworks', () => {
  it('Vite-built React UI', () => {
    const agent = makeAgent({
      project: { name: 'r', root: '.', languages: ['TypeScript'], frameworks: ['React', 'Vite'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A Vite-built React UI.');
  });

  it('plain React UI without a build tool', () => {
    const agent = makeAgent({
      project: { name: 'r', root: '.', languages: ['JavaScript'], frameworks: ['React'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A React UI.');
  });

  it('Vite-built Svelte UI', () => {
    const agent = makeAgent({
      project: { name: 's', root: '.', languages: ['JavaScript'], frameworks: ['Svelte', 'Vite'], entryPoints: [], monorepo: null } as AgentArtifact['project'],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A Vite-built Svelte UI.');
  });
});

describe('inferIntent — CLI', () => {
  it('detects a Node CLI from a cli.ts file', () => {
    const agent = makeAgent({
      project: { name: 'c', root: '.', languages: ['TypeScript'], frameworks: [], entryPoints: [], monorepo: null } as AgentArtifact['project'],
      files: [makeFile('src/cli.ts')],
    });
    expect(inferIntent(agent, makeHuman())).toBe('A Node CLI tool.');
  });
});

describe('inferIntent — monorepo', () => {
  it('enumerates apps under apps/* with their kinds', () => {
    const agent = makeAgent({
      project: {
        name: 'mono', root: '.', languages: ['TypeScript'],
        frameworks: ['Remix', 'React'], entryPoints: [],
        monorepo: { manager: 'pnpm', workspaces: [] },
      } as AgentArtifact['project'],
      files: [
        makeFile('apps/cli/src/index.ts'),
        makeFile('apps/mcp-server/src/server.ts'),
        makeFile('apps/ui-remix/src/main.tsx'),
      ],
    });
    expect(inferIntent(agent, makeHuman())).toBe(
      'A pnpm monorepo containing a CLI, an MCP server, and a Remix dashboard.',
    );
  });

  it('skips unknown app dirs (returns null when ALL apps are unknown)', () => {
    /* Honest-omission: rather than inventing "an somecustomthing app"
       labels that read awkwardly, the intent generator skips dirs it
       can't classify. With no recognizable apps, the monorepo branch
       falls through to single-app intent (which itself returns null
       for an empty project). */
    const agent = makeAgent({
      project: {
        name: 'mono', root: '.', languages: ['TypeScript'], frameworks: [],
        entryPoints: [], monorepo: { manager: 'pnpm', workspaces: [] },
      } as AgentArtifact['project'],
      files: [makeFile('apps/somecustomthing/src/index.ts')],
    });
    expect(inferIntent(agent, makeHuman())).toBeNull();
  });

  it('dedupes labels when multiple app dirs map to the same kind', () => {
    /* Two browser-extension apps (chrome-ext + firefox-ext) should
       emit "a browser extension" exactly once — not twice. */
    const agent = makeAgent({
      project: {
        name: 'mono', root: '.', languages: ['TypeScript'], frameworks: [],
        entryPoints: [], monorepo: { manager: 'pnpm', workspaces: [] },
      } as AgentArtifact['project'],
      files: [
        makeFile('apps/chrome-ext/src/x.ts'),
        makeFile('apps/firefox-ext/src/x.ts'),
        makeFile('apps/cli/src/x.ts'),
      ],
    });
    expect(inferIntent(agent, makeHuman())).toBe(
      'A pnpm monorepo containing a browser extension and a CLI.',
    );
  });

  it('classifies vscode-ext as VS Code extension, not browser extension', () => {
    const agent = makeAgent({
      project: {
        name: 'mono', root: '.', languages: ['TypeScript'], frameworks: [],
        entryPoints: [], monorepo: { manager: 'pnpm', workspaces: [] },
      } as AgentArtifact['project'],
      files: [makeFile('apps/vscode-ext/src/x.ts')],
    });
    expect(inferIntent(agent, makeHuman())).toBe(
      'A pnpm monorepo containing a VS Code extension.',
    );
  });

  it('falls back to single-app intent prefixed with the manager when no apps/', () => {
    const agent = makeAgent({
      project: {
        name: 'mono', root: '.', languages: ['Python'], frameworks: ['FastAPI'],
        entryPoints: [],
        monorepo: { manager: 'turbo', workspaces: [] },
      } as AgentArtifact['project'],
      routes: [{ framework: 'fastapi', method: 'GET', path: '/r', handlerFile: 'm.py', handlerSymbol: null }],
    });
    expect(inferIntent(agent, makeHuman())).toBe(
      'A turbo monorepo with fastAPI service with 1 route.',
    );
  });
});

describe('inferIntent — determinism', () => {
  it('produces byte-identical output across two calls with the same input', () => {
    const agent = makeAgent({
      project: {
        name: 'mono', root: '.', languages: ['TypeScript'], frameworks: ['Remix', 'React'],
        entryPoints: [], monorepo: { manager: 'pnpm', workspaces: [] },
      } as AgentArtifact['project'],
      files: [makeFile('apps/cli/src/index.ts'), makeFile('apps/ui-remix/src/main.tsx')],
    });
    const a = inferIntent(agent, makeHuman());
    const b = inferIntent(agent, makeHuman());
    expect(a).toBe(b);
  });

  it('sorts apps deterministically regardless of file insertion order', () => {
    const filesA = [
      makeFile('apps/zoo/src/index.ts'),
      makeFile('apps/cli/src/index.ts'),
      makeFile('apps/api/src/server.ts'),
    ];
    const filesB = [...filesA].reverse();
    const projA = makeAgent({
      project: { name: 'm', root: '.', languages: ['TypeScript'], frameworks: [], entryPoints: [], monorepo: { manager: 'pnpm', workspaces: [] } } as AgentArtifact['project'],
      files: filesA,
    });
    const projB = makeAgent({
      project: { name: 'm', root: '.', languages: ['TypeScript'], frameworks: [], entryPoints: [], monorepo: { manager: 'pnpm', workspaces: [] } } as AgentArtifact['project'],
      files: filesB,
    });
    expect(inferIntent(projA, makeHuman())).toBe(inferIntent(projB, makeHuman()));
  });
});

describe('joinList', () => {
  it('handles 0 items', () => {
    expect(joinList([])).toBe('');
  });
  it('handles 1 item', () => {
    expect(joinList(['a'])).toBe('a');
  });
  it('handles 2 items', () => {
    expect(joinList(['a', 'b'])).toBe('a and b');
  });
  it('handles 3 items with Oxford comma', () => {
    expect(joinList(['a', 'b', 'c'])).toBe('a, b, and c');
  });
  it('handles many items', () => {
    expect(joinList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d, and e');
  });
});

/* ───────── helpers ───────── */

function makeFile(p: string): AgentArtifact['files'][number] {
  return {
    path: p,
    language: 'typescript',
    loc: 10,
    bytes: 100,
    bundleSize: null,
    tokenCost: 50,
    imports: [],
    exports: [],
    declarations: [],
    todos: [],
    complexity: { cyclomatic: 0, cognitive: 0 },
    status: 'ok',
    lastModifiedMs: null,
    churnScore: null,
  };
}

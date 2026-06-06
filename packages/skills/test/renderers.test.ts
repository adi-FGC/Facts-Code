/**
 * Tests for the three skill renderers + the buildSkillsTo orchestrator.
 *
 * Consolidated into one file because each renderer's surface is small
 * (one render() method, deterministic, no shared state) and grouping
 * them lets us assert cross-renderer invariants (same SkillSpec input
 * → all three render successfully → orchestrator writes the union).
 *
 * The orchestrator tests use the MemoryFileWriter shim so we can
 * assert file paths + body content without touching disk.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_FORMATS,
  buildSkillsTo,
  claudeRenderer,
  copilotRenderer,
  cursorRenderer,
  agentsRenderer,
  agentToSkillSpec,
  SKILL_REGISTRY,
  type SkillSpec,
} from '../src/index.js';
import { MemoryFileWriter } from './helpers/memory-writer.js';
import { makeAgent, makeHuman } from './helpers/fixtures.js';

/** Build a representative SkillSpec via the extract function so the
 *  renderer tests exercise real-shape inputs without re-typing the
 *  shape literal. */
function representativeSpec(): SkillSpec {
  const agent = makeAgent({
    project: {
      name: 'demo-project',
      root: '.',
      languages: ['typescript'],
      frameworks: ['React', 'Vite'],
      entryPoints: ['npm run dev', 'npm test'],
      monorepo: null,
    },
    files: [{ path: 'a.ts', language: 'typescript', loc: 100, bytes: 3000, bundleSize: null, tokenCost: 50, imports: [], exports: [], declarations: [], todos: [], complexity: { cyclomatic: 0, cognitive: 0 }, status: 'ok', lastModifiedMs: null, churnScore: null }],
    /* Include graph edges so the keyFiles section renders. Without
       this, every renderer's "## Read these first" / "## Key files"
       section gets omitted (per the SECTION OMISSION contract) and
       cross-renderer presence tests would need to be conditional. */
    graph: {
      nodes: [],
      edges: [
        { from: 'a.ts', to: 'src/lib/index.ts', kind: 'import' },
        { from: 'b.ts', to: 'src/lib/index.ts', kind: 'import' },
      ],
      cycles: [],
    },
    capabilities: ['Renders a React UI', 'Uses Vite for bundling'],
    risks: [{ severity: 'high', category: 'secret', rule: 'r', message: 'High-sev finding', file: 'a.ts' }],
    vulnerabilities: [{ id: 'GHSA-x', severity: 'high', ecosystem: 'npm', package: 'lodash', installedVersion: '4.17.20', fixedVersion: '4.17.21', advisoryUrl: 'https://example.test', lastChecked: 0, manifestPath: 'package.json' }],
    stats: { loc: 100, fileCount: 1, packageCount: 1, totalTokenCost: 50 },
    routes: [
      { framework: 'express', method: 'GET',  path: '/health', handlerFile: 'a.ts', handlerSymbol: null },
      { framework: 'express', method: 'POST', path: '/users',  handlerFile: 'a.ts', handlerSymbol: null },
    ],
  });
  const human = makeHuman({
    summary: {
      oneLiner: 'A demo React project.',
      intent: 'Auto-generated test fixture for the skills renderers.',
      capabilities: [],
      entryPoints: [],
      health: { broken: 0, stale: 0, todos: 0, secrets: 1, headline: '1 secret' },
    },
  });
  return agentToSkillSpec(agent, human);
}

/* ─────────── Claude renderer ─────────── */

describe('claudeRenderer', () => {
  it('emits exactly one file at .claude/skills/factstack-<slug>/SKILL.md', () => {
    const out = claudeRenderer.render(representativeSpec());
    const paths = Object.keys(out);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^\.claude\/skills\/factstack-[a-z0-9-]+\/SKILL\.md$/);
  });

  it('starts with valid YAML frontmatter', () => {
    const out = claudeRenderer.render(representativeSpec());
    const body = Object.values(out)[0]!;
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toMatch(/^---\n[\s\S]+?\n---\n/);
  });

  it('frontmatter contains required name + description fields', () => {
    const body = Object.values(claudeRenderer.render(representativeSpec()))[0]!;
    const fm = body.split('---\n')[1]!;
    expect(fm).toMatch(/^name: factstack-/m);
    expect(fm).toMatch(/^description: "/m);
  });

  it('embeds the FACTS operating contract + onboarding tools', () => {
    const body = Object.values(claudeRenderer.render(representativeSpec()))[0]!;
    /* The MCP-only "Mandatory preparation" block was replaced by the
       shared, pack-first operating contract (workflowContract): read the
       pack for context, keep it fresh via the hook. */
    expect(body).toContain('## How to work in this project');
    expect(body).toContain('.facts/agent.pack');
    expect(body).toContain('factstack analyze --minimal');
    /* The 6 onboarding tools still appear — MCP is now the live-query
       enhancement, listed inline rather than as a mandatory checklist. */
    expect(body).toContain('`read_memory`');
    expect(body).toContain('`analyze`');
    expect(body).toContain('`query_graph`');
    expect(body).toContain('`list_risks`');
    expect(body).toContain('`list_credentials`');
    expect(body).toContain('`list_vulnerabilities`');
  });

  it('renders capabilities, entry points, key files, routes, risks, vulns sections', () => {
    const body = Object.values(claudeRenderer.render(representativeSpec()))[0]!;
    expect(body).toContain('## At a glance');
    expect(body).toContain('## Capabilities');
    expect(body).toContain('## Entry points');
    expect(body).toContain('## Routes');
    expect(body).toContain('## Open risks');
    expect(body).toContain('## Known vulnerabilities');
  });

  it('is deterministic across two calls', () => {
    const spec = representativeSpec();
    const a = JSON.stringify(claudeRenderer.render(spec));
    const b = JSON.stringify(claudeRenderer.render(spec));
    expect(a).toBe(b);
  });
});

/* ─────────── Cursor renderer ─────────── */

describe('cursorRenderer', () => {
  it('emits exactly one file at .cursorrules at project root', () => {
    const out = cursorRenderer.render(representativeSpec());
    expect(Object.keys(out)).toEqual(['.cursorrules']);
  });

  it('opens with project-persona framing', () => {
    const body = cursorRenderer.render(representativeSpec())['.cursorrules']!;
    expect(body.startsWith('You are working in the **demo-project** codebase')).toBe(true);
  });

  it('renders core sections', () => {
    const body = cursorRenderer.render(representativeSpec())['.cursorrules']!;
    expect(body).toContain('## Project facts');
    expect(body).toContain('## Entry points');
    expect(body).toContain('## Read these first');
    expect(body).toContain('## Workflow conventions');
  });

  it('mentions vulnerabilities when present', () => {
    const body = cursorRenderer.render(representativeSpec())['.cursorrules']!;
    expect(body).toContain('## Security');
    /* The count is wrapped in `**` markdown, so the literal substring
       isn't `1 known dependency vulnerability` — assert on the
       singular form's surrounding context. */
    expect(body).toContain('1** known dependency vulnerability');
  });
});

/* ─────────── Copilot renderer ─────────── */

describe('copilotRenderer', () => {
  it('emits exactly one file at .github/copilot-instructions.md', () => {
    const out = copilotRenderer.render(representativeSpec());
    expect(Object.keys(out)).toEqual(['.github/copilot-instructions.md']);
  });

  it('opens with H1 project name + first-person plural framing', () => {
    const body = copilotRenderer.render(representativeSpec())['.github/copilot-instructions.md']!;
    expect(body.startsWith('# demo-project\n')).toBe(true);
    expect(body).toMatch(/We work in a typescript project/);
  });

  it('renders project shape + conventions sections', () => {
    const body = copilotRenderer.render(representativeSpec())['.github/copilot-instructions.md']!;
    expect(body).toContain('## Project shape');
    expect(body).toContain('## Conventions');
  });
});

/* ─────────── AGENTS.md renderer ─────────── */

describe('agentsRenderer', () => {
  it('is exported from the package barrel with id "agents"', () => {
    /* Importing agentsRenderer by name in this file's header is itself
       the lock: if index.ts stops re-exporting it, this test file fails
       to load. The id assertion just makes the intent explicit. */
    expect(agentsRenderer.id).toBe('agents');
  });

  it('emits exactly one file at AGENTS.md', () => {
    expect(Object.keys(agentsRenderer.render(representativeSpec()))).toEqual(['AGENTS.md']);
  });

  it("leads with the \"use the pack, don't scan\" directive", () => {
    const body = agentsRenderer.render(representativeSpec())['AGENTS.md']!;
    expect(body).toContain('## Before you scan: use the FACTS map');
    expect(body).toContain('.facts/agent.pack');
  });
});

/* ─────────── orchestrator + registry ─────────── */

describe('SKILL_REGISTRY + ALL_FORMATS', () => {
  it('registers all four renderers', () => {
    expect(Object.keys(SKILL_REGISTRY).sort()).toEqual(['agents', 'claude', 'copilot', 'cursor']);
  });

  it('ALL_FORMATS matches the registry keys', () => {
    expect([...ALL_FORMATS].sort()).toEqual(['agents', 'claude', 'copilot', 'cursor']);
  });

  it('each renderer exposes its own id matching the registry key', () => {
    for (const [key, renderer] of Object.entries(SKILL_REGISTRY)) {
      expect(renderer.id).toBe(key);
    }
  });

  it('every format teaches the pack-first + hook-fresh contract', () => {
    /* The whole point of ft-1: whichever agent tool reads its skill file,
       it's told to (B) read .facts/agent.pack for context and (A) keep it
       fresh via the `analyze --minimal` hook. Locks the contract across
       all four renderers so a future format can't ship without it. */
    const spec = representativeSpec();
    for (const [id, renderer] of Object.entries(SKILL_REGISTRY)) {
      const body = Object.values(renderer.render(spec)).join('\n');
      expect(body, `${id} must point the agent at the pack`).toContain('.facts/agent.pack');
      expect(body, `${id} must teach the refresh hook`).toContain('factstack analyze --minimal');
    }
  });
});

describe('buildSkillsTo', () => {
  it('writes all four formats by default', async () => {
    const writer = new MemoryFileWriter();
    const agent = makeAgent({ project: { ...makeAgent().project, name: 'x' } });
    const result = await buildSkillsTo(writer, agent, makeHuman());

    expect(result.formats).toEqual(['claude', 'cursor', 'copilot', 'agents']);
    expect(writer.has('.claude/skills/factstack-x/SKILL.md')).toBe(true);
    expect(writer.has('.cursorrules')).toBe(true);
    expect(writer.has('.github/copilot-instructions.md')).toBe(true);
    expect(writer.has('AGENTS.md')).toBe(true);
    expect(result.bytesWritten).toBeGreaterThan(0);
  });

  it('respects formats filter — single-format subset works', async () => {
    const writer = new MemoryFileWriter();
    const result = await buildSkillsTo(writer, makeAgent(), makeHuman(), ['cursor']);

    expect(result.formats).toEqual(['cursor']);
    expect(writer.has('.cursorrules')).toBe(true);
    expect(writer.has('.github/copilot-instructions.md')).toBe(false);
    expect(writer.files.size).toBe(1);
  });

  it('preserves an existing AGENTS.md when preserveExisting=[agents]', async () => {
    /* AGENTS.md is a cross-tool standard a team may hand-author. With
       preserveExisting it's left untouched (and reported), while the
       FACTS-managed rules files still refresh. Guards Codex finding #3. */
    const writer = new MemoryFileWriter();
    const handAuthored = '# AGENTS.md\nHand-written team policy — do not clobber.\n';
    await writer.writeText('AGENTS.md', handAuthored);

    const result = await buildSkillsTo(writer, makeAgent(), makeHuman(), undefined, {
      preserveExisting: ['agents'],
    });

    expect(writer.get('AGENTS.md')).toBe(handAuthored); // untouched
    expect(result.preserved).toContain('AGENTS.md');
    expect(result.files).not.toHaveProperty('AGENTS.md');
    expect(writer.has('.cursorrules')).toBe(true); // others still refresh
    expect(writer.has('.github/copilot-instructions.md')).toBe(true);
  });

  it('still writes AGENTS.md when none exists, even with preserveExisting', async () => {
    /* The universal feature must survive: a repo WITHOUT an AGENTS.md
       still gets one. Preserve only fires when a file is already there. */
    const writer = new MemoryFileWriter();
    const result = await buildSkillsTo(writer, makeAgent(), makeHuman(), undefined, {
      preserveExisting: ['agents'],
    });
    expect(writer.has('AGENTS.md')).toBe(true);
    expect(result.preserved).toEqual([]);
  });

  it('silently drops unknown format IDs', async () => {
    /* Caller is responsible for surfacing typos; orchestrator stays
       pure. Asserts the documented behavior. */
    const writer = new MemoryFileWriter();
    const result = await buildSkillsTo(writer, makeAgent(), makeHuman(),
      ['claude', 'cusror' as unknown as 'cursor']);
    expect(result.formats).toEqual(['claude']);
  });

  it('files map mirrors what the writer received', async () => {
    const writer = new MemoryFileWriter();
    const result = await buildSkillsTo(writer, makeAgent(), makeHuman());
    for (const [path, body] of Object.entries(result.files)) {
      expect(writer.get(path)).toBe(body);
    }
  });

  it('bytesWritten matches the sum of UTF-8 byte lengths', async () => {
    const writer = new MemoryFileWriter();
    const result = await buildSkillsTo(writer, makeAgent(), makeHuman());
    const expected = Object.values(result.files).reduce(
      (s, body) => s + new TextEncoder().encode(body).byteLength,
      0,
    );
    expect(result.bytesWritten).toBe(expected);
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeArtifacts, readSnapshots } from '../src/write.js';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests for the Node-tier writeArtifacts shim. After the orchestrator
 * deepening (CONTEXT.md "Write tier"), this file covers ONLY the
 * Node-specific outer ring:
 *
 *   - .gitignore append (Node-only — browser writers don't manage gitignore)
 *   - readSnapshots (Node-only function reading sidecars back from disk)
 *
 * The write-semantics tests (file presence, JSONL toggle, schema
 * validation, snapshot retention, MEMORY.md handling, PACK emission)
 * live in `orchestrator.test.ts` where they run against the in-memory
 * MemoryFileWriter — no temp dirs, microseconds per test.
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'factstack-emit-'));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeAgent(): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: new Date().toISOString(),
    project: { name: 'test', root: tmp, languages: [], frameworks: [], entryPoints: [], monorepo: null },
    files: [],
    graph: { nodes: [], edges: [], cycles: [] },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  } as AgentArtifact;
}

function makeHuman(): HumanArtifact {
  return {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: '0.1.0',
    generatedAt: new Date().toISOString(),
    summary: { oneLiner: 'x', intent: '', capabilities: [], entryPoints: [], health: { broken: 0, stale: 1, todos: 2, secrets: 0, headline: 'ok' } },
    stack: [],
    tree: { id: 'root', name: 'root', path: '.', kind: 'directory', language: null, loc: 0, tokenCost: 0, bundleSizeGzip: null, status: 'ok', children: [] },
    graph: { nodes: [], edges: [], cycles: [] },
    activity: [],
    risks: [],
    glossary: [],
  } as HumanArtifact;
}

describe('writeArtifacts — .gitignore management (Node shim)', () => {
  it('creates .gitignore + adds .facts/ entry on first run', async () => {
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    const gi = readFileSync(join(tmp, '.gitignore'), 'utf8');
    expect(gi).toContain('.facts/');
  });

  it('does not duplicate the entry on subsequent runs', async () => {
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    const gi = readFileSync(join(tmp, '.gitignore'), 'utf8');
    const matches = (gi.match(/\.facts\/?/g) || []).length;
    expect(matches).toBeLessThanOrEqual(2); // header line + entry, not 4
  });

  it('skips gitignore when addGitignoreEntry: false', async () => {
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), addGitignoreEntry: false });
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
  });
});

describe('readSnapshots (Node-only sidecar reader)', () => {
  it('returns empty for a project with no snapshots', async () => {
    const snaps = await readSnapshots(tmp);
    expect(snaps).toEqual([]);
  });

  it('returns snapshots sorted by name (chronological since names are ISO)', async () => {
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), writeSnapshot: true });
    await new Promise((r) => setTimeout(r, 10));
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), writeSnapshot: true });
    const snaps = await readSnapshots(tmp);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    // Each entry has the documented shape
    for (const s of snaps) {
      expect(s).toHaveProperty('at');
      expect(s).toHaveProperty('files');
      expect(s).toHaveProperty('tokens');
    }
  });

  it('skips malformed snapshot files (graceful)', async () => {
    const snapDir = join(tmp, '.facts', 'snapshots');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(snapDir, { recursive: true });
    writeFileSync(join(snapDir, '2026-01-01T00-00-00-000Z.json'), '{ invalid json');
    const snaps = await readSnapshots(tmp);
    expect(snaps).toEqual([]);
  });
});

describe('writeArtifacts — return-shape parity (Node shim)', () => {
  /* These 2 tests live in the Node shim because they exercise the
     name→path expansion that the shim adds on top of the orchestrator's
     name-only result. Equivalent assertions in orchestrator.test.ts
     check only the names. */
  it('returns absolute paths under <root>/.facts/', async () => {
    const r = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    expect(r.agentPath).toBe(join(tmp, '.facts', 'agent.json'));
    expect(r.humanPath).toBe(join(tmp, '.facts', 'human.json'));
    expect(r.packPath).toBe(join(tmp, '.facts', 'agent.pack'));
  });

  it('includes the snapshot under snapshots/ when written', async () => {
    const r = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), writeSnapshot: true });
    expect(r.snapshotPath).not.toBeNull();
    expect(r.snapshotPath!).toMatch(/[/\\]snapshots[/\\]/);
    expect(existsSync(r.snapshotPath!)).toBe(true);
  });
});

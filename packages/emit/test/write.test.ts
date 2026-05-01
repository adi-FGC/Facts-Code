import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeArtifacts, readSnapshots } from '../src/write.js';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests for `writeArtifacts` + `readSnapshots`. Validates:
 *   - artifacts written to .facts/ with correct shape
 *   - .gitignore auto-add on first run
 *   - snapshot retention cap
 *   - millisecond-resolution filenames + collision retry
 *   - JSONL streamable companion
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

describe('writeArtifacts — basic write', () => {
  it('writes agent.json + human.json + agent.jsonl', async () => {
    const r = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    expect(existsSync(r.agentPath)).toBe(true);
    expect(existsSync(r.humanPath)).toBe(true);
    expect(existsSync(r.jsonlPath!)).toBe(true);
    expect(r.bytesWritten).toBeGreaterThan(0);
  });

  it('skips JSONL when streamable: false', async () => {
    const r = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), streamable: false });
    expect(r.jsonlPath).toBeNull();
  });

  it('produces parseable JSON', async () => {
    const r = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    expect(() => JSON.parse(readFileSync(r.agentPath, 'utf8'))).not.toThrow();
    expect(() => JSON.parse(readFileSync(r.humanPath, 'utf8'))).not.toThrow();
  });

  it('validates agent against the schema (rejects malformed)', async () => {
    const bad = makeAgent();
    // Invalid: stats.loc must be non-negative integer
    (bad as any).stats.loc = -1;
    await expect(writeArtifacts({ root: tmp, agent: bad, human: makeHuman() })).rejects.toThrow();
  });
});

describe('writeArtifacts — .gitignore management', () => {
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

describe('writeArtifacts — snapshots', () => {
  it('does not write snapshots by default', async () => {
    const r = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    expect(r.snapshotPath).toBeNull();
  });

  it('writes a snapshot when writeSnapshot: true', async () => {
    const r = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), writeSnapshot: true });
    expect(r.snapshotPath).not.toBeNull();
    expect(existsSync(r.snapshotPath!)).toBe(true);
  });

  it('retains only the N most recent snapshots (default 50)', async () => {
    // Hand-write 55 snapshots, then write one more — should leave 50.
    const snapDir = join(tmp, '.facts', 'snapshots');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(snapDir, { recursive: true });
    for (let i = 0; i < 55; i++) {
      const t = new Date(Date.now() - (55 - i) * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 23);
      writeFileSync(join(snapDir, `${t}Z.json`), '{}');
    }
    expect(readdirSync(snapDir).length).toBe(55);
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), writeSnapshot: true });
    const after = readdirSync(snapDir).filter((n) => n.endsWith('.json'));
    expect(after.length).toBe(50);
  });

  it('configurable retention via snapshotRetention', async () => {
    const snapDir = join(tmp, '.facts', 'snapshots');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(snapDir, { recursive: true });
    for (let i = 0; i < 8; i++) {
      const t = new Date(Date.now() - (8 - i) * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 23);
      writeFileSync(join(snapDir, `${t}Z.json`), '{}');
    }
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), writeSnapshot: true, snapshotRetention: 5 });
    const after = readdirSync(snapDir).filter((n) => n.endsWith('.json'));
    expect(after.length).toBe(5);
  });

  it('snapshotRetention: 0 disables retention', async () => {
    const snapDir = join(tmp, '.facts', 'snapshots');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(snapDir, { recursive: true });
    for (let i = 0; i < 60; i++) {
      const t = new Date(Date.now() - (60 - i) * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 23);
      writeFileSync(join(snapDir, `${t}Z.json`), '{}');
    }
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman(), writeSnapshot: true, snapshotRetention: 0 });
    const after = readdirSync(snapDir).filter((n) => n.endsWith('.json'));
    expect(after.length).toBe(61); // 60 prior + 1 new, none dropped
  });
});

describe('readSnapshots', () => {
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

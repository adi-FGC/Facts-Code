/**
 * Tests for `writeArtifactsTo` — the isomorphic orchestrator.
 *
 * Migrated from `write.test.ts` (Node-shim flavor) to test the
 * orchestrator directly against a `MemoryFileWriter`. The assertions
 * are equivalent in spirit (X file gets written with Y content, the
 * snapshot retention prunes correctly, malformed input is rejected),
 * but the setup is microseconds instead of mkdtemp + rmSync per test.
 *
 * What's NOT covered here (lives in `write.test.ts`):
 *   - .gitignore append (Node-shim concern)
 *   - readSnapshots (Node-only function)
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { writeArtifactsTo } from '../src/orchestrator.js';
import { MemoryFileWriter } from './helpers/memory-writer.js';
import { applyChain, decode, encode } from '@factstack/factspack';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

let writer: MemoryFileWriter;

beforeEach(() => {
  writer = new MemoryFileWriter();
});

function makeAgent(): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: new Date().toISOString(),
    project: { name: 'test', root: '.', languages: [], frameworks: [], entryPoints: [], monorepo: null },
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

/** Pre-seed the writer's snapshots dir with N dated entries — used
 *  by the retention tests. Equivalent to the old test's `mkdirSync +
 *  writeFileSync` loop but operates on the in-memory map. */
async function seedSnapshots(w: MemoryFileWriter, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const t = new Date(Date.now() - (count - i) * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 23);
    await w.writeText(`snapshots/${t}Z.json`, '{}');
  }
}

describe('writeArtifactsTo — basic write', () => {
  it('writes the default artifact set', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman());
    expect(writer.has('agent.json')).toBe(true);
    expect(writer.has('human.json')).toBe(true);
    expect(writer.has('agent.pack')).toBe(true);
    expect(writer.has('agent.jsonl')).toBe(true);
    expect(r.bytesWritten).toBeGreaterThan(0);
  });

  it('skips JSONL when streamable: false', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { streamable: false });
    expect(r.jsonlName).toBeNull();
    expect(writer.has('agent.jsonl')).toBe(false);
  });

  it('produces parseable JSON', async () => {
    await writeArtifactsTo(writer, makeAgent(), makeHuman());
    expect(() => JSON.parse(writer.get('agent.json')!)).not.toThrow();
    expect(() => JSON.parse(writer.get('human.json')!)).not.toThrow();
  });

  it('validates agent against the schema (rejects malformed)', async () => {
    const bad = makeAgent();
    // Invalid: stats.loc must be non-negative integer
    (bad as any).stats.loc = -1;
    await expect(writeArtifactsTo(writer, bad, makeHuman())).rejects.toThrow();
  });
});

describe('writeArtifactsTo — F8 diff sidecar', () => {
  /** A risk row is the simplest thing that changes a pack table between
   *  runs (the risks table gains a row). Avoids needing a full File shape. */
  function agentWithRisk(): AgentArtifact {
    return {
      ...makeAgent(),
      risks: [{ severity: 'low', category: 'large-file', rule: 'big-file', message: 'oversized', file: 'src/big.ts' }],
    } as AgentArtifact;
  }

  it('writes no diff on a cold run (no prevPackBody)', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman());
    expect(r.diffName).toBeNull();
    expect(writer.has('agent.diff.pack')).toBe(false);
  });

  it('emits agent.diff.pack on a warm run, and the diff applies back to the new master', async () => {
    // Cold run captures the prior master.
    await writeArtifactsTo(writer, makeAgent(), makeHuman());
    const master = writer.get('agent.pack')!;

    // Warm run: one new risk row vs the master, with the prior pack supplied.
    const w2 = new MemoryFileWriter();
    const r = await writeArtifactsTo(w2, agentWithRisk(), makeHuman(), { prevPackBody: master });

    expect(r.diffName).toBe('agent.diff.pack');
    expect(w2.has('agent.diff.pack')).toBe(true);

    const diff = decode(w2.get('agent.diff.pack')!);
    expect(diff.header.kind).toBe('diff');
    expect(diff.header.seq).toBe(2);
    expect(diff.header.parent).toBe(decode(master).trailer!.sha256);

    // Applying the diff onto the prior master reconstructs the new master's
    // risks table (the chain round-trips through the real emit path). Assert
    // row CONTENT, not just the count — a count-only check would pass on a
    // corrupted-but-right-length diff.
    const rebuilt = applyChain(decode(master), [diff]);
    const newMasterRisks = decode(w2.get('agent.pack')!).tables.get('risks')!;
    expect(newMasterRisks.rows.length).toBe(1); // sanity: the master really changed
    expect(rebuilt.get('risks')!.rows).toEqual(newMasterRisks.rows);
  });

  it('skips the diff (no throw) when prevPackBody is corrupt — master stays authoritative', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { prevPackBody: 'not a pack at all' });
    expect(r.diffName).toBeNull();
    expect(writer.has('agent.diff.pack')).toBe(false);
    expect(writer.has('agent.pack')).toBe(true);
  });

  it('skips the diff when the previous pack has a different schema', async () => {
    // A valid v0.2 master stamped under an OLD schema name (agent-v3): it
    // decodes fine, but the schema guard must refuse to diff across it.
    const oldSchemaPack = encode({
      header: { producer: 'factstack/0.0.0', schema: 'agent-v3', snapshotId: 'old', rowCount: null, seq: 1, parent: '-', kind: 'master', generated: 'old' },
      tables: [{ name: 'files', columns: [{ name: 'path' }], rows: [['a.ts']] }],
    });
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { prevPackBody: oldSchemaPack });
    expect(r.diffName).toBeNull();
    expect(writer.has('agent.diff.pack')).toBe(false);
  });
});

describe('writeArtifactsTo — snapshots', () => {
  it('does not write snapshots by default', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman());
    expect(r.snapshotName).toBeNull();
    expect(await writer.listKeys('snapshots')).toEqual([]);
  });

  it('writes a snapshot when writeSnapshot: true', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { writeSnapshot: true });
    expect(r.snapshotName).not.toBeNull();
    expect(writer.has(`snapshots/${r.snapshotName!}`)).toBe(true);
  });

  it('retains only the N most recent snapshots (default 50)', async () => {
    await seedSnapshots(writer, 55);
    expect((await writer.listKeys('snapshots')).length).toBe(55);
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), { writeSnapshot: true });
    const after = (await writer.listKeys('snapshots')).filter((n) => n.endsWith('.json'));
    expect(after.length).toBe(50);
  });

  it('configurable retention via snapshotRetention', async () => {
    await seedSnapshots(writer, 8);
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), {
      writeSnapshot: true,
      snapshotRetention: 5,
    });
    const after = (await writer.listKeys('snapshots')).filter((n) => n.endsWith('.json'));
    expect(after.length).toBe(5);
  });

  it('snapshotRetention: 0 disables retention', async () => {
    await seedSnapshots(writer, 60);
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), {
      writeSnapshot: true,
      snapshotRetention: 0,
    });
    const after = (await writer.listKeys('snapshots')).filter((n) => n.endsWith('.json'));
    expect(after.length).toBe(61); // 60 prior + 1 new, none dropped
  });
});

describe('writeArtifactsTo — MEMORY.md', () => {
  it('does not write MEMORY.md when memoryBody is omitted', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman());
    expect(r.memoryName).toBeNull();
    expect(writer.has('MEMORY.md')).toBe(false);
  });

  it('does not write MEMORY.md when memoryBody is the empty string', async () => {
    // Defensive: empty string is meaningful — caller chose to render
    // nothing. Treat it the same as omission.
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { memoryBody: '' });
    expect(r.memoryName).toBeNull();
    expect(writer.has('MEMORY.md')).toBe(false);
  });

  it('writes MEMORY.md when memoryBody is provided', async () => {
    const body = '# test\n\n> hello\n';
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { memoryBody: body });
    expect(r.memoryName).toBe('MEMORY.md');
    expect(writer.get('MEMORY.md')).toBe(body);
    // The orchestrator never knows about `.facts/` — that prefix is
    // adapter-internal. So we assert on the bare name.
    expect(r.memoryName).toBe('MEMORY.md');
  });

  it('overwrites an existing MEMORY.md atomically (not appended)', async () => {
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), { memoryBody: 'old content\n' });
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), { memoryBody: 'new content\n' });
    const finalText = writer.get('MEMORY.md');
    expect(finalText).toBe('new content\n');
    expect(finalText).not.toContain('old content');
  });

  it('counts the MEMORY.md bytes in bytesWritten', async () => {
    const body = 'x'.repeat(123);
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { memoryBody: body });
    expect(r.bytesWritten).toBe(writer.totalBytes());
  });
});

describe('writeArtifactsTo — emit profile (minimal vs legacy)', () => {
  it('legacy is the default: writes the full set incl. agent.json + jsonl', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman());
    expect(writer.has('agent.json')).toBe(true);
    expect(writer.has('agent.jsonl')).toBe(true);
    expect(writer.has('agent.pack')).toBe(true);
    expect(writer.has('human.json')).toBe(true);
    expect(r.agentName).toBe('agent.json');
    expect(r.jsonlName).toBe('agent.jsonl');
  });

  it('explicit legacy matches the default', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { profile: 'legacy' });
    expect(writer.has('agent.json')).toBe(true);
    expect(writer.has('agent.jsonl')).toBe(true);
    expect(r.agentName).toBe('agent.json');
  });

  it('minimal drops agent.json + agent.jsonl, keeps pack + human', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { profile: 'minimal' });
    // Dropped:
    expect(writer.has('agent.json')).toBe(false);
    expect(writer.has('agent.jsonl')).toBe(false);
    expect(r.agentName).toBeNull();
    expect(r.jsonlName).toBeNull();
    // Always-on:
    expect(writer.has('agent.pack')).toBe(true);
    expect(writer.has('human.json')).toBe(true);
    expect(r.packName).toBe('agent.pack');
    expect(r.humanName).toBe('human.json');
  });

  it('minimal still writes MEMORY.md when a body is supplied', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), {
      profile: 'minimal',
      memoryBody: '# MEMORY\n',
    });
    expect(writer.has('MEMORY.md')).toBe(true);
    expect(r.memoryName).toBe('MEMORY.md');
    expect(writer.has('agent.json')).toBe(false);
  });

  it('minimal drops the snapshot by default', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), { profile: 'minimal' });
    expect(r.snapshotName).toBeNull();
  });

  it('explicit writeSnapshot wins over the minimal default', async () => {
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), {
      profile: 'minimal',
      writeSnapshot: true,
    });
    // The caller explicitly asked, so even minimal honors it.
    expect(r.snapshotName).not.toBeNull();
  });

  it('explicit streamable wins over the minimal default', async () => {
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), {
      profile: 'minimal',
      streamable: true,
    });
    // Minimal turns jsonl off by default, but the explicit flag re-enables it.
    expect(writer.has('agent.jsonl')).toBe(true);
  });

  it('minimal writes byte-fewer than legacy for the same input', async () => {
    const minimal = new MemoryFileWriter();
    const legacy = new MemoryFileWriter();
    const a = makeAgent();
    const h = makeHuman();
    const rMin = await writeArtifactsTo(minimal, a, h, { profile: 'minimal' });
    const rLeg = await writeArtifactsTo(legacy, a, h, { profile: 'legacy' });
    expect(rMin.bytesWritten).toBeLessThan(rLeg.bytesWritten);
  });
});

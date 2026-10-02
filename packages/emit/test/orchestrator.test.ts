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
import { encodeAgentPack } from '../src/pack.js';
import { StaleResaveError, packGeneratedAt, parseStaleMark } from '../src/stale-mark.js';
import { MemoryFileWriter } from './helpers/memory-writer.js';
import { applyChain, decode, encode } from '@factstack/factspack';
import {
  AgentArtifactSchema,
  BASELINE_AGENT_FILE,
  type AgentArtifact,
  type HumanArtifact,
} from '@factstack/spec';

let writer: MemoryFileWriter;

beforeEach(() => {
  writer = new MemoryFileWriter();
});

function makeAgent(): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: new Date().toISOString(),
    project: {
      name: 'test',
      root: '.',
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

function makeHuman(): HumanArtifact {
  return {
    $schema: 'https://factstack.dev/schema/human.v1.json',
    factsVersion: '0.1.0',
    generatedAt: new Date().toISOString(),
    summary: {
      oneLiner: 'x',
      intent: '',
      capabilities: [],
      entryPoints: [],
      health: { broken: 0, stale: 1, todos: 2, secrets: 0, headline: 'ok' },
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
    graph: {
      nodes: [],
      edges: [],
      cycles: [],
      symbolNodes: [],
      symbolEdges: [],
      entities: [],
      entityEdges: [],
    },
    activity: [],
    risks: [],
    glossary: [],
  };
}

/** Pre-seed the writer's snapshots dir with N dated entries — used
 *  by the retention tests. Equivalent to the old test's `mkdirSync +
 *  writeFileSync` loop but operates on the in-memory map. */
async function seedSnapshots(w: MemoryFileWriter, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const t = new Date(Date.now() - (count - i) * 1000)
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 23);
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
    bad.stats.loc = -1;
    await expect(writeArtifactsTo(writer, bad, makeHuman())).rejects.toThrow();
  });
});

describe('writeArtifactsTo — agent.json from an older producer (INV4 additive defaults)', () => {
  /* The raw on-disk shape the MCP CVE refresh passes in (readPriorAgent is a
     bare JSON.parse): an agent.json written before the additive fields
     existed. writeArtifactsTo only VALIDATES with AgentArtifactSchema.parse
     and encodes the raw object, so the encoder's `?? []` fallbacks run in
     production. Every other fixture spells the fields out; this one keeps
     them covered. Typed as the schema's input (zod 3 `_input`, i.e. z.input —
     emit has no zod dep), so only fields the schema really defaults can be
     dropped; cast to AgentArtifact once, the way the refresh hands it over. */
  function legacyAgent(): AgentArtifact {
    const a: (typeof AgentArtifactSchema)['_input'] = makeAgent();
    delete a.dependencyManifests;
    delete a.vulnerabilities;
    delete a.docs;
    delete a.rationale;
    delete a.graph.symbolNodes;
    delete a.graph.symbolEdges;
    delete a.graph.entities;
    delete a.graph.entityEdges;
    return a as AgentArtifact;
  }

  it('writes a decodable agent.pack with empty additive tables (no "not iterable")', async () => {
    const legacy = legacyAgent();
    // Sanity: really the old shape, not a default-filled one.
    expect(Object.keys(legacy)).not.toContain('rationale');
    expect(Object.keys(legacy.graph)).not.toContain('symbolNodes');
    const r = await writeArtifactsTo(writer, legacy, makeHuman());
    expect(r.packName).toBe('agent.pack');
    const pack = decode(writer.get('agent.pack')!);
    for (const t of ['symbols', 'calls', 'rationale', 'entities', 'entityEdges']) {
      expect(pack.tables.get(t)?.rows, t).toEqual([]);
    }
    // The fallbacks ARE the schema defaults: same bytes as the parsed shape.
    expect(writer.get('agent.pack')).toBe(encodeAgentPack(AgentArtifactSchema.parse(legacy)));
  });
});

describe('writeArtifactsTo — F8 diff sidecar', () => {
  /** A risk row is the simplest thing that changes a pack table between
   *  runs (the risks table gains a row). Avoids needing a full File shape. */
  function agentWithRisk(): AgentArtifact {
    return {
      ...makeAgent(),
      risks: [
        {
          severity: 'low',
          category: 'large-file',
          rule: 'big-file',
          message: 'oversized',
          file: 'src/big.ts',
        },
      ],
    };
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
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), {
      prevPackBody: 'not a pack at all',
    });
    expect(r.diffName).toBeNull();
    expect(writer.has('agent.diff.pack')).toBe(false);
    expect(writer.has('agent.pack')).toBe(true);
  });

  it('skips the diff when the previous pack has a different schema', async () => {
    // A valid v0.2 master stamped under an OLD schema name (agent-v3): it
    // decodes fine, but the schema guard must refuse to diff across it.
    const oldSchemaPack = encode({
      header: {
        producer: 'factstack/0.0.0',
        schema: 'agent-v3',
        snapshotId: 'old',
        rowCount: null,
        seq: 1,
        parent: '-',
        kind: 'master',
        generated: 'old',
      },
      tables: [{ name: 'files', columns: [{ name: 'path' }], rows: [['a.ts']] }],
    });
    const r = await writeArtifactsTo(writer, makeAgent(), makeHuman(), {
      prevPackBody: oldSchemaPack,
    });
    expect(r.diffName).toBeNull();
    expect(writer.has('agent.diff.pack')).toBe(false);
  });

  it('skips the diff when the previous pack is itself a diff, not a master (PACK-3)', async () => {
    // Produce a REAL diff pack the way the producer does (cold master → warm diff).
    await writeArtifactsTo(writer, makeAgent(), makeHuman());
    const masterA = writer.get('agent.pack')!;
    const w2 = new MemoryFileWriter();
    await writeArtifactsTo(w2, agentWithRisk(), makeHuman(), { prevPackBody: masterA });
    const realDiff = w2.get('agent.diff.pack')!;
    expect(decode(realDiff).header.kind).toBe('diff'); // sanity: it really is a diff

    // Feeding that diff (not a master) as the prev must NOT produce a
    // delta-of-a-delta — the consumer could never apply it. Master stays sole truth.
    const w3 = new MemoryFileWriter();
    const r = await writeArtifactsTo(w3, agentWithRisk(), makeHuman(), { prevPackBody: realDiff });
    expect(r.diffName).toBeNull();
    expect(w3.has('agent.diff.pack')).toBe(false);
    expect(w3.has('agent.pack')).toBe(true);
  });

  it('removes a stale agent.diff.pack when this run writes no diff (it would describe an older master)', async () => {
    // Run A (cold) then run B (diff A→B) on the SAME .facts dir.
    await writeArtifactsTo(writer, makeAgent(), makeHuman());
    const masterA = writer.get('agent.pack')!;
    await writeArtifactsTo(writer, agentWithRisk(), makeHuman(), { prevPackBody: masterA });
    expect(writer.has('agent.diff.pack')).toBe(true);

    // Run C cannot diff (unusable prev / no prev): the A→B sidecar must go,
    // or sync_pack serves it next to master C and the client silently desyncs.
    for (const opts of [{ prevPackBody: 'not a pack at all' }, {}]) {
      await writeArtifactsTo(writer, agentWithRisk(), makeHuman(), opts);
      expect(writer.has('agent.diff.pack')).toBe(false);
      await writeArtifactsTo(writer, agentWithRisk(), makeHuman(), { prevPackBody: masterA });
      expect(writer.has('agent.diff.pack')).toBe(true); // re-seed for the next case
    }
  });

  it('drops the old sidecar BEFORE the new master lands (no new-master + old-diff window)', async () => {
    const ops: string[] = [];
    class Recording extends MemoryFileWriter {
      override async writeText(p: string, body: string): Promise<number> {
        ops.push(`write ${p}`);
        return super.writeText(p, body);
      }
      override async removeEntry(dir: string, name: string): Promise<void> {
        ops.push(`remove ${name}`);
        return super.removeEntry(dir, name);
      }
    }
    const w = new Recording();
    await w.writeText('agent.diff.pack', 'stale');
    await writeArtifactsTo(w, makeAgent(), makeHuman());
    expect(ops.indexOf('remove agent.diff.pack')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('remove agent.diff.pack')).toBeLessThan(ops.indexOf('write agent.pack'));
    expect(w.has('agent.diff.pack')).toBe(false);
  });

  it('says why no diff was written instead of swallowing it (diffSkipped)', async () => {
    await writeArtifactsTo(writer, makeAgent(), makeHuman());
    const master = writer.get('agent.pack')!;
    const skipped = async (prevPackBody: string | undefined): Promise<string | undefined> =>
      (
        await writeArtifactsTo(new MemoryFileWriter(), agentWithRisk(), makeHuman(), {
          ...(prevPackBody !== undefined && { prevPackBody }),
        })
      ).diffSkipped;

    expect(await skipped(undefined)).toBeUndefined(); // cold run: nothing to explain
    expect(await skipped(master)).toBeUndefined(); // the diff was written
    expect(await skipped('not a pack at all')).toMatch(/^previous agent\.pack is unreadable: /);
    const oldSchema = encode({
      header: {
        producer: 'factstack/0.0.0',
        schema: 'agent-v3',
        snapshotId: 'old',
        rowCount: null,
        seq: 1,
        parent: '-',
        kind: 'master',
        generated: 'old',
      },
      tables: [{ name: 'files', columns: [{ name: 'path' }], rows: [['a.ts']] }],
    });
    expect(await skipped(oldSchema)).toBe('pack schema changed (agent-v3 → agent-v4)');
    const w = new MemoryFileWriter();
    await writeArtifactsTo(w, agentWithRisk(), makeHuman(), { prevPackBody: master });
    expect(await skipped(w.get('agent.diff.pack')!)).toBe(
      'previous agent.pack is a diff, not a master',
    );
  });

  it('surfaces a computeDiff failure (duplicate primary key) and still writes the master', async () => {
    /* data-model#3: duplicate column-0 ids made computeDiff throw, which was
       swallowed — every consumer silently lost the small diff. A prev master
       whose risks table repeats one id reproduces the throw. */
    const dupPrev = encode({
      header: {
        producer: 'factstack/0.3.10',
        schema: 'agent-v4',
        snapshotId: 'prev',
        rowCount: null,
        seq: 1,
        parent: '-',
        kind: 'master',
        generated: 'prev',
      },
      tables: [
        {
          name: 'risks',
          columns: [{ name: 'id' }, { name: 'sev' }],
          rows: [
            ['0', 'low'],
            ['0', 'high'],
          ],
        },
      ],
    });
    const r = await writeArtifactsTo(writer, agentWithRisk(), makeHuman(), {
      prevPackBody: dupPrev,
    });
    expect(r.diffName).toBeNull();
    expect(r.diffSkipped).toMatch(/^computing the diff failed: .*duplicate primary key/);
    expect(r.diffSkipped!.length).toBeLessThanOrEqual(240);
    expect(writer.has('agent.pack')).toBe(true);
    expect(writer.has('agent.diff.pack')).toBe(false);
  });

  it('a locked stale sidecar (Windows EBUSY) never aborts the write or splits the set (EMIT-R3)', async () => {
    const ops: string[] = [];
    class Locked extends MemoryFileWriter {
      override async writeText(p: string, body: string): Promise<number> {
        ops.push(p);
        return super.writeText(p, body);
      }
      override async removeEntry(_dir: string, name: string): Promise<void> {
        ops.push(`remove ${name}`);
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
    }
    const w = new Locked();
    const r = await writeArtifactsTo(w, makeAgent(), makeHuman(), { memoryBody: '# m\n' });
    expect(r.packName).toBe('agent.pack');
    for (const f of ['agent.json', 'human.json', 'agent.pack', 'agent.jsonl', 'MEMORY.md']) {
      expect(w.has(f)).toBe(true);
    }
    // The removal is tried before ANY artifact write, so a failure cannot split the set.
    expect(ops[0]).toBe('remove agent.diff.pack');
  });
});

describe('writeArtifactsTo — review baseline (keep-1 previous agent.json)', () => {
  it('copies the previous agent.json to baseline/agent.json just before replacing it', async () => {
    const ops: string[] = [];
    class Recording extends MemoryFileWriter {
      override async writeText(p: string, body: string): Promise<number> {
        ops.push(p);
        return super.writeText(p, body);
      }
    }
    const w = new Recording();
    await writeArtifactsTo(w, makeAgent(), makeHuman());
    const first = w.get('agent.json')!;
    expect(w.has(BASELINE_AGENT_FILE)).toBe(false); // nothing to keep on a cold run

    const later = { ...makeAgent(), generatedAt: '2999-01-01T00:00:00.000Z' };
    await writeArtifactsTo(w, later, makeHuman(), { prevAgentBody: first });
    expect(w.get(BASELINE_AGENT_FILE)).toBe(first);
    expect(ops.lastIndexOf(BASELINE_AGENT_FILE)).toBeLessThan(ops.lastIndexOf('agent.json'));
  });

  it('keeps exactly one baseline — the next run replaces it', async () => {
    const body = (n: number): string => `{"generatedAt":"run-${n}"}`;
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), { prevAgentBody: body(1) });
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), { prevAgentBody: body(2) });
    expect(writer.get(BASELINE_AGENT_FILE)).toBe(body(2));
    expect(await writer.listKeys('baseline')).toEqual(['agent.json']);
  });

  it('does not rotate the baseline when no agent.json is written (fresh minimal)', async () => {
    await writeArtifactsTo(writer, makeAgent(), makeHuman(), {
      profile: 'minimal',
      prevAgentBody: '{"run":1}',
    });
    expect(writer.has(BASELINE_AGENT_FILE)).toBe(false);
  });

  /** One analyze run on `writer`, fed the agent.json on disk the way the shims
   *  pre-read it. Distinct generatedAt per run (two runs can share a ms). */
  async function run(n: number, profile: 'legacy' | 'minimal'): Promise<string> {
    const agent = { ...makeAgent(), generatedAt: `2026-09-24T09:00:0${n}.000Z` };
    const prevAgentBody = writer.get('agent.json');
    await writeArtifactsTo(writer, agent, makeHuman(), {
      profile,
      ...(prevAgentBody !== undefined && { prevAgentBody }),
    });
    return agent.generatedAt;
  }
  const baselineAt = (): string | null =>
    writer.has(BASELINE_AGENT_FILE)
      ? (JSON.parse(writer.get(BASELINE_AGENT_FILE)!) as AgentArtifact).generatedAt
      : null;

  it('per-edit --minimal runs never touch agent.json or the baseline (EMIT-R1, performance#1)', async () => {
    const first = await run(1, 'legacy');
    const full = await run(2, 'legacy');
    expect(baselineAt()).toBe(first);
    await run(3, 'minimal');
    await run(4, 'minimal');
    await run(5, 'minimal');
    expect(baselineAt()).toBe(first); // no hook run ever becomes "one edit ago"
    // agent.json is still the last FULL analysis (marked stale, see below).
    expect(JSON.parse(writer.get('agent.json')!).generatedAt).toBe(full);
    await run(6, 'legacy');
    expect(baselineAt()).toBe(full); // the pre-streak full analysis, parked by the full run
  });

  it('a full analyze after a hook streak keeps the pre-streak baseline, then rotates normally', async () => {
    const full = await run(1, 'legacy');
    await run(2, 'minimal');
    await run(3, 'minimal');
    const next = await run(4, 'legacy'); // agent.json was still run 1: parked
    expect(baselineAt()).toBe(full);
    const last = await run(5, 'legacy');
    expect(baselineAt()).toBe(next);
    await run(6, 'minimal');
    expect(baselineAt()).toBe(next); // minimal replaces no agent.json, so parks nothing
    expect(JSON.parse(writer.get('agent.json')!).generatedAt).toBe(last);
  });

  it('re-writing the SAME analysis (scan-vulns) keeps the older baseline (EMIT-R2)', async () => {
    const first = await run(1, 'legacy');
    const second = await run(2, 'legacy');
    expect(baselineAt()).toBe(first);
    // scan-vulns / MCP CVE refresh: same generatedAt, new vulnerabilities.
    const head = JSON.parse(writer.get('agent.json')!) as AgentArtifact;
    await writeArtifactsTo(writer, { ...head, vulnerabilities: [] }, makeHuman(), {
      prevAgentBody: writer.get('agent.json')!,
    });
    expect(baselineAt()).toBe(first); // not a copy of the head (MCP rejects that)
    expect(JSON.parse(writer.get('agent.json')!).generatedAt).toBe(second);
  });

  it('a stale re-save (rotateBaseline:false after a hook run) is refused and writes nothing', async () => {
    /* scan-vulns / the MCP CVE refresh load agent.json, which after a hook
       run is OLDER than agent.pack. Re-saving it used to revert agent.pack,
       human.json and MEMORY.md to that older analysis. */
    const full = await run(1, 'legacy');
    const hook = await run(2, 'minimal');
    const stale = JSON.parse(writer.get('agent.json')!) as AgentArtifact;
    expect(stale.generatedAt).toBe(full);
    const before = new Map(writer.files);
    const err = await writeArtifactsTo(writer, { ...stale, vulnerabilities: [] }, makeHuman(), {
      prevPackBody: writer.get('agent.pack')!,
      rotateBaseline: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleResaveError);
    expect(err).toMatchObject({
      code: 'FACTS_STALE_RESAVE',
      resaveAt: full,
      packAt: hook,
      resave: true, // agent.json holds exactly this analysis
    });
    expect((err as Error).message).toMatch(
      /^not re-saving the analysis .*agent\.json is stale\. Run `factstack analyze`, then retry/,
    );
    expect(writer.files).toEqual(before); // not even the diff sidecar was dropped
    expect(packGeneratedAt(writer.get('agent.pack')!)).toBe(hook);
  });

  it('a re-save of the CURRENT analysis (rotateBaseline:false) still lands', async () => {
    await run(1, 'legacy');
    const head = await run(2, 'legacy');
    const cur = JSON.parse(writer.get('agent.json')!) as AgentArtifact;
    const r = await writeArtifactsTo(writer, { ...cur, vulnerabilities: [] }, makeHuman(), {
      prevPackBody: writer.get('agent.pack')!,
      rotateBaseline: false,
    });
    expect(r.agentName).toBe('agent.json');
    expect(packGeneratedAt(writer.get('agent.pack')!)).toBe(head);
  });

  it('a NEW analysis overtaken by a hook run is refused without blaming agent.json (EMIT-REV-2)', async () => {
    /* The CLI refresh (ui --watch, Re-analyze during a hold) and the MCP
       warm-up also write with rotateBaseline:false. Their analysis is new —
       agent.json holds an older one — so "not re-saving … agent.json is
       stale" misled (it reached the ui as an HTTP 500 body). */
    const full = await run(1, 'legacy');
    const hook = await run(3, 'minimal');
    const overtaken = { ...makeAgent(), generatedAt: '2026-09-24T09:00:02.000Z' }; // began before the hook run
    const before = new Map(writer.files);
    const err = await writeArtifactsTo(writer, overtaken, makeHuman(), {
      prevPackBody: writer.get('agent.pack')!,
      rotateBaseline: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleResaveError);
    expect(err).toMatchObject({
      code: 'FACTS_STALE_RESAVE',
      resaveAt: overtaken.generatedAt,
      packAt: hook,
      resave: false,
    });
    const msg = (err as Error).message;
    expect(msg).toMatch(/^not writing the analysis from .*written while it ran/);
    expect(msg).toMatch(/nothing was written\. Run the analysis again\.$/);
    expect(msg).not.toMatch(/re-saving|agent\.json is stale/);
    expect(writer.files).toEqual(before);
    expect(JSON.parse(writer.get('agent.json')!).generatedAt).toBe(full);

    // No agent.json at all (a pure --minimal project): a new analysis too.
    const bare = new MemoryFileWriter();
    await writeArtifactsTo(bare, { ...makeAgent(), generatedAt: hook }, makeHuman(), {
      profile: 'minimal',
    });
    await expect(
      writeArtifactsTo(bare, overtaken, makeHuman(), {
        prevPackBody: bare.get('agent.pack')!,
        rotateBaseline: false,
      }),
    ).rejects.toMatchObject({ resave: false });
  });

  it('refuseUnderNewerPack decouples the guard from rotateBaseline (EMIT-REV-2)', async () => {
    const first = await run(1, 'legacy');
    await run(2, 'legacy');
    const hook = await run(4, 'minimal');
    const older = { ...makeAgent(), generatedAt: '2026-09-24T09:00:03.000Z' };

    // A rotating write can opt in: refused before anything is parked or written.
    const before = new Map(writer.files);
    await expect(
      writeArtifactsTo(writer, older, makeHuman(), {
        prevPackBody: writer.get('agent.pack')!,
        prevAgentBody: writer.get('agent.json')!,
        refuseUnderNewerPack: true,
      }),
    ).rejects.toMatchObject({ code: 'FACTS_STALE_RESAVE', packAt: hook, resave: false });
    expect(writer.files).toEqual(before);

    // A non-rotating write can opt out: last writer wins, the baseline stays.
    const r = await writeArtifactsTo(writer, older, makeHuman(), {
      prevPackBody: writer.get('agent.pack')!,
      rotateBaseline: false,
      refuseUnderNewerPack: false,
    });
    expect(r.agentName).toBe('agent.json');
    expect(packGeneratedAt(writer.get('agent.pack')!)).toBe(older.generatedAt);
    expect(baselineAt()).toBe(first);
    expect(writer.has('agent.json.stale')).toBe(false); // it refreshed agent.json
  });

  it('rotateBaseline:false leaves the baseline alone even with a new generatedAt', async () => {
    /* scan-vulns / the MCP CVE refresh re-save an analysis already on disk.
       Even when the re-saved artifact carries a fresh generatedAt, it must
       not push the real previous analysis out of the baseline. */
    const first = await run(1, 'legacy');
    await run(2, 'legacy');
    const head = JSON.parse(writer.get('agent.json')!) as AgentArtifact;
    await writeArtifactsTo(
      writer,
      { ...head, generatedAt: '2026-09-24T09:00:09.000Z', vulnerabilities: [] },
      makeHuman(),
      { prevAgentBody: writer.get('agent.json')!, rotateBaseline: false },
    );
    expect(baselineAt()).toBe(first);
    expect(JSON.parse(writer.get('agent.json')!).generatedAt).toBe('2026-09-24T09:00:09.000Z');
  });

  it('a minimal-head mark an earlier build left keeps that hook head out of the baseline, once', async () => {
    /* Earlier builds' --minimal rewrote agent.json and marked it
       baseline/minimal-head. The first full run after upgrading must not
       park that hook head; it drops the mark, then rotation is normal. */
    const mark = 'baseline/minimal-head';
    const full = await run(1, 'legacy');
    await run(2, 'legacy');
    expect(baselineAt()).toBe(full);
    // What an earlier build's hook run left: its own head, plus the mark.
    await writer.writeText('agent.json', JSON.stringify({ ...makeAgent(), generatedAt: 'hook' }));
    await writer.writeText(mark, 'agent.json is from a --minimal run\n');
    const next = await run(3, 'legacy');
    expect(baselineAt()).toBe(full); // the old hook head was not parked
    expect(writer.has(mark)).toBe(false);
    await run(4, 'legacy');
    expect(baselineAt()).toBe(next);
    // A minimal run never creates the old mark.
    await run(5, 'minimal');
    expect(writer.has(mark)).toBe(false);
  });

  it('never parks an unparseable agent.json over a good baseline', async () => {
    const first = await run(1, 'legacy');
    await run(2, 'legacy');
    await writer.writeText('agent.json', '{"truncated":');
    await run(3, 'legacy');
    expect(baselineAt()).toBe(first);
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

describe('writeArtifactsTo — --minimal after a full run: stale marks, not rewrites (performance#1)', () => {
  /** Records every mutation, in order. */
  class Recording extends MemoryFileWriter {
    readonly ops: string[] = [];
    override async writeText(p: string, body: string): Promise<number> {
      this.ops.push(`write ${p}`);
      return super.writeText(p, body);
    }
    override async removeEntry(dir: string, name: string): Promise<void> {
      this.ops.push(`remove ${dir ? `${dir}/` : ''}${name}`);
      return super.removeEntry(dir, name);
    }
  }
  const at = (n: number): string => `2026-09-24T11:00:0${n}.000Z`;
  const agentAt = (n: number): AgentArtifact => ({ ...makeAgent(), generatedAt: at(n) });
  const writes = (w: Recording): string[] =>
    w.ops.filter((o) => o.startsWith('write ')).map((o) => o.slice(6));

  it('leaves a full run’s agent.json + agent.jsonl untouched and marks both stale first', async () => {
    /* The per-edit hook rewrote the multi-MB agent.json + agent.jsonl on every
       edit once any full analyze had run (8.09 MB vs 1.62 MB per edit). */
    const w = new Recording();
    await writeArtifactsTo(w, agentAt(1), makeHuman());
    const json = w.get('agent.json');
    const jsonl = w.get('agent.jsonl');
    w.ops.length = 0;

    const r = await writeArtifactsTo(w, agentAt(2), makeHuman(), { profile: 'minimal' });
    expect(writes(w)).toEqual([
      'agent.json.stale',
      'agent.jsonl.stale',
      'human.json',
      'agent.pack',
    ]);
    expect(w.get('agent.json')).toBe(json);
    expect(w.get('agent.jsonl')).toBe(jsonl);
    expect(r.agentName).toBeNull();
    expect(r.jsonlName).toBeNull();
    expect(r.staleLeft).toEqual(['agent.json', 'agent.jsonl']);
    expect(parseStaleMark('agent.json', w.get('agent.json.stale')!)).toEqual({
      file: 'agent.json',
      staleSince: at(2),
    });
    expect(parseStaleMark('agent.jsonl', w.get('agent.jsonl.stale')!).staleSince).toBe(at(2));
  });

  it('later hook runs write no raw JSON and no mark: staleSince stays the first newer run', async () => {
    const w = new Recording();
    await writeArtifactsTo(w, agentAt(1), makeHuman());
    await writeArtifactsTo(w, agentAt(2), makeHuman(), { profile: 'minimal' });
    w.ops.length = 0;
    const r = await writeArtifactsTo(w, agentAt(3), makeHuman(), { profile: 'minimal' });
    expect(writes(w)).toEqual(['human.json', 'agent.pack']);
    expect(r.staleLeft).toEqual(['agent.json', 'agent.jsonl']);
    expect(parseStaleMark('agent.json', w.get('agent.json.stale')!).staleSince).toBe(at(2));
  });

  it('a full run refreshes both files, then clears their marks', async () => {
    const w = new Recording();
    await writeArtifactsTo(w, agentAt(1), makeHuman());
    await writeArtifactsTo(w, agentAt(2), makeHuman(), { profile: 'minimal' });
    w.ops.length = 0;
    const r = await writeArtifactsTo(w, agentAt(3), makeHuman());
    expect(JSON.parse(w.get('agent.json')!).generatedAt).toBe(at(3));
    expect(w.has('agent.json.stale')).toBe(false);
    expect(w.has('agent.jsonl.stale')).toBe(false);
    expect(r.staleLeft).toBeUndefined();
    // Each mark goes only after its own file landed…
    expect(w.ops.indexOf('remove agent.json.stale')).toBeGreaterThan(
      w.ops.indexOf('write agent.json'),
    );
    expect(w.ops.indexOf('remove agent.jsonl.stale')).toBeGreaterThan(
      w.ops.indexOf('write agent.jsonl'),
    );
    // …and before this run's pack (EMIT-REV-6: see the interleaving tests).
    expect(w.ops.indexOf('remove agent.jsonl.stale')).toBeLessThan(
      w.ops.indexOf('write agent.pack'),
    );
  });

  /** A second process interleaving: `interleave.run` goes once, just before
   *  or just after the next write of `interleave.on`. */
  class Interleaved extends MemoryFileWriter {
    interleave: { on: string; when: 'before' | 'after'; run: () => Promise<unknown> } | null = null;
    override async writeText(p: string, body: string): Promise<number> {
      const i = this.interleave?.on === p ? this.interleave : null;
      if (i) this.interleave = null; // once: the other run writes `on` too
      if (i?.when === 'before') await i.run();
      const n = await super.writeText(p, body);
      if (i?.when === 'after') await i.run();
      return n;
    }
  }
  /** Full analysis `n` over whatever `w` holds, fed agent.json like the shims. */
  const fullRun = (w: MemoryFileWriter, n: number) => () =>
    writeArtifactsTo(w, agentAt(n), makeHuman(), { prevAgentBody: w.get('agent.json')! });
  const hookRun = (w: MemoryFileWriter, n: number) => () =>
    writeArtifactsTo(w, agentAt(n), makeHuman(), { profile: 'minimal' });
  const marked = (w: MemoryFileWriter): boolean[] =>
    ['agent.json.stale', 'agent.jsonl.stale'].map((m) => w.has(m));

  it('a full run clearing the marks mid-hook-run cannot leave them off beside a newer pack (EMIT-REV-6)', async () => {
    /* The reviewer's interleaving: hook run M (4) lists the root and sees the
       marks, so skips writing them; a full run F (3) then lands agent.json
       and clears the marks; then M's newer pack lands. */
    const w = new Interleaved();
    await fullRun(w, 1)();
    await hookRun(w, 2)();
    w.interleave = { on: 'agent.pack', when: 'before', run: fullRun(w, 3) };
    const r = await hookRun(w, 4)();
    expect(JSON.parse(w.get('agent.json')!).generatedAt).toBe(at(3));
    expect(packGeneratedAt(w.get('agent.pack')!)).toBe(at(4));
    expect(marked(w)).toEqual([true, true]); // was [false, false]: silently stale
    expect(parseStaleMark('agent.json', w.get('agent.json.stale')!).staleSince).toBe(at(4));
    expect(r.staleLeft).toEqual(['agent.json', 'agent.jsonl']);
  });

  it('a hook run landing right after a full run’s pack keeps both marks (EMIT-REV-6)', async () => {
    /* A full run used to clear agent.jsonl's mark AFTER its pack: a hook run
       landing in between saw the mark, skipped it, and the full run then
       removed it beside the hook's newer pack. */
    const w = new Interleaved();
    await fullRun(w, 1)();
    await hookRun(w, 2)();
    w.interleave = { on: 'agent.pack', when: 'after', run: hookRun(w, 4) };
    await fullRun(w, 3)();
    expect(packGeneratedAt(w.get('agent.pack')!)).toBe(at(4));
    expect(JSON.parse(w.get('agent.json')!).generatedAt).toBe(at(3));
    expect(marked(w)).toEqual([true, true]);
  });

  it('the post-pack check marks nothing once a later full run replaced this pack (EMIT-REV-6)', async () => {
    /* No false "stale": when a whole full run lands between this hook run's
       pack and its re-check, agent.json and the pack are that run's pair. */
    const w = new Interleaved();
    await fullRun(w, 1)();
    await hookRun(w, 2)();
    w.interleave = { on: 'agent.pack', when: 'after', run: fullRun(w, 3) };
    await hookRun(w, 4)();
    expect(packGeneratedAt(w.get('agent.pack')!)).toBe(at(3));
    expect(JSON.parse(w.get('agent.json')!).generatedAt).toBe(at(3));
    expect(marked(w)).toEqual([false, false]);

    // A writer that cannot read the pack back cannot tell: it marks (safe side).
    const blind = new Interleaved();
    Object.defineProperty(blind, 'readText', { value: undefined });
    await fullRun(blind, 1)();
    await hookRun(blind, 2)();
    blind.interleave = { on: 'agent.pack', when: 'after', run: fullRun(blind, 3) };
    await hookRun(blind, 4)();
    expect(marked(blind)).toEqual([true, true]);
  });

  it('streamable:false marks a leftover agent.jsonl; the next streamable run clears it', async () => {
    await writeArtifactsTo(writer, agentAt(1), makeHuman());
    const r = await writeArtifactsTo(writer, agentAt(2), makeHuman(), { streamable: false });
    expect(r.staleLeft).toEqual(['agent.jsonl']);
    expect(writer.has('agent.jsonl.stale')).toBe(true);
    expect(writer.has('agent.json.stale')).toBe(false);
    await writeArtifactsTo(writer, agentAt(3), makeHuman());
    expect(writer.has('agent.jsonl.stale')).toBe(false);
  });

  it('explicit streamable:true under minimal refreshes agent.jsonl and marks only agent.json', async () => {
    await writeArtifactsTo(writer, agentAt(1), makeHuman());
    const r = await writeArtifactsTo(writer, agentAt(2), makeHuman(), {
      profile: 'minimal',
      streamable: true,
    });
    expect(r.jsonlName).toBe('agent.jsonl');
    expect(r.staleLeft).toEqual(['agent.json']);
    expect(writer.has('agent.jsonl.stale')).toBe(false);
  });

  it('a fresh minimal project gets no marks; a mark whose file is gone is dropped', async () => {
    const r = await writeArtifactsTo(writer, agentAt(1), makeHuman(), { profile: 'minimal' });
    expect(r.staleLeft).toBeUndefined();
    expect([...writer.files.keys()].some((k) => k.endsWith('.stale'))).toBe(false);

    await writer.writeText('agent.json.stale', '{}'); // its agent.json was deleted by hand
    await writeArtifactsTo(writer, agentAt(2), makeHuman(), { profile: 'minimal' });
    expect(writer.has('agent.json.stale')).toBe(false);
  });

  it('a failed root listing still marks (the safe side), without claiming staleLeft', async () => {
    class NoList extends MemoryFileWriter {
      override async listKeys(dir: string): Promise<string[]> {
        if (dir === '') throw new Error('EACCES');
        return super.listKeys(dir);
      }
    }
    const w = new NoList();
    const r = await writeArtifactsTo(w, agentAt(1), makeHuman(), { profile: 'minimal' });
    expect(w.has('agent.json.stale')).toBe(true);
    expect(w.has('agent.jsonl.stale')).toBe(true);
    expect(r.staleLeft).toBeUndefined();
  });

  it('a failing mark write aborts before the newer pack lands (never silently stale)', async () => {
    class MarkFails extends MemoryFileWriter {
      override async writeText(p: string, body: string): Promise<number> {
        if (p.endsWith('.stale')) throw new Error('EPERM');
        return super.writeText(p, body);
      }
    }
    const w = new MarkFails();
    await writeArtifactsTo(w, agentAt(1), makeHuman());
    const pack = w.get('agent.pack');
    await expect(
      writeArtifactsTo(w, agentAt(2), makeHuman(), { profile: 'minimal' }),
    ).rejects.toThrow('EPERM');
    expect(w.get('agent.pack')).toBe(pack);
  });
});

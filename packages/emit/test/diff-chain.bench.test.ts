/**
 * F8 diff-chain benchmark (task #179) — the warm re-analyze win, as a
 * deterministic assertion.
 *
 * Runs a representative repo through the REAL emit path twice: a cold run
 * (full master, no prior pack) and a warm run (a handful of changed rows,
 * with the prior master supplied). It then measures `agent.diff.pack`
 * against `agent.pack` and asserts the diff is a small fraction of the
 * master — the whole point of the feature: a consumer holding the master
 * ingests a few hundred bytes instead of re-reading the whole pack.
 *
 * Doubling as a correctness check: the diff is applied back onto the prior
 * master and must reconstruct the new master's tables (round-trip), so the
 * "it's smaller" number can never come at the cost of "it's wrong".
 *
 * The numbers print to the test log so the benchmark is legible, not just
 * a pass/fail. They are not asserted exactly (byte counts shift with the
 * schema); the RATIO is what's pinned.
 */
import { describe, expect, it } from 'vitest';
import { writeArtifactsTo } from '../src/orchestrator.js';
import { MemoryFileWriter } from './helpers/memory-writer.js';
import { applyChain, decode } from '@factstack/factspack';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

function baseAgent(): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: new Date().toISOString(),
    project: { name: 'bench', root: '.', languages: [], frameworks: [], entryPoints: [], monorepo: null },
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
    summary: { oneLiner: 'bench', intent: '', capabilities: [], entryPoints: [], health: { broken: 0, stale: 0, todos: 0, secrets: 0, headline: 'ok' } },
    stack: [],
    tree: { id: 'root', name: 'root', path: '.', kind: 'directory', language: null, loc: 0, tokenCost: 0, bundleSizeGzip: null, status: 'ok', children: [] },
    graph: { nodes: [], edges: [], cycles: [] },
    activity: [],
    risks: [],
    glossary: [],
  } as HumanArtifact;
}

/** A repo whose pack has `n` risk rows — a realistic stand-in for a
 *  few-hundred-finding analysis. The warm run adds a few more. */
function agentWithRisks(n: number): AgentArtifact {
  return {
    ...baseAgent(),
    risks: Array.from({ length: n }, (_, i) => ({
      severity: 'low',
      category: 'large-file',
      rule: 'oversized',
      message: `file src/module-${i}/component-${i}.ts exceeds the size budget`,
      file: `src/module-${i}/component-${i}.ts`,
      line: i + 1,
    })),
  } as AgentArtifact;
}

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

describe('F8 diff-chain benchmark — warm re-analyze size win', () => {
  it('a few-row change produces a diff that is a small fraction of the master', async () => {
    const COLD = 250; // findings in the baseline analysis
    const CHANGED = 5; // findings added on the warm re-analyze

    // Cold run — full master, no prior pack.
    const w1 = new MemoryFileWriter();
    await writeArtifactsTo(w1, agentWithRisks(COLD), makeHuman());
    const master = w1.get('agent.pack')!;

    // Warm run — same repo plus CHANGED new findings, prior master supplied.
    const w2 = new MemoryFileWriter();
    const r = await writeArtifactsTo(w2, agentWithRisks(COLD + CHANGED), makeHuman(), { prevPackBody: master });
    const diff = w2.get('agent.diff.pack')!;

    const masterBytes = bytes(master);
    const diffBytes = bytes(diff);
    const ratio = diffBytes / masterBytes;
    // eslint-disable-next-line no-console
    console.log(
      `[F8 bench] master=${masterBytes}B  diff=${diffBytes}B  ratio=${(ratio * 100).toFixed(1)}%  ` +
        `(${COLD} findings, +${CHANGED} changed)`,
    );

    expect(r.diffName).toBe('agent.diff.pack');
    // The win: the diff is well under a fifth of the master. In practice it's
    // a couple percent; 20% is a deliberately loose guard against schema drift.
    expect(diffBytes * 5).toBeLessThan(masterBytes);

    // Correctness: the diff applies back onto the prior master to reproduce
    // the new master's risks table — small AND right. Compare CONTENT as an
    // order-independent set (applyChain doesn't promise the master's row
    // order), so the size win can never come at the cost of wrong data.
    const rebuilt = applyChain(decode(master), [decode(diff)]);
    const newMasterRisks = decode(w2.get('agent.pack')!).tables.get('risks')!;
    expect(newMasterRisks.rows.length).toBe(COLD + CHANGED);
    const asSet = (rows: readonly (readonly (string | null)[])[]) => rows.map((r) => JSON.stringify(r)).sort();
    expect(asSet(rebuilt.get('risks')!.rows)).toEqual(asSet(newMasterRisks.rows));
  });
});

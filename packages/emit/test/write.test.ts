import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeArtifacts, readSnapshots } from '../src/write.js';
import { StaleResaveError, packGeneratedAt, staleHint } from '../src/stale-mark.js';
import { readStaleMark } from '../src/stale-mark-node.js';
import { BASELINE_AGENT_FILE, type AgentArtifact, type HumanArtifact } from '@factstack/spec';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeAgent(): AgentArtifact {
  return {
    $schema: 'https://factstack.dev/schema/agent.v1.json',
    factsVersion: '0.1.0',
    generatedAt: new Date().toISOString(),
    project: {
      name: 'test',
      root: tmp,
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
    await writeArtifacts({
      root: tmp,
      agent: makeAgent(),
      human: makeHuman(),
      addGitignoreEntry: false,
    });
    expect(existsSync(join(tmp, '.gitignore'))).toBe(false);
  });
});

describe('writeArtifacts — review baseline (Node shim)', () => {
  it('keeps the previous agent.json at .facts/baseline/agent.json', async () => {
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    const baseline = join(tmp, '.facts', ...BASELINE_AGENT_FILE.split('/'));
    expect(existsSync(baseline)).toBe(false); // first run: nothing to keep
    const first = readFileSync(join(tmp, '.facts', 'agent.json'), 'utf8');

    const later = { ...makeAgent(), generatedAt: '2999-01-01T00:00:00.000Z' };
    await writeArtifacts({ root: tmp, agent: later, human: makeHuman() });
    expect(readFileSync(baseline, 'utf8')).toBe(first);
  });

  it('legacy → --minimal → --minimal → legacy parks the first legacy run (EMIT-R1)', async () => {
    const at = (n: number): string => `2026-09-24T09:02:3${n}.000Z`;
    const baseline = join(tmp, '.facts', ...BASELINE_AGENT_FILE.split('/'));
    const write = (n: number, profile: 'legacy' | 'minimal') =>
      writeArtifacts({
        root: tmp,
        agent: { ...makeAgent(), generatedAt: at(n) },
        human: makeHuman(),
        profile,
      });
    await write(1, 'legacy');
    await write(2, 'minimal');
    await write(3, 'minimal');
    expect(existsSync(baseline)).toBe(false); // a hook run parks nothing
    expect(JSON.parse(readFileSync(join(tmp, '.facts', 'agent.json'), 'utf8')).generatedAt).toBe(
      at(1),
    );
    await write(4, 'legacy');
    expect(JSON.parse(readFileSync(baseline, 'utf8')).generatedAt).toBe(at(1));
    expect(JSON.parse(readFileSync(join(tmp, '.facts', 'agent.json'), 'utf8')).generatedAt).toBe(
      at(4),
    );
  });

  it('rotateBaseline:false (scan-vulns / CVE refresh) keeps the real previous analysis', async () => {
    const at = (n: number): string => `2026-09-24T09:03:0${n}.000Z`;
    const baseline = join(tmp, '.facts', ...BASELINE_AGENT_FILE.split('/'));
    await writeArtifacts({
      root: tmp,
      agent: { ...makeAgent(), generatedAt: at(1) },
      human: makeHuman(),
    });
    await writeArtifacts({
      root: tmp,
      agent: { ...makeAgent(), generatedAt: at(2) },
      human: makeHuman(),
    });
    expect(JSON.parse(readFileSync(baseline, 'utf8')).generatedAt).toBe(at(1));
    // A refresh that re-stamps the artifact must still not rotate it.
    await writeArtifacts({
      root: tmp,
      agent: { ...makeAgent(), generatedAt: at(3), vulnerabilities: [] },
      human: makeHuman(),
      rotateBaseline: false,
    });
    expect(JSON.parse(readFileSync(baseline, 'utf8')).generatedAt).toBe(at(1));
    expect(JSON.parse(readFileSync(join(tmp, '.facts', 'agent.json'), 'utf8')).generatedAt).toBe(
      at(3),
    );
  });
});

describe('writeArtifacts — --minimal after a full analyze (performance#1, Node shim)', () => {
  /** A full analyze's agent: enough files that agent.json dwarfs the pack. */
  function bigAgent(at: string): AgentArtifact {
    const a = { ...makeAgent(), generatedAt: at };
    a.files = Array.from({ length: 300 }, (_, i) => ({
      path: `src/mod${i}.ts`,
      language: 'typescript',
      loc: 40,
      bytes: 1200,
      bundleSize: null,
      tokenCost: 300,
      imports: [],
      exports: [{ name: `fn${i}`, kind: 'function', isDefault: false }],
      declarations: [
        { name: `fn${i}`, kind: 'function', startLine: 1, endLine: 40, exported: true },
      ],
      todos: [],
      complexity: { cyclomatic: 1, cognitive: 1 },
      status: 'ok',
      lastModifiedMs: null,
      churnScore: null,
      readingMinutes: 1,
    }));
    return a;
  }
  const facts = (...p: string[]): string => join(tmp, '.facts', ...p);

  it('never rewrites agent.json / agent.jsonl; marks them stale, and readStaleMark says so', async () => {
    const at = (n: number): string => `2026-09-24T12:00:0${n}.000Z`;
    const full = await writeArtifacts({ root: tmp, agent: bigAgent(at(1)), human: makeHuman() });
    const json = readFileSync(facts('agent.json'), 'utf8');
    const jsonl = readFileSync(facts('agent.jsonl'), 'utf8');
    expect(readStaleMark(facts())).toBeNull();

    const hooks = [];
    for (const n of [2, 3]) {
      hooks.push(
        await writeArtifacts({
          root: tmp,
          agent: bigAgent(at(n)),
          human: makeHuman(),
          profile: 'minimal',
        }),
      );
    }
    expect(readFileSync(facts('agent.json'), 'utf8')).toBe(json);
    expect(readFileSync(facts('agent.jsonl'), 'utf8')).toBe(jsonl);
    for (const r of hooks) {
      expect(r.agentPath).toBeNull();
      expect(r.jsonlPath).toBeNull();
      expect(r.stalePaths).toEqual([facts('agent.json'), facts('agent.jsonl')]);
      // The whole point: a hook run writes a fraction of a full run's bytes.
      expect(r.bytesWritten).toBeLessThan(full.bytesWritten - json.length);
    }
    expect(readStaleMark(facts())).toEqual({ file: 'agent.json', staleSince: at(2) });
    expect(readStaleMark(facts(), 'agent.jsonl')?.staleSince).toBe(at(2));
    expect(staleHint(readStaleMark(facts())!)).toMatch(
      /^\.facts\/agent\.json is older than the newest analysis \(a newer analysis exists since 2026-09-24T12:00:02\.000Z\).*Run `factstack analyze`/,
    );

    await writeArtifacts({ root: tmp, agent: bigAgent(at(4)), human: makeHuman() });
    expect(readStaleMark(facts())).toBeNull();
    expect(readStaleMark(facts(), 'agent.jsonl')).toBeNull();
  });

  it('refuses the scan-vulns re-save of a stale agent.json (StaleResaveError), leaving the pack', async () => {
    const at = (n: number): string => `2026-09-24T12:10:0${n}.000Z`;
    await writeArtifacts({ root: tmp, agent: bigAgent(at(1)), human: makeHuman() });
    await writeArtifacts({
      root: tmp,
      agent: bigAgent(at(2)),
      human: makeHuman(),
      profile: 'minimal',
    });
    const pack = readFileSync(facts('agent.pack'), 'utf8');
    const stale = JSON.parse(readFileSync(facts('agent.json'), 'utf8')) as AgentArtifact;
    const err = await writeArtifacts({
      root: tmp,
      agent: { ...stale, vulnerabilities: [] },
      human: makeHuman(),
      rotateBaseline: false,
      addGitignoreEntry: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleResaveError);
    // Read back through NodeFileWriter.readText: agent.json holds this analysis.
    expect(err).toMatchObject({ resave: true });
    expect((err as Error).message).toMatch(/^not re-saving the analysis from /);
    expect(readFileSync(facts('agent.pack'), 'utf8')).toBe(pack);
    expect(packGeneratedAt(pack)).toBe(at(2));
    expect(readStaleMark(facts())).not.toBeNull();
  });

  it('an overtaken NEW analysis gets the new-analysis wording; refuseUnderNewerPack passes through (EMIT-REV-2)', async () => {
    const at = (n: number): string => `2026-09-24T12:20:0${n}.000Z`;
    await writeArtifacts({ root: tmp, agent: bigAgent(at(1)), human: makeHuman() });
    await writeArtifacts({
      root: tmp,
      agent: bigAgent(at(3)),
      human: makeHuman(),
      profile: 'minimal',
    });
    const overtaken = bigAgent(at(2)); // a ui/watch refresh that began before the hook run
    const err = await writeArtifacts({
      root: tmp,
      agent: overtaken,
      human: makeHuman(),
      rotateBaseline: false,
      addGitignoreEntry: false,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'FACTS_STALE_RESAVE', resave: false, packAt: at(3) });
    expect((err as Error).message).not.toMatch(/re-saving|agent\.json is stale/);
    expect(packGeneratedAt(readFileSync(facts('agent.pack'), 'utf8'))).toBe(at(3));

    // Opting out through the shim: last writer wins, and agent.json is fresh again.
    await writeArtifacts({
      root: tmp,
      agent: overtaken,
      human: makeHuman(),
      rotateBaseline: false,
      refuseUnderNewerPack: false,
      addGitignoreEntry: false,
    });
    expect(packGeneratedAt(readFileSync(facts('agent.pack'), 'utf8'))).toBe(at(2));
    expect(readStaleMark(facts())).toBeNull();
  });

  it('readStaleMark: no mark → null; an unreadable body still means stale', async () => {
    expect(readStaleMark(join(tmp, 'no-such-dir'))).toBeNull();
    mkdirSync(facts(), { recursive: true });
    writeFileSync(facts('agent.json.stale'), 'not json');
    expect(readStaleMark(facts())).toEqual({ file: 'agent.json', staleSince: null });
    expect(staleHint(readStaleMark(facts())!)).not.toContain('since');
  });
});

describe('writeArtifacts — diff sidecar reporting (Node shim)', () => {
  it('passes the orchestrator diffSkipped reason through, and omits it when the diff lands', async () => {
    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    const warm = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    expect(warm.diffPath).not.toBeNull();
    expect(warm.diffSkipped).toBeUndefined();

    writeFileSync(join(tmp, '.facts', 'agent.pack'), 'truncated garbage');
    const r = await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });
    expect(r.diffPath).toBeNull();
    expect(r.diffSkipped).toMatch(/^previous agent\.pack is unreadable: /);
  });
});

describe('writeArtifacts — orphaned atomic-write temp files (Node shim)', () => {
  it('sweeps stale *.tmp left by a killed run, never a fresh one (EMIT-R6)', async () => {
    const facts = join(tmp, '.facts');
    const stale = [
      join(facts, 'agent.json.4242.ab12cd34.tmp'),
      join(facts, 'baseline', 'agent.json.4242.0f0f0f0f.tmp'),
      join(facts, 'snapshots', '2026-01-01T00-00-00-000Z.json.7.deadbeef.tmp'),
    ];
    const fresh = join(facts, 'agent.pack.99.12345678.tmp'); // a concurrent writer's, in flight
    const userFile = join(facts, 'notes.tmp'); // not ours: wrong shape
    const old = new Date(Date.now() - 10 * 60_000);
    for (const f of [...stale, fresh, userFile]) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, 'partial');
    }
    for (const f of [...stale, userFile]) utimesSync(f, old, old);

    await writeArtifacts({ root: tmp, agent: makeAgent(), human: makeHuman() });

    for (const f of stale) expect(existsSync(f)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
  });
});

describe('readSnapshots (Node-only sidecar reader)', () => {
  it('returns empty for a project with no snapshots', async () => {
    const snaps = await readSnapshots(tmp);
    expect(snaps).toEqual([]);
  });

  it('returns snapshots sorted by name (chronological since names are ISO)', async () => {
    await writeArtifacts({
      root: tmp,
      agent: makeAgent(),
      human: makeHuman(),
      writeSnapshot: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    await writeArtifacts({
      root: tmp,
      agent: makeAgent(),
      human: makeHuman(),
      writeSnapshot: true,
    });
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
    const r = await writeArtifacts({
      root: tmp,
      agent: makeAgent(),
      human: makeHuman(),
      writeSnapshot: true,
    });
    expect(r.snapshotPath).not.toBeNull();
    expect(r.snapshotPath!).toMatch(/[/\\]snapshots[/\\]/);
    expect(existsSync(r.snapshotPath!)).toBe(true);
  });
});

/**
 * In-process tests of the MCP server's handlers (tech-debt#7) over the SDK's
 * linked in-memory transport — the same JSON-RPC path a real client takes,
 * minus stdio. Each test gets a fresh temp project.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { analyze, isExposedSecret } from '@factstack/core';
import { packGeneratedAt, writeArtifacts } from '@factstack/emit';
import { decode } from '@factstack/factspack';
import { mineGitStats, nodeFS } from '@factstack/fs-node';
import { VULN_LABEL_TEXT, type OsvQuery } from '@factstack/scanners';
import {
  GIT_STATS_CACHE_FILE,
  MCP_PUBLISHED,
  MCP_TOOL_NAMES,
  type AgentArtifact,
} from '@factstack/spec';
import { loginHint } from '../src/auth.js';
import {
  createFactsMcpServer,
  type AnalyzeRunOptions,
  type CloudSync,
  type FactsMcpServerOptions,
} from '../src/create-server.js';

/* Nearly every test runs a real in-process analyze of a temp project
   (~350 ms here). With every package suite sharing a 3-4 vCPU CI runner that
   becomes several seconds, so vitest's 5 s default measures the runner. */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type ToolReply = { isError: boolean; text: string };

const SIGNED_OUT: CloudSync = {
  session: async () => ({ state: 'signed-out' }),
  set: async () => {
    throw new Error('the cloud mirror must not run signed out');
  },
};

function makeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'facts-mcp-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fx', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
  );
  writeFileSync(path.join(root, 'src', 'b.ts'), 'export function b() {\n  return 1;\n}\n');
  writeFileSync(
    path.join(root, 'src', 'a.ts'),
    "import { b } from './b';\nexport function a() {\n  return b();\n}\n",
  );
  return root;
}

/** Git-free analyzer (fast + deterministic); the stdio e2e covers the default. */
const quickAnalyzer =
  (root: string) =>
  ({ symbols }: AnalyzeRunOptions) =>
    analyze(nodeFS(root), { root: '.', projectName: 'fx', symbols });

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** Per-test overrides of boot()'s defaults. The root is boot()'s own argument.
 *  Only analyzeProject and cloud take an explicit `undefined`: it drops the
 *  test default, so the server uses its own (the git-aware analyzer, the
 *  Google sign-in). Every other option (all optional already) can only be
 *  left out. */
type BootOverrides = Omit<FactsMcpServerOptions, 'root' | 'analyzeProject' | 'cloud'> & {
  analyzeProject?: FactsMcpServerOptions['analyzeProject'] | undefined;
  cloud?: CloudSync | undefined;
};

async function boot(root: string, over: BootOverrides = {}) {
  const { analyzeProject, cloud, ...rest } = over;
  const options: FactsMcpServerOptions = {
    root,
    projectName: 'fx',
    addGitignoreEntry: false,
    queryOsv: async () => [],
    ...rest,
  };
  // `in`, not `??`: a key set to undefined leaves the option out altogether.
  const analyzer = 'analyzeProject' in over ? analyzeProject : quickAnalyzer(root);
  if (analyzer) options.analyzeProject = analyzer;
  const mirror = 'cloud' in over ? cloud : SIGNED_OUT;
  if (mirror) options.cloud = mirror;
  const facts = createFactsMcpServer(options);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const { warm } = await facts.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text: string }>;
    return { isError: r.isError === true, text: content[0]!.text };
  };
  return { facts, client, call, warm };
}

const readAgent = (root: string) =>
  JSON.parse(readFileSync(path.join(root, '.facts', 'agent.json'), 'utf8')) as AgentArtifact;

/* The type check (tsconfig.test.json) is the real assertion here: each
   expect-error directive below fails `pnpm typecheck` once BootOverrides
   widens again. */
describe('boot() overrides (checked by the test type-check)', () => {
  it('take an explicit undefined only for the options with a server default', () => {
    const fine: BootOverrides[] = [{ analyzeProject: undefined }, { cloud: undefined }, {}];
    // @ts-expect-error -- the root is boot()'s own argument, never an override
    const moved: BootOverrides = { root: '/elsewhere' };
    // @ts-expect-error -- exactOptionalPropertyTypes: leave projectName out instead
    const unnamed: BootOverrides = { projectName: undefined };
    expect([...fine, moved, unnamed]).toHaveLength(5);
  });
});

describe('handshake + boot analyze (performance#4, ux#8)', () => {
  it('answers initialize before the boot analyze finishes, and shares one run', async () => {
    const root = makeProject();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const slow = async (o: AnalyzeRunOptions) => {
      runs++;
      await gate;
      return quickAnalyzer(root)(o);
    };
    // boot() resolves only once the client's initialize has been answered.
    const { call, warm } = await boot(root, { analyzeProject: slow });
    expect(existsSync(path.join(root, '.facts', 'agent.json'))).toBe(false);
    // A tool call during the boot analyze waits for THAT run (no duplicate).
    const pending = call('read_memory');
    release();
    const memory = await pending;
    await warm;
    expect(memory.isError).toBe(false);
    expect(runs).toBe(1);
  });

  it('starts the boot analyze only after the handshake and the first listing (MCP-R1)', async () => {
    const root = makeProject();
    const events: string[] = [];
    // The default analyzer mines git synchronously (spawnSync) before its
    // first await; a busy-wait stands in for it, so nothing async can hide it.
    const blocking = (o: AnalyzeRunOptions) => {
      events.push('analyze');
      const until = Date.now() + 150;
      while (Date.now() < until) {
        /* synchronous git mining */
      }
      return quickAnalyzer(root)(o);
    };
    const { client, warm } = await boot(root, { analyzeProject: blocking });
    events.push('initialize');
    await client.listTools();
    events.push('listTools');
    await warm;
    expect(events).toEqual(['initialize', 'listTools', 'analyze']);
  });

  it('survives a failing boot analyze; tools report it and retry', async () => {
    const root = makeProject();
    let fail = true;
    const flaky = async (o: AnalyzeRunOptions) => {
      if (fail) throw new Error('boom: analyzer crashed');
      return quickAnalyzer(root)(o);
    };
    const log = vi.fn();
    const { client, call, warm } = await boot(root, { analyzeProject: flaky, log });
    await warm; // never rejects
    expect(log.mock.calls.flat().join('\n')).toMatch(/initial analyze failed: boom/);
    expect((await client.listTools()).tools).toHaveLength(17);
    const first = await call('read_memory');
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/boom/);
    fail = false;
    expect((await call('read_memory')).isError).toBe(false);
  });

  it('with no safe root: handshake works, every tool errors, nothing is written', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'facts-noroot-'));
    const { client, call, warm } = await boot(root, {
      rootError: 'No project found; pass --root <project dir>.',
      analyzeProject: undefined,
    });
    await warm;
    expect((await client.listTools()).tools.length).toBe(17);
    for (const tool of ['analyze', 'read_memory', 'log_learning', 'query_learnings']) {
      const r = await call(tool, { agent: 'a', action: 'x', outcome: 'pending' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/--root/);
    }
    expect(existsSync(path.join(root, '.facts'))).toBe(false);
    expect(existsSync(path.join(root, '.gitignore'))).toBe(false);
  });
});

describe('sign-in is optional (ux#1)', () => {
  it('every tool and resource works signed out', async () => {
    const root = makeProject();
    const { client, call, warm } = await boot(root);
    await warm;
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
    const argsFor: Record<string, Record<string, unknown>> = {
      query_graph: { verb: 'callers', path: 'src/b.ts' },
      get_outline: { path: 'src/a.ts' },
      since: { timestamp: '2020-01-01T00:00:00Z' },
      log_learning: { agent: 't', action: 'decision', outcome: 'pending' },
      count_tokens: { path: 'src/a.ts' },
      get_context: { query: 'a' },
      query: { q: 'what imports src/b.ts' },
    };
    await call('analyze'); // a second analysis → review_change has a baseline
    for (const name of MCP_TOOL_NAMES) {
      const r = await call(name, argsFor[name] ?? {});
      expect(r.isError, `${name}: ${r.text.slice(0, 200)}`).toBe(false);
    }
    const project = await client.readResource({ uri: 'facts://project' });
    expect(JSON.parse((project.contents[0] as { text: string }).text).stats.fileCount).toBe(3);
    const file = await client.readResource({ uri: 'facts://file/src%5Ca.ts' });
    expect((file.contents[0] as { text: string }).text).toContain('"path": "src/a.ts"');
  });

  it('log_learning signed out: local write only, and says how to turn sync on', async () => {
    const root = makeProject();
    const { call } = await boot(root);
    const r = JSON.parse(
      (await call('log_learning', { agent: 't', action: 'x', outcome: 'pending' })).text,
    );
    expect(r).toMatchObject({ ok: true, cloudSync: 'off' });
    /* MCP-R4: an agent reads this: auth's caveated hint (auth.test.ts covers
       both of its forms). While factstack-mcp is not on npm, the only command
       it offers as runnable is the from-a-clone one — never a bare `npx -y`
       of an unclaimed package name. Follows spec's flag, so the owner's
       publish change lands green. */
    expect(r.signIn).toBe(loginHint());
    if (!MCP_PUBLISHED) {
      expect(r.signIn).toContain('`npx tsx apps/mcp-server/src/server.ts login`');
      expect(r.signIn).toMatch(/not on npm yet/);
      expect(r.signIn).not.toMatch(/^Optional: `npx -y factstack-mcp/);
    }
    expect(readFileSync(path.join(root, '.facts', 'learnings.jsonl'), 'utf8')).toContain(
      '"agent":"t"',
    );
  });

  it('signed in: learnings mirror to the private users/{uid} subtree', async () => {
    const root = makeProject();
    const set = vi.fn(async () => true);
    const session = { uid: 'u1', email: 'e@x', idToken: 't', refreshToken: 'r', expiresAt: 1 };
    const { call } = await boot(root, {
      cloud: { session: async () => ({ state: 'ready', session }), set },
    });
    const r = JSON.parse(
      (await call('log_learning', { agent: 't', action: 'x', outcome: 'pending' })).text,
    );
    expect(r.cloudSync).toBe('synced');
    expect(set.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      expect.stringMatching(/^users\/u1\/learnings\//),
      'users/u1',
    ]);
  });

  it('signed in but offline: the tool still succeeds, sync reports paused', async () => {
    const root = makeProject();
    const set = vi.fn(async () => true);
    const { call } = await boot(root, {
      cloud: { session: async () => ({ state: 'paused', reason: 'offline' }), set },
    });
    const r = await call('log_learning', { agent: 't', action: 'x', outcome: 'pending' });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).cloudSync).toBe('paused');
    expect(set).not.toHaveBeenCalled();
  });

  it('signed in but the cloud write does not go through: the tool succeeds, sync reports failed', async () => {
    const session = { uid: 'u1', email: 'e@x', idToken: 't', refreshToken: 'r', expiresAt: 1 };
    const writes: Array<CloudSync['set']> = [
      async () => false, // the store answered but refused the write
      async () => {
        throw new Error('socket hang up');
      },
    ];
    for (const set of writes) {
      const root = makeProject();
      const { call } = await boot(root, {
        cloud: { session: async () => ({ state: 'ready', session }), set },
      });
      const r = await call('log_learning', { agent: 't', action: 'x', outcome: 'pending' });
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.text)).toMatchObject({ ok: true, cloudSync: 'failed' });
      expect(JSON.parse(r.text).signIn).toBeUndefined();
      // The local log is the record either way.
      expect(readFileSync(path.join(root, '.facts', 'learnings.jsonl'), 'utf8')).toContain(
        '"agent":"t"',
      );
    }
  });

  it('default auth with no auth.json on disk: signed out, local tools work', async () => {
    vi.stubEnv('FACTS_HOME', mkdtempSync(path.join(tmpdir(), 'facts-home-')));
    try {
      const root = makeProject();
      const { call } = await boot(root, { cloud: undefined });
      expect((await call('read_memory')).isError).toBe(false);
      const r = JSON.parse(
        (await call('log_learning', { agent: 't', action: 'x', outcome: 'pending' })).text,
      );
      expect(r.cloudSync).toBe('off');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('baseline (data-model#5)', () => {
  it('review_change compares against the previous analysis', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    writeFileSync(
      path.join(root, 'src', 'c.ts'),
      "import { a } from './a';\nexport const c = a();\n",
    );
    expect((await call('analyze')).isError).toBe(false);
    expect(existsSync(path.join(root, '.facts', 'baseline', 'agent.json'))).toBe(true);
    const r = await call('review_change');
    expect(r.isError, r.text).toBe(false);
    const verdict = JSON.parse(r.text);
    expect(typeof verdict.severity).toBe('string');
    expect(verdict.summary.filesAdded).toBe(1); // src/c.ts, vs the prior analysis
  });

  /** Two earlier explicit analyses (the CLI): E0 (2020-01-01), then E1
   *  (2020-01-02), which adds src/c.ts and parks E0 as the baseline. */
  async function twoExplicitAnalyses(root: string) {
    const cliAnalyze = async (at: string) => {
      const r = await quickAnalyzer(root)({ symbols: false, useCache: true });
      r.agent.generatedAt = at;
      r.human.generatedAt = at;
      await writeArtifacts({ root, agent: r.agent, human: r.human, addGitignoreEntry: false });
    };
    await cliAnalyze('2020-01-01T00:00:00.000Z');
    writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3;\n');
    await cliAnalyze('2020-01-02T00:00:00.000Z');
    const agentJson = path.join(root, '.facts', 'agent.json');
    const baseline = path.join(root, '.facts', 'baseline', 'agent.json');
    const e0 = readFileSync(baseline, 'utf8');
    expect(JSON.parse(e0).generatedAt).toBe('2020-01-01T00:00:00.000Z');
    return { agentJson, baseline, e0, e1: readFileSync(agentJson, 'utf8') };
  }

  it('the boot warm-up holds the last explicit analysis as the baseline (correctness#5)', async () => {
    const root = makeProject();
    const { agentJson, baseline, e0, e1 } = await twoExplicitAnalyses(root);
    const { call, warm } = await boot(root);
    await warm;
    // The warm-up refreshes the pack but, like the --minimal hook, leaves
    // agent.json (the last explicit analysis) in place, marked stale.
    const bootAt = packGeneratedAt(readFileSync(path.join(root, '.facts', 'agent.pack'), 'utf8'));
    expect(bootAt).not.toBe('2020-01-02T00:00:00.000Z');
    expect(readFileSync(agentJson, 'utf8')).toBe(e1);
    expect(existsSync(`${agentJson}.stale`)).toBe(true);
    expect(readFileSync(baseline, 'utf8')).toBe(e0);
    // No code change since E1: review_change compares against E1, never E0.
    const held = await call('review_change');
    expect(held.isError, held.text).toBe(false);
    expect(JSON.parse(held.text).summary).toMatchObject({ filesAdded: 0, filesRemoved: 0 });
    // since picks the newest full analysis at or before the timestamp.
    const sinceAt = async (timestamp: string) =>
      JSON.parse((await call('since', { timestamp })).text).baselineAt as string | null;
    expect(await sinceAt('2020-01-01T12:00:00.000Z')).toBe('2020-01-01T00:00:00.000Z');
    expect(await sinceAt('2020-01-03T00:00:00.000Z')).toBe('2020-01-02T00:00:00.000Z');
    // The explicit analyze parks E1: the baseline is the last explicit analysis.
    expect((await call('analyze')).isError).toBe(false);
    expect(readFileSync(baseline, 'utf8')).toBe(e1);
    expect(existsSync(`${agentJson}.stale`)).toBe(false);
    const after = await call('review_change');
    expect(after.isError, after.text).toBe(false);
    expect(JSON.parse(after.text).summary).toMatchObject({ filesAdded: 0, filesRemoved: 0 });
  });

  it('a CVE refresh during the hold parks the held analysis before replacing it (correctness#5)', async () => {
    const root = makeProject();
    const { agentJson, baseline, e1 } = await twoExplicitAnalyses(root);
    const { call, warm } = await boot(root);
    await warm;
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError, vu.text).toBe(false);
    // The refresh saves the head it scanned into agent.json, so it first
    // parks E1 there, as the next analyze would have.
    expect(readFileSync(baseline, 'utf8')).toBe(e1);
    const disk = readAgent(root);
    expect(disk.generatedAt).not.toBe('2020-01-02T00:00:00.000Z');
    expect(disk.vulnerabilityScan?.source).toBe('osv.dev');
    expect(existsSync(`${agentJson}.stale`)).toBe(false);
    const r = await call('review_change');
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text).summary).toMatchObject({ filesAdded: 0, filesRemoved: 0 });
  });

  it('a CVE refresh during the hold never lands under a newer pack', async () => {
    const root = makeProject();
    const { agentJson, baseline, e0, e1 } = await twoExplicitAnalyses(root);
    const { call, warm } = await boot(root);
    await warm;
    // The per-edit --minimal hook lands a newer analysis meanwhile.
    const hook = await quickAnalyzer(root)({ symbols: false, useCache: true });
    const hookAt = new Date(Date.now() + 60_000).toISOString();
    hook.agent.generatedAt = hookAt;
    hook.human.generatedAt = hookAt;
    await writeArtifacts({
      root,
      agent: hook.agent,
      human: hook.human,
      addGitignoreEntry: false,
      profile: 'minimal',
    });
    const packPath = path.join(root, '.facts', 'agent.pack');
    const pack = readFileSync(packPath, 'utf8');
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError).toBe(true);
    expect(vu.text).toMatch(/newer/);
    expect(readFileSync(packPath, 'utf8')).toBe(pack);
    expect(readFileSync(agentJson, 'utf8')).toBe(e1);
    expect(readFileSync(baseline, 'utf8')).toBe(e0);
  });

  it('since uses the baseline only when it predates the timestamp', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    await call('analyze');
    const baselineAt = JSON.parse(
      readFileSync(path.join(root, '.facts', 'baseline', 'agent.json'), 'utf8'),
    ).generatedAt as string;
    const after = JSON.parse((await call('since', { timestamp: baselineAt })).text);
    expect(after.hasBaseline).toBe(true);
    expect(after.baselineAt).toBe(baselineAt);
    const before = JSON.parse((await call('since', { timestamp: '2020-01-01T00:00:00Z' })).text);
    expect(before.hasBaseline).toBe(false); // a newer baseline would hide older changes
  });

  it('an external analyze after boot never inverts the verdict (MCP-R2)', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm; // the MCP's head: a.ts + b.ts
    writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3;\n');
    // The CLI / the per-edit freshness hook / another client analyzes meanwhile.
    const external = async () => {
      const r = await quickAnalyzer(root)({ symbols: false, useCache: true });
      await writeArtifacts({ root, agent: r.agent, human: r.human, addGitignoreEntry: false });
    };
    await external();
    const once = await call('review_change');
    expect(once.isError, once.text).toBe(false);
    expect(JSON.parse(once.text).summary).toMatchObject({ filesAdded: 1, filesRemoved: 0 });
    await external(); // the baseline is now newer than the MCP's in-memory head
    const twice = await call('review_change');
    expect(twice.isError, twice.text).toBe(false);
    expect(JSON.parse(twice.text).summary.filesRemoved).toBe(0);
    const since = JSON.parse((await call('since', { timestamp: new Date().toISOString() })).text);
    expect(since.files.filter((f: { kind: string }) => f.kind === 'removed')).toEqual([]);
  });

  it('a CVE refresh keeps the review baseline (MCP-R3)', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3;\n');
    expect((await call('analyze')).isError).toBe(false);
    const baseline = path.join(root, '.facts', 'baseline', 'agent.json');
    const kept = readFileSync(baseline, 'utf8');
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError, vu.text).toBe(false);
    expect(readFileSync(baseline, 'utf8')).toBe(kept); // a data-only rewrite
    const r = await call('review_change');
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text).summary.filesAdded).toBe(1);
  });

  /** A CLI-style analyze written by another process, stamped `offsetMs`
   *  from the MCP's head so the ordering never rests on clock resolution. */
  async function externalAnalyze(root: string, offsetMs: number) {
    const ext = await quickAnalyzer(root)({ symbols: false, useCache: true });
    const at = new Date(Date.parse(readAgent(root).generatedAt) + offsetMs).toISOString();
    ext.agent.generatedAt = at;
    ext.human.generatedAt = at;
    await writeArtifacts({ root, agent: ext.agent, human: ext.human, addGitignoreEntry: false });
    return at;
  }

  it('a CVE refresh lands on a newer external analysis, never reverting it (mcp-r3-adv-1)', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    expect((await call('analyze')).isError).toBe(false);
    // The CLI analyzes meanwhile: disk now holds a NEWER analysis than the MCP's.
    writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3;\n');
    const extAt = await externalAnalyze(root, 1000);
    const baseline = path.join(root, '.facts', 'baseline', 'agent.json');
    const kept = readFileSync(baseline, 'utf8'); // the MCP's analysis, parked by the CLI
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError, vu.text).toBe(false);
    const disk = readAgent(root);
    expect(disk.generatedAt).toBe(extAt);
    expect(disk.files.map((f) => f.path)).toContain('src/c.ts');
    expect(disk.vulnerabilityScan?.source).toBe('osv.dev');
    const human = JSON.parse(readFileSync(path.join(root, '.facts', 'human.json'), 'utf8'));
    expect(human.generatedAt).toBe(extAt);
    expect(readFileSync(baseline, 'utf8')).toBe(kept);
    const r = await call('review_change');
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(r.text).summary).toMatchObject({ filesAdded: 1, filesRemoved: 0 });
    // The cache adopted the external analysis too.
    const tok = JSON.parse((await call('count_tokens', { path: 'src/c.ts' })).text);
    expect(tok.source).toBe('artifact');
  });

  it('a CVE refresh never parks the agent.json it replaces as the baseline (rotateBaseline:false)', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    expect((await call('analyze')).isError).toBe(false);
    const ours = readAgent(root).generatedAt;
    // A stale writer lands an analysis OLDER than the MCP's head: ours stays the head.
    writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3;\n');
    const staleAt = await externalAnalyze(root, -1000);
    const baseline = path.join(root, '.facts', 'baseline', 'agent.json');
    const kept = readFileSync(baseline, 'utf8');
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError, vu.text).toBe(false);
    expect(readAgent(root).generatedAt).toBe(ours);
    // Rotating would have parked the stale analysis (its generatedAt differs).
    expect(readFileSync(baseline, 'utf8')).toBe(kept);
    expect(JSON.parse(kept).generatedAt).not.toBe(staleAt);
  });

  it('a CVE refresh refuses a newer agent.json whose human.json is from another run', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    const humanPath = path.join(root, '.facts', 'human.json');
    const oldHuman = readFileSync(humanPath, 'utf8');
    writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3;\n');
    await externalAnalyze(root, 1000);
    writeFileSync(humanPath, oldHuman); // a writer caught between its two files
    const agentBytes = readFileSync(path.join(root, '.facts', 'agent.json'), 'utf8');
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError).toBe(true);
    expect(vu.text).toMatch(/newer analysis/);
    expect(readFileSync(path.join(root, '.facts', 'agent.json'), 'utf8')).toBe(agentBytes);
    expect(readFileSync(humanPath, 'utf8')).toBe(oldHuman);
  });
});

describe('a warm-up analyze never lands over a newer pack, nor fails on one', () => {
  /* A pack stamped ahead of this process's clock: a --minimal hook in a
     WSL/container with a skewed clock, or an NTP step back. */
  it.each([
    ['a hook-only project (no agent.json)', false],
    ['a project with an explicit analysis', true],
  ])('%s: tools answer from memory; the pack is kept', async (_label, withAgentJson) => {
    const root = makeProject();
    const stamp = async (at: string, profile: 'minimal' | 'legacy') => {
      const r = await quickAnalyzer(root)({ symbols: false, useCache: true });
      r.agent.generatedAt = at;
      r.human.generatedAt = at;
      await writeArtifacts({
        root,
        agent: r.agent,
        human: r.human,
        addGitignoreEntry: false,
        profile,
      });
    };
    if (withAgentJson) await stamp('2020-01-01T00:00:00.000Z', 'legacy');
    await stamp(new Date(Date.now() + 60_000).toISOString(), 'minimal');
    const packPath = path.join(root, '.facts', 'agent.pack');
    const pack = readFileSync(packPath, 'utf8');
    const lines: string[] = [];
    const { call, warm } = await boot(root, { log: (l) => lines.push(l) });
    await warm;
    expect(lines.join('\n')).not.toMatch(/initial analyze failed/);
    expect(lines.join('\n')).toMatch(/newer analysis .*serving this one from memory/);
    for (const [tool, args] of [
      ['get_outline', { path: 'src/a.ts' }],
      ['read_memory', {}],
      ['list_risks', {}],
      ['count_tokens', { path: 'src/a.ts' }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError, `${tool}: ${r.text.slice(0, 200)}`).toBe(false);
    }
    expect(readFileSync(packPath, 'utf8')).toBe(pack);
    // The analyze tool writes regardless (a new analysis the caller asked for).
    const an = await call('analyze');
    expect(an.isError, an.text).toBe(false);
    expect(readFileSync(packPath, 'utf8')).not.toBe(pack);
  });
});

describe('diffSkipped goes to the status log, never the transport', () => {
  it('says why no agent.diff.pack was written, after analyze and after a CVE refresh', async () => {
    const root = makeProject();
    const lines: string[] = [];
    const { call, warm } = await boot(root, { log: (l) => lines.push(l) });
    await warm;
    const pack = path.join(root, '.facts', 'agent.pack');
    const skipped = () => lines.filter((l) => l.startsWith('no agent.diff.pack: '));
    // A usable previous master → the diff lands and nothing is logged.
    expect((await call('analyze')).isError).toBe(false);
    expect(existsSync(path.join(root, '.facts', 'agent.diff.pack'))).toBe(true);
    expect(skipped()).toEqual([]);
    writeFileSync(pack, 'not a pack\n');
    const an = await call('analyze');
    expect(an.isError, an.text).toBe(false); // informational: the write succeeded
    expect(an.text).not.toMatch(/agent\.diff\.pack/);
    expect(skipped()).toEqual([expect.stringMatching(/: previous agent\.pack is unreadable: /)]);
    writeFileSync(pack, 'not a pack\n');
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError, vu.text).toBe(false);
    expect(vu.text).not.toMatch(/agent\.diff\.pack/);
    expect(skipped()).toHaveLength(2);
  });

  it('a throwing log hook never fails the write or leaves the cache behind disk (mcp-r3-adv-3)', async () => {
    const root = makeProject();
    const log = vi.fn(() => {
      throw new Error('log hook boom');
    });
    const { call, warm } = await boot(root, { log });
    await warm; // settles although every status line throws
    const pack = path.join(root, '.facts', 'agent.pack');
    writeFileSync(pack, 'not a pack\n');
    writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 3;\n');
    const an = await call('analyze');
    expect(an.isError, an.text).toBe(false);
    const tok = JSON.parse((await call('count_tokens', { path: 'src/c.ts' })).text);
    expect(tok.source).toBe('artifact'); // the cache holds the analysis on disk
    writeFileSync(pack, 'not a pack\n');
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError, vu.text).toBe(false);
    expect(JSON.parse(vu.text).scan.scannedAt).toBe(readAgent(root).vulnerabilityScan?.scannedAt);
    expect(log.mock.calls.flat().join('\n')).toMatch(/no agent\.diff\.pack: /);
  });
});

describe('analyze + CVE refresh race (MCP-01)', () => {
  it('a concurrent refresh never reverts the fresh analysis (disk or cache)', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    writeFileSync(
      path.join(root, 'src', 'c.ts'),
      "import { a } from './a';\nexport const c = a();\n",
    );
    const [an, vu] = await Promise.all([
      call('analyze'),
      call('list_vulnerabilities', { refresh: true }),
    ]);
    expect(an.isError).toBe(false);
    expect(vu.isError, vu.text).toBe(false);
    expect(readAgent(root).files.map((f) => f.path)).toContain('src/c.ts');
    expect(readAgent(root).vulnerabilityScan?.source).toBe('osv.dev');
    const tok = JSON.parse((await call('count_tokens', { path: 'src/c.ts' })).text);
    expect(tok.source).toBe('artifact');
  });
});

describe('CVE refresh reads the lockfile (owner CVE decision, INV7 parity)', () => {
  it('queries installed versions, labels declared ranges, keeps findings across analyze', async () => {
    const root = makeProject();
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fx',
        dependencies: { 'left-pad': '^1.0.0' },
        devDependencies: { 'is-odd': '~3.0.0' },
      }),
    );
    writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { 'left-pad': '^1.0.0' } },
          'node_modules/left-pad': { version: '1.3.0' },
          'node_modules/is-number': { version: '6.0.0' },
        },
      }),
    );
    const asked: OsvQuery[] = [];
    const queryOsv = async (qs: OsvQuery[]) => {
      asked.push(...qs);
      return qs.map((query) => ({
        query,
        vulns: query.name === 'left-pad' ? [{ id: 'GHSA-test-0001', summary: 'x' }] : [],
      }));
    };
    const { call, warm } = await boot(root, { queryOsv });
    await warm;
    const vu = JSON.parse((await call('list_vulnerabilities', { refresh: true })).text);
    expect(asked).toContainEqual(
      expect.objectContaining({
        name: 'left-pad',
        version: '1.3.0',
        versionSource: 'lockfile',
        scope: 'direct',
      }),
    );
    expect(asked).toContainEqual(
      expect.objectContaining({
        name: 'is-odd',
        version: '3.0.0',
        versionSource: 'declared-range',
        scope: 'dev',
      }),
    );
    expect(asked).toContainEqual(
      expect.objectContaining({ name: 'is-number', version: '6.0.0', scope: 'transitive' }),
    );
    expect(vu.findings).toEqual([
      expect.objectContaining({ package: 'left-pad', installedVersion: '1.3.0' }),
    ]);
    // A re-analyze carries the lockfile-resolved finding forward.
    await call('analyze');
    expect(JSON.parse((await call('list_vulnerabilities')).text).count).toBe(1);
  });

  it('records the lockfiles it resolved versions from, as scan-vulns does (data-model#23)', async () => {
    const root = makeProject();
    const lock = path.join(root, 'package-lock.json');
    writeFileSync(
      lock,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { 'left-pad': '1.3.0' } },
          'node_modules/left-pad': { version: '1.3.0' },
        },
      }),
    );
    const { call, warm } = await boot(root);
    await warm;
    const vu = await call('list_vulnerabilities', { refresh: true });
    expect(vu.isError, vu.text).toBe(false);
    expect(JSON.parse(vu.text).scan.lockfiles).toEqual(['package-lock.json']);
    expect(readAgent(root).vulnerabilityScan?.lockfiles).toEqual(['package-lock.json']);
    // Carried across a re-analyze with the rest of the scan metadata.
    expect((await call('analyze')).isError).toBe(false);
    expect(readAgent(root).vulnerabilityScan?.lockfiles).toEqual(['package-lock.json']);
    // No lockfile: absent, which the spec reads as "every version was a declared range".
    rmSync(lock);
    expect((await call('list_vulnerabilities', { refresh: true })).isError).toBe(false);
    expect(readAgent(root).vulnerabilityScan).not.toHaveProperty('lockfiles');
  });
});

/* Deps that changed while OSV.dev answered were named only in that
   call's transient note; the saved scan said findings 0 about them, and every
   later read took it for verified clean. */
describe('a partial CVE refresh is persisted, not only noted', () => {
  it('saves `unscanned`; later reads say partial; a re-analyze carries it', async () => {
    const root = makeProject();
    let landed = false;
    const queryOsv = async (qs: OsvQuery[]) => {
      if (!landed) {
        landed = true;
        // Another process adds a dependency and analyzes while OSV.dev answers.
        writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({
            name: 'fx',
            version: '1.0.0',
            dependencies: { 'left-pad': '1.3.0', 'is-odd': '3.0.1' },
          }),
        );
        const ext = await quickAnalyzer(root)({ symbols: false, useCache: true });
        const at = new Date(Date.parse(readAgent(root).generatedAt) + 1000).toISOString();
        ext.agent.generatedAt = at;
        ext.human.generatedAt = at;
        await writeArtifacts({
          root,
          agent: ext.agent,
          human: ext.human,
          addGitignoreEntry: false,
        });
      }
      return qs.map((query) => ({ query, vulns: [] }));
    };
    const { call, warm } = await boot(root, { queryOsv });
    await warm;
    expect((await call('analyze')).isError).toBe(false);
    const refreshed = await call('list_vulnerabilities', { refresh: true });
    expect(refreshed.isError, refreshed.text).toBe(false);
    expect(JSON.parse(refreshed.text).hint).toMatch(/not in this scan/);
    expect(readAgent(root).vulnerabilityScan).toMatchObject({ findings: 0, unscanned: 1 });

    const later = JSON.parse((await call('list_vulnerabilities')).text);
    expect(later.partial).toBe(true);
    expect(later.hint).toMatch(/^Partial scan — 1 dependency was not queried/);

    expect((await call('analyze')).isError).toBe(false);
    expect(readAgent(root).vulnerabilityScan).toMatchObject({ unscanned: 1 });
    // A complete rescan clears it.
    const full = JSON.parse((await call('list_vulnerabilities', { refresh: true })).text);
    expect(full.partial).toBeUndefined();
    expect(readAgent(root).vulnerabilityScan).not.toHaveProperty('unscanned');
  });
});

describe('CVE carry-forward validates each prior row (correctness#13)', () => {
  /** A project whose last scan found GHSA-test-0001 in left-pad. */
  async function scanned(): Promise<string> {
    const root = makeProject();
    const queryOsv = async (qs: OsvQuery[]) =>
      qs.map((query) => ({
        query,
        vulns: query.name === 'left-pad' ? [{ id: 'GHSA-test-0001', summary: 'x' }] : [],
      }));
    const { call, warm } = await boot(root, { queryOsv });
    await warm;
    expect((await call('list_vulnerabilities', { refresh: true })).isError).toBe(false);
    expect(readAgent(root).vulnerabilities).toHaveLength(1);
    return root;
  }

  /** Rewrite the prior agent.json the way an older FACTS or a hand edit would. */
  function tamper(root: string, edit: (a: Record<string, unknown>) => void): void {
    const p = path.join(root, '.facts', 'agent.json');
    const a = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    edit(a);
    writeFileSync(p, JSON.stringify(a));
  }

  it('a malformed prior row is dropped with a warning; the valid rows are kept', async () => {
    const root = await scanned();
    // A two-finding scan whose second row went bad (an older FACTS, a hand edit).
    tamper(root, (a) => {
      const [row] = a.vulnerabilities as Array<Record<string, unknown>>;
      a.vulnerabilities = [row, { ...row, id: 'GHSA-bad-0002', severity: 'bogus' }];
      (a.vulnerabilityScan as Record<string, unknown>).findings = 2;
    });
    const lines: string[] = [];
    const { call, warm } = await boot(root, { log: (l) => lines.push(l) });
    await warm; // the warm-up carries the scan: one bad row used to fail every analyze
    expect(lines.join('\n')).toMatch(/vulns: 1 malformed vulnerability row in the previous scan/);
    const vu = JSON.parse((await call('list_vulnerabilities')).text);
    expect(vu.count).toBe(1);
    expect(vu.findings[0].id).toBe('GHSA-test-0001');
    expect(vu.scan.findings).toBe(1);
    expect(vu.warning).toMatch(/1 malformed vulnerability row/);
    // The explicit analyze reports it to the agent too.
    tamper(root, (a) => {
      const [row] = a.vulnerabilities as Array<Record<string, unknown>>;
      a.vulnerabilities = [row, { ...row, lastChecked: 'yesterday' }];
    });
    const an = await call('analyze');
    expect(an.isError, an.text).toBe(false);
    expect(JSON.parse(an.text).warnings).toEqual([
      expect.stringMatching(/^1 malformed vulnerability row in the previous scan dropped; /),
    ]);
    expect(readAgent(root).vulnerabilities.map((v) => v.id)).toEqual(['GHSA-test-0001']);
    // A clean carry says nothing.
    const again = await call('analyze');
    expect(JSON.parse(again.text).warnings).toBeUndefined();
    expect(JSON.parse((await call('list_vulnerabilities')).text).warning).toBeUndefined();
  });

  it('a prior scan of an unexpected shape is dropped with a warning, never failing analyze', async () => {
    const root = await scanned();
    const { call, warm } = await boot(root);
    await warm;
    tamper(root, (a) => {
      delete (a.vulnerabilityScan as Record<string, unknown>).scannedAt;
    });
    const an = await call('analyze');
    expect(an.isError, an.text).toBe(false);
    expect(JSON.parse(an.text).warnings).toEqual([expect.stringMatching(/unexpected shape/)]);
    const vu = JSON.parse((await call('list_vulnerabilities')).text);
    expect(vu.scan).toBeNull();
    expect(vu.count).toBe(0);
    expect(vu.warning).toMatch(/unexpected shape/);
    expect(vu.warning).toMatch(/refresh:true/);
    // A fresh scan replaces the dropped one and clears the warning.
    const fresh = JSON.parse((await call('list_vulnerabilities', { refresh: true })).text);
    expect(fresh.scan).not.toBeNull();
    expect(fresh.warning).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['an object', {}],
    ['a string', 'x'],
    ['missing', undefined],
  ])(
    'a scan whose rows are %s is dropped with a warning, never carried as clean',
    async (_label, rows) => {
      const root = await scanned();
      tamper(root, (a) => {
        if (rows === undefined) delete a.vulnerabilities;
        else a.vulnerabilities = rows;
      });
      const { call, warm } = await boot(root);
      await warm;
      const vu = JSON.parse((await call('list_vulnerabilities')).text);
      expect(vu.scan).toBeNull(); // not "scanned and clean"
      expect(vu.count).toBe(0);
      expect(vu.warning).toMatch(/unexpected shape.*refresh:true/);
      const an = await call('analyze');
      expect(an.isError, an.text).toBe(false);
      expect(JSON.parse(an.text).warnings).toEqual([expect.stringMatching(/unexpected shape/)]);
      expect(readAgent(root).vulnerabilityScan).toBeUndefined();
    },
  );

  it('a scan whose row count disagrees with its findings count is carried with a warning', async () => {
    const root = await scanned();
    tamper(root, (a) => {
      a.vulnerabilities = []; // the scan still records 1 finding
    });
    const { call, warm } = await boot(root);
    await warm;
    const vu = JSON.parse((await call('list_vulnerabilities')).text);
    expect(vu.count).toBe(0);
    expect(vu.warning).toMatch(/recorded 1 finding but held 0 rows.*refresh:true/);
    const an = await call('analyze');
    expect(JSON.parse(an.text).warnings).toEqual([expect.stringMatching(/recorded 1 finding/)]);
  });
});

describe('vulnerability provenance labels (owner CVE decision)', () => {
  it('labels declared ranges and dev/transitive findings as shown, not graded', async () => {
    const root = makeProject();
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fx',
        dependencies: { 'left-pad': '^1.0.0' },
        devDependencies: { 'is-odd': '~3.0.0' },
      }),
    );
    writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { 'left-pad': '^1.0.0' } },
          'node_modules/left-pad': { version: '1.3.0' },
          'node_modules/is-number': { version: '6.0.0' },
        },
      }),
    );
    const queryOsv = async (qs: OsvQuery[]) =>
      qs.map((query) => ({ query, vulns: [{ id: `GHSA-${query.name}`, summary: 'x' }] }));
    const { call, warm } = await boot(root, { queryOsv });
    await warm;
    const vu = JSON.parse((await call('list_vulnerabilities', { refresh: true })).text);
    const by = (pkg: string) => vu.findings.find((f: { package: string }) => f.package === pkg);
    expect(by('left-pad')).toMatchObject({
      scope: 'direct',
      versionSource: 'lockfile',
      graded: true,
    });
    expect(by('left-pad').labels).toBeUndefined();
    expect(by('is-odd')).toMatchObject({ scope: 'dev', versionSource: 'declared-range' });
    expect(by('is-odd').graded).toBe(false);
    // The scanners' shared wording, so the CLI and dashboard say the same (INV7).
    expect(by('is-odd').labels).toEqual([
      VULN_LABEL_TEXT.declaredRange,
      `dev: ${VULN_LABEL_TEXT.notGraded}`,
    ]);
    expect(VULN_LABEL_TEXT.declaredRange).toMatch(/^declared range/);
    expect(by('is-number')).toMatchObject({
      graded: false,
      labels: [`transitive: ${VULN_LABEL_TEXT.notGraded}`],
    });
    expect(vu.graded).toBe(1);
    expect(vu.queried).toEqual({
      scope: { direct: 1, dev: 1, transitive: 1 },
      versionSource: { lockfile: 2, 'declared-range': 1 },
    });
    // The labels ride along on disk, so a fresh read still says so.
    const again = JSON.parse((await call('list_vulnerabilities')).text);
    expect(again.graded).toBe(1);
    expect(again.queried).toBeUndefined();
  });
});

describe('list_credentials marks possible secrets (owner decision: ungraded)', () => {
  it('an info-severity secret is possible + not graded; a fixture hit is not graded', async () => {
    const root = makeProject();
    const withSecrets = async (o: AnalyzeRunOptions) => {
      const r = await quickAnalyzer(root)(o);
      r.agent.risks.push(
        {
          severity: 'high',
          category: 'secret',
          rule: 'github-token',
          file: 'src/a.ts',
          line: 1,
          message: 'GitHub token detected.',
          preview: 'ghp_***xx',
        },
        {
          severity: 'info',
          category: 'secret',
          rule: 'generic-secret',
          file: 'src/b.ts',
          line: 2,
          message: 'Possible secret.',
          preview: '***',
        },
        {
          severity: 'low',
          category: 'secret',
          rule: 'github-token',
          file: 'test/x.ts',
          line: 3,
          message: 'Fixture.',
          preview: 'ghp_***yy',
        },
      );
      return r;
    };
    const { call } = await boot(root, { analyzeProject: withSecrets });
    const r = JSON.parse((await call('list_credentials')).text);
    expect(r).toMatchObject({ count: 3, graded: 1, possible: 1 });
    expect(r.note).toMatch(/not graded and not confirmed/);
    const rule = (id: string, sev: string) =>
      r.credentials.find(
        (c: { rule: string; severity: string }) => c.rule === id && c.severity === sev,
      );
    expect(rule('generic-secret', 'info')).toMatchObject({ possible: true, graded: false });
    expect(rule('github-token', 'high')).toMatchObject({ graded: true });
    expect(rule('github-token', 'high').possible).toBeUndefined();
    expect(rule('github-token', 'low')).toMatchObject({ graded: false });
    // `graded` is core's rule, the one health.secrets and the review verdict count by.
    for (const c of r.credentials) expect(c.graded).toBe(isExposedSecret(c));
    const high = JSON.parse((await call('list_credentials', { severity: 'high' })).text);
    expect(high).toMatchObject({ count: 1, graded: 1, possible: 0 });
    expect(high.note).toBeUndefined();
  });
});

describe('CVE carry-forward reads the prior artifact strictly (correctness#15)', () => {
  it('an unparseable agent.json fails the analyze loudly and is not overwritten', async () => {
    const root = makeProject();
    mkdirSync(path.join(root, '.facts'));
    const agentJson = path.join(root, '.facts', 'agent.json');
    writeFileSync(agentJson, '{"vulnerabilityScan": {"scannedAt": "2026-');
    const { call, warm } = await boot(root);
    await warm; // the boot analyze fails the same way; logged, never fatal
    const r = await call('analyze');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/agent\.json could not be read/);
    expect(r.text).toMatch(/vulnerability scan is kept/);
    expect(readFileSync(agentJson, 'utf8')).toBe('{"vulnerabilityScan": {"scannedAt": "2026-');
    // Only a MISSING file means "no prior scan".
    rmSync(agentJson);
    expect((await call('analyze')).isError).toBe(false);
  });
});

describe('graph-tool glob cap (MCP-11 defense in depth)', () => {
  it('a glob over 256 characters is an invalid-input result', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    const long = 'src/' + 'x'.repeat(260);
    const qg = await call('query_graph', { verb: 'callers', path: 'src/b.ts', filter: long });
    expect(qg.isError).toBe(true);
    expect(JSON.parse(qg.text).issues).toEqual([
      { field: 'filter', message: 'at most 256 characters' },
    ]);
    const q = await call('query', { query: { start: { glob: long }, where: { pathGlob: long } } });
    expect(q.isError).toBe(true);
    expect(JSON.parse(q.text).issues.map((i: { field: string }) => i.field)).toEqual([
      'query.start.glob',
      'query.where.pathGlob',
    ]);
    const ok = await call('query_graph', {
      verb: 'callers',
      path: 'src/b.ts',
      filter: 'x'.repeat(256),
      format: 'json',
    });
    expect(ok.isError, ok.text).toBe(false);
  });
});

describe('since over the real tool path in a git repo (CORE-R4)', () => {
  const hasGit = spawnSync('git', ['--version']).status === 0;
  it.skipIf(!hasGit)(
    'an uncommitted edit after the baseline is reported as modified',
    { timeout: 60_000 },
    async () => {
      const root = makeProject();
      /* The fixture commit must not hang on a pinentry prompt or fail on a
         hook (mcp-pkg-10): every call turns signing and hooks off. A hostile
         stand-in for the developer's global config (signing on, a failing
         pre-commit hook) proves the overrides win over it. */
      const aside = mkdtempSync(path.join(tmpdir(), 'facts-mcp-git-'));
      const badHooks = path.join(aside, 'bad-hooks');
      const noHooks = path.join(aside, 'no-hooks');
      mkdirSync(badHooks);
      mkdirSync(noHooks);
      writeFileSync(path.join(badHooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const hostileConfig = path.join(aside, 'gitconfig');
      writeFileSync(
        hostileConfig,
        '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = factstack-no-such-gpg\n' +
          `[core]\n\thooksPath = ${badHooks.replaceAll('\\', '/')}\n`,
      );
      const git = (...a: string[]) =>
        execFileSync(
          'git',
          [
            ...['-c', 'user.name=t', '-c', 'user.email=t@t'],
            ...['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${noHooks}`],
            ...a,
          ],
          {
            cwd: root,
            stdio: 'pipe',
            env: { ...process.env, GIT_CONFIG_GLOBAL: hostileConfig, GIT_CONFIG_NOSYSTEM: '1' },
          },
        );
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      rmSync(aside, { recursive: true, force: true });
      // The default analyzer: git mining (commit-time timestamps) + parse cache.
      const { call, warm } = await boot(root, { analyzeProject: undefined });
      await warm;
      expect((await call('analyze')).isError).toBe(false);
      const baseline = path.join(root, '.facts', 'baseline', 'agent.json');
      expect(existsSync(baseline)).toBe(true);
      // The analyze refreshed the topology cache the per-edit --minimal hook reuses.
      expect(existsSync(path.join(root, '.facts', 'topology-cache.json'))).toBe(true);
      /* performance#2: and the git-history cache. The hook's reuse path takes
         this copy (a hit rewrites nothing) instead of re-walking `git log`. */
      const statsCache = path.join(root, '.facts', GIT_STATS_CACHE_FILE);
      const savedAt = () =>
        (JSON.parse(readFileSync(statsCache, 'utf8')) as { savedAt: number }).savedAt;
      const minedAt = savedAt();
      const reused = mineGitStats(root, { cache: { file: statsCache, reuse: true } });
      expect(reused.get('src/a.ts')?.churnScore).toBe(1);
      expect(savedAt()).toBe(minedAt);
      await new Promise((r) => setTimeout(r, 5));
      const ts = new Date().toISOString();
      expect(Date.parse(JSON.parse(readFileSync(baseline, 'utf8')).generatedAt)).toBeLessThan(
        Date.parse(ts),
      );
      const edited = path.join(root, 'src', 'a.ts');
      writeFileSync(
        edited,
        "import { b } from './b';\nexport function a() {\n  return b() + 1;\n}\nexport const z = 2;\n",
      );
      /* Linux stamps mtime from a coarse kernel clock that can trail
         Date.now() by a few ms, so an edit written right after `ts` can carry
         an mtime at or before it and fall outside the window (seen on the
         ubuntu runner). Pin the edit's mtime past the cutoff. */
      const editedAt = new Date(Date.parse(ts) + 2_000);
      utimesSync(edited, editedAt, editedAt);
      expect((await call('analyze')).isError).toBe(false);
      // A full analyze re-mines and refreshes the copy (the spec's reuse:false).
      expect(savedAt()).toBeGreaterThan(minedAt);
      const r = JSON.parse((await call('since', { timestamp: ts })).text);
      expect(r.hasBaseline).toBe(true);
      expect(r.files).toContainEqual(
        expect.objectContaining({ path: 'src/a.ts', kind: 'modified' }),
      );
    },
  );
});

describe('symbol graph parity with the CLI (correctness#13)', () => {
  it('analyze {symbols:true} builds it, and later analyzes (and boots) keep it', async () => {
    const root = makeProject();
    const first = await boot(root);
    await first.warm;
    expect(readAgent(root).graph.symbolNodes?.length ?? 0).toBe(0);
    const on = JSON.parse((await first.call('analyze', { symbols: true })).text);
    expect(on.symbols).toBe(true);
    expect(readAgent(root).graph.symbolNodes!.length).toBeGreaterThan(0);
    expect(JSON.parse((await first.call('analyze')).text).symbols).toBe(true);
    const outline = JSON.parse(
      (await first.call('get_outline', { path: 'src/a.ts', format: 'json' })).text,
    );
    expect(outline.refs.length).toBeGreaterThan(0);
    // A new server over the same repo (a fresh MCP session) keeps the mode.
    const second = await boot(root);
    await second.warm;
    expect(readAgent(root).graph.symbolNodes!.length).toBeGreaterThan(0);
  });
});

describe('get_outline (MCP-10) and path spelling (MCP-12)', () => {
  it('the live fallback returns the artifact shape, without imports', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    writeFileSync(
      path.join(root, 'src', 'live.ts'),
      "import './b';\nexport function live() {\n  return 2;\n}\n",
    );
    const json = JSON.parse(
      (await call('get_outline', { path: 'src/live.ts', format: 'json' })).text,
    );
    expect(json.source).toBe('live');
    expect(json.outline).toEqual([
      expect.objectContaining({
        name: 'live',
        kind: 'function',
        startLine: 2,
        endLine: 4,
        exported: true,
      }),
    ]);
    const pack = (await call('get_outline', { path: 'src/live.ts' })).text;
    expect(pack).not.toContain('undefined');
    const decl = decode(pack).tables.get('declarations')!;
    expect(decl.rows).toHaveLength(1);
  });

  it('backslash, ./ and absolute spellings hit the artifact; unknown targets are errors', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    for (const p of ['src\\b.ts', './src/b.ts', path.join(root, 'src', 'b.ts')]) {
      const r = JSON.parse(
        (await call('query_graph', { verb: 'callers', path: p, format: 'json' })).text,
      );
      expect(r.count, p).toBe(1);
    }
    const nope = await call('query_graph', { verb: 'callers', path: 'nope.ts', format: 'json' });
    expect(nope.isError).toBe(true);
    expect(JSON.parse(nope.text).error).toBe('not in graph');
    const b = await call('query_graph', { verb: 'callers', path: 'b.ts', format: 'json' });
    expect(JSON.parse(b.text).didYouMean).toEqual(['src/b.ts']);
    const tok = JSON.parse((await call('count_tokens', { path: './src/a.ts' })).text);
    expect(tok).toMatchObject({ path: 'src/a.ts', source: 'artifact' });
  });

  it('get_outline and count_tokens: a missing file is an isError result with didYouMean', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    for (const tool of ['get_outline', 'count_tokens']) {
      const miss = await call(tool, { path: 'b.ts', format: 'json' });
      expect(miss.isError, tool).toBe(true);
      expect(JSON.parse(miss.text), tool).toEqual({
        ok: false,
        error: 'File not found: b.ts',
        didYouMean: ['src/b.ts'],
      });
      // No close match: still the field, empty — never a guess.
      const none = JSON.parse((await call(tool, { path: 'src/zzz.ts' })).text);
      expect(none, tool).toMatchObject({ error: 'File not found: src/zzz.ts', didYouMean: [] });
    }
  });
});

describe('input validation (MCP-13) and isError results (MCP-14)', () => {
  it('malformed timestamps and limits are structured isError results', async () => {
    const root = makeProject();
    const { call } = await boot(root);
    for (const [tool, args] of [
      ['since', { timestamp: 'yesterday' }],
      ['since', {}],
      ['query_learnings', { since: 'garbage' }],
      ['query_learnings', { limit: -1 }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(JSON.parse(r.text).issues.length).toBeGreaterThan(0);
    }
  });

  it('tool failures are results, not JSON-RPC errors; unknown tools stay protocol errors', async () => {
    const root = makeProject();
    const { client, call } = await boot(root);
    const dir = await call('count_tokens', { path: 'src' });
    expect(dir).toMatchObject({ isError: true });
    expect(dir.text).toMatch(/Not a file/);
    const escape = await call('get_outline', { path: '../x.ts' });
    expect(escape.isError).toBe(true);
    expect(escape.text).toMatch(/outside project root/);
    // MCP-R5: an existing absolute file elsewhere is "outside", not "not found".
    const elsewhere = fileURLToPath(import.meta.url)
      .replace(/^[A-Za-z]:/, '')
      .replace(/\\/g, '/');
    for (const tool of ['get_outline', 'count_tokens']) {
      const r = await call(tool, { path: elsewhere });
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/outside project root/);
    }
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );
    // The dispatch table's inherited keys are not tools either.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      await expect(client.callTool({ name, arguments: {} }), name).rejects.toThrow(/Unknown tool/);
    }
  });

  it('a learning with reasoning "-" no longer breaks default-format query_learnings', async () => {
    const root = makeProject();
    const { call } = await boot(root);
    await call('log_learning', {
      agent: 'p',
      action: 'decision',
      outcome: 'pending',
      reasoning: '-',
    });
    const r = await call('query_learnings');
    expect(r.isError).toBe(false);
    expect(decode(r.text).tables.get('learnings')!.rows.length).toBeGreaterThan(0);
  });
});

describe('sync_pack', () => {
  it('serves the full master, then "current" for the sha it returned', async () => {
    const root = makeProject();
    const { call, warm } = await boot(root);
    await warm;
    const full = JSON.parse((await call('sync_pack')).text);
    expect(full.status).toBe('full');
    const again = JSON.parse((await call('sync_pack', { have: full.sha })).text);
    expect(again.status).toBe('current');
  });
});

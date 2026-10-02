/**
 * The ONE analyze-and-write pipeline (tech-debt#6) that `analyze`, `ui`
 * (start-up, Re-analyze, --watch), `export` and `quick` share. It used to be
 * two hand-kept copies; these pin what each option does to the written
 * artifact set, the F8 cache and what is reported on stderr.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BASELINE_AGENT_FILE,
  GIT_STATS_CACHE_FILE,
  TOPOLOGY_CACHE_FILE,
  type AgentArtifact,
} from '@factstack/spec';
import {
  analyzeAndWrite,
  analyzeProject,
  BASELINE_HOLD_MARK,
  diffSkippedLine,
  gitStatsCache,
  openCacheSafe,
  topologyCache,
} from '../src/pipeline.js';
import { fixtureProject, hermeticEnv, plain, runCli } from './cli-io.js';

const temps: string[] = [];
const fresh = (): string => {
  const d = fixtureProject('facts-pipeline-');
  temps.push(d);
  return d;
};
const facts = (root: string, ...rel: string[]) => path.join(root, '.facts', ...rel);
let restoreEnv: () => void = () => {};
beforeAll(() => {
  restoreEnv = hermeticEnv();
});
afterAll(() => {
  restoreEnv();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const T = 60_000;

describe('analyzeProject', () => {
  it(
    'defaults: the legacy set, no snapshot, a .gitignore entry, the F8 cache filled then reused',
    async () => {
      const root = fresh();
      const progress: number[] = [];
      const first = await analyzeProject(root, { onProgress: (pct) => progress.push(pct) });
      for (const f of ['agent.json', 'human.json', 'agent.pack', 'agent.jsonl', 'MEMORY.md']) {
        expect(existsSync(facts(root, f)), f).toBe(true);
      }
      expect(first.written.agentPath).toBe(facts(root, 'agent.json'));
      expect(first.written.snapshotPath).toBeNull();
      expect(existsSync(facts(root, 'snapshots'))).toBe(false);
      expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('.facts');
      expect(first.agent.stats.fileCount).toBeGreaterThanOrEqual(3);
      expect(first.hostIgnoreRules).toEqual([]); // not a git repository
      expect(progress.at(-1)).toBe(1);
      expect(first.cacheStats!.hits).toBe(0);
      expect(first.cacheStats!.misses).toBeGreaterThan(0);

      const second = await analyzeProject(root);
      expect(second.cacheStats).toEqual({ hits: first.cacheStats!.misses, misses: 0 });
      // Byte-identical analysis either way (INV2) — only the timestamp moves.
      const strip = (a: object) => JSON.stringify({ ...a, generatedAt: '' });
      expect(strip(second.agent)).toBe(strip(first.agent));
    },
    T,
  );

  it(
    'cache:false runs without the F8 cache; writeSnapshot + addGitignoreEntry:false are honoured',
    async () => {
      const root = fresh();
      const r = await analyzeProject(root, {
        cache: false,
        writeSnapshot: true,
        addGitignoreEntry: false,
      });
      expect(r.cacheStats).toBeNull();
      expect(existsSync(facts(root, 'cache.db'))).toBe(false);
      expect(readdirSync(facts(root, 'snapshots'))).toHaveLength(1);
      expect(r.written.snapshotPath).not.toBeNull();
      expect(existsSync(path.join(root, '.gitignore'))).toBe(false);
    },
    T,
  );

  it(
    'minimal: the lean set (no agent.json on a fresh project), no snapshot by default',
    async () => {
      const root = fresh();
      const r = await analyzeProject(root, { minimal: true });
      expect(existsSync(facts(root, 'agent.pack'))).toBe(true);
      expect(existsSync(facts(root, 'human.json'))).toBe(true);
      expect(existsSync(facts(root, 'MEMORY.md'))).toBe(true);
      expect(existsSync(facts(root, 'agent.json'))).toBe(false);
      expect(r.written.agentPath).toBeNull();
      expect(existsSync(facts(root, 'snapshots'))).toBe(false);
    },
    T,
  );

  it(
    'symbols: builds the symbol graph only when asked',
    async () => {
      const root = fresh();
      const off = await analyzeProject(root, { cache: false });
      expect(off.agent.graph.symbolNodes ?? []).toEqual([]);
      const on = await analyzeProject(root, { cache: false, symbols: true });
      expect((on.agent.graph.symbolNodes ?? []).length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    'a malformed carried-forward CVE scan is reported on the injected stderr, never fatal',
    async () => {
      const root = fresh();
      await analyzeProject(root);
      const p = facts(root, 'agent.json');
      const art = JSON.parse(readFileSync(p, 'utf8'));
      art.vulnerabilityScan = { scannedAt: '2026-09-01T00:00:00.000Z', findings: 1 };
      writeFileSync(p, JSON.stringify(art));
      const run = await runCli((io) => analyzeProject(root, {}, io));
      expect(run.code).toBe(0);
      expect(plain(run.stderr)).toMatch(/vulns: .*scan-vulns/);
    },
    T,
  );
});

describe('analyzeAndWrite (ui / watch / export / quick)', () => {
  it(
    'is analyzeProject with its defaults, and says why no agent.diff.pack was written',
    async () => {
      const root = fresh();
      const clean = await runCli((io) => analyzeAndWrite(root, {}, io));
      expect(clean.stderr).toBe('');
      expect(existsSync(facts(root, 'agent.json'))).toBe(true);
      expect(existsSync(facts(root, 'snapshots'))).toBe(false);

      writeFileSync(facts(root, 'agent.pack'), 'not a pack\n');
      const skipped = await runCli((io) => analyzeAndWrite(root, { writeSnapshot: true }, io));
      expect(plain(skipped.stderr)).toMatch(/^ {2}no agent\.diff\.pack: previous agent\.pack /);
      expect(readdirSync(facts(root, 'snapshots'))).toHaveLength(1); // the ui re-analyze path
    },
    T,
  );

  /* performance#5 / correctness#5: `ui --watch` re-analyzes on every save.
     Each write used to park the previous agent.json as the review baseline,
     so "previous analysis" meant "one save ago" (and each save copied the
     multi-MB baseline). Then no refresh rotated at all — and the next
     explicit analyze parked the LAST SAVE (cli-rev-1). The baseline is now
     always the last explicit analyze older than the head. */
  it(
    'the baseline is the last explicit analyze — during a watch session and after it',
    async () => {
      const root = fresh();
      const at = (rel: string): string =>
        JSON.parse(readFileSync(facts(root, ...rel.split('/')), 'utf8')).generatedAt;
      const mark = facts(root, ...BASELINE_HOLD_MARK.split('/'));
      const first = await analyzeProject(root, { cache: false });
      const second = await analyzeProject(root, { cache: false }); // parks `first`
      expect(at(BASELINE_AGENT_FILE)).toBe(first.agent.generatedAt);
      expect(existsSync(mark)).toBe(false);

      // The first refresh parks the analyze it replaces, once, then holds it.
      const saved = await analyzeAndWrite(root, { writeSnapshot: true }); // a watch save
      expect(at('agent.json')).toBe(saved.agent.generatedAt);
      expect(at(BASELINE_AGENT_FILE)).toBe(second.agent.generatedAt);
      expect(existsSync(mark)).toBe(true);
      const parked = statSync(facts(root, ...BASELINE_AGENT_FILE.split('/'))).mtimeMs;
      const exported = await analyzeAndWrite(root); // ui start-up / export / quick
      await analyzeAndWrite(root, { writeSnapshot: true }); // another save
      expect(at(BASELINE_AGENT_FILE)).toBe(second.agent.generatedAt);
      // Later refreshes copy nothing.
      expect(statSync(facts(root, ...BASELINE_AGENT_FILE.split('/'))).mtimeMs).toBe(parked);
      expect(exported.agent.generatedAt).not.toBe(saved.agent.generatedAt);

      // watch save → analyze: compared against the previous ANALYZE, not the last save.
      const third = await analyzeProject(root, { cache: false });
      expect(at(BASELINE_AGENT_FILE)).toBe(second.agent.generatedAt);
      expect(existsSync(mark)).toBe(false);
      // …and analyze → analyze rotates as it always did.
      await analyzeProject(root, { cache: false });
      expect(at(BASELINE_AGENT_FILE)).toBe(third.agent.generatedAt);
    },
    T,
  );

  it(
    'a refresh before any analyze is never parked as a baseline',
    async () => {
      const root = fresh();
      await analyzeAndWrite(root); // `factstack ui` on a fresh project
      expect(existsSync(facts(root, ...BASELINE_HOLD_MARK.split('/')))).toBe(true);
      await analyzeProject(root, { cache: false });
      expect(existsSync(facts(root, ...BASELINE_AGENT_FILE.split('/')))).toBe(false);
    },
    T,
  );

  it(
    '--minimal never touches the hold marker',
    async () => {
      const root = fresh();
      await analyzeProject(root, { cache: false });
      await analyzeAndWrite(root);
      const mark = facts(root, ...BASELINE_HOLD_MARK.split('/'));
      const body = readFileSync(mark, 'utf8');
      await analyzeProject(root, { cache: false, minimal: true, refresh: true });
      expect(readFileSync(mark, 'utf8')).toBe(body);
    },
    T,
  );
});

/* performance#2 / data-model#5: the gitStats cache was built and tested in
   fs-node but never passed, so every per-edit hook still walked the whole
   `git log`. */
describe('the git-stats cache (GIT_STATS_CACHE_FILE)', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'cli test',
    GIT_AUTHOR_EMAIL: 'test@factstack.invalid',
    GIT_COMMITTER_NAME: 'cli test',
    GIT_COMMITTER_EMAIL: 'test@factstack.invalid',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  const gitRepo = (): string => {
    const root = fresh();
    for (const args of [
      ['init', '-q'],
      ['add', '-A'],
      ['commit', '-q', '-m', 'init'],
    ]) {
      const r = spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: GIT_ENV,
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    }
    return root;
  };
  const churn = (a: AgentArtifact, p: string) => a.files.find((f) => f.path === p)?.churnScore;
  type CacheBody = { stats: Array<[string, { churnScore: number }]> };

  it(
    'a full analyze mines and refreshes it; only --minimal reuses it',
    async () => {
      const root = gitRepo();
      const file = facts(root, GIT_STATS_CACHE_FILE);
      const full = await analyzeProject(root, { cache: false });
      expect(existsSync(file)).toBe(true);
      expect(churn(full.agent, 'src/a.ts')).toBe(1);

      // Tamper with the stored walk: a reuse shows it, a re-mine does not.
      const body = JSON.parse(readFileSync(file, 'utf8')) as CacheBody;
      for (const [p, s] of body.stats) if (p === 'src/a.ts') s.churnScore = 42;
      writeFileSync(file, JSON.stringify(body));
      const hook = await analyzeProject(root, { cache: false, minimal: true });
      expect(churn(hook.agent, 'src/a.ts')).toBe(42); // no `git log` walk

      const again = await analyzeProject(root, { cache: false });
      expect(churn(again.agent, 'src/a.ts')).toBe(1);
      const refreshed = JSON.parse(readFileSync(file, 'utf8')) as CacheBody;
      expect(refreshed.stats.find(([p]) => p === 'src/a.ts')?.[1].churnScore).toBe(1);
    },
    T,
  );

  it('gitStatsCache points at .facts/<GIT_STATS_CACHE_FILE>', () => {
    const root = path.resolve('/proj');
    expect(gitStatsCache(root, false)).toEqual({
      file: path.join(root, '.facts', GIT_STATS_CACHE_FILE),
      reuse: false,
    });
  });
});

describe('pipeline helpers', () => {
  it('topologyCache points at .facts/<TOPOLOGY_CACHE_FILE>', () => {
    const root = path.resolve('/proj');
    expect(topologyCache(root, true)).toEqual({
      file: path.join(root, '.facts', TOPOLOGY_CACHE_FILE),
      reuse: true,
    });
  });

  it('openCacheSafe degrades to no cache instead of failing the analyze', () => {
    const root = fresh();
    writeFileSync(path.join(root, '.facts'), 'a file where the directory should be');
    expect(openCacheSafe(root)).toBeUndefined();
  });

  it('diffSkippedLine is empty unless emit skipped the diff', () => {
    expect(diffSkippedLine({})).toBe('');
    expect(plain(diffSkippedLine({ diffSkipped: 'duplicate primary key' }))).toBe(
      '  no agent.diff.pack: duplicate primary key',
    );
  });
});

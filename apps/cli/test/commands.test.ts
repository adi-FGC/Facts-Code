/**
 * The commands in src/commands/, run in-process over a throw-away project
 * (tech-debt#6): the `--json` shape of analyze / query / diff / review /
 * scan-vulns / export-diagram / tokens / why / context-store, and the exit
 * codes of their validation paths; ci-report's graded gate (cli-r3-2),
 * install's canonical root (cli-r3-1/3) and the write path export-skills and
 * setup-agents share (cli-dry-1). cli-e2e.test.ts still drives the real
 * binary end to end; these pin the glue without a spawn per case.
 *
 * Telemetry is mocked (nothing is written under the real home dir) and
 * scan-vulns runs against a stubbed OSV.dev (no network).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeQuery } from '@factstack/core';
import { ALL_FORMATS } from '@factstack/skills';
import {
  BASELINE_AGENT_FILE,
  CLI_PUBLISHED,
  MCP_PUBLISHED,
  type AgentArtifact,
} from '@factstack/spec';
import type { CliIO } from '../src/io.js';
import { FRESHNESS_HOOK_COMMAND } from '../src/agentHook.js';
import { GIT_HOOK_COMMAND } from '../src/gitHook.js';
import { analyzeCommand } from '../src/commands/analyze.js';
import { ciReportCommand } from '../src/commands/ci-report.js';
import { installCommand, uninstallCommand } from '../src/commands/install.js';
import { formatServerCommand, MCP_NOT_PUBLISHED_NOTE } from '../src/mcpInstall.js';
import { contextStoreCommand, rememberCommand } from '../src/commands/context.js';
import { diffCommand } from '../src/commands/diff.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { exportDiagramCommand } from '../src/commands/export-diagram.js';
import { hookCommand } from '../src/commands/hook.js';
import { queryCommand } from '../src/commands/query.js';
import { reviewCommand } from '../src/commands/review.js';
import { scanVulnsCommand } from '../src/commands/scan-vulns.js';
import { exportSkillsCommand, setupAgentsCommand } from '../src/commands/skills.js';
import { telemetryCommand } from '../src/commands/telemetry.js';
import { tokensCommand } from '../src/commands/tokens.js';
import { whyCommand } from '../src/commands/why.js';
import { fixtureProject, hermeticEnv, plain, runCli } from './cli-io.js';

const telemetry = vi.hoisted(() => ({ events: [] as Array<[string, Record<string, unknown>]> }));
vi.mock('../src/telemetry.js', () => ({
  createTelemetry: () => ({
    recordEvent: async (name: string, data: Record<string, unknown>) => {
      telemetry.events.push([name, data]);
    },
  }),
}));

const temps: string[] = [];
let restoreEnv: () => void = () => {};
let root = '';
const T = 60_000;

const analyzeJson = (dir: string) =>
  runCli((io) => analyzeCommand(dir, { json: true, progress: false, agentRequests: false }, io));

beforeAll(async () => {
  restoreEnv = hermeticEnv();
  root = fixtureProject();
  temps.push(root);
  // Two full analyzes: the second parks the first as the review baseline.
  expect((await analyzeJson(root)).code).toBe(0);
  expect((await analyzeJson(root)).code).toBe(0);
}, 120_000);
afterAll(() => {
  restoreEnv();
  vi.unstubAllGlobals();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const keys = (o: object) => Object.keys(o).sort();

describe('analyze', () => {
  it(
    '--json: the result shape, with secrets and cache stats; telemetry records numbers only',
    async () => {
      telemetry.events.length = 0;
      const r = await analyzeJson(root);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(keys(out)).toEqual([
        'agentPath',
        'bytesWritten',
        'cache',
        'diffPath',
        'elapsedMs',
        'humanPath',
        'jsonlPath',
        'memoryPath',
        'ok',
        'packPath',
        'risks',
        'secrets',
        'snapshotPath',
        'stats',
      ]);
      expect(out.ok).toBe(true);
      expect(out.agentPath).toBe(path.join(root, '.facts', 'agent.json'));
      expect(out.stats.fileCount).toBeGreaterThanOrEqual(3);
      expect(out.cache.misses).toBe(0); // third run over an unchanged tree: all hits
      expect(out.secrets).toEqual([]);
      expect(telemetry.events).toHaveLength(1);
      const [name, data] = telemetry.events[0]!;
      expect(name).toBe('analyze.complete');
      expect(keys(data)).toEqual(['durationMs', 'fileCount', 'root', 'surface']);
      expect(data.surface).toBe('cli');
    },
    T,
  );

  it(
    'TTY: the summary goes to stderr, nothing to stdout',
    async () => {
      const r = await runCli((io) =>
        analyzeCommand(root, { progress: false, agentRequests: false }, io),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      const err = plain(r.stderr);
      expect(err).toContain('FACTS · analyzing');
      expect(err).toMatch(/Summary[\s\S]*files[\s\S]*Artifacts/);
      expect(err).toContain('✓ .facts/agent.json');
      expect(err).toContain('✓ .facts/agent.pack');
    },
    T,
  );

  it('a missing target or a file exits 1 with the reason', async () => {
    const missing = await runCli((io) => analyzeCommand(path.join(root, 'nope'), {}, io));
    expect(missing.code).toBe(1);
    expect(plain(missing.stderr)).toContain('does not exist');
    const file = await runCli((io) => analyzeCommand(path.join(root, 'package.json'), {}, io));
    expect(file.code).toBe(1);
    expect(plain(file.stderr)).toContain('is not a directory');
    expect(plain(file.stderr)).not.toContain('does not exist');
  });
});

describe('query', () => {
  const q = (selector: string, targets: string[], extra: object = {}) =>
    runCli((io) =>
      queryCommand(selector, targets, { root, limit: '200', depth: '1', ...extra }, io),
    );

  it('--json callers: the QueryResult shape', async () => {
    const r = await q('callers', ['src\\a.ts'], { json: true });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ verb: 'callers', count: 2 });
    expect(out.results.sort()).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('TTY cycles: the header and one block per cycle on stderr', async () => {
    const r = await q('cycles', []);
    expect(r.code).toBe(0);
    expect(plain(r.stderr)).toMatch(/^cycles — 1 result\n {2}─── cycle ───\n/);
  });

  it('validation paths exit 1', async () => {
    expect((await q('callers', [])).code).toBe(1);
    expect((await q('path-between', ['src/b.ts'])).code).toBe(1);
    expect((await q('callers', ['src/a.ts'], { minConfidence: 'bogus' })).code).toBe(1);
    expect((await q('neighbors', ['src/a.ts'], { direction: 'sideways' })).code).toBe(1);
    const free = await q('zzqq', ['nothing', 'here'], { json: true });
    expect(free.code).toBe(1); // no candidates
    expect(JSON.parse(free.stdout)).toMatchObject({ ok: false, candidates: [] });
  });

  it('a path the graph does not know is called out, not reported as "no callers"', async () => {
    const r = await q('callers', ['src/nope.ts']);
    expect(r.code).toBe(0);
    expect(plain(r.stderr)).toContain('is not a file in the graph');
  });

  /* --depth defaulted to 1 for every verb, so `impact` gave a 1-hop
     blast radius while core (and MCP query_graph) default it to 3. */
  it('impact without --depth is core’s default answer (the one MCP gives)', async () => {
    const run = (extra: object) =>
      runCli((io) =>
        queryCommand('impact', ['src/c.ts'], { root, limit: '200', json: true, ...extra }, io),
      );
    const def = await run({});
    expect(def.code, def.stderr).toBe(0);
    const agent = JSON.parse(
      readFileSync(path.join(root, '.facts', 'agent.json'), 'utf8'),
    ) as AgentArtifact;
    const core = executeQuery(agent, { verb: 'impact', path: 'src/c.ts', limit: 200 });
    expect(JSON.parse(def.stdout).results).toEqual(core.results);
    // b.ts reaches c.ts in two hops (b → a → c): inside the default, outside -d 1.
    expect(JSON.stringify(core.results)).toContain('src/b.ts');
    const one = JSON.parse((await run({ depth: '1' })).stdout);
    expect(JSON.stringify(one.results)).not.toContain('src/b.ts');
  });
});

/* After the per-edit `analyze --minimal` hook, agent.json is the last
   FULL analyze (marked `.stale`). diff/review/ci-report compared against it
   silently, and `review --fail-on` passed on it. */
describe('a stale head is said, and never gated on', () => {
  it(
    'diff and review warn; review --fail-on and ci-report --fail-on-shift refuse (exit 2)',
    async () => {
      const dir = fixtureProject('facts-cli-stale-');
      temps.push(dir);
      expect((await analyzeJson(dir)).code).toBe(0);
      expect((await analyzeJson(dir)).code).toBe(0); // a review baseline
      const hook = await runCli((io) =>
        analyzeCommand(dir, { json: true, progress: false, minimal: true }, io),
      );
      expect(hook.code, hook.stderr).toBe(0);
      const staleSays = /agent\.json is older than the newest analysis/;

      const diff = await runCli((io) =>
        diffCommand(undefined, undefined, { root: dir, json: true }, io),
      );
      expect(diff.code, diff.stderr).toBe(0);
      expect(plain(diff.stderr)).toMatch(staleSays);
      expect(JSON.parse(diff.stdout).headStale).toMatchObject({ file: 'agent.json' });

      const review = await runCli((io) =>
        reviewCommand(undefined, undefined, { root: dir, json: true }, io),
      );
      expect(review.code, review.stderr).toBe(0);
      expect(plain(review.stderr)).toMatch(staleSays);
      expect(JSON.parse(review.stdout).headStale).toMatchObject({ file: 'agent.json' });

      const gated = await runCli((io) =>
        reviewCommand(undefined, undefined, { root: dir, failOn: 'high' }, io),
      );
      expect(gated.code).toBe(2);
      expect(gated.stdout).toBe(''); // refused before any verdict
      expect(plain(gated.stderr)).toContain('--fail-on does not gate a stale head');

      const base = path.join(dir, '.facts', ...BASELINE_AGENT_FILE.split('/'));
      const ci = await runCli((io) => ciReportCommand(dir, { base }, io));
      expect(ci.code, ci.stderr).toBe(0);
      expect(plain(ci.stderr)).toMatch(staleSays);
      const ciGate = await runCli((io) => ciReportCommand(dir, { base, failOnShift: '1' }, io));
      expect(ciGate.code).toBe(2);
      // A head the caller names is their choice: no warning, the gate runs.
      const named = await runCli((io) =>
        ciReportCommand(
          dir,
          { base, head: path.join(dir, '.facts', 'agent.json'), failOnShift: '1' },
          io,
        ),
      );
      expect(named.code, named.stderr).toBe(0);
      expect(plain(named.stderr)).not.toMatch(staleSays);
    },
    T,
  );
});

describe('diff and review against the review baseline', () => {
  it('diff --json: a full per-file diff (both endpoints are full artifacts)', async () => {
    const r = await runCli((io) => diffCommand(undefined, undefined, { root, json: true }, io));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toHaveProperty('from.at');
    expect(out).toHaveProperty('to.at');
    expect(keys(out.stats)).toEqual(
      expect.arrayContaining(['files', 'loc', 'tokens', 'risks', 'todos', 'secrets']),
    );
    expect(out.files.incomplete).toBeFalsy();
    expect(out.files).toMatchObject({ added: [], removed: [] });
  });

  it('diff with no endpoints exits 1', async () => {
    const empty = fixtureProject('facts-cli-empty-');
    temps.push(empty);
    const r = await runCli((io) => diffCommand(undefined, undefined, { root: empty }, io));
    expect(r.code).toBe(1);
    expect(plain(r.stderr)).toContain('need two analyzable endpoints');
  });

  it('review --json: an unchanged tree reads NONE; --fail-on validates and gates', async () => {
    const r = await runCli((io) =>
      reviewCommand(undefined, undefined, { root, json: true, failOn: 'low' }, io),
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).severity).toBe('none');
    const bad = await runCli((io) =>
      reviewCommand(undefined, undefined, { root, failOn: 'nope' }, io),
    );
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe(''); // refused before any verdict
    const md = await runCli((io) =>
      reviewCommand(undefined, undefined, { root, failOn: 'none' }, io),
    );
    expect(md.code).toBe(0);
    expect(md.stdout.length).toBeGreaterThan(0);
  });
});

describe('diff and review before a baseline exists (cli-dry-2)', () => {
  it(
    'the default base is a snapshot rollup: review says so, diff marks the per-file diff incomplete',
    async () => {
      const dir = fixtureProject('facts-cli-rollup-');
      temps.push(dir);
      expect((await analyzeJson(dir)).code).toBe(0); // one analyze: a snapshot, no baseline
      const review = await runCli((io) =>
        reviewCommand(undefined, undefined, { root: dir, json: true }, io),
      );
      expect(review.code, review.stderr).toBe(0);
      expect(plain(review.stderr)).toContain('no review baseline yet');
      const diff = await runCli((io) =>
        diffCommand(undefined, undefined, { root: dir, json: true }, io),
      );
      expect(diff.code, diff.stderr).toBe(0);
      expect(JSON.parse(diff.stdout).files.incomplete).toBe(true);
      expect(diff.stderr).toBe('');
      // A named base is not a fallback: no notice.
      const agent = path.join(dir, '.facts', 'agent.json');
      const named = await runCli((io) =>
        reviewCommand(agent, undefined, { root: dir, json: true }, io),
      );
      expect(named.code, named.stderr).toBe(0);
      expect(plain(named.stderr)).not.toContain('no review baseline yet');
    },
    T,
  );
});

describe('export-skills and setup-agents share one write path (cli-dry-1)', () => {
  let dir = '';
  beforeAll(async () => {
    dir = fixtureProject('facts-cli-skills-');
    temps.push(dir);
    expect((await analyzeJson(dir)).code).toBe(0);
  }, T);

  it('an unknown --format exits 1 under the command name, before writing anything', async () => {
    const want = (cmd: string) =>
      `factstack ${cmd}: unknown formats: cusror, nope\n  available: ${ALL_FORMATS.join(', ')}\n`;
    const ex = await runCli((io) =>
      exportSkillsCommand(dir, { format: 'claude, cusror,nope' }, io),
    );
    expect(ex.code).toBe(1);
    expect(plain(ex.stderr)).toBe(want('export-skills'));
    const setup = await runCli((io) =>
      setupAgentsCommand(dir, { format: 'claude, cusror,nope', hook: true }, io),
    );
    expect(setup.code).toBe(1);
    expect(plain(setup.stderr)).toBe(want('setup-agents'));
    expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(dir, '.cursorrules'))).toBe(false);
  });

  it('no artifacts: exit 1 naming the command to re-run', async () => {
    const empty = fixtureProject('facts-cli-noskills-');
    temps.push(empty);
    for (const [cmd, run] of [
      ['export-skills', (io: CliIO) => exportSkillsCommand(empty, {}, io)],
      ['setup-agents', (io: CliIO) => setupAgentsCommand(empty, { hook: true }, io)],
    ] as const) {
      const r = await runCli(run);
      expect(r.code).toBe(1);
      expect(plain(r.stderr)).toBe(
        `factstack ${cmd}: no .facts/agent.json or human.json found.\n` +
          `  run \`factstack analyze .\` first; then re-run ${cmd}.\n`,
      );
    }
    expect(existsSync(path.join(empty, '.claude'))).toBe(false); // no hook either
  });

  it('one kept wording in both summaries, true for AGENTS.md and for a rules file', async () => {
    writeFileSync(path.join(dir, 'AGENTS.md'), '# our own agent guide\n');
    writeFileSync(path.join(dir, '.cursorrules'), 'our own rules\n');
    const kept =
      '  • .cursorrules — kept (existing file without the FACTS marker, not overwritten)\n' +
      '  • AGENTS.md — kept (existing AGENTS.md, not overwritten; --format agents replaces it)\n';
    const footer = /\n\n {2}4 formats · \d+ files · [^\n]+ written\n\n$/;

    const ex = await runCli((io) => exportSkillsCommand(dir, {}, io));
    expect(ex.code, ex.stderr).toBe(0);
    const exErr = plain(ex.stderr);
    expect(exErr).toContain('FACTS · export-skills');
    expect(exErr).toContain(kept + '\n  4 formats · ');
    expect(exErr).toMatch(footer);

    const setup = await runCli((io) => setupAgentsCommand(dir, { hook: false }, io));
    expect(setup.code, setup.stderr).toBe(0);
    const setupErr = plain(setup.stderr);
    expect(setupErr).toContain('FACTS · setup-agents');
    // The hook line sits between the kept lines and the footer.
    expect(setupErr).toContain(kept + '  · freshness hook skipped (--no-hook)\n');
    expect(setupErr).toMatch(footer);

    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('# our own agent guide\n');
    expect(readFileSync(path.join(dir, '.cursorrules'), 'utf8')).toBe('our own rules\n');
    // The hint in the AGENTS.md line holds: an explicit request replaces it.
    const agents = await runCli((io) => exportSkillsCommand(dir, { format: 'agents' }, io));
    expect(agents.code, agents.stderr).toBe(0);
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).not.toBe('# our own agent guide\n');
  });

  it(
    'install keeps the same files, and its AGENTS.md line says why (not a missing marker)',
    async () => {
      const own = fixtureProject('facts-cli-install-kept-');
      temps.push(own);
      expect((await analyzeJson(own)).code).toBe(0);
      writeFileSync(path.join(own, 'AGENTS.md'), '# our own agent guide\n');
      writeFileSync(path.join(own, '.cursorrules'), 'our own rules\n');

      const tty = await runCli((io) => installCommand(own, { agent: 'all' }, io));
      expect(tty.code, tty.stderr).toBe(0);
      const err = plain(tty.stderr);
      expect(err).toContain(
        '    • AGENTS.md — kept (existing AGENTS.md, not overwritten; `factstack export-skills --format agents` replaces it)\n',
      );
      expect(err).toContain(
        '    • .cursorrules — kept (existing file without the FACTS marker, not overwritten)\n',
      );
      expect(err).not.toContain('AGENTS.md — kept (existing file without the FACTS marker');
      expect(readFileSync(path.join(own, 'AGENTS.md'), 'utf8')).toBe('# our own agent guide\n');
      expect(readFileSync(path.join(own, '.cursorrules'), 'utf8')).toBe('our own rules\n');

      // The same preserve rules as export-skills' default path, in --json too.
      const json = JSON.parse(
        (await runCli((io) => installCommand(own, { agent: 'all', json: true }, io))).stdout,
      );
      const preserved = Object.fromEntries(
        json.agents.map((a: { agent: string; preserved: string[] }) => [a.agent, a.preserved]),
      );
      expect(preserved).toEqual({ claude: ['AGENTS.md'], cursor: ['.cursorrules'], copilot: [] });
      // The hint holds: export-skills --format agents replaces it.
      const agents = await runCli((io) => exportSkillsCommand(own, { format: 'agents' }, io));
      expect(agents.code, agents.stderr).toBe(0);
      expect(readFileSync(path.join(own, 'AGENTS.md'), 'utf8')).not.toBe('# our own agent guide\n');
    },
    T,
  );

  it('--json: the same fields from both commands; setup-agents adds the hook', async () => {
    const ex = await runCli((io) => exportSkillsCommand(dir, { format: 'claude', json: true }, io));
    expect(ex.code, ex.stderr).toBe(0);
    const exOut = JSON.parse(ex.stdout);
    expect(keys(exOut)).toEqual(['bytesWritten', 'files', 'formats', 'ok', 'preserved']);
    expect(exOut).toMatchObject({ ok: true, formats: ['claude'], preserved: [] });
    const setup = await runCli((io) =>
      setupAgentsCommand(dir, { format: 'claude', hook: false, json: true }, io),
    );
    expect(setup.code, setup.stderr).toBe(0);
    const { hook, ...rest } = JSON.parse(setup.stdout);
    expect(hook).toBeNull();
    expect(rest).toEqual(exOut);
  });
});

describe('small commands', () => {
  it('export-diagram --json: the envelope', async () => {
    const r = await runCli((io) =>
      exportDiagramCommand(
        root,
        { view: 'package', depth: '2', maxNodes: '30', wrap: true, json: true },
        io,
      ),
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(keys(out)).toEqual(['depth', 'maxNodes', 'mermaid', 'view']);
    expect(out.mermaid).toMatch(/flowchart/);
    const focal = await runCli((io) =>
      exportDiagramCommand(root, { view: 'focal', depth: '2', maxNodes: '30', wrap: true }, io),
    );
    expect(focal.code).toBe(1);
  });

  it('tokens --json, why --json, context-store --json', async () => {
    const t = await runCli((io) =>
      tokensCommand(path.join(root, 'src', 'a.ts'), { json: true }, io),
    );
    expect(keys(JSON.parse(t.stdout))).toEqual(['chars', 'path', 'tokens']);
    const w = await runCli((io) => whyCommand('a.ts', { root, json: true }, io));
    expect(keys(JSON.parse(w.stdout))).toEqual(['count', 'rationale', 'target']);
    const rem = await runCli((io) =>
      rememberCommand('decision', ['use', 'sessions'], { agent: 'test', root, json: true }, io),
    );
    expect(JSON.parse(rem.stdout)).toMatchObject({
      ok: true,
      kind: 'decision',
      memoryRefreshed: true,
    });
    const cs = await runCli((io) => contextStoreCommand({ root, json: true }, io));
    expect(JSON.parse(cs.stdout).decisions.map((d: { text: string }) => d.text)).toContain(
      'use sessions',
    );
    expect(
      (await runCli((io) => rememberCommand('bogus', ['x'], { agent: 'a', root }, io))).code,
    ).toBe(1);
  });

  /* Uninstall printed "✗ … failed" (or ok:false) and exited 0, so a
     scripted teardown read a failed removal as success. */
  it('uninstall exits 1 when a removal failed, in --json and on a TTY', async () => {
    const dir = fixtureProject('facts-cli-uninstall-');
    temps.push(dir);
    writeFileSync(path.join(dir, '.mcp.json'), '{ not json');
    const json = await runCli((io) => uninstallCommand(dir, { agent: 'claude', json: true }, io));
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout).ok).toBe(false);
    const tty = await runCli((io) => uninstallCommand(dir, { agent: 'claude' }, io));
    expect(tty.code).toBe(1);
    expect(plain(tty.stderr)).toContain('✗ .mcp.json');
    rmSync(path.join(dir, '.mcp.json'));
    const clean = await runCli((io) => uninstallCommand(dir, { agent: 'claude' }, io));
    expect(clean.code, clean.stderr).toBe(0);
  });

  it('hook reports an unknown action through the exit code, without exiting', async () => {
    const r = await runCli((io) => hookCommand('bogus', root, { command: 'x' }, io));
    expect(r.code).toBe(1);
    expect(plain(r.stderr)).toContain('unknown action "bogus"');
  });

  it('telemetry rejects a mistyped action before touching any state', async () => {
    const r = await runCli((io) => telemetryCommand('optout', {}, io));
    expect(r.code).toBe(1);
    expect(plain(r.stderr)).toMatch(/unknown action "optout"/);
  });

  it('doctor passes on the Node running these tests (the floor is 24.3)', async () => {
    const r = await runCli((io) => doctorCommand(io));
    expect(r.code).toBe(0);
    expect(plain(r.stderr)).toMatch(/✓ Node ≥ 24\.3/);
  });
});

/* ── scan-vulns against a stubbed OSV.dev ─────────────────────────────── */

const PACKAGE_LOCK = JSON.stringify({
  name: 'demo',
  lockfileVersion: 3,
  packages: {
    '': {
      name: 'demo',
      dependencies: { lodash: '^4.17.0' },
      devDependencies: { vitest: '^1.0.0' },
    },
    'node_modules/lodash': { version: '4.17.20' },
    'node_modules/vitest': { version: '1.6.0', dev: true },
  },
});

const ADVISORY: Record<string, object> = {
  'GHSA-direct': {
    id: 'GHSA-direct',
    summary: 'prototype pollution',
    database_specific: { severity: 'HIGH' },
    affected: [
      {
        package: { name: 'lodash', ecosystem: 'npm' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
      },
    ],
  },
  'GHSA-dev': {
    id: 'GHSA-dev',
    database_specific: { severity: 'MODERATE' },
    affected: [{ package: { name: 'vitest', ecosystem: 'npm' } }],
  },
};

describe('scan-vulns (stubbed OSV.dev)', () => {
  it(
    '--json: lockfile versions, the direct finding graded, the dev one shown not graded',
    async () => {
      const dir = fixtureProject('facts-cli-vulns-');
      temps.push(dir);
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'demo',
          version: '1.0.0',
          dependencies: { lodash: '^4.17.0' },
          devDependencies: { vitest: '^1.0.0' },
        }),
      );
      writeFileSync(path.join(dir, 'package-lock.json'), PACKAGE_LOCK);
      expect((await analyzeJson(dir)).code).toBe(0);

      const urls: string[] = [];
      vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
        urls.push(url);
        if (url === 'https://api.osv.dev/v1/querybatch') {
          const { queries } = JSON.parse(init!.body!) as {
            queries: Array<{ package: { name: string } }>;
          };
          const hit: Record<string, string> = { lodash: 'GHSA-direct', vitest: 'GHSA-dev' };
          return new Response(
            JSON.stringify({
              results: queries.map((q) =>
                hit[q.package.name] ? { vulns: [{ id: hit[q.package.name] }] } : {},
              ),
            }),
          );
        }
        const id = decodeURIComponent(url.split('/').pop()!);
        return ADVISORY[id]
          ? new Response(JSON.stringify(ADVISORY[id]))
          : new Response('not found', { status: 404 });
      });
      try {
        const r = await runCli((io) => scanVulnsCommand(dir, { cache: true, json: true }, io));
        expect(r.code, r.stderr).toBe(0);
        const out = JSON.parse(r.stdout);
        expect(keys(out)).toEqual([
          'counts',
          'declaredRangeFindings',
          'elapsedMs',
          'findings',
          'lockfiles',
          'queryLabels',
          'scanned',
          'skipped',
          'skippedNonRegistry',
          'ungraded',
          'vulnerabilities',
          'vulnerablePackages',
        ]);
        expect(out.lockfiles).toEqual(['package-lock.json']);
        expect(out.findings).toBe(2);
        expect(out.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0, unknown: 0 });
        expect(out.ungraded).toEqual({
          findings: 1,
          counts: { critical: 0, high: 0, medium: 1, low: 0, unknown: 0 },
        });
        expect(out.declaredRangeFindings).toBe(0);
        const lodash = out.vulnerabilities.find((v: { id: string }) => v.id === 'GHSA-direct');
        expect(lodash).toMatchObject({
          graded: true,
          installedVersion: '4.17.20',
          versionSource: 'lockfile',
        });
        expect(out.vulnerabilities.find((v: { id: string }) => v.id === 'GHSA-dev')).toMatchObject({
          graded: false,
          scope: 'dev',
        });
        expect(urls.every((u) => u.startsWith('https://api.osv.dev/'))).toBe(true);
        // Persisted: the scan metadata is the staleness anchor.
        const agent = JSON.parse(readFileSync(path.join(dir, '.facts', 'agent.json'), 'utf8'));
        expect(agent.vulnerabilityScan).toMatchObject({ source: 'osv.dev', findings: 2 });
      } finally {
        vi.unstubAllGlobals();
      }
    },
    T,
  );

  /* data-model#3 / correctness#9: scan-vulns loaded agent.json, waited on
     OSV.dev, then wrote that loaded copy back — reverting an analyze the
     per-edit hook (or `ui --watch`, or MCP) wrote in between. */
  describe('an analysis written while OSV.dev is answering', () => {
    /** A lodash + vitest project, analyzed once; returns its root. */
    const analyzedProject = async (): Promise<string> => {
      const dir = fixtureProject('facts-cli-vulns-race-');
      temps.push(dir);
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'demo',
          version: '1.0.0',
          dependencies: { lodash: '^4.17.0' },
          devDependencies: { vitest: '^1.0.0' },
        }),
      );
      writeFileSync(path.join(dir, 'package-lock.json'), PACKAGE_LOCK);
      expect((await analyzeJson(dir)).code).toBe(0);
      return dir;
    };
    const read = (dir: string, f: string) =>
      JSON.parse(readFileSync(path.join(dir, '.facts', f), 'utf8'));
    /** OSV.dev answering `lodash → GHSA-direct`, running `during` once first. */
    const stubOsv = (during: () => Promise<void>) => {
      let ran = false;
      vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
        if (url === 'https://api.osv.dev/v1/querybatch') {
          if (!ran) {
            ran = true;
            await during();
          }
          const { queries } = JSON.parse(init!.body!) as {
            queries: Array<{ package: { name: string } }>;
          };
          return new Response(
            JSON.stringify({
              results: queries.map((q) =>
                q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-direct' }] } : {},
              ),
            }),
          );
        }
        const id = decodeURIComponent(url.split('/').pop()!);
        return ADVISORY[id]
          ? new Response(JSON.stringify(ADVISORY[id]))
          : new Response('not found', { status: 404 });
      });
    };

    it(
      'the scan lands on the newer analysis; the older copy is never written back',
      async () => {
        const dir = await analyzedProject();
        const loadedAt = read(dir, 'agent.json').generatedAt as string;
        let newerAt = '';
        stubOsv(async () => {
          expect((await analyzeJson(dir)).code).toBe(0); // the hook's analyze
          newerAt = read(dir, 'agent.json').generatedAt;
        });
        try {
          const r = await runCli((io) => scanVulnsCommand(dir, { cache: true }, io));
          expect(r.code, r.stderr).toBe(0);
          expect(newerAt).not.toBe(loadedAt);
          const agent = read(dir, 'agent.json');
          expect(agent.generatedAt).toBe(newerAt);
          expect(read(dir, 'human.json').generatedAt).toBe(newerAt);
          expect(agent.vulnerabilityScan).toMatchObject({ source: 'osv.dev', findings: 1 });
          expect(agent.vulnerabilities.map((v: { id: string }) => v.id)).toEqual(['GHSA-direct']);
          expect(plain(r.stderr)).toContain('applied to the newer analysis');
        } finally {
          vi.unstubAllGlobals();
        }
      },
      T,
    );

    it(
      'a newer agent.json whose human.json is from another run is refused, not overwritten',
      async () => {
        const dir = await analyzedProject();
        const p = path.join(dir, '.facts', 'agent.json');
        let midRun = '';
        stubOsv(async () => {
          // A writer mid-run: its agent.json has landed, its human.json not yet.
          const a = read(dir, 'agent.json');
          a.generatedAt = new Date(Date.parse(a.generatedAt) + 60_000).toISOString();
          midRun = JSON.stringify(a, null, 2);
          writeFileSync(p, midRun);
        });
        try {
          const r = await runCli((io) => scanVulnsCommand(dir, { cache: true }, io));
          expect(r.code).toBe(1);
          expect(plain(r.stderr)).toMatch(/newer analysis .* not writing the older analysis/);
          expect(readFileSync(p, 'utf8')).toBe(midRun);
        } finally {
          vi.unstubAllGlobals();
        }
      },
      T,
    );

    /* The per-edit hook runs `analyze --minimal`, which writes agent.pack
       but no agent.json (emit, performance#1): there is no newer agent.json
       to apply the scan to, and the stale one must not revert the pack. */
    it(
      'a --minimal hook run mid-scan: refused with a clear error, the newer pack kept',
      async () => {
        const dir = await analyzedProject();
        const pack = path.join(dir, '.facts', 'agent.pack');
        let hookPack = '';
        stubOsv(async () => {
          const hook = await runCli((io) =>
            analyzeCommand(dir, { json: true, progress: false, minimal: true }, io),
          );
          expect(hook.code, hook.stderr).toBe(0);
          hookPack = readFileSync(pack, 'utf8');
        });
        try {
          const r = await runCli((io) => scanVulnsCommand(dir, { cache: true }, io));
          expect(r.code).toBe(1);
          expect(plain(r.stderr)).toMatch(/^factstack scan-vulns: not re-saving the analysis/m);
          expect(plain(r.stderr)).toContain('nothing was written');
          expect(readFileSync(pack, 'utf8')).toBe(hookPack);
        } finally {
          vi.unstubAllGlobals();
        }
      },
      T,
    );

    it(
      'an agent.json the hook already left stale is refused before any network',
      async () => {
        const dir = await analyzedProject();
        const hook = await runCli((io) =>
          analyzeCommand(dir, { json: true, progress: false, minimal: true }, io),
        );
        expect(hook.code, hook.stderr).toBe(0);
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        try {
          const r = await runCli((io) => scanVulnsCommand(dir, { cache: true }, io));
          expect(r.code).toBe(1);
          expect(plain(r.stderr)).toMatch(/agent\.json is older than the newest analysis/);
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      },
      T,
    );

    /* A dep added while OSV.dev answered was counted as unscanned on
       stdout only; the saved scan said findings 0 about it, which every later
       reader took for verified clean. */
    it(
      'deps left unscanned are persisted, carried, and called partial',
      async () => {
        const dir = await analyzedProject();
        stubOsv(async () => {
          // The hook's analyze, after a dependency was added meanwhile.
          writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
              name: 'demo',
              version: '1.0.0',
              dependencies: { lodash: '^4.17.0', minimist: '1.2.8' },
              devDependencies: { vitest: '^1.0.0' },
            }),
          );
          expect((await analyzeJson(dir)).code).toBe(0);
        });
        try {
          const r = await runCli((io) => scanVulnsCommand(dir, { cache: true }, io));
          expect(r.code, r.stderr).toBe(0);
          expect(read(dir, 'agent.json').vulnerabilityScan).toMatchObject({ unscanned: 1 });
        } finally {
          vi.unstubAllGlobals();
        }
        // A re-analyze carries the partial scan; its summary says so.
        const tty = await runCli((io) =>
          analyzeCommand(dir, { progress: false, agentRequests: false }, io),
        );
        expect(tty.code, tty.stderr).toBe(0);
        expect(read(dir, 'agent.json').vulnerabilityScan).toMatchObject({ unscanned: 1 });
        expect(plain(tty.stderr)).toMatch(/vulns .*partial: 1 dependency not scanned/);
      },
      T,
    );

    /* cli-rev-6: an adopted head's scan recorded the lockfiles read BEFORE
       OSV.dev answered, although its findings are reconciled against the
       head's lockfiles as they are now. */
    it(
      'the saved scan names the lockfiles its findings were reconciled against',
      async () => {
        const dir = await analyzedProject();
        const lock = path.join(dir, 'package-lock.json');
        rmSync(lock); // no lockfile on disk when scan-vulns starts
        stubOsv(async () => {
          writeFileSync(lock, PACKAGE_LOCK); // restored + re-analyzed meanwhile
          expect((await analyzeJson(dir)).code).toBe(0);
        });
        try {
          const r = await runCli((io) => scanVulnsCommand(dir, { cache: true }, io));
          expect(r.code, r.stderr).toBe(0);
          expect(plain(r.stderr)).toContain('applied to the newer analysis');
          expect(plain(r.stderr)).not.toContain('installed versions from'); // none before OSV
          expect(read(dir, 'agent.json').vulnerabilityScan.lockfiles).toEqual([
            'package-lock.json',
          ]);
        } finally {
          vi.unstubAllGlobals();
        }
      },
      T,
    );
  });

  it('refuses to run before an analyze (exit 1, no network)', async () => {
    const empty = fixtureProject('facts-cli-novulns-');
    temps.push(empty);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const r = await runCli((io) => scanVulnsCommand(empty, { cache: true }, io));
      expect(r.code).toBe(1);
      expect(plain(r.stderr)).toContain('no .facts/agent.json found');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ── ci-report --fail-on-shift (cli-r3-2) ─────────────────────────────── */

const advisory = (id: string, scope: 'direct' | 'transitive', severity: string) => ({
  id,
  severity,
  ecosystem: 'npm',
  package: 'minimist',
  installedVersion: '1.2.0',
  fixedVersion: '1.2.6',
  advisoryUrl: `https://github.com/advisories/${id}`,
  lastChecked: 1_700_000_000_000,
  manifestPath: 'package-lock.json',
  scope,
  versionSource: 'lockfile',
});

describe('ci-report --fail-on-shift grades direct advisories only (cli-r3-2)', () => {
  it('a new transitive advisory is listed, not graded, and never trips the gate', async () => {
    const base = path.join(root, '.facts', ...BASELINE_AGENT_FILE.split('/'));
    const head = JSON.parse(readFileSync(path.join(root, '.facts', 'agent.json'), 'utf8'));
    const dir = fixtureProject('facts-cli-ci-');
    temps.push(dir);
    const headPath = path.join(dir, 'head.json');
    const report = (vulnerabilities: object[]) => {
      writeFileSync(headPath, JSON.stringify({ ...head, vulnerabilities }));
      return runCli((io) => ciReportCommand(root, { base, head: headPath, failOnShift: '1' }, io));
    };

    const trans = await report([advisory('GHSA-trans', 'transitive', 'critical')]);
    expect(trans.code, trans.stderr).toBe(0);
    expect(trans.stdout).toContain('- `GHSA-trans` — transitive: shown, not graded');
    expect(trans.stdout).not.toContain('Risk surface grew');

    const direct = await report([
      advisory('GHSA-trans', 'transitive', 'critical'),
      advisory('GHSA-direct', 'direct', 'high'),
    ]);
    expect(direct.code).toBe(1);
    expect(plain(direct.stderr)).toContain('graded severity shift +3 >= 1 — gating merge');
    expect(direct.stdout).toContain('Risk surface grew (severity shift **+3**)');
  });
});

/* ── install: a canonical --root, and the notes beside it ─────────────── */

describe('install pins one canonical project root (cli-r3-1, cli-r3-3)', () => {
  it(
    'another spelling of the path finds the configs installed; the notes say what the pin means',
    async () => {
      const dir = fixtureProject('facts-cli-install-');
      temps.push(dir);
      expect((await analyzeJson(dir)).code).toBe(0);
      const linkParent = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'facts-cli-link-')));
      temps.push(linkParent);
      const link = path.join(linkParent, 'proj');
      symlinkSync(dir, link, 'junction');
      const install = (target: string, opts: { agent: string; serverCommand?: string }) =>
        runCli((io) => installCommand(target, { ...opts, json: true }, io));

      const first = await install(link, { agent: 'all' });
      expect(first.code, first.stderr).toBe(0);
      const out = JSON.parse(first.stdout);
      expect(out.server.args.slice(-2)).toEqual(['--root', dir]); // the real path, not the link
      expect(out.portabilityNote).toMatch(
        /^\.mcp\.json, \.cursor\/mcp\.json, \.vscode\/mcp\.json pin --root to this machine's path/,
      );
      const mcpJson = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
      expect(mcpJson.mcpServers.factstack.args.at(-1)).toBe(dir);

      const again = JSON.parse((await install(dir, { agent: 'all' })).stdout);
      expect(again.agents.map((a: { mcpStatus: string }) => a.mcpStatus)).toEqual([
        'already-installed',
        'already-installed',
        'already-installed',
      ]);

      // cli-r3-3: the printed command pasted back is still the npx launch.
      const pasted = JSON.parse(
        (await install(dir, { agent: 'cursor', serverCommand: formatServerCommand(out.server) }))
          .stdout,
      );
      expect(pasted.agents[0].mcpStatus).toBe('already-installed');
      if (MCP_PUBLISHED) expect(pasted.serverNote).toBeUndefined();
      else expect(pasted.serverNote).toBe(MCP_NOT_PUBLISHED_NOTE);

      // A client-variable root travels: no machine-local note.
      const portable = JSON.parse(
        (
          await install(dir, {
            agent: 'cursor',
            serverCommand: 'npx -y factstack-mcp --root ${workspaceFolder}',
          })
        ).stdout,
      );
      expect(portable.portabilityNote).toBeUndefined();

      const tty = await runCli((io) => installCommand(dir, { agent: 'claude' }, io));
      expect(tty.code, tty.stderr).toBe(0);
      expect(plain(tty.stderr)).toContain("note: .mcp.json pins --root to this machine's path");
      /* ux#3: while factstack-mcp is not on npm the registration is flagged
         beside the server, never a plain green check. */
      const lines = plain(tty.stderr).split('\n');
      const server = lines.findIndex((l) => l.startsWith('  server command: '));
      if (!MCP_PUBLISHED) {
        expect(lines).toContain(
          '    ! .mcp.json (already registered — it will not start until factstack-mcp is on npm; see the note below)',
        );
        expect(lines[server + 1]).toBe(`  ! ${MCP_NOT_PUBLISHED_NOTE}`);
        expect(plain(tty.stderr)).not.toContain('✓ .mcp.json');
      } else {
        expect(lines).toContain('    ✓ .mcp.json (already registered)');
      }
    },
    T,
  );
});

/* Hooks run off a TTY, where `npx` installs without asking — so a
   default hook must never fetch the unclaimed `factstack` name, and every
   hook summary says the package is not on npm (as install does for MCP). */
describe('the hook summaries flag the unpublished CLI', () => {
  it(
    'install, setup-agents and `hook install` run the no-download launch and say so',
    async () => {
      const dir = fixtureProject('facts-cli-hooknote-');
      temps.push(dir);
      expect((await analyzeJson(dir)).code).toBe(0);

      const inst = await runCli((io) => installCommand(dir, { agent: 'claude', json: true }, io));
      expect(inst.code, inst.stderr).toBe(0);
      const claude = JSON.parse(inst.stdout).agents[0];
      expect(claude.hookCommand).toBe(FRESHNESS_HOOK_COMMAND);
      const setup = await runCli((io) => setupAgentsCommand(dir, { hook: true, json: true }, io));
      expect(setup.code, setup.stderr).toBe(0);
      const tty = await runCli((io) => setupAgentsCommand(dir, { hook: true }, io));
      const lines = plain(tty.stderr).split('\n');
      const runs = lines.indexOf(`      runs: ${FRESHNESS_HOOK_COMMAND}`);
      expect(runs).toBeGreaterThan(-1);

      spawnSync('git', ['init', '-q'], { cwd: dir });
      const git = await runCli((io) =>
        hookCommand('install', dir, { command: GIT_HOOK_COMMAND }, io),
      );
      expect(git.code, git.stderr).toBe(0);

      if (CLI_PUBLISHED) {
        expect(claude.hookNote).toBeUndefined();
        expect(JSON.parse(setup.stdout).hook.note).toBeUndefined();
        return;
      }
      expect(FRESHNESS_HOOK_COMMAND).not.toMatch(/^npx\b/);
      expect(GIT_HOOK_COMMAND).not.toMatch(/^npx\b/);
      const note = /factstack is not on npm yet — this hook fails \(it never downloads\)/;
      expect(claude.hookNote).toMatch(note);
      expect(JSON.parse(setup.stdout).hook.note).toMatch(note);
      // Beside the command, as install's MCP line is beside the server.
      expect(lines[runs + 1]).toMatch(new RegExp(`^ {4}! ${note.source}`));
      expect(plain(git.stderr)).toMatch(note);
      expect(plain(git.stderr)).toContain('`hook install --command <cmd>`');
    },
    T,
  );
});

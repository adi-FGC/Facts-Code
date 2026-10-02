/**
 * mineGitTopology cost (performance#2). The topology miner was over half of
 * every analyze: ~70 ms per git spawn on Windows, and up to TWO `rev-list`
 * spawns per branch. These tests count spawns through a pass-through mock:
 *   - ahead/behind for every branch comes from one `for-each-ref
 *     %(ahead-behind:<base>)` per base, with output identical to the
 *     per-branch path;
 *   - `cache: { reuse: true }` (the per-edit `--minimal` hook) returns the
 *     cached topology with no git spawn at all while the refs are unchanged,
 *     and re-mines as soon as a ref moves.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawns: string[][] = [];
/** `timeout` option of each entry in `spawns`, same index. */
const timeouts: (number | undefined)[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    spawnSync: (cmd: string, args: string[], opts: { timeout?: number }) => {
      if (cmd === 'git') {
        spawns.push(args);
        timeouts.push(opts?.timeout);
      }
      return orig.spawnSync(cmd, args, opts as never);
    },
  };
});

const { spawnSync } = await import('node:child_process');
const { mineGitTopology } = await import('../src/topology.js');
const { GIT_PLUMBING_TIMEOUT_MS, GIT_TIMEOUT_MS } = await import('../src/git-safe.js');

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fs-node test',
  GIT_AUTHOR_EMAIL: 'test@factstack.invalid',
  GIT_COMMITTER_NAME: 'fs-node test',
  GIT_COMMITTER_EMAIL: 'test@factstack.invalid',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
}
const write = (p: string, body: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
/** A spawn's git subcommand: the first bare arg after the safety flags. */
const subOf = (a: string[]): string | undefined =>
  a.find((x) => !x.startsWith('-') && !x.includes('='));
/** Spawns whose git subcommand is `sub`. */
const count = (sub: string): number => spawns.filter((a) => subOf(a) === sub).length;

const NOW = Date.parse('2026-01-10T00:00:00Z');
let tmp = '';
let repo = '';

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-node-topo-perf-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  write(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: init');
  git(tmp, 'init', '-q', '--bare', 'origin.git');
  git(repo, 'remote', 'add', 'origin', path.join(tmp, 'origin.git'));
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  // Six branches: merged, ahead of main, behind main, ahead of local main only.
  git(repo, 'branch', 'merged');
  for (const b of ['f1', 'f2', 'f3']) {
    git(repo, 'checkout', '-q', '-b', b, 'main');
    write(path.join(repo, `${b}.txt`), b + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `feat: ${b}`);
  }
  git(repo, 'checkout', '-q', 'main');
  write(path.join(repo, 'm.txt'), 'm\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feat: local main moves ahead of origin');
  git(repo, 'branch', 'behind', 'main~1');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  spawns.length = 0;
  timeouts.length = 0;
});

const stable = (g: ReturnType<typeof mineGitTopology>) => ({ ...g!, elapsedMs: 0 });

describe('mineGitTopology — batched ahead/behind', () => {
  it('spawns no per-branch rev-list, and matches the per-branch path exactly', () => {
    const batched = mineGitTopology(repo, { now: NOW, agentRequests: false })!;
    expect(count('rev-list')).toBe(0);
    expect(count('for-each-ref')).toBeLessThanOrEqual(6); // branches, merged x2, ahead-behind x2

    spawns.length = 0;
    const perBranch = mineGitTopology(repo, {
      now: NOW,
      agentRequests: false,
      batchAheadBehind: false,
    })!;
    expect(count('rev-list')).toBeGreaterThan(5); // the old cost: 1-2 spawns per branch
    expect(stable(batched)).toEqual(stable(perBranch));

    const f1 = batched.branches.find((b) => b.name === 'f1')!;
    expect(f1.uniqueCount).toBe(1);
    expect(f1.behindDefault).toBe(1); // local main moved on
    expect(f1.deleteBlockers).toContain('1 commit not in origin/main');
    expect(batched.branches.find((b) => b.name === 'behind')!.uniqueCount).toBe(0);
  });
});

describe('mineGitTopology — spawn timeouts come from git-safe', () => {
  it('bounds status/config by GIT_TIMEOUT_MS and every plumbing read by GIT_PLUMBING_TIMEOUT_MS', () => {
    mineGitTopology(repo, { now: NOW, agentRequests: false });
    expect(count('status')).toBeGreaterThan(0); // readStatus ran
    const got = spawns.map((a, i) => `${subOf(a)}:${timeouts[i]}`);
    const want = spawns.map((a) => {
      const sub = subOf(a);
      const ms = sub === 'status' || sub === 'config' ? GIT_TIMEOUT_MS : GIT_PLUMBING_TIMEOUT_MS;
      return `${sub}:${ms}`;
    });
    expect(got).toEqual(want);
  });
});

describe('mineGitTopology — cached reuse (per-edit --minimal hook)', () => {
  it('reuses the cached topology with zero git spawns while the refs are unchanged', () => {
    const file = path.join(tmp, 'cache-a', 'topology-cache.json');
    const first = mineGitTopology(repo, {
      now: NOW,
      agentRequests: false,
      cache: { file, reuse: true },
    })!;
    expect(spawns.length).toBeGreaterThan(10);
    expect(fs.existsSync(file)).toBe(true);

    spawns.length = 0;
    const again = mineGitTopology(repo, {
      now: NOW,
      agentRequests: false,
      cache: { file, reuse: true },
    })!;
    expect(spawns).toEqual([]);
    expect(again).toEqual(first);
  });

  it('re-mines as soon as a ref moves (commit), and never reuses when reuse is off', () => {
    const file = path.join(tmp, 'cache-b', 'topology-cache.json');
    const before = mineGitTopology(repo, {
      now: NOW,
      agentRequests: false,
      cache: { file, reuse: true },
    })!;
    git(repo, 'checkout', '-q', 'f2');
    write(path.join(repo, 'f2b.txt'), 'more\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat: f2 again');
    git(repo, 'checkout', '-q', 'main');

    spawns.length = 0;
    const after = mineGitTopology(repo, {
      now: NOW,
      agentRequests: false,
      cache: { file, reuse: true },
    })!;
    expect(spawns.length).toBeGreaterThan(0);
    const uc = (g: typeof after) => g.branches.find((b) => b.name === 'f2')!.uniqueCount;
    expect(uc(before)).toBe(1);
    expect(uc(after)).toBe(2);

    // reuse:false (a full analyze) always mines, and refreshes the file.
    spawns.length = 0;
    mineGitTopology(repo, { now: NOW, agentRequests: false, cache: { file, reuse: false } });
    expect(spawns.length).toBeGreaterThan(0);
  });

  it('does not reuse across different options, past maxAgeMs, or from a damaged file', () => {
    const file = path.join(tmp, 'cache-c', 'topology-cache.json');
    mineGitTopology(repo, { now: NOW, agentRequests: false, cache: { file, reuse: true } });
    const reuses = (opts: Parameters<typeof mineGitTopology>[1]): boolean => {
      spawns.length = 0;
      mineGitTopology(repo, opts);
      return spawns.length === 0;
    };
    expect(reuses({ now: NOW, agentRequests: false, cache: { file, reuse: true } })).toBe(true);
    expect(
      reuses({ now: NOW, agentRequests: false, maxCommits: 3, cache: { file, reuse: true } }),
    ).toBe(false);
    mineGitTopology(repo, { now: NOW, agentRequests: false, cache: { file, reuse: true } });
    expect(
      reuses({ now: NOW, agentRequests: false, cache: { file, reuse: true, maxAgeMs: 0 } }),
    ).toBe(false);
    fs.writeFileSync(file, '{ not json');
    expect(() =>
      mineGitTopology(repo, { now: NOW, agentRequests: false, cache: { file, reuse: true } }),
    ).not.toThrow();
    expect(reuses({ now: NOW, agentRequests: false, cache: { file, reuse: true } })).toBe(true);
  });
});

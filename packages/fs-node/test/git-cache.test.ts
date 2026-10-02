/**
 * mineGitStats `cache` (performance#8 residual). With the topology reused,
 * the per-edit `analyze --minimal` hook still ran a full `git log` walk on
 * every agent edit. These tests count spawns through a pass-through mock:
 *   - `cache: { reuse: true }` skips `git log` while no ref has moved, and
 *     returns the same stats;
 *   - the `git status` pass still runs on a reused copy, so an uncommitted
 *     edit carries its real mtime (never frozen into the cache);
 *   - a commit, another root or window, an aged or damaged file all re-mine;
 *   - a failed or overflowed `git log` is never cached (a degraded result
 *     must not be replayed), and the shallow boundary is part of the key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawns: string[][] = [];
/** Make the MAIN history walk (not the fallback) fail or overflow. */
let failMainLog: 'status' | 'overflow' | null = null;
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return {
    ...orig,
    spawnSync: (cmd: string, args: string[], opts: object) => {
      if (cmd === 'git') spawns.push(args);
      if (cmd === 'git' && failMainLog && args.some((a) => a.startsWith('--pretty=format:__C__'))) {
        const base = { pid: 0, signal: null, output: [null, '', ''] };
        return failMainLog === 'status'
          ? { ...base, status: 128, stdout: '', stderr: 'fatal: simulated log failure' }
          : {
              ...base,
              status: null,
              stdout: '__C__partial',
              stderr: '',
              error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }),
            };
      }
      return orig.spawnSync(cmd, args, opts as never);
    },
  };
});

const { spawnSync } = await import('node:child_process');
const { mineGitStats } = await import('../src/git.js');
const { refsFingerprint } = await import('../src/git-cache.js');

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 24 * 60 * 60 * 1000;
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fs-node test',
  GIT_AUTHOR_EMAIL: 'test@factstack.invalid',
  GIT_COMMITTER_NAME: 'fs-node test',
  GIT_COMMITTER_EMAIL: 'test@factstack.invalid',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};
function git(cwd: string, at: number | null, ...args: string[]): void {
  const dates = at == null ? {} : { GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) };
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...ENV, ...dates },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
}
const iso = (ms: number): string => new Date(ms).toISOString();
const write = (p: string, body: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
/** The git subcommand of one spawn: first bare arg, skipping `-C <dir>` / `-c <k=v>`. */
const subcommand = (args: string[]): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-C' || a === '-c') i++;
    else if (!a.startsWith('-')) return a;
  }
  return undefined;
};
const count = (sub: string): number => spawns.filter((a) => subcommand(a) === sub).length;

let tmp = '';
let repo = '';
let commitMs = 0;
let cacheN = 0;
/** A fresh cache path per call site, under this run's own temp dir. */
const cacheFile = (): string => path.join(tmp, `cache-${++cacheN}`, 'gitstats-cache.json');

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-node-gitstats-cache-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  // Backdated (inside the log window) so an edit's mtime is clearly later.
  commitMs = Math.floor((Date.now() - 10 * DAY) / 1000) * 1000;
  git(repo, null, 'init', '-q');
  write(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  write(path.join(repo, 'pkg', 'b.ts'), 'export const b = 1;\n');
  git(repo, null, 'add', '-A');
  git(repo, commitMs, 'commit', '-q', '-m', 'init');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  spawns.length = 0;
  failMainLog = null;
});

describe('mineGitStats — cached reuse (per-edit --minimal hook)', () => {
  it('skips the git log walk while the refs are unchanged, with identical stats', () => {
    const file = cacheFile();
    const first = mineGitStats(repo, { cache: { file, reuse: true } });
    expect(count('log')).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
    expect(first.get('a.ts')!.churnScore).toBe(1);

    spawns.length = 0;
    const again = mineGitStats(repo, { cache: { file, reuse: true } });
    expect(count('log')).toBe(0);
    expect(count('rev-parse')).toBeLessThanOrEqual(1); // only the status pass's --show-prefix
    expect(again).toEqual(first);
    expect(again.get('a.ts')!.topContributors[0]!.email).toBe('test@factstack.invalid');
  });

  it('still applies a fresh uncommitted edit on a reused copy, and never caches it', () => {
    const file = cacheFile();
    const p = path.join(repo, 'a.ts');
    const editedMs = Date.now() - DAY;
    write(p, 'export const a = 2;\n');
    fs.utimesSync(p, editedMs / 1000, editedMs / 1000);
    try {
      // Mined (and cached) while a.ts is dirty…
      const mined = mineGitStats(repo, { cache: { file, reuse: true } });
      expect(mined.get('a.ts')!.lastModifiedMs).toBe(fs.statSync(p).mtimeMs);
      // …yet the file holds the COMMIT time: the edit's mtime is per call.
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        stats: Array<[string, { lastModifiedMs: number }]>;
      };
      expect(onDisk.stats.find(([k]) => k === 'a.ts')![1].lastModifiedMs).toBe(commitMs);

      spawns.length = 0;
      const reused = mineGitStats(repo, { cache: { file, reuse: true } });
      expect(count('log')).toBe(0);
      expect(count('status')).toBe(1);
      expect(reused.get('a.ts')!.lastModifiedMs).toBe(fs.statSync(p).mtimeMs);
      expect(reused.get('a.ts')!.lastModifiedMs).toBeGreaterThan(commitMs);
    } finally {
      git(repo, null, 'checkout', '-q', '--', 'a.ts');
    }
    // Reverted: the reused copy is back to the commit time, not the old edit.
    spawns.length = 0;
    expect(mineGitStats(repo, { cache: { file, reuse: true } }).get('a.ts')!.lastModifiedMs).toBe(
      commitMs,
    );
    expect(count('log')).toBe(0);
  });

  it('re-mines as soon as a ref moves (commit), and never reuses when reuse is off', () => {
    const file = cacheFile();
    const before = mineGitStats(repo, { cache: { file, reuse: true } });
    write(path.join(repo, 'pkg', 'b.ts'), 'export const b = 2;\n');
    git(repo, null, 'add', '-A');
    git(repo, commitMs + 1000, 'commit', '-q', '-m', 'bump b');

    spawns.length = 0;
    const after = mineGitStats(repo, { cache: { file, reuse: true } });
    expect(count('log')).toBe(1);
    expect(before.get('pkg/b.ts')!.churnScore).toBe(1);
    expect(after.get('pkg/b.ts')!.churnScore).toBe(2);

    // reuse:false (a full analyze) always walks the log, and refreshes the file.
    spawns.length = 0;
    fs.rmSync(file);
    mineGitStats(repo, { cache: { file, reuse: false } });
    expect(count('log')).toBe(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('does not reuse across roots, windows, past maxAgeMs, or from a damaged file', () => {
    const file = cacheFile();
    mineGitStats(repo, { cache: { file, reuse: true } });
    const reuses = (root: string, opts: Parameters<typeof mineGitStats>[1]): boolean => {
      spawns.length = 0;
      mineGitStats(root, opts);
      return count('log') === 0;
    };
    expect(reuses(repo, { cache: { file, reuse: true } })).toBe(true);
    // A subdirectory root mines other keys (`b.ts`, not `pkg/b.ts`).
    expect(reuses(path.join(repo, 'pkg'), { cache: { file, reuse: true } })).toBe(false);
    expect([
      ...mineGitStats(path.join(repo, 'pkg'), { cache: { file, reuse: true } }).keys(),
    ]).toEqual(['b.ts']);
    mineGitStats(repo, { cache: { file, reuse: true } });
    expect(reuses(repo, { windowDays: 30, cache: { file, reuse: true } })).toBe(false);
    mineGitStats(repo, { cache: { file, reuse: true } });
    expect(reuses(repo, { cache: { file, reuse: true, maxAgeMs: 0 } })).toBe(false);

    // Not JSON: no throw, re-mines, and the refreshed file is reusable again.
    fs.writeFileSync(file, '{ not json');
    expect(reuses(repo, { cache: { file, reuse: true } })).toBe(false);
    expect(reuses(repo, { cache: { file, reuse: true } })).toBe(true);
    // Right key, wrong shape: rejected field by field, never passed through.
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { stats: Array<[string, unknown]> };
    j.stats[0]![1] = { lastModifiedMs: 'soon', churnScore: 1, authorCount: 1, topContributors: [] };
    fs.writeFileSync(file, JSON.stringify(j));
    expect(reuses(repo, { cache: { file, reuse: true } })).toBe(false);
    expect(mineGitStats(repo, { cache: { file, reuse: true } }).get('a.ts')!.lastModifiedMs).toBe(
      commitMs,
    );
  });

  it.each([
    ['fails (exit 128)', 'status'],
    ['overflows its buffer (ENOBUFS)', 'overflow'],
  ] as const)(
    'never caches a history whose git log %s, and walks it again next time',
    (_label, mode) => {
      const file = cacheFile();
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        failMainLog = mode;
        const degraded = mineGitStats(repo, { cache: { file, reuse: true } });
        // The fallback still ran (last-commit times only, no churn)…
        expect(degraded.get('a.ts')!.churnScore).toBe(0);
        expect(degraded.get('a.ts')!.lastModifiedMs).toBe(commitMs);
        // …but that degraded copy is not what the next run gets.
        expect(fs.existsSync(file)).toBe(false);
        if (mode === 'overflow') {
          expect(stderr.mock.calls.some(([m]) => String(m).includes('exceeded 1GiB'))).toBe(true);
        }
      } finally {
        failMainLog = null;
        stderr.mockRestore();
      }

      spawns.length = 0;
      const healthy = mineGitStats(repo, { cache: { file, reuse: true } });
      expect(count('log')).toBe(1);
      expect(healthy.get('a.ts')!.churnScore).toBe(1);
      expect(fs.existsSync(file)).toBe(true);
      // A failed walk also leaves an EXISTING good copy untouched.
      const saved = fs.readFileSync(file, 'utf8');
      const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        failMainLog = mode;
        mineGitStats(repo, { cache: { file, reuse: false } });
      } finally {
        failMainLog = null;
        quiet.mockRestore();
      }
      expect(fs.readFileSync(file, 'utf8')).toBe(saved);
    },
  );

  it('writes no cache outside a git repo, and still returns an empty map', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    write(path.join(plain, 'x.ts'), 'export {};\n');
    const file = path.join(plain, '.facts', 'gitstats-cache.json');
    /* tmp may itself sit under a git checkout on some machines: stop git's
       repo discovery at tmp (gitEnv() passes the variable through), so the
       no-repo contract is asserted everywhere instead of skipped. */
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmp;
    try {
      const inRepo =
        spawnSync('git', ['-C', plain, 'rev-parse', '--is-inside-work-tree'], {
          encoding: 'utf8',
          windowsHide: true,
        }).status === 0;
      expect(inRepo, 'GIT_CEILING_DIRECTORIES did not stop discovery at tmp').toBe(false);
      spawns.length = 0;
      const stats = mineGitStats(plain, { cache: { file, reuse: true } });
      expect(stats.size).toBe(0);
      expect(fs.existsSync(file)).toBe(false);
      expect(count('log')).toBe(0); // not a work tree: no history walk at all
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });
});

describe('refsFingerprint — the shallow boundary is a key input', () => {
  /* `git fetch --deepen/--unshallow` changes the history a walk sees without
     moving any ref. FETCH_HEAD usually changes too, but not with
     `--no-write-fetch-head` (or fetch.writeFetchHEAD=false), so `shallow`
     is statted on its own. */
  it('changes when .git/shallow appears, moves, or goes away', () => {
    const dir = path.join(tmp, 'shallow-repo');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, null, 'init', '-q');
    const shallow = path.join(dir, '.git', 'shallow');
    const fp = (): string | null => refsFingerprint(dir, ['v', dir]);

    const full = fp();
    expect(full).toMatch(/^[0-9a-f]{64}$/);
    expect(fp()).toBe(full); // stable while nothing changes

    fs.writeFileSync(shallow, `${'a'.repeat(40)}\n`); // cloned with --depth
    const shallowed = fp();
    expect(shallowed).not.toBe(full);

    fs.writeFileSync(shallow, `${'b'.repeat(40)}\n${'c'.repeat(40)}\n`); // --deepen
    const deepened = fp();
    expect(deepened).not.toBe(shallowed);
    expect(deepened).not.toBe(full);

    fs.rmSync(shallow); // --unshallow: back to the full-history key
    expect(fp()).toBe(full);
  });
});

/**
 * Git history miner — Node-side because `git` lives outside FactsFS.
 *
 * One `git log --name-only` pass gives us, for every file the project
 * has ever touched:
 *   - lastCommitTs (most recent commit that touched it)
 *   - commitCount over a lookback window (90 days by default) → churn
 *   - authorCount (distinct authors over that window)
 *
 * Far cheaper than shelling out per file. Injected into @factstack/core
 * the same way `gzip` is — stays out of the isomorphic tree.
 *
 * Plus one `git status` pass: a file edited since its last commit gets its
 * real mtime, not that commit's time (see applyWorkingTreeMtimes).
 *
 * With `cache`, the `git log` part is persisted and reused while no ref moves
 * (see MineOptions.cache); the status pass always runs.
 *
 * The analyzed checkout may be an archive with a hostile .git/config: every
 * spawn goes through SAFE_GIT_ARGS + gitEnv(), and the status pass also
 * disarms filter drivers (./git-safe.ts).
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { readCacheFile, refsFingerprint, writeCacheFile } from './git-cache.js';
import { GIT_TIMEOUT_MS, SAFE_GIT_ARGS, filterOverrides, gitEnv } from './git-safe.js';

/** Options for a short read-only probe (rev-parse, status). */
const probe = (maxBuffer = 1024 * 1024): SpawnSyncOptionsWithStringEncoding => ({
  encoding: 'utf8',
  env: gitEnv(),
  windowsHide: true,
  timeout: GIT_TIMEOUT_MS,
  maxBuffer,
  stdio: ['ignore', 'pipe', 'pipe'],
});

export interface Contributor {
  email: string;
  /** Display name from git config user.name. Empty string when git
   *  config didn't supply one — CLI consumer can fall back to the
   *  email's local-part. */
  name: string;
  /** Number of commits this author made to the file in the lookback
   *  window. Lifetime count is also captured but only the windowed
   *  number influences the top-3 ranking. */
  commits: number;
  /** Most recent commit by this author touching this file. */
  lastTouchedMs: number;
}

export interface GitStats {
  lastModifiedMs: number;
  churnScore: number; // commits-in-window
  authorCount: number;
  /** v0.3.8 — top-3 contributors by commits-in-window, with names +
   *  last-touched timestamps. Empty array when no in-window commits
   *  reach the file (e.g., legacy file untouched in 90 days). */
  topContributors: Contributor[];
}

export interface MineOptions {
  /** Days of history to consider for churn / author counts. Default 90. */
  windowDays?: number;
  /**
   * Persist the mined history to `file` (e.g. `.facts/gitstats-cache.json`),
   * keyed by the same refs fingerprint as the topology cache (HEADs, refs,
   * worktree state; ./git-cache.ts) plus the root and `windowDays`. With
   * `reuse`, a matching copy younger than `maxAgeMs` (default 10 min) stands
   * in for the `git log` walk — the per-edit `--minimal` hook path, where that
   * walk was most of each run once the topology was reused. The `git status`
   * pass still runs on every call, so an uncommitted edit carries its real
   * mtime on a reused copy too. Any ref move (commit, checkout, fetch,
   * rebase) re-mines at once. Every call without `reuse` refreshes the file.
   */
  cache?: { file: string; reuse?: boolean | undefined; maxAgeMs?: number | undefined } | undefined;
}

/** Bump when the cache file layout or the fingerprint inputs change. */
const GIT_STATS_CACHE_VERSION = 1;
const DEFAULT_CACHE_MAX_AGE_MS = 10 * 60_000;

/**
 * Run `git log` once and bucket touches per file. Returns a Map keyed by
 * POSIX-style project-relative paths (matches what the walker emits).
 * Returns an empty map if the target is not a git working tree.
 */
export function mineGitStats(root: string, opts: MineOptions = {}): Map<string, GitStats> {
  const windowDays = opts.windowDays ?? 90;
  const cache = opts.cache;
  /* Fingerprint BEFORE mining: a ref that moves mid-walk leaves the stored
     key older than the repo, so the next run re-mines rather than reuse.
     The root is part of the key — a subdirectory root mines other keys. */
  const abs = path.resolve(root);
  const fp = cache
    ? refsFingerprint(abs, [
        GIT_STATS_CACHE_VERSION,
        process.platform === 'win32' ? abs.toLowerCase() : abs,
        windowDays,
      ])
    : null;
  if (cache && fp && cache.reuse) {
    const hit = readGitStatsCache(cache.file, fp, cache.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
    if (hit) return applyWorkingTreeMtimes(root, hit);
  }
  const mined = mineHistory(root, windowDays);
  /* Stored BEFORE the status pass: working-tree mtimes change on every edit,
     so they are applied fresh on each call, never frozen into the cache. */
  if (cache && fp && mined.cacheable) {
    writeCacheFile(cache.file, {
      v: GIT_STATS_CACHE_VERSION,
      fp,
      savedAt: Date.now(),
      stats: [...mined.stats],
    });
  }
  return applyWorkingTreeMtimes(root, mined.stats);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The cached history, rebuilt field by field (a damaged or hand-edited
 *  file must not put unknown keys or wrong types into the artifact).
 *  null = no usable copy → mine. */
function readGitStatsCache(
  file: string,
  fp: string,
  maxAgeMs: number,
): Map<string, GitStats> | null {
  const j = readCacheFile(file, GIT_STATS_CACHE_VERSION, fp, maxAgeMs);
  if (!j || !Array.isArray(j.stats)) return null;
  const out = new Map<string, GitStats>();
  for (const entry of j.stats as unknown[]) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return null;
    const s = entry[1] as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') return null;
    if (!finite(s.lastModifiedMs) || !finite(s.churnScore) || !finite(s.authorCount)) return null;
    if (!Array.isArray(s.topContributors)) return null;
    const topContributors: Contributor[] = [];
    for (const c of s.topContributors as Array<Record<string, unknown> | null>) {
      if (!c || typeof c.email !== 'string' || typeof c.name !== 'string') return null;
      if (!finite(c.commits) || !finite(c.lastTouchedMs)) return null;
      topContributors.push({
        email: c.email,
        name: c.name,
        commits: c.commits,
        lastTouchedMs: c.lastTouchedMs,
      });
    }
    out.set(entry[0], {
      lastModifiedMs: s.lastModifiedMs,
      churnScore: s.churnScore,
      authorCount: s.authorCount,
      topContributors,
    });
  }
  return out;
}

/** The commit-derived stats (no working-tree mtimes yet). `cacheable` is
 *  false when git failed or overflowed, so a degraded result — and its
 *  stderr warning — is never replayed from the cache. */
function mineHistory(
  root: string,
  windowDays: number,
): { stats: Map<string, GitStats>; cacheable: boolean } {
  const out = new Map<string, GitStats>();
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  // Short-circuit if not a git repo.
  const check = spawnSync(
    'git',
    [...SAFE_GIT_ARGS, '-C', root, 'rev-parse', '--is-inside-work-tree'],
    probe(),
  );
  if (check.status !== 0) return { stats: out, cacheable: false };

  // Get the full log in a compact format: author + unix-ts + touched files.
  // We use ASCII US (\x1f) as the field separator instead of `|` — git
  // authors occasionally contain pipes and the parser previously broke
  // silently into NaN timestamps. ASCII US never appears in an email
  // or in a file path so it's unambiguous.
  // Budget: 1 GiB maxBuffer covers very large monorepos; below that we
  // previously truncated silently with no user-facing signal.
  const log = spawnSync(
    'git',
    /* %ae = author email · %an = author name · %ct = commit timestamp.
       v0.3.8 added %an so we can attribute top contributors per file
       with a display name. The ASCII US (\x1f) separator is still
       safe — it cannot legally appear in a git config user.name. */
    [
      ...SAFE_GIT_ARGS,
      '-C',
      root,
      'log',
      '--no-merges',
      '--pretty=format:__C__%ae\x1f%an\x1f%ct',
      '--name-only',
      '-z',
      `--since=${windowDays * 2} days ago`,
      /* Paths relative to `root` and only its subtree: analyzing a repo
         SUBDIRECTORY keys files the way the walker does (`src/a.ts`, not
         `packages/x/src/a.ts`), else no git stat matched any file. */
      '--relative',
      '--',
      '.',
    ],
    {
      encoding: 'utf8',
      env: gitEnv(),
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (log.status !== 0 || !log.stdout) {
    if (log.error && (log.error as NodeJS.ErrnoException & { code?: string }).code === 'ENOBUFS') {
      // Budget exceeded — surface a warning instead of silently losing
      // all churn data. Caller (CLI) prints it; we still return empty.
      process.stderr.write(
        'factstack: git log exceeded 1GiB — churn/authors unavailable for this repo.\n',
      );
    }
    /* A clean, empty window (no commit in 2×windowDays) is a real answer and
       may be cached; a failed or overflowed log is not. */
    const fallback = fallbackMostRecent(root);
    return {
      stats: fallback ?? out,
      cacheable: log.status === 0 && !log.error && fallback !== null,
    };
  }

  // Lines are NUL-separated file names prefixed by a `__C__email\x1fts` sentinel.
  // Parse sequentially: on each sentinel we start a new commit; subsequent
  // non-sentinel lines are files touched by that commit.
  let currentEmail = '';
  let currentName = '';
  let currentTs = 0;
  /* v0.3.8: per-file author tally moved from a Set<email> (just a count)
     to a Map<email, {name, commits, lastMs}> so we can rank contributors
     and surface display names. The Set is gone; authorCount is derived
     from the map size at the end. */
  const buckets = new Map<
    string,
    {
      last: number;
      churn: number;
      authors: Map<string, { name: string; commits: number; lastMs: number }>;
    }
  >();

  const parts = log.stdout.split('\0');
  for (const raw of parts) {
    if (!raw) continue;
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('__C__')) {
        const body = line.slice(5);
        // Three fields now: email\x1fname\x1fts. Split on \x1f and take
        // the first three pieces. A missing name is fine (empty string).
        const fields = body.split('\x1f');
        if (fields.length < 3) {
          currentEmail = '';
          currentName = '';
          currentTs = 0;
          continue;
        }
        currentEmail = fields[0] ?? '';
        currentName = fields[1] ?? '';
        const ts = Number(fields[2]);
        currentTs = Number.isFinite(ts) ? ts * 1000 : 0;
      } else {
        if (currentTs === 0) continue; // no valid commit context
        const posix = line.replace(/\\/g, '/');
        const b = buckets.get(posix) ?? {
          last: 0,
          churn: 0,
          authors: new Map<string, { name: string; commits: number; lastMs: number }>(),
        };
        if (currentTs > b.last) b.last = currentTs;
        if (currentTs >= cutoff) {
          b.churn++;
          if (currentEmail) {
            const a = b.authors.get(currentEmail) ?? { name: currentName, commits: 0, lastMs: 0 };
            a.commits++;
            if (currentTs > a.lastMs) a.lastMs = currentTs;
            // Prefer the most recently-seen name when git history has
            // the same email under different names (rebasing, contact
            // changes). Only update if we actually got one this commit.
            if (currentName) a.name = currentName;
            b.authors.set(currentEmail, a);
          }
        }
        buckets.set(posix, b);
      }
    }
  }

  for (const [file, b] of buckets) {
    /* Build top-3 contributors per file: sort the per-email map by
       commit count desc, then by recency desc as the tiebreaker. */
    const sorted: Contributor[] = [];
    for (const [email, a] of b.authors) {
      sorted.push({ email, name: a.name, commits: a.commits, lastTouchedMs: a.lastMs });
    }
    sorted.sort((a, b) =>
      b.commits !== a.commits ? b.commits - a.commits : b.lastTouchedMs - a.lastTouchedMs,
    );
    out.set(file, {
      lastModifiedMs: b.last,
      churnScore: b.churn,
      authorCount: b.authors.size,
      topContributors: sorted.slice(0, 3),
    });
  }
  return { stats: out, cacheable: true };
}

/**
 * Uncommitted edits. `lastModifiedMs` is the last COMMIT touching a file, and
 * core prefers it over the file's mtime (a clone's mtimes are all clone
 * time). So a file edited but not committed kept its old commit time, and
 * `since` could not see the edit: in mtime-only mode (no baseline), or when
 * the file was committed between the baseline and the cutoff and then edited.
 *
 * One `git status` pass: for every modified, staged or untracked path that
 * has a git entry, lastModifiedMs = max(last commit, real mtime). Clean files
 * are untouched. Untracked files without history have no entry at all, so
 * core already uses the walker's mtime for them. Best-effort: any git failure
 * leaves the commit times as they were.
 *
 * `git status` is the one call here that runs repo config as code
 * (core.fsmonitor, every filter driver's clean command): SAFE_GIT_ARGS
 * (which also keeps it off index.lock) plus filterOverrides(), or no pass.
 * --ignore-submodules=all: never recurse into a submodule, whose own config
 * would define drivers these overrides do not cover.
 */
function applyWorkingTreeMtimes(root: string, out: Map<string, GitStats>): Map<string, GitStats> {
  if (out.size === 0) return out;
  // Porcelain paths are relative to the REPO top-level, the map's keys to
  // `root` (see --relative above): strip the subdirectory prefix.
  const prefixRun = spawnSync(
    'git',
    [...SAFE_GIT_ARGS, '-C', root, 'rev-parse', '--show-prefix'],
    probe(),
  );
  if (prefixRun.status !== 0) return out;
  const prefix = prefixRun.stdout.trim();
  const disarm = filterOverrides(root);
  if (!disarm) return out;
  const status = spawnSync(
    'git',
    [
      ...SAFE_GIT_ARGS,
      ...disarm,
      '-C',
      root,
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
      '--',
      '.',
    ],
    probe(256 * 1024 * 1024),
  );
  if (status.status !== 0 || !status.stdout) return out;

  const fields = status.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? '';
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    // -z renames/copies: `XY <new>\0<old>\0` — the old path is not a file here.
    if (xy.includes('R') || xy.includes('C')) i++;
    const repoPath = entry.slice(3);
    if (!repoPath.startsWith(prefix)) continue;
    const key = repoPath.slice(prefix.length);
    const stats = out.get(key);
    if (!stats) continue;
    try {
      const st = statSync(path.join(root, key));
      if (st.isFile() && st.mtimeMs > stats.lastModifiedMs) stats.lastModifiedMs = st.mtimeMs;
    } catch {
      /* deleted in the working tree — nothing newer to report */
    }
  }
  return out;
}

/**
 * Fallback when the full log exceeded the buffer or errored — one bulk
 * `git log --name-only --pretty=format:%ct -z` WITHOUT `--since` bound so
 * it's a last resort with smaller payload. Populates lastModifiedMs only;
 * churn/authors stay at 0. null when this pass fails or overflows too.
 */
function fallbackMostRecent(root: string): Map<string, GitStats> | null {
  const out = new Map<string, GitStats>();
  const r = spawnSync(
    'git',
    [
      ...SAFE_GIT_ARGS,
      '-C',
      root,
      'log',
      '--no-merges',
      '--name-only',
      '--pretty=format:\x01%ct',
      '-z',
      '--relative', // same subtree-relative keys as the main pass
      '--',
      '.',
    ],
    {
      encoding: 'utf8',
      env: gitEnv(),
      windowsHide: true,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (r.status !== 0 || r.error) return null;
  if (!r.stdout) return out; // a history with no file touches at all
  let ts = 0;
  for (const part of r.stdout.split('\0')) {
    if (!part) continue;
    for (const line of part.split('\n')) {
      if (!line) continue;
      if (line.startsWith('\x01')) {
        const n = Number(line.slice(1));
        ts = Number.isFinite(n) ? n * 1000 : 0;
      } else if (ts > 0) {
        const posix = line.replace(/\\/g, '/');
        const existing = out.get(posix);
        if (!existing || ts > existing.lastModifiedMs) {
          out.set(posix, {
            lastModifiedMs: ts,
            churnScore: 0,
            authorCount: 0,
            topContributors: [],
          });
        }
      }
    }
  }
  return out;
}

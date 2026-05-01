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
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

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
  churnScore: number;    // commits-in-window
  authorCount: number;
  /** v0.3.8 — top-3 contributors by commits-in-window, with names +
   *  last-touched timestamps. Empty array when no in-window commits
   *  reach the file (e.g., legacy file untouched in 90 days). */
  topContributors: Contributor[];
}

export interface MineOptions {
  /** Days of history to consider for churn / author counts. Default 90. */
  windowDays?: number;
}

/**
 * Run `git log` once and bucket touches per file. Returns a Map keyed by
 * POSIX-style project-relative paths (matches what the walker emits).
 * Returns an empty map if the target is not a git working tree.
 */
export function mineGitStats(root: string, opts: MineOptions = {}): Map<string, GitStats> {
  const out = new Map<string, GitStats>();
  const windowDays = opts.windowDays ?? 90;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  // Short-circuit if not a git repo.
  const check = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (check.status !== 0) return out;

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
    ['-C', root, 'log', '--no-merges', '--pretty=format:__C__%ae\x1f%an\x1f%ct', '--name-only', '-z', `--since=${windowDays * 2} days ago`],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );
  if (log.status !== 0 || !log.stdout) {
    if (log.error && (log.error as NodeJS.ErrnoException & { code?: string }).code === 'ENOBUFS') {
      // Budget exceeded — surface a warning instead of silently losing
      // all churn data. Caller (CLI) prints it; we still return empty.
      process.stderr.write('factstack: git log exceeded 1GiB — churn/authors unavailable for this repo.\n');
    }
    return fallbackMostRecent(root);
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
          currentEmail = ''; currentName = ''; currentTs = 0;
          continue;
        }
        currentEmail = fields[0] ?? '';
        currentName = fields[1] ?? '';
        const ts = Number(fields[2]);
        currentTs = Number.isFinite(ts) ? ts * 1000 : 0;
      } else {
        if (currentTs === 0) continue;     // no valid commit context
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
  return out;
}

/**
 * Fallback when the full log exceeded the buffer or errored — one bulk
 * `git log --name-only --pretty=format:%ct -z` WITHOUT `--since` bound so
 * it's a last resort with smaller payload. Populates lastModifiedMs only;
 * churn/authors stay at 0. If even this overflows we return empty.
 */
function fallbackMostRecent(root: string): Map<string, GitStats> {
  const out = new Map<string, GitStats>();
  const r = spawnSync(
    'git',
    ['-C', root, 'log', '--no-merges', '--name-only', '--pretty=format:\x01%ct', '-z'],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout) return out;
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

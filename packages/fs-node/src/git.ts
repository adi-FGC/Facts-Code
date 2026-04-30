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

export interface GitStats {
  lastModifiedMs: number;
  churnScore: number;    // commits-in-window
  authorCount: number;
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
    ['-C', root, 'log', '--no-merges', '--pretty=format:__C__%ae\x1f%ct', '--name-only', '-z', `--since=${windowDays * 2} days ago`],
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
  let currentTs = 0;
  const buckets = new Map<string, { last: number; churn: number; authors: Set<string> }>();

  const parts = log.stdout.split('\0');
  for (const raw of parts) {
    if (!raw) continue;
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('__C__')) {
        const body = line.slice(5);
        const sep = body.indexOf('\x1f');
        if (sep < 0) {
          // Malformed sentinel — skip this commit's files to avoid NaN
          // propagating across every subsequent line.
          currentEmail = ''; currentTs = 0;
          continue;
        }
        currentEmail = body.slice(0, sep);
        const ts = Number(body.slice(sep + 1));
        currentTs = Number.isFinite(ts) ? ts * 1000 : 0;
      } else {
        if (currentTs === 0) continue;     // no valid commit context
        const posix = line.replace(/\\/g, '/');
        const b = buckets.get(posix) ?? { last: 0, churn: 0, authors: new Set<string>() };
        if (currentTs > b.last) b.last = currentTs;
        if (currentTs >= cutoff) {
          b.churn++;
          if (currentEmail) b.authors.add(currentEmail);
        }
        buckets.set(posix, b);
      }
    }
  }

  for (const [file, b] of buckets) {
    out.set(file, {
      lastModifiedMs: b.last,
      churnScore: b.churn,
      authorCount: b.authors.size,
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
          out.set(posix, { lastModifiedMs: ts, churnScore: 0, authorCount: 0 });
        }
      }
    }
  }
  return out;
}

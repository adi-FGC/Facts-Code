/**
 * The name a project should be reported under — v0.3.11.
 *
 * `path.basename(root)` was the rule everywhere, and it is wrong for a
 * linked worktree: analyzing `<repo>/.claude/worktrees/feature-x` called the
 * project "feature-x", and a static site built from a worktree shipped with
 * that name. The PROJECT is the repository, whichever checkout you happen to
 * be in, so the name comes from the main worktree — the directory that owns
 * the common `.git` — and only falls back to the basename when there is no
 * git at all (a zip, a fresh folder) or the repo is bare.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function repoDisplayName(root: string): string {
  const fallback = path.basename(path.resolve(root)) || 'project';
  try {
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (r.status !== 0 || !r.stdout.trim()) return fallback;
    const common = path.resolve(root, r.stdout.trim());
    // `<main>/.git` for a normal repo (and for every linked worktree of it);
    // anything else (a bare repo's own dir) has no main checkout to name.
    if (path.basename(common) !== '.git') return fallback;
    return path.basename(path.dirname(common)) || fallback;
  } catch {
    return fallback;
  }
}

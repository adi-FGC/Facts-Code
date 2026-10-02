/**
 * Spawn-free cache keys for the git miners' per-edit reuse path.
 *
 * The `--minimal` hook runs analyze on every agent edit. Re-mining git each
 * time (the topology, the full `git log` walk) was most of each run, yet
 * neither result can change while no ref moves. Both miners key a persisted
 * copy on a fingerprint of the repo's refs and HEADs, computed from plain fs
 * stats: the reuse path must not spawn git at all to decide it may reuse.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The git dir + common dir for `start`, found WITHOUT spawning git (the
 *  reuse path must stay spawn-free): walk up to the first `.git`; a `.git`
 *  FILE (linked worktree) points at its git dir, whose `commondir` names the
 *  shared one. null = not found / unreadable → no cache for this run. */
function findGitDirs(start: string): { gitDir: string; commonDir: string } | null {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      /* not here — keep walking */
    }
    if (st?.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    if (st?.isFile()) {
      try {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!m) return null;
        const gitDir = path.resolve(dir, m[1]!);
        let commonDir = gitDir;
        try {
          const rel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
          if (rel) commonDir = path.resolve(gitDir, rel);
        } catch {
          /* no commondir (submodule-style gitdir): it is its own common dir */
        }
        return { gitDir, commonDir };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Per-worktree state files whose change must invalidate the cache: HEAD
 *  (checkout/commit on a detached HEAD), in-progress operations, fetches,
 *  locks. The index is deliberately NOT here — IDEs rewrite it on every save,
 *  which would defeat reuse on exactly the per-edit path it exists for. */
const WORKTREE_STATE = [
  'HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'rebase-merge',
  'rebase-apply',
  'locked',
  'gitdir',
];

/** Fingerprint of everything a git miner reads that can change without an
 *  edit to the tree: refs (loose, packed, reftable), every worktree's HEAD/op
 *  state, the worktree list, remotes (config), the shallow boundary, plus the
 *  caller's own `inputs` (cache version, root, options). Pure fs stats — no
 *  git spawn. null = no git dir found → the caller mines without a cache. */
export function refsFingerprint(absRoot: string, inputs: unknown[]): string | null {
  const dirs = findGitDirs(absRoot);
  if (!dirs) return null;
  const sig: string[] = [JSON.stringify(inputs)];
  const stat = (p: string): void => {
    try {
      const s = fs.statSync(p);
      sig.push(`${p}|${s.mtimeMs}|${s.size}`);
    } catch {
      sig.push(`${p}|-`);
    }
  };
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (sig.length > 50_000) return; // pathological ref count: still a stable key
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 8) walk(p, depth + 1);
      } else stat(p);
    }
  };
  const { gitDir, commonDir } = dirs;
  for (const f of WORKTREE_STATE) stat(path.join(gitDir, f));
  for (const f of ['HEAD', 'packed-refs', 'config', 'FETCH_HEAD', 'shallow'])
    stat(path.join(commonDir, f));
  walk(path.join(commonDir, 'refs'), 0);
  walk(path.join(commonDir, 'reftable'), 0);
  let wts: string[] = [];
  try {
    wts = fs.readdirSync(path.join(commonDir, 'worktrees')).sort();
  } catch {
    /* no linked worktrees */
  }
  for (const w of wts) {
    sig.push(`wt:${w}`);
    for (const f of WORKTREE_STATE) stat(path.join(commonDir, 'worktrees', w, f));
  }
  return createHash('sha256').update(sig.join('\n')).digest('hex');
}

/** The cache file's JSON body when its version and fingerprint match and it
 *  is younger than `maxAgeMs`; null otherwise (missing / unreadable / not
 *  JSON / stale). The caller still validates its own payload field. */
export function readCacheFile(
  file: string,
  version: number,
  fp: string,
  maxAgeMs: number,
): Record<string, unknown> | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    if (!j || typeof j !== 'object') return null;
    if (j.v !== version || j.fp !== fp || typeof j.savedAt !== 'number') return null;
    const age = Date.now() - j.savedAt;
    return age >= 0 && age < maxAgeMs ? j : null;
  } catch {
    return null; // missing / unreadable / not JSON → mine
  }
}

/** Write `body` as JSON with a whole-file swap, so a concurrent reader never
 *  sees half a file. Best effort: a failed write only costs the next reuse. */
export function writeCacheFile(file: string, body: Record<string, unknown>): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

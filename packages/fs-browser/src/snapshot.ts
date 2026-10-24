/**
 * A local folder's identity for saved scans (D-10): the commit it is at,
 * when `.git` is readable, and a signature over its tree — every file's
 * path, byte size and mtime — so a saved scan is reused only while nothing
 * changed, and a change is reported as "new commit" or "files edited".
 *
 * The walk skips `.git` and the directories the GitHub fetcher skips
 * (GH_EXCLUDE_DIRS). The walker's .gitignore rules are not applied, so an
 * edit inside an ignored-but-present folder (a build output) also counts
 * as a change. Conservative on purpose: never a stale result, at worst an
 * unnecessary rescan.
 */
import type { Dirent, FactsFS } from '@factstack/spec';
import { GH_EXCLUDE_DIRS } from './github.js';

export interface LocalSnapshot {
  /** HEAD's commit, or null (no `.git`, a worktree pointer file, unreadable). */
  commit: string | null;
  /** SHA-256 over the sorted `path NUL size NUL mtime` lines. */
  signature: string;
  files: number;
  bytes: number;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/** HEAD's commit from a checkout's own `.git` directory. A worktree's
 *  `.git` is a file pointing outside the picked folder: unreadable, null. */
export async function readGitCommit(fs: FactsFS): Promise<string | null> {
  const sha = (s: string): string | null => (SHA_RE.test(s) ? s.toLowerCase() : null);
  try {
    if (!(await fs.stat('.git')).isDirectory) return null;
    const head = (await fs.readText('.git/HEAD')).trim();
    const direct = sha(head);
    if (direct) return direct;
    const m = /^ref:\s*(\S+)/.exec(head);
    if (!m) return null;
    const ref = m[1]!;
    try {
      const loose = sha((await fs.readText(`.git/${ref}`)).trim());
      if (loose) return loose;
    } catch {
      /* not a loose ref: try the packed file */
    }
    try {
      for (const line of (await fs.readText('.git/packed-refs')).split('\n')) {
        const [h, r] = line.trim().split(/\s+/);
        if (r === ref && h) return sha(h);
      }
    } catch {
      /* no packed-refs */
    }
    return null;
  } catch {
    return null;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Walk the folder and sign its tree. `onProgress` receives the running
 *  file count every few hundred files. */
export async function localSnapshot(
  fs: FactsFS,
  onProgress?: (files: number) => void,
): Promise<LocalSnapshot> {
  const lines: string[] = [];
  let bytes = 0;
  const stack = ['.'];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries: Dirent[] = [];
    try {
      for await (const e of fs.readDir(dir)) entries.push(e);
    } catch {
      continue; // unreadable directory: it contributes nothing, deterministically
    }
    const files: Dirent[] = [];
    for (const e of entries) {
      if (e.isDirectory) {
        if (e.name !== '.git' && !GH_EXCLUDE_DIRS.has(e.name)) stack.push(e.path);
      } else if (e.isFile) {
        files.push(e);
      }
    }
    /* One directory's stats in parallel: on the File System Access API
       each is a round trip, and the handles are cached for the walk. */
    const stats = await Promise.all(
      files.map(async (e) => {
        try {
          const s = await fs.stat(e.path);
          return `${e.path}\u0000${s.size}\u0000${s.mtimeMs}`;
        } catch {
          return `${e.path}\u0000?`;
        }
      }),
    );
    for (const line of stats) {
      lines.push(line);
      const size = Number(line.split('\u0000')[1]);
      if (Number.isFinite(size)) bytes += size;
    }
    if (onProgress && lines.length % 200 < files.length) onProgress(lines.length);
  }
  lines.sort();
  return {
    commit: await readGitCommit(fs),
    signature: await sha256Hex(lines.join('\n')),
    files: lines.length,
    bytes,
  };
}

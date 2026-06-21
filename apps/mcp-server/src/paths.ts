import * as path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

/**
 * Resolve a project-relative path against `root` and assert it stays inside it.
 * Defends the MCP server's live-read fallbacks (get_outline, count_tokens)
 * against path traversal — e.g. a crafted `../../etc/passwd` — and against
 * in-root symlinks that escape the project. Throws when the resolved path is
 * outside the root or is/contains an escaping symlink.
 *
 * Containment uses `path.relative` (XP-1), not a lexical `startsWith` prefix,
 * which normalizes case + separators on Windows. A pure prefix comparison
 * false-positives on (a) Windows drive-letter casing ("D:\Repo" vs "d:\repo"),
 * (b) filesystem-root projects where root is "/" or "C:\" (no trailing sep),
 * and (c) sibling dirs that share a string prefix ("/var/lib" vs "/var/libfoo").
 * This is the same implementation the CLI proved out in `safeResolveInside`;
 * it also closes the symlink-escape gap (SEC-2).
 *
 * Pure of server state (takes `root` explicitly) so it can be unit-tested
 * without booting the server (server.ts runs `main()` on import).
 */
export function resolveInRoot(root: string, relPath: string): string {
  // Realpath the root (best-effort) so containment compares real-vs-real. A
  // legitimately symlinked project root (macOS /var, or a symlinked repo) must
  // not reject its own in-root files at the realpath recheck in step 3. Falls
  // back to the lexical root when the root isn't resolvable on disk.
  let rootAbs = path.resolve(root);
  try {
    rootAbs = realpathSync(rootAbs);
  } catch {
    /* root not on disk — keep the lexical resolve */
  }
  const abs = path.resolve(rootAbs, relPath);

  // 1. Lexical containment (cross-platform via path.relative).
  if (!isInside(rootAbs, abs)) {
    throw new Error('Path outside project root');
  }

  // 2. Reject a leaf symlink outright (don't follow user-created symlinks —
  //    realpathSync would silently widen scope). A not-yet-existent target is
  //    fine: the caller does its own existence check and returns a clean 404.
  let leaf;
  try {
    leaf = lstatSync(abs);
  } catch {
    return abs;
  }
  if (leaf.isSymbolicLink()) {
    throw new Error('Path outside project root');
  }

  // 3. Resolve mid-path symlinks and re-check containment, so a symlinked
  //    parent directory can't escape either.
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return abs;
  }
  if (!isInside(rootAbs, real)) {
    throw new Error('Path outside project root');
  }
  return real;
}

/** True iff `candidate` is `root` itself or a descendant of it. Uses
 *  path.relative so it is correct across OSes (Windows drive casing, UNC,
 *  cross-drive absolutes) — not a byte-prefix check. */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  // `..` escapes upward; an absolute `rel` means different drives on Windows.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

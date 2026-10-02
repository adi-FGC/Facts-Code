/**
 * CLI-06 — graph targets typed on a command line. The artifact keys every
 * file by a POSIX, project-relative path (`src/a.ts`), but PowerShell and cmd
 * tab-complete `.\src\a.ts`, and agents pass absolute paths. Without
 * normalizing, `query callers src\a.ts` answered "0 results" (exit 0) for a
 * file that has callers — read as "safe to delete". The ui server already
 * normalized; the CLI now matches it (INV7).
 */

import path from 'node:path';
import type { AgentArtifact } from '@factstack/spec';

/**
 * Normalize a user-supplied file/symbol target against `root`:
 *   - `\` → `/`;
 *   - an absolute path inside `root` becomes root-relative;
 *   - leading `./` segments are dropped.
 * Anything else (a symbol name, an id like `src/a.ts#fn`) passes through
 * with only the separator fix, so non-path targets are unaffected.
 */
export function normalizeTarget(root: string, raw: string): string {
  const trimmed = raw.trim();
  let s = trimmed.replaceAll('\\', '/');
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:\//.test(s)) {
    const rel = path.relative(path.resolve(root), path.resolve(trimmed));
    if (rel === '') s = '.';
    else if (!rel.startsWith('..') && !path.isAbsolute(rel)) s = rel.replaceAll('\\', '/');
  }
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/** Looks like a file path (has a separator or a file extension). */
export function isPathLike(target: string): boolean {
  return /[/\\]/.test(target) || /\.[A-Za-z0-9]{1,8}$/.test(target);
}

/** True when a path-like target names a file node in the graph. */
export function fileInGraph(agent: AgentArtifact, target: string): boolean {
  return agent.graph.nodes.some((n) => n.path === target || n.id === target);
}

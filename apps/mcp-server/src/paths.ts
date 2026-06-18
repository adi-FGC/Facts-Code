import * as path from 'node:path';

/**
 * Resolve a project-relative path against `root` and assert it stays inside it.
 * Defends the MCP server's live-read fallbacks (get_outline, count_tokens)
 * against path traversal — e.g. a crafted `../../etc/passwd`. Throws when the
 * resolved path escapes the project root.
 *
 * Pure + side-effect-free so it can be unit-tested without booting the server
 * (server.ts runs `main()` on import).
 */
export function resolveInRoot(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path outside project root');
  }
  return abs;
}

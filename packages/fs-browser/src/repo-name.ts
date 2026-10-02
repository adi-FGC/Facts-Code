/**
 * The name a browser scan reports its project under — the browser half of
 * fs-node's `repoDisplayName` (v0.3.11).
 *
 * The CLI names a project after its MAIN checkout, even from a linked
 * worktree, because the project is the repository. A browser scan used the
 * picked folder's name, so saving from a worktree wrote
 * `.claude/skills/factstack-<worktree>/SKILL.md` next to the CLI's
 * `factstack-<repo>` — two FACTS skills, one of them drifting stale.
 *
 * A browser cannot run git, but a linked worktree's `.git` is a FILE naming
 * the common dir: `gitdir: <main>/.git/worktrees/<name>`. That is enough to
 * recover `<main>`'s name. Anything else — a `.git` directory (this IS the
 * main checkout), a submodule's `.git/modules/…`, a relative path the
 * browser cannot resolve, no git at all — keeps the fallback, which is what
 * the CLI reports in those cases too.
 */

import type { FactsFS } from '@factstack/spec';

export async function browserRepoName(fs: FactsFS, fallback: string): Promise<string> {
  try {
    if (!(await fs.stat('.git')).isFile) return fallback;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readText('.git'));
    if (!m) return fallback;
    const parts = m[1]!.replace(/\\/g, '/').split('/').filter(Boolean);
    const i = parts.lastIndexOf('worktrees');
    const main = i >= 2 && parts[i - 1] === '.git' ? parts[i - 2]! : '';
    return main && main !== '.' && main !== '..' && !main.endsWith(':') ? main : fallback;
  } catch {
    return fallback;
  }
}

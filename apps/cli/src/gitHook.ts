/**
 * F8 — git post-commit hook installer.
 *
 * Goal (feature-plan F8 DoD, "commit auto-refreshes"): after every commit,
 * refresh `.facts/` so the committed artifact never drifts from the tree it
 * describes. The hook shells out to `factstack analyze` — no network, so it
 * honors constraint C1 (offline) and can never block or fail a commit
 * (`|| true` swallows a non-zero exit; output is silenced).
 *
 * Design mirrors `agentHook.ts`: a pure, unit-testable merge
 * (`ensureGitHook`) + a thin fs wrapper (`installGitHook` / `uninstallGitHook`).
 * The merge is **idempotent** and **non-destructive** — our lines live inside
 * a marker-delimited block, so re-installing replaces only that block and any
 * pre-existing post-commit logic (CI notifiers, linters, …) survives untouched.
 *
 * Resolving the hooks dir: the common case is `<root>/.git/hooks`. Submodules
 * and linked worktrees use `.git` as a *file* (`gitdir: <path>`); we follow
 * that pointer so the hook lands in the real git dir. `core.hooksPath` overrides
 * are out of scope for this increment (documented limitation).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, chmodSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname } from 'node:path';

/** Default command the hook runs. `npx` resolves a local devDependency or a
 *  global install, matching the `agentHook` convention. A full re-analyze (not
 *  `--minimal`) is the right call at commit time — the artifact you commit
 *  should be the complete one. Self-hosting repos override via `--command`. */
export const GIT_HOOK_COMMAND = 'npx factstack analyze';

/** Sentinels bracketing the factstack-managed lines. Stable across versions so
 *  an old block is always found + replaced on upgrade. Do not change lightly. */
const MARKER_START = '# >>> factstack post-commit (auto-refresh .facts) >>>';
const MARKER_END = '# <<< factstack post-commit <<<';

/**
 * The factstack-managed block (pure). `command` is the analyze invocation
 * (e.g. `npx factstack analyze`); we append the repo-root target + redirects.
 * post-commit runs with CWD = repo root, so `.` is the project root.
 */
export function factstackGitHookBlock(command: string = GIT_HOOK_COMMAND): string {
  return [
    MARKER_START,
    '# Keep .facts/ current after each commit. Offline (C1-safe); never blocks the commit.',
    `${command} . >/dev/null 2>&1 || true`,
    MARKER_END,
  ].join('\n');
}

const SHEBANG = '#!/bin/sh';

/**
 * Pure, non-destructive merge: return post-commit hook content that contains
 * exactly one up-to-date factstack block.
 *
 * - empty/absent input → a fresh `#!/bin/sh` + our block.
 * - input already containing a factstack block → that block is *replaced*
 *   in place (idempotent; preserves everything around it).
 * - input with other hook logic but no factstack block → our block is appended
 *   (the user's logic is preserved, runs first).
 */
export function ensureGitHook(existing: string | null, command: string = GIT_HOOK_COMMAND): string {
  const block = factstackGitHookBlock(command);

  if (existing == null || existing.trim() === '') {
    return `${SHEBANG}\n${block}\n`;
  }

  const start = existing.indexOf(MARKER_START);
  if (start >= 0) {
    const endIdx = existing.indexOf(MARKER_END, start);
    if (endIdx >= 0) {
      // Replace the existing block in place (keep surrounding content verbatim).
      const before = existing.slice(0, start);
      const after = existing.slice(endIdx + MARKER_END.length);
      return before + block + after;
    }
    // Start marker but no end marker (hand-mangled): replace from start to EOL-run.
    return existing.slice(0, start) + block + '\n';
  }

  // No factstack block — append, preserving the user's hook. Ensure a shebang.
  const hasShebang = existing.startsWith('#!');
  const base = hasShebang ? existing : `${SHEBANG}\n${existing}`;
  const sep = base.endsWith('\n') ? '' : '\n';
  return `${base}${sep}${block}\n`;
}

/**
 * Pure removal: strip the factstack block from existing content. Returns:
 * - `null` when nothing remains but a shebang/whitespace (caller deletes the file).
 * - the cleaned content otherwise (other hook logic preserved).
 * - `null` when the input had no factstack block AND is shebang-only (idempotent
 *   uninstall is a no-op the caller can detect via `removed`).
 */
export function stripGitHook(existing: string | null): { content: string | null; removed: boolean } {
  if (existing == null) return { content: null, removed: false };
  const start = existing.indexOf(MARKER_START);
  if (start < 0) return { content: existing, removed: false };

  const endIdx = existing.indexOf(MARKER_END, start);
  const after = endIdx >= 0 ? existing.slice(endIdx + MARKER_END.length) : '';
  let cleaned = (existing.slice(0, start) + after).replace(/\n{3,}/g, '\n\n').trimEnd();

  // If only a shebang (or nothing) is left, signal a full delete.
  if (cleaned === '' || cleaned === SHEBANG || /^#!\S*\/?\w+\s*$/.test(cleaned)) {
    return { content: null, removed: true };
  }
  if (!cleaned.endsWith('\n')) cleaned += '\n';
  return { content: cleaned, removed: true };
}

/**
 * Resolve `<root>/.git`'s hooks directory. Handles `.git` as a directory
 * (normal) or as a `gitdir:` pointer file (submodule/worktree). Throws a clear
 * error when `root` is not a git working tree.
 */
export function resolveHooksDir(root: string): string {
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) {
    throw new Error(`not a git repository: ${root} (no .git)`);
  }
  const st = statSync(dotGit);
  if (st.isDirectory()) return join(dotGit, 'hooks');

  // `.git` is a file: `gitdir: <path>` (path may be relative to root).
  const raw = readFileSync(dotGit, 'utf8').trim();
  const m = /^gitdir:\s*(.+)$/.exec(raw);
  const gitdirPath = m?.[1];
  if (!gitdirPath) throw new Error(`unrecognized .git file at ${dotGit}`);
  const gitDir = isAbsolute(gitdirPath) ? gitdirPath : resolve(root, gitdirPath);
  return join(gitDir, 'hooks');
}

export interface GitHookResult {
  /** Absolute path to the hook file written (or that would be removed). */
  hookPath: string;
  /** True when the file was changed (added/updated/removed); false on no-op. */
  changed: boolean;
  /** The analyze command embedded (install only). */
  command: string;
}

/**
 * Install/refresh the post-commit hook under `root`'s git dir. Idempotent:
 * re-running with the same command is a no-op (`changed: false`). Makes the
 * hook executable (best-effort; chmod is a no-op on Windows fs).
 */
export function installGitHook(root: string, command: string = GIT_HOOK_COMMAND): GitHookResult {
  const hooksDir = resolveHooksDir(root);
  const hookPath = join(hooksDir, 'post-commit');
  const existing = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;
  const next = ensureGitHook(existing, command);

  const changed = next !== existing;
  if (changed) {
    mkdirSync(dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, next, 'utf8');
  }
  // Hooks must be executable on POSIX; chmod throws on some Windows fs — ignore.
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* non-POSIX filesystem — git on Windows runs the hook regardless */
  }
  return { hookPath, changed, command };
}

/**
 * Remove the factstack block from the post-commit hook. If the hook is left
 * empty (only our block existed), the file is deleted. Other hook logic is
 * preserved. No-op (`changed: false`) when no factstack block is present.
 */
export function uninstallGitHook(root: string): GitHookResult {
  const hooksDir = resolveHooksDir(root);
  const hookPath = join(hooksDir, 'post-commit');
  if (!existsSync(hookPath)) {
    return { hookPath, changed: false, command: '' };
  }
  const existing = readFileSync(hookPath, 'utf8');
  const { content, removed } = stripGitHook(existing);
  if (!removed) {
    return { hookPath, changed: false, command: '' };
  }
  if (content == null) {
    rmSync(hookPath);
  } else {
    writeFileSync(hookPath, content, 'utf8');
  }
  return { hookPath, changed: true, command: '' };
}

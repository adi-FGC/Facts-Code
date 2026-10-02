/**
 * F8 — git post-commit hook installer.
 *
 * Goal (feature-plan F8 DoD, "commit auto-refreshes"): after every commit,
 * refresh `.facts/` so the committed artifact never drifts from the tree it
 * describes. The hook shells out to `factstack analyze`, which itself makes no
 * network call (INV6), and can never block or fail a commit (`|| true`
 * swallows a non-zero exit; output is silenced). The launch runs the
 * project's or the global factstack install; while the `factstack` name is
 * unpublished it never asks the npm registry (`npm exec --no`), and
 * only after the owner publishes it does `npx` fall back to the registry.
 *
 * Design mirrors `agentHook.ts`: a pure, unit-testable merge
 * (`ensureGitHook`) + a thin fs wrapper (`installGitHook` / `uninstallGitHook`).
 * The merge is **idempotent** and **non-destructive** — our lines live inside
 * a marker-delimited block, so re-installing replaces only that block and any
 * pre-existing post-commit logic (CI notifiers, linters, …) survives untouched.
 * A hook we cannot safely extend (not a sh script, or a mangled block) is
 * refused, never rewritten.
 *
 * Resolving the hooks dir: git itself answers (`git rev-parse --git-path
 * hooks`), so linked worktrees (hooks live in the COMMON dir), submodules,
 * subdirectories and `core.hooksPath` (husky & co.) all land where git
 * actually runs hooks. Without git on PATH we fall back to reading `.git`.
 *
 * Shared hooks dirs (R2): a `core.hooksPath` from the global/system config
 * makes git run the hook in EVERY repository on the machine, and a hooks dir
 * inside the work tree (husky's `.husky/`, `.githooks/`) is committed, so the
 * hook reaches every teammate — both running the factstack launch, which in a
 * hook (no TTY) installs from the registry without asking once the CLI is
 * published and launched through `npx`. Install and uninstall
 * refuse such a dir unless the caller opts in (`--shared`); the refusal
 * prints the line to add by hand.
 */

import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join, isAbsolute, resolve, dirname, basename, relative } from 'node:path';
import { hookCliLaunch } from './agentHook.js';

/** Default command the hook runs — `<launch> analyze`, where the launch is
 *  agentHook's hookCliLaunch: `npm exec --no -- factstack` (never downloads)
 *  until the owner publishes the name, then spec's CLI_NPX. A full
 *  re-analyze (not `--minimal`) is the right call at commit time — the
 *  artifact you commit should be the complete one. Until the package is
 *  published, and in self-hosting repos, override it via `--command` /
 *  FACTSTACK_HOOK_COMMAND. */
export const GIT_HOOK_COMMAND = `${hookCliLaunch()} analyze`;

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
    '# Keep .facts/ current after each commit. analyze makes no network call; never blocks the commit.',
    gitHookLine(command),
    MARKER_END,
  ].join('\n');
}

/** The one line that runs the analyze (what a user adds by hand). */
export function gitHookLine(command: string = GIT_HOOK_COMMAND): string {
  return `${command} . >/dev/null 2>&1 || true`;
}

const SHEBANG = '#!/bin/sh';

/** Shebangs our sh block can be appended under. */
const SH_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/\S*\/)?(?:sh|bash|dash|zsh|ksh)\b/;

/** An existing hook ensureGitHook will not touch; the message says what to do. */
export class GitHookRefusal extends Error {
  override name = 'GitHookRefusal';
}

/**
 * Pure, non-destructive merge: return post-commit hook content that contains
 * exactly one up-to-date factstack block.
 *
 * - empty/absent input → a fresh `#!/bin/sh` + our block.
 * - input already containing a factstack block → that block is *replaced*
 *   in place (idempotent; preserves everything around it).
 * - input with other sh hook logic but no factstack block → our block is
 *   appended (the user's logic is preserved, runs first).
 *
 * Throws GitHookRefusal (CLI-05) for a hook written in another language
 * (`#!/usr/bin/env node`, python, …) — a sh line appended there breaks the
 * user's hook — and for a start marker with no end marker, where we cannot
 * tell our lines from the user's.
 */
export function ensureGitHook(existing: string | null, command: string = GIT_HOOK_COMMAND): string {
  const block = factstackGitHookBlock(command);

  if (existing == null || existing.trim() === '') {
    return `${SHEBANG}\n${block}\n`;
  }

  const start = existing.indexOf(MARKER_START);
  if (start >= 0) {
    const endIdx = existing.indexOf(MARKER_END, start);
    if (endIdx < 0) {
      throw new GitHookRefusal(
        `the post-commit hook has a factstack start marker but no end marker ("${MARKER_END}") — fix the block by hand or delete it, then re-run`,
      );
    }
    // Replace the existing block in place (keep surrounding content verbatim).
    const before = existing.slice(0, start);
    const after = existing.slice(endIdx + MARKER_END.length);
    return before + block + after;
  }

  const firstLine = existing.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith('#!') && !SH_SHEBANG.test(firstLine)) {
    throw new GitHookRefusal(
      `the existing post-commit hook is not a sh script (${firstLine.trim()}) — appending a sh line would break it. Make it run \`${command} .\` itself, or pass --command`,
    );
  }

  // No factstack block — append, preserving the user's hook. Ensure a shebang.
  const base = firstLine.startsWith('#!') ? existing : `${SHEBANG}\n${existing}`;
  const sep = base.endsWith('\n') ? '' : '\n';
  return `${base}${sep}${block}\n`;
}

/**
 * True when the user's own hook logic ends in an `exit` — sh stops there, so
 * a block appended after it never runs. The caller warns (we never edit the
 * user's lines).
 */
export function endsWithExit(content: string): boolean {
  const start = content.indexOf(MARKER_START);
  const own = start >= 0 ? content.slice(0, start) : content;
  const lines = own
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return /^exit\b/.test(lines.at(-1) ?? '');
}

/**
 * Pure removal: strip the factstack block from existing content. Returns:
 * - `null` when nothing remains but a shebang/whitespace (caller deletes the file).
 * - the cleaned content otherwise (other hook logic preserved).
 * - `null` when the input had no factstack block AND is shebang-only (idempotent
 *   uninstall is a no-op the caller can detect via `removed`).
 */
export function stripGitHook(existing: string | null): {
  content: string | null;
  removed: boolean;
} {
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

export interface HooksDirInfo {
  /** Directory git runs hooks from (where our post-commit belongs). */
  dir: string;
  /** Set when `core.hooksPath` relocates hooks (husky, lefthook, …): a note
   *  for the install summary. */
  note?: string;
  /** Set when `dir` is SHARED beyond this developer's clone of this repo —
   *  a global/system core.hooksPath (every repo on the machine) or a dir in
   *  the work tree (every teammate once committed). Says who a hook there
   *  reaches. install/uninstall need `shared: true` to touch it. */
  shared?: string;
}

export interface GitHookOptions {
  /** Install/uninstall even when the hooks dir is shared (see HooksDirInfo). */
  shared?: boolean;
  /** Environment for the git calls (tests pin git's config). */
  env?: NodeJS.ProcessEnv;
}

/** Run git in `root`; trimmed stdout, or null on any failure (no git, not a
 *  work tree, unset config key). */
function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    const r = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      ...(env ? { env } : {}),
    });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout).trim() || null;
  } catch {
    return null;
  }
}

/** `git rev-parse --path-format=absolute --git-path hooks` from `root` —
 *  honours worktrees (common dir) and core.hooksPath — or null when git is
 *  unavailable or `root` is not in a work tree. */
function gitHooksPath(root: string, env?: NodeJS.ProcessEnv): string | null {
  const out = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], env)
    ?.split('\n')
    .at(-1)
    ?.trim();
  if (!out) return null;
  return resolve(root, out); // normalizes git's forward slashes on Windows
}

/** `child` is `parent` or below it. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Which config file core.hooksPath comes from: `local` / `worktree` (this
 * repo's own) or `global` / `system` / `command` (shared). `--show-scope`
 * needs git ≥ 2.26; older git answers by whether the repo-local value is the
 * effective one.
 */
function hooksPathScope(root: string, env?: NodeJS.ProcessEnv): string {
  const shown = git(root, ['config', '--show-scope', '--get', 'core.hooksPath'], env);
  const scope = shown?.split('\t', 1)[0];
  if (scope && shown!.includes('\t')) return scope;
  const local = git(root, ['config', '--local', '--get', 'core.hooksPath'], env);
  return local !== null && local === git(root, ['config', '--get', 'core.hooksPath'], env)
    ? 'local'
    : 'global';
}

/** Why a hook in `dir` (from core.hooksPath) would reach beyond this clone,
 *  or undefined when it would not. */
function sharedReason(root: string, dir: string, env?: NodeJS.ProcessEnv): string | undefined {
  const scope = hooksPathScope(root, env);
  if (scope !== 'local' && scope !== 'worktree') {
    return `core.hooksPath comes from your ${scope} git config, so a hook in ${dir.replaceAll('\\', '/')} runs in every repository on this machine`;
  }
  const top = git(root, ['rev-parse', '--path-format=absolute', '--show-toplevel'], env);
  if (!top || !isWithin(dir, resolve(top))) return undefined;
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
  if (common && isWithin(dir, resolve(root, common))) return undefined; // e.g. .git/hooks
  const rel = relative(resolve(top), join(dir, 'post-commit')).replaceAll('\\', '/');
  // A hooks file git ignores stays personal.
  if (git(resolve(top), ['check-ignore', '--no-index', '--', rel], env) !== null) return undefined;
  return `${rel} is inside the work tree, so once committed it runs for every teammate`;
}

/**
 * Where git runs hooks for the repo containing `root`, asked of git itself
 * (CLI-04): a linked worktree's hooks live in the COMMON git dir, and
 * `core.hooksPath` moves them elsewhere. For husky 9 (`core.hooksPath=.husky/_`)
 * the user hook belongs in `.husky/post-commit` — `_/` is regenerated by
 * husky and dispatches to it. A shared dir is flagged (`shared`, R2). Falls
 * back to reading `<root>/.git` when git is not available. Throws a clear
 * error when `root` is not a git working tree.
 */
export function resolveHooks(root: string, env?: NodeJS.ProcessEnv): HooksDirInfo {
  const fromGit = gitHooksPath(root, env);
  if (fromGit) {
    if (git(root, ['config', '--get', 'core.hooksPath'], env) === null) return { dir: fromGit };
    let dir = fromGit;
    let note = `core.hooksPath → ${fromGit.replaceAll('\\', '/')}`;
    if (basename(fromGit) === '_' && basename(dirname(fromGit)) === '.husky') {
      dir = dirname(fromGit);
      note = `core.hooksPath is husky-managed — installed into ${dir.replaceAll('\\', '/')}/post-commit`;
    }
    const shared = sharedReason(root, dir, env);
    return { dir, note, ...(shared ? { shared } : {}) };
  }
  return { dir: resolveHooksDirFromDotGit(root) };
}

/** Back-compat wrapper: just the directory. */
export function resolveHooksDir(root: string, env?: NodeJS.ProcessEnv): string {
  return resolveHooks(root, env).dir;
}

/**
 * Fallback without git: `<root>/.git`'s hooks directory. Handles `.git` as a
 * directory (normal) or as a `gitdir:` pointer file (submodule/worktree); a
 * worktree's `commondir` file leads to the shared hooks dir.
 */
export function resolveHooksDirFromDotGit(root: string): string {
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
  // Linked worktree: `commondir` names the shared git dir, where hooks run.
  const commondirFile = join(gitDir, 'commondir');
  if (existsSync(commondirFile)) {
    const common = readFileSync(commondirFile, 'utf8').trim();
    if (common) return join(isAbsolute(common) ? common : resolve(gitDir, common), 'hooks');
  }
  return join(gitDir, 'hooks');
}

export interface GitHookResult {
  /** Absolute path to the hook file written (or that would be removed). */
  hookPath: string;
  /** True when the file was changed (added/updated/removed); false on no-op. */
  changed: boolean;
  /** The analyze command embedded (install only). */
  command: string;
  /** core.hooksPath / husky note for the summary (install only). */
  note?: string;
  /** The user's hook ends in `exit`, so the appended block never runs. */
  unreachable?: boolean;
  /** Who a hook in this (shared) dir reaches — set only with `shared: true`. */
  shared?: string;
}

/**
 * Install/refresh the post-commit hook under `root`'s git dir. Idempotent:
 * re-running with the same command is a no-op (`changed: false`). Makes the
 * hook executable (best-effort; chmod is a no-op on Windows fs). Throws
 * GitHookRefusal for a hook it cannot safely extend (see ensureGitHook), and
 * for a SHARED hooks dir unless `opts.shared` (R2) — the message carries the
 * line to add by hand.
 */
export function installGitHook(
  root: string,
  command: string = GIT_HOOK_COMMAND,
  opts: GitHookOptions = {},
): GitHookResult {
  const { dir: hooksDir, note, shared } = resolveHooks(root, opts.env);
  const hookPath = join(hooksDir, 'post-commit');
  if (shared && !opts.shared) {
    throw new GitHookRefusal(
      `not installed: git runs this repo's hooks from a shared place — ${shared}. ` +
        `Re-run with --shared to install there anyway, or add this line to ${hookPath.replaceAll('\\', '/')} yourself:\n` +
        `  ${gitHookLine(command)}`,
    );
  }
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
  return {
    hookPath,
    changed,
    command,
    ...(note ? { note } : {}),
    ...(endsWithExit(next) ? { unreachable: true } : {}),
    ...(shared ? { shared } : {}),
  };
}

/**
 * Remove the factstack block from the post-commit hook. If the hook is left
 * empty (only our block existed), the file is deleted. Other hook logic is
 * preserved. No-op (`changed: false`) when no factstack block is present.
 * Mirrors install for a SHARED hooks dir: removing the block there changes
 * every repo / teammate, so it needs `opts.shared` (GitHookRefusal otherwise).
 */
export function uninstallGitHook(root: string, opts: GitHookOptions = {}): GitHookResult {
  const { dir: hooksDir, shared } = resolveHooks(root, opts.env);
  const hookPath = join(hooksDir, 'post-commit');
  if (!existsSync(hookPath)) {
    return { hookPath, changed: false, command: '' };
  }
  const existing = readFileSync(hookPath, 'utf8');
  const { content, removed } = stripGitHook(existing);
  if (!removed) {
    return { hookPath, changed: false, command: '' };
  }
  if (shared && !opts.shared) {
    throw new GitHookRefusal(
      `not removed: the factstack block in ${hookPath.replaceAll('\\', '/')} is shared — ${shared}. ` +
        'Re-run with --shared to remove it there, or delete the block by hand.',
    );
  }
  if (content == null) {
    rmSync(hookPath);
  } else {
    writeFileSync(hookPath, content, 'utf8');
  }
  return { hookPath, changed: true, command: '', ...(shared ? { shared } : {}) };
}

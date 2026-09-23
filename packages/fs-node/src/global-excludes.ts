/**
 * The ignore rules git applies from OUTSIDE a repository's tracked files —
 * v0.3.12.
 *
 * A `.gitignore` is not the whole truth about what git ignores. Per-developer
 * entries live in the user's global excludes file (`core.excludesFile`,
 * default `~/.config/git/ignore`) and in the repo-local, untracked
 * `.git/info/exclude`, so they never appear in anyone's diff: editor state,
 * and — the case that bit us — `.claude/settings.local.json`, the personal
 * hook/permission settings a coding agent writes into the repo.
 *
 * The walker is isomorphic and may only read inside the FactsFS root, so it
 * cannot find either file. This is the Node-side lookup; the CLI and the MCP
 * server pass the result to `analyze({ extraIgnore })`. Rules are returned
 * verbatim (comments and blanks included — the walker's parser drops them)
 * and are interpreted relative to the analysis root, which is how git applies
 * them to paths inside the repository.
 *
 * Deliberately faithful to git, because a divergence either leaks a file the
 * developer hid or hides one they expect to see:
 *   - `core.excludesFile` set but missing  → NO global excludes (git does not
 *     fall back to the default path once the setting exists).
 *   - not a git repository, or no git      → no rules at all (git is not
 *     ignoring anything there).
 *   - a relative `core.excludesFile`       → resolved against the repository,
 *     as git does, never against the caller's cwd.
 *   - an existing but empty file           → no rules, and no fallback.
 *
 * Read-only and never throws: anything unreadable yields fewer rules, never
 * an error, and the walk proceeds with the repository's own ignore files.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Cap on an excludes file. A sane one is a few hundred bytes; this bounds
 *  the read itself, not just the string that comes out of it. */
const MAX_BYTES = 256 * 1024;

function git(root: string, args: string[]): { ok: boolean; out: string; missing: boolean } {
  try {
    const r = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (r.error)
      return { ok: false, out: '', missing: (r.error as NodeJS.ErrnoException).code === 'ENOENT' };
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), missing: false };
  } catch {
    return { ok: false, out: '', missing: true };
  }
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  // `~user/` is git syntax we cannot resolve portably. Returning it verbatim
  // would silently match nothing, so say so by reporting no file at all.
  if (p.startsWith('~')) return '';
  return p;
}

/** Lines of one ignore file, or null when it does not exist / is empty. */
function readRules(file: string): string[] | null {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    fd = fs.openSync(file, 'r');
    const size = Math.min(stat.size, MAX_BYTES);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    const lines = buf.toString('utf8').split(/\r?\n/);
    // A cap that lands mid-rule must not invent a truncated pattern.
    if (stat.size > MAX_BYTES) lines.pop();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** The global excludes file git would use for `root`, or null. */
function globalExcludesPath(root: string): string | null {
  const configured = git(root, ['config', '--get', 'core.excludesFile']);
  if (configured.ok && configured.out) {
    const expanded = expandHome(configured.out);
    if (!expanded) return null;
    return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  // git checks $XDG_CONFIG_HOME/git/ignore and only then ~/.config/git/ignore.
  if (xdg) {
    const p = path.join(xdg, 'git', 'ignore');
    if (fs.existsSync(p)) return p;
  }
  return path.join(os.homedir(), '.config', 'git', 'ignore');
}

/**
 * Ignore-file lines git applies to `root` from outside the tracked tree:
 * the global excludes file followed by `.git/info/exclude`. `[]` when there
 * are none, when `root` is not a git repository, or when git is unavailable.
 */
export function gitGlobalExcludes(root: string): string[] {
  const top = git(root, ['rev-parse', '--git-common-dir']);
  if (!top.ok || !top.out) return []; // no git, or not a repository: git ignores nothing here
  const rules: string[] = [];
  const globalPath = globalExcludesPath(root);
  if (globalPath) rules.push(...(readRules(globalPath) ?? []));
  const gitDir = path.isAbsolute(top.out) ? top.out : path.resolve(root, top.out);
  rules.push(...(readRules(path.join(gitDir, 'info', 'exclude')) ?? []));
  return rules;
}

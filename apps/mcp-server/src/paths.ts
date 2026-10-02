import * as path from 'node:path';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { rootArgOf, withoutRootArgs } from '@factstack/spec';

/**
 * Normalize a caller-supplied path to the artifact's key spelling:
 * project-relative, forward slashes, no leading `./` or `/`. An absolute path
 * inside `root` is relativized. One outside it that EXISTS is returned
 * slash-normalized but still absolute (lookups then miss, and live reads get
 * "Path outside project root" from `resolveInRoot`); one that doesn't exist
 * is read as root-relative — agents write `/src/b.ts` for `src/b.ts` (MCP-R5).
 * Without this, `src\b.ts` or `./src/b.ts` silently missed every artifact
 * lookup — "0 callers" for a file that has callers (MCP-12).
 */
export function normalizeRelPath(root: string, p: string): string {
  let s = p.trim();
  if (path.isAbsolute(s)) {
    const rel = path.relative(path.resolve(root), s);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) s = rel;
    else if (existsSync(s)) return s.replace(/\\/g, '/');
  }
  s = s.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/^\/+/, '');
}

export interface ServerArgs {
  login: boolean;
  root?: string;
  /** `--help` / `-h`: print usage and exit (never starts the server). */
  help?: true;
  /** `--version` / `-v`: print the version and exit. */
  version?: true;
}

/** The server's own argv: an optional `login` sub-command, `--root <dir>`
 *  (`-r <dir>`, `--root=<dir>` — the grammar is @factstack/spec's, shared
 *  with the installers), `--help` and `--version`. The value after `--root`
 *  is never mistaken for a sub-command or flag, so a project in a folder
 *  named `login` still works. */
export function parseServerArgs(argv: readonly string[]): ServerArgs {
  const root = rootArgOf(argv);
  let login = false;
  let help = false;
  let version = false;
  for (const a of withoutRootArgs(argv)) {
    if (a === 'login') login = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--version' || a === '-v') version = true;
  }
  return {
    login,
    ...(root ? { root } : {}),
    ...(help ? { help: true as const } : {}),
    ...(version ? { version: true as const } : {}),
  };
}

/** Best-effort canonical spelling: the OS's own realpath (symlinks resolved,
 *  8.3 short names expanded), else the lexical resolve. */
function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Nearest directory at or above `start` containing `marker`, or null. */
export function findUp(start: string, marker: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ResolvedRoot {
  root: string;
  /** Set when no safe root was found: the server still answers the
   *  handshake, but tools report this instead of analyzing anything. */
  error?: string;
}

/**
 * Pick the project root. An explicit `--root` / `FACTS_ROOT` wins as given.
 * Otherwise walk up from `cwd` to the repo (`.git`), else the nearest
 * `package.json` — MCP clients often launch servers from an arbitrary cwd,
 * and the old `'.'` fallback analyzed that directory and wrote `.facts/` +
 * a `.gitignore` into it. An inferred home directory or filesystem root is
 * refused: analyzing (and writing into) either is never what the user meant.
 */
export function resolveProjectRoot(opts: {
  argRoot?: string | undefined;
  envRoot?: string | undefined;
  cwd: string;
  home: string;
}): ResolvedRoot {
  const explicit = opts.argRoot || opts.envRoot;
  if (explicit) return { root: path.resolve(opts.cwd, explicit) };
  const found = findUp(opts.cwd, '.git') ?? findUp(opts.cwd, 'package.json');
  const hint = 'pass --root <project dir> (or set FACTS_ROOT) in the MCP client config';
  if (!found) {
    return {
      root: path.resolve(opts.cwd),
      error: `No project found at or above the server's working directory; ${hint}.`,
    };
  }
  const isFsRoot = path.dirname(found) === found;
  /* path.relative is case-insensitive on win32, so `C:\Temp\A` ≡ `c:\temp\a`;
     the native realpath also expands 8.3 short names (`C:\PROGRA~1`),
     which a cwd or HOME may carry (MCP-R6). */
  const isHome = path.relative(canonical(found), canonical(opts.home)) === '';
  if (isFsRoot || isHome) {
    return {
      root: found,
      error: `Refusing to analyze ${isFsRoot ? 'a filesystem root' : 'your home directory'} (inferred from the working directory); ${hint}.`,
    };
  }
  return { root: found };
}

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
 * without booting the server.
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

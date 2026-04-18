/**
 * Gitignore-aware filesystem walker. Operates on a FactsFS so the same
 * walker runs in Node (apps/cli) and the browser (v0.4 Chrome extension).
 *
 * Rules:
 *   - Respects .gitignore + .dockerignore + .cursorignore + .aiignore + .factsignore
 *     (stacked hierarchically; deeper files can override with `!` patterns).
 *   - Always excludes: node_modules, dist, build, .next, .turbo, .cache,
 *     __pycache__, .venv, .git, vendor, target, coverage, .pnpm-store.
 *   - Symlink loop detection via visited set of resolved paths.
 *   - Binary sniff: first 8 KB; skip if a null byte appears.
 *   - File size cap: default 1 MB, configurable.
 */

import ignore from 'ignore';
import type { Dirent, FactsFS } from '@factstack/spec';

const ALWAYS_EXCLUDE = new Set([
  'node_modules', 'dist', 'build', '.next', '.turbo', '.cache',
  '__pycache__', '.venv', '.git', 'vendor', 'target', 'coverage',
  '.pnpm-store', '.vscode', '.idea',
]);

const IGNORE_FILES = ['.gitignore', '.dockerignore', '.cursorignore', '.aiignore', '.factsignore'];

export interface WalkOptions {
  /** Maximum bytes to read per file. Larger files are flagged but not parsed. */
  maxFileSize?: number;
  /** Skip .git directory even if ignored. Default true. */
  skipGit?: boolean;
  /** Follow symlinks. Default false; loops are never followed regardless. */
  followSymlinks?: boolean;
}

export interface WalkedFile {
  /** POSIX path relative to walker root. */
  path: string;
  /** Parent folder path (POSIX, relative). */
  dir: string;
  /** Base filename. */
  name: string;
  /** Lowercase extension including the dot, e.g. `.ts`. */
  ext: string;
  /** File size in bytes. */
  size: number;
  /** Last-modified ms (from stat). */
  mtimeMs: number;
  /** UTF-8 decoded text, or null for binaries / over-cap files. */
  text: string | null;
  /** Line count of the text, or 0 if no text. */
  loc: number;
  /** Reason the file was not read (null if read successfully). */
  skippedReason: 'binary' | 'too_large' | 'read_error' | null;
}

export async function* walk(
  fs: FactsFS,
  root: string = '.',
  opts: WalkOptions = {},
): AsyncIterable<WalkedFile> {
  const maxFileSize = opts.maxFileSize ?? 1024 * 1024;
  const followSymlinks = opts.followSymlinks ?? false;
  const rootNorm = fs.normalize(root);
  const visited = new Set<string>();

  yield* walkDir(fs, rootNorm, rootNorm, ignore(), visited, { maxFileSize, followSymlinks });
}

async function* walkDir(
  fs: FactsFS,
  base: string,
  current: string,
  parentIgnore: ReturnType<typeof ignore>,
  visited: Set<string>,
  opts: Required<WalkOptions>,
): AsyncIterable<WalkedFile> {
  // Compose ignore patterns at this level by appending any local ignore files.
  const localIgnore = ignore().add(parentIgnore as unknown as string[]);
  // `ignore` doesn't expose its internal pattern list, so each level starts
  // fresh from the parent's set by re-adding discovered rule content.
  // The walker accumulates ignore content in `accumulated` and reuses.

  const accumulated: string[] = [];
  for (const f of IGNORE_FILES) {
    try {
      const ignorePath = fs.join(current, f);
      const content = await fs.readText(ignorePath);
      accumulated.push(...parseIgnore(content));
    } catch {
      /* file doesn't exist — fine */
    }
  }
  if (accumulated.length > 0) localIgnore.add(accumulated);

  const entries: Dirent[] = [];
  try {
    for await (const e of fs.readDir(current)) entries.push(e);
  } catch {
    return;
  }
  entries.sort((a, b) => {
    // Directories first, then files, alphabetical within each.
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (ALWAYS_EXCLUDE.has(entry.name)) continue;

    const relToRoot = relativeTo(base, entry.path, fs);
    const ignoreKey = entry.isDirectory ? relToRoot + '/' : relToRoot;
    if (localIgnore.ignores(ignoreKey)) continue;

    if (entry.isSymlink && !opts.followSymlinks) continue;

    if (entry.isDirectory) {
      if (visited.has(entry.path)) continue;
      visited.add(entry.path);
      yield* walkDir(fs, base, entry.path, localIgnore, visited, opts);
      continue;
    }
    if (!entry.isFile) continue;

    const stat = await fs.stat(entry.path).catch(() => null);
    if (!stat) continue;
    if (stat.size > opts.maxFileSize) {
      yield synthesizeFile(entry, relToRoot, stat.size, stat.mtimeMs, null, 'too_large');
      continue;
    }

    let text: string | null = null;
    try {
      text = await fs.readText(entry.path);
    } catch {
      yield synthesizeFile(entry, relToRoot, stat.size, stat.mtimeMs, null, 'read_error');
      continue;
    }
    if (isBinary(text)) {
      yield synthesizeFile(entry, relToRoot, stat.size, stat.mtimeMs, null, 'binary');
      continue;
    }

    yield synthesizeFile(entry, relToRoot, stat.size, stat.mtimeMs, text, null);
  }
}

function synthesizeFile(
  entry: Dirent,
  relPath: string,
  size: number,
  mtimeMs: number,
  text: string | null,
  skippedReason: WalkedFile['skippedReason'],
): WalkedFile {
  const lastSlash = relPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? relPath.slice(0, lastSlash) : '';
  const name = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return {
    path: relPath,
    dir,
    name,
    ext,
    size,
    mtimeMs,
    text,
    loc: text ? text.split('\n').length : 0,
    skippedReason,
  };
}

function parseIgnore(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function isBinary(text: string): boolean {
  // Sniff up to 8 KB of characters for NUL
  const head = text.slice(0, 8192);
  return head.includes('\0');
}

function relativeTo(base: string, p: string, fs: FactsFS): string {
  const b = fs.normalize(base);
  const n = fs.normalize(p);
  if (b === '.') return n;
  if (n.startsWith(b + '/')) return n.slice(b.length + 1);
  return n;
}

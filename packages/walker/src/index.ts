/**
 * Gitignore-aware filesystem walker. Operates on a FactsFS so the same
 * walker runs in Node (apps/cli) and the browser (v0.4 Chrome extension).
 *
 * Rules:
 *   - Respects .gitignore + .dockerignore + .cursorignore + .aiignore + .factsignore
 *     (stacked hierarchically; deeper files can override with `!` patterns).
 *   - Always excludes: node_modules, dist, build, .next, .turbo, .cache,
 *     __pycache__, .venv, .git, vendor, target, coverage, .pnpm-store,
 *     .playwright-mcp, playwright-report, test-results.
 *   - Symlink loop detection via visited set of resolved paths.
 *   - Binary sniff: first 8 KB; skip when NUL bytes are frequent (>2, or
 *     dense in a short head). A single stray NUL in otherwise-normal text
 *     does NOT mark the file binary — source files legitimately embed one.
 *   - File size cap: default 1 MB, configurable.
 */

// `ignore` is a CJS package whose default export is a callable factory.
// Under NodeNext + verbatimModuleSyntax (our cli/mcp-server tsconfig)
// `import ignore from 'ignore'` resolves to the namespace object, not the
// callable. Importing as namespace + unwrapping `.default` works in BOTH
// Bundler resolution (used by walker's own build) and NodeNext.
import * as ignoreModule from 'ignore';
import type { Ignore } from 'ignore';
const ignore = ((ignoreModule as unknown as { default?: () => Ignore }).default
  ?? (ignoreModule as unknown as () => Ignore)) as () => Ignore;
import type { Dirent, FactsFS } from '@factstack/spec';

const ALWAYS_EXCLUDE = new Set([
  'node_modules', 'dist', 'build', '.next', '.turbo', '.cache',
  '__pycache__', '.venv', '.git', 'vendor', 'target', 'coverage',
  '.pnpm-store', '.vscode', '.idea',
  /* FACTS's OWN output dir — never analyze our artifacts. Hard-excluded (not
     just via the .gitignore entry analyze writes) so a re-analyze is correct
     even before that entry exists, and so the F8 cache.db + its sqlite
     -wal/-shm sidecars inside .facts/ never pollute the file set or break
     determinism (the WAL files come and go between runs). */
  '.facts',
  /* Test/automation runtime output — surfaced as analyzer noise in
     v0.4 calibration against RallyPro: 80+ YAML trace files from
     .playwright-mcp/ polluted the "other" tier without contributing
     any signal. Same category as .turbo and .cache: produced by
     tooling, not authored. */
  '.playwright-mcp', 'playwright-report', 'test-results',
]);

/**
 * File-name suffixes that are build artifacts / caches the analyzer should
 * never count as source. Surfaces in: file count, activity stream, orphan
 * list, framework detection. The walker drops these before any further
 * processing; downstream consumers (UI, MCP, query) never see them.
 */
const ALWAYS_EXCLUDE_SUFFIXES = [
  '.tsbuildinfo',
  '.tsbuildinfo.json',
];

function isNoiseArtifact(name: string): boolean {
  const lower = name.toLowerCase();
  return ALWAYS_EXCLUDE_SUFFIXES.some((s) => lower.endsWith(s));
}

const IGNORE_FILES = ['.gitignore', '.dockerignore', '.cursorignore', '.aiignore', '.factsignore'];

/** Pause before the single read retry — long enough for an editor save or
 *  AV scan to release the file, short enough to be invisible on the rare
 *  failing file. Only paid on the failure path. */
const READ_RETRY_DELAY_MS = 50;

/* This package compiles against the bare ES lib (no DOM, no @types/node)
 * so the same build runs in Node and the browser. `setTimeout` exists in
 * both runtimes but neither type lib is loaded — declare the one shape
 * we use. */
declare function setTimeout(cb: () => void, ms: number): unknown;

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
  const skipGit = opts.skipGit ?? true;
  const rootNorm = fs.normalize(root);
  const visited = new Set<string>();

  yield* walkDir(fs, rootNorm, rootNorm, ignore(), visited, { maxFileSize, followSymlinks, skipGit });
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
    if (!entry.isDirectory && isNoiseArtifact(entry.name)) continue;
    // Ignore-rule files (.gitignore/.factsignore/…) are consumed for their
    // RULES above — never EMIT them as analysis content. FACTS writes a
    // `.gitignore` itself, so emitting it made re-analysis non-idempotent (the
    // file set grew by one on the 2nd run, shifting graph metrics). Rules still
    // apply; we just don't treat the rule file as a graph node.
    if (!entry.isDirectory && IGNORE_FILES.includes(entry.name)) continue;

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
      // Transient failures are real: an editor mid-save, an antivirus lock
      // (Windows), or an mtime race when the file changed between stat and
      // read. One delayed retry recovers those; a persistent failure falls
      // through to `read_error` so downstream NEVER records the file as
      // read-but-empty.
      text = await new Promise<string | null>((resolve) =>
        setTimeout(() => fs.readText(entry.path).then(resolve, () => resolve(null)), READ_RETRY_DELAY_MS),
      );
      if (text == null) {
        yield synthesizeFile(entry, relToRoot, stat.size, stat.mtimeMs, null, 'read_error');
        continue;
      }
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
  // Sniff up to 8 KB of characters for NUL — but COUNT, don't test
  // presence. Real binary formats (length-prefixed chunks, executables,
  // UTF-16-decoded-as-UTF-8) produce many NULs; source code occasionally
  // embeds a single literal `\0` as a string separator. A real 338-line
  // TS file was misclassified binary — and packed as loc 0 / "ok" —
  // because of ONE legitimate NUL inside a template literal.
  const head = text.slice(0, 8192);
  let nuls = 0;
  for (let i = 0; i < head.length; i++) {
    if (head.charCodeAt(i) === 0) {
      nuls++;
      if (nuls > 2) return true;
    }
  }
  // 1–2 NULs: binary only when they're dense (tiny header-like blobs),
  // text when they're stray characters in thousands of normal ones.
  return nuls > 0 && nuls / head.length > 0.005;
}

function relativeTo(base: string, p: string, fs: FactsFS): string {
  const b = fs.normalize(base);
  const n = fs.normalize(p);
  if (b === '.') return n;
  if (n.startsWith(b + '/')) return n.slice(b.length + 1);
  return n;
}

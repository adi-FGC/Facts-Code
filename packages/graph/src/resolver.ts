/**
 * @factstack/graph — module resolver.
 *
 * Given a specifier string (from an import/require/export-from) and the
 * importing file's project-relative path, return the resolved project path,
 * or null if it resolves to an external module / is unresolvable.
 *
 * Scope for v0.1:
 *   - Relative specifiers ('./foo', '../bar') — probe extensions + index.
 *   - Workspace-local specifiers ('@factstack/spec') — map via workspace
 *     index built from every package.json in the project.
 *   - Bare specifiers with known workspace prefix — same as above.
 *   - Node built-ins ('fs', 'path', 'node:crypto') → null (external).
 *   - Third-party packages ('react', 'zod') → null (external).
 *
 * Isomorphic: no node:path, no fs. Works with POSIX-style paths the walker
 * emits. FactsFS is NOT used — resolution is purely over the in-memory
 * file set.
 */

export interface WorkspacePackage {
  /** package.json `name` (e.g. "@factstack/spec"). */
  name: string;
  /** Project-relative package directory (e.g. "packages/spec"). */
  dir: string;
  /** package.json `main` / `module` / `exports['.']`, project-relative. */
  entry: string | null;
}

export interface ResolverContext {
  /** Every project file path known to the analysis (for existence probing). */
  files: Set<string>;
  /** Workspace packages, indexed by name. */
  workspaces: Map<string, WorkspacePackage>;
}

const CANDIDATE_EXTS = [
  '',
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.json',
];

const INDEX_BASES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];

/** True if the specifier is a relative path. */
export function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

/** True if the specifier references a Node built-in. */
export function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  return NODE_BUILTINS.has(spec);
}

/** Is this importer a Python file? Affects how we resolve specifiers. */
function isPythonPath(p: string): boolean {
  return p.endsWith('.py') || p.endsWith('.pyi');
}

/** Python stdlib modules we shouldn't try to resolve inside the project. */
const PYTHON_STDLIB = new Set([
  'os', 'sys', 're', 'json', 'math', 'datetime', 'time', 'random', 'subprocess',
  'threading', 'asyncio', 'collections', 'functools', 'itertools', 'typing',
  'pathlib', 'hashlib', 'logging', 'argparse', 'io', 'csv', 'sqlite3', 'urllib',
  'http', 'socket', 'tempfile', 'shutil', 'enum', 'abc', 'dataclasses', 'copy',
  'unittest', 'warnings', 'traceback', 'inspect', 'pickle', 'gzip', 'zipfile',
  'tarfile', 'xml', 'html', 'ast', 'token', 'string', 'struct', 'array', 'uuid',
  'secrets', 'statistics', 'decimal', 'fractions', 'numbers', 'operator', 'weakref',
]);

/**
 * Resolve a specifier to a project-relative file path, or null if external
 * / unresolvable. `importerPath` is project-relative (e.g. "packages/core/src/index.ts").
 */
export function resolveSpecifier(
  spec: string,
  importerPath: string,
  ctx: ResolverContext,
): string | null {
  if (isNodeBuiltin(spec)) return null;

  // ── Python path ────────────────────────────────────────────────────────
  if (isPythonPath(importerPath)) {
    return resolvePythonSpecifier(spec, importerPath, ctx);
  }

  if (isRelative(spec)) {
    const baseDir = dirname(importerPath);
    const joined = normalize(baseDir, spec);
    return probe(joined, ctx.files);
  }

  // Workspace package — try longest-prefix match so sub-paths like
  // '@factstack/spec/agent' resolve to packages/spec/src/agent.
  const ws = matchWorkspace(spec, ctx.workspaces);
  if (ws) {
    const rest = spec.slice(ws.name.length).replace(/^\//, '');
    if (!rest) {
      return ws.entry && ctx.files.has(ws.entry)
        ? ws.entry
        : probe(ws.dir + '/src/index', ctx.files) ?? probe(ws.dir + '/index', ctx.files);
    }
    return (
      probe(ws.dir + '/src/' + rest, ctx.files) ??
      probe(ws.dir + '/' + rest, ctx.files)
    );
  }

  return null;
}

function matchWorkspace(spec: string, all: Map<string, WorkspacePackage>): WorkspacePackage | null {
  let best: WorkspacePackage | null = null;
  for (const ws of all.values()) {
    if (spec === ws.name || spec.startsWith(ws.name + '/')) {
      if (!best || ws.name.length > best.name.length) best = ws;
    }
  }
  return best;
}

/**
 * Given a path with no extension (or with one), try every candidate
 * extension + index file, returning the first that exists in `files`.
 */
function probe(base: string, files: Set<string>): string | null {
  // Exact match first
  for (const ext of CANDIDATE_EXTS) {
    const candidate = base + ext;
    if (files.has(candidate)) return candidate;
  }
  // As a directory: try index files inside
  for (const idx of INDEX_BASES) {
    const candidate = base + '/' + idx;
    if (files.has(candidate)) return candidate;
  }
  // Rewrite .js → .ts (common in ESM TS projects)
  if (base.endsWith('.js')) {
    const swapped = base.slice(0, -3) + '.ts';
    if (files.has(swapped)) return swapped;
    const tsx = base.slice(0, -3) + '.tsx';
    if (files.has(tsx)) return tsx;
  }
  return null;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** POSIX-style normalize("packages/core/src", "../../spec") → "packages/spec". */
function normalize(baseDir: string, rel: string): string {
  const parts = baseDir === '' ? [] : baseDir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Resolve a Python specifier. Python uses dotted module names (a.b.c) that
 * map to directories + __init__.py OR individual .py files. Relative
 * imports use leading dots (`from ..utils import x` → "utils" relative to
 * parent's parent).
 *
 * v0.1 covers the common cases: `package/module.py`, `package/__init__.py`,
 * relative leading-dot imports. Namespace packages (PEP 420, dir with no
 * __init__) also resolve when a matching directory exists.
 */
function resolvePythonSpecifier(
  spec: string,
  importerPath: string,
  ctx: ResolverContext,
): string | null {
  if (PYTHON_STDLIB.has(spec.split('.')[0] ?? '')) return null;

  // Relative imports: leading-dot count controls how many levels to climb.
  if (spec.startsWith('.')) {
    const leading = /^\.+/.exec(spec)?.[0] ?? '';
    const rest = spec.slice(leading.length);
    const dir = dirname(importerPath);
    const parts = dir === '' ? [] : dir.split('/');
    // N dots → climb N-1 levels (single dot = same pkg).
    for (let i = 0; i < leading.length - 1; i++) parts.pop();
    const restParts = rest ? rest.split('.').filter(Boolean) : [];
    const base = [...parts, ...restParts].join('/');
    return probePy(base, ctx.files);
  }

  // Absolute (project-root-relative) dotted import.
  const base = spec.split('.').filter(Boolean).join('/');
  if (!base) return null;
  // Python imports resolve against sys.path; we approximate by walking
  // candidate roots: project root, any dir with a pyproject.toml or setup.py.
  const hit = probePy(base, ctx.files);
  if (hit) return hit;
  // Try from packages/__init__ style dirs
  for (const p of ctx.files) {
    if (p.endsWith('/' + base + '.py') || p.endsWith('/' + base + '/__init__.py')) return p;
  }
  return null;
}

function probePy(base: string, files: Set<string>): string | null {
  if (files.has(base + '.py')) return base + '.py';
  if (files.has(base + '/__init__.py')) return base + '/__init__.py';
  // Namespace package (PEP 420) — accept the dir itself as the "landing"
  // if any .py file lives inside it.
  const prefix = base + '/';
  for (const p of files) {
    if (p.startsWith(prefix) && p.endsWith('.py')) return p;
  }
  return null;
}

/** Builds a workspace index from every package.json file seen during walk. */
export function buildWorkspaceIndex(
  packageJsons: Array<{ path: string; text: string }>,
): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>();
  for (const { path: p, text } of packageJsons) {
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const name = json?.name;
    if (typeof name !== 'string' || !name) continue;
    const dir = dirname(p);
    const mainRaw = (json.module as string) || (json.main as string) || null;
    let entry: string | null = null;
    if (typeof mainRaw === 'string') {
      const cleaned = mainRaw.replace(/^\.\//, '');
      entry = cleaned ? (dir ? dir + '/' + cleaned : cleaned) : null;
    }
    out.set(name, { name, dir, entry });
  }
  return out;
}

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'stream/promises', 'stream/web', 'string_decoder', 'sys',
  'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url',
  'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  'sqlite',
]);

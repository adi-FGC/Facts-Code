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
  /**
   * tsconfig `paths` alias rules (root-relative targets), built once by
   * {@link buildAliasIndex}. Optional — a repo with no path aliases omits it.
   * Lets bare specifiers like `@lib/foo` resolve to internal files instead of
   * being dropped as "external".
   */
  aliases?: AliasRule[];
  /**
   * F6 — Go modules declared by the repo's go.mod files: the `module` name +
   * the root-relative directory containing that go.mod ('' for repo root).
   * Lets module-absolute Go imports ("example.com/shop/internal/auth")
   * resolve to project packages. Optional — non-Go repos omit it.
   */
  goModules?: Array<{ module: string; dir: string }>;
}

/**
 * A tsconfig `paths` alias rule, pre-resolved to repo-root-relative targets.
 *
 * `"@lib/*": ["src/lib/*"]` in `apps/web/tsconfig.json` (baseUrl `.`) →
 *   { prefix: '@lib/', suffix: '', wildcard: true,
 *     targets: ['apps/web/src/lib/*'], scope: 'apps/web' }
 */
export interface AliasRule {
  /** Literal text before the `*` (or the whole pattern when `wildcard` is false). */
  prefix: string;
  /** Literal text after the `*` (`''` when terminal; unused when not a wildcard). */
  suffix: string;
  /** Whether the source pattern contained a single `*` wildcard. */
  wildcard: boolean;
  /** Target templates, repo-root-relative, each with at most one `*`. */
  targets: string[];
  /**
   * The tsconfig's own directory (repo-relative; `''` = root). A rule only
   * applies to importing files within this subtree, so two packages can each
   * define `@lib/*` without colliding.
   */
  scope?: string;
}

const CANDIDATE_EXTS = [
  '',
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.json',
  /* v0.4.6 — framework component formats. Astro/Vue/Svelte all use
     relative imports of their own file type (`import Foo from './Foo.astro'`)
     AND extensionless imports that should fall through to a .astro/.vue/
     .svelte sibling. Without these, the Astro frontmatter extractor
     produces specifiers but the graph still misses the edges. */
  '.astro', '.vue', '.svelte',
];

const INDEX_BASES = [
  'index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs',
  /* Match the CANDIDATE_EXTS expansion — some Astro/Vue projects ship
     barrel files as index.astro etc. Rare but cheap to support. */
  'index.astro', 'index.vue', 'index.svelte',
];

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

/** Is this importer a Go file? Affects how we resolve specifiers. */
function isGoPath(p: string): boolean {
  return p.endsWith('.go');
}

/**
 * F6 — resolve a Go import path within the repo. Go imports are
 * module-absolute ("example.com/shop/internal/auth"): a specifier resolves
 * internally when it extends a module name declared by one of the repo's
 * go.mod files. The import target is a PACKAGE (a directory), but the
 * dependency graph is file-level — so we resolve to the package's
 * lexicographically-first non-test .go file as its stable representative.
 * Deterministic, and exactly right for "which package does this file depend
 * on" edges. Anything not under a known module (stdlib "fmt", third-party
 * modules) is external → null, same as npm packages.
 */
function resolveGoSpecifier(spec: string, ctx: ResolverContext): string | null {
  for (const m of ctx.goModules ?? []) {
    let rel: string | null = null;
    if (spec === m.module) rel = '';
    else if (spec.startsWith(m.module + '/')) rel = spec.slice(m.module.length + 1);
    if (rel === null) continue;
    const dir = m.dir ? (rel ? `${m.dir}/${rel}` : m.dir) : rel;
    const prefix = dir ? dir + '/' : '';
    let best: string | null = null;
    for (const f of ctx.files) {
      if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (rest.includes('/')) continue; // a package is exactly one directory deep
      if (best === null || f < best) best = f;
    }
    if (best) return best;
  }
  return null;
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

  // ── Go path (F6) ─────────────────────────────────────────────────────────
  if (isGoPath(importerPath)) {
    return resolveGoSpecifier(spec, ctx);
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

  // tsconfig `paths` alias (e.g. `@lib/foo` → `apps/web/src/lib/foo.ts`).
  // Tried after workspace matching, before declaring the import external —
  // otherwise every aliased import silently loses its graph edge.
  const aliased = resolveAlias(spec, importerPath, ctx);
  if (aliased) return aliased;

  return null;
}

/**
 * Resolve a bare specifier through tsconfig `paths` aliases. Only rules whose
 * scope governs `importerPath` apply, nearest tsconfig (longest scope) first.
 * Returns the resolved project path, or null if no rule resolves.
 */
export function resolveAlias(
  spec: string,
  importerPath: string,
  ctx: ResolverContext,
): string | null {
  const rules = ctx.aliases;
  if (!rules || rules.length === 0) return null;
  const applicable = rules
    .filter((r) => aliasInScope(r, importerPath))
    .sort((a, b) => (b.scope?.length ?? 0) - (a.scope?.length ?? 0));

  for (const rule of applicable) {
    let star = '';
    if (rule.wildcard) {
      if (spec.length < rule.prefix.length + rule.suffix.length) continue;
      if (!spec.startsWith(rule.prefix)) continue;
      if (rule.suffix !== '' && !spec.endsWith(rule.suffix)) continue;
      star = spec.slice(rule.prefix.length, spec.length - rule.suffix.length);
    } else if (spec !== rule.prefix) {
      continue;
    }
    for (const target of rule.targets) {
      const candidate = rule.wildcard ? target.replace('*', star) : target;
      const hit = probe(candidate, ctx.files);
      if (hit) return hit;
    }
  }
  return null;
}

/** Whether an alias rule governs the importing file (by scope subtree). */
function aliasInScope(rule: AliasRule, importerPath: string): boolean {
  const scope = rule.scope;
  if (scope === undefined || scope === '') return true;
  return importerPath === scope || importerPath.startsWith(`${scope}/`);
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

/**
 * Build the alias index from every tsconfig/jsconfig seen during the walk.
 * Mirrors {@link buildWorkspaceIndex}: same `{ path, text }` input shape.
 * Resolves `baseUrl` + each `paths` entry against the tsconfig's own dir, so
 * the returned targets are all repo-root-relative.
 *
 * Known limitation (documented, not silent): `extends` chains are NOT
 * followed — only `paths`/`baseUrl` declared directly in the file are honored.
 */
export function buildAliasIndex(
  tsconfigs: Array<{ path: string; text: string }>,
): AliasRule[] {
  const rules: AliasRule[] = [];
  for (const { path: p, text } of tsconfigs) {
    const parsed = parseTsconfigJson(text);
    const opts = parsed?.compilerOptions;
    const pathsRaw = opts?.paths;
    if (!pathsRaw || typeof pathsRaw !== 'object') continue;

    const tsconfigDir = dirname(p);
    const baseUrl = typeof opts?.baseUrl === 'string' ? opts.baseUrl : '.';
    // `paths` resolve relative to baseUrl, which is relative to the tsconfig
    // dir. Absent baseUrl ⇒ relative to the tsconfig dir (baseUrl === '.').
    const effectiveBase = normalize(tsconfigDir, baseUrl);

    for (const [pattern, targetsRaw] of Object.entries(pathsRaw as Record<string, unknown>)) {
      if (!Array.isArray(targetsRaw)) continue;
      const stars = pattern.split('*');
      if (stars.length > 2) continue; // TS allows at most one `*`
      const wildcard = stars.length === 2;
      const prefix = wildcard ? stars[0]! : pattern;
      const suffix = wildcard ? stars[1]! : '';

      const targets: string[] = [];
      for (const t of targetsRaw) {
        if (typeof t !== 'string') continue;
        if (t.split('*').length > 2) continue;
        // normalize() preserves `*` (an ordinary path segment char).
        targets.push(normalize(effectiveBase, t));
      }
      if (targets.length > 0) rules.push({ prefix, suffix, wildcard, targets, scope: tsconfigDir });
    }
  }
  return rules;
}

interface TsconfigShape {
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

/** Tolerantly parse tsconfig JSONC (comments + trailing commas allowed). */
function parseTsconfigJson(text: string): TsconfigShape | null {
  try {
    const v = JSON.parse(stripJsonc(text)) as unknown;
    return v && typeof v === 'object' ? (v as TsconfigShape) : null;
  } catch {
    return null;
  }
}

/**
 * Strip `//` line comments, block comments, and trailing commas from JSONC,
 * leaving comment-like sequences inside string literals untouched.
 */
function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
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

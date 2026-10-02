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
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  /* v0.4.6 — framework component formats. Astro/Vue/Svelte all use
     relative imports of their own file type (`import Foo from './Foo.astro'`)
     AND extensionless imports that should fall through to a .astro/.vue/
     .svelte sibling. Without these, the Astro frontmatter extractor
     produces specifiers but the graph still misses the edges. */
  '.astro',
  '.vue',
  '.svelte',
];

const INDEX_BASES = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  /* Match the CANDIDATE_EXTS expansion — some Astro/Vue projects ship
     barrel files as index.astro etc. Rare but cheap to support. */
  'index.astro',
  'index.vue',
  'index.svelte',
];

/** True if the specifier is a relative path. */
export function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

/**
 * Strip a bundler query / hash suffix (`./x.md?raw`, `./w.ts?worker&url`,
 * `./a.svg#frag`) so the specifier names the real file. A leading `#` is
 * kept: that is a Node subpath import (`#internal/x`), not a fragment.
 */
export function stripSpecifierQuery(spec: string): string {
  const i = spec.slice(1).search(/[?#]/);
  return i < 0 ? spec : spec.slice(0, i + 1);
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
 * Lookup tables over one file set, built once and reused for every import.
 * Python and Go resolution used to scan the whole set per import, so a run
 * cost files × imports (≈2 ms per third-party Python import at 20k files).
 * Cached per Set instance; rebuilt if the set's size changes.
 */
interface FileIndex {
  size: number;
  /** Python: every dotted-module path suffix that starts after a `/`
   *  ('b/c' and 'c' for x/b/c.py; 'b' for x/b/__init__.py) → the SHORTEST
   *  such file (ties by code unit), for sys.path roots below the root. */
  pySuffix: Map<string, string>;
  /** Python: directory → a .py file somewhere beneath it (code-unit first),
   *  the landing file for a PEP 420 namespace package. */
  pyUnder: Map<string, string>;
  /** Go: package directory → its code-unit-first non-test .go file. */
  goByDir: Map<string, string>;
}

const INDEX_CACHE = new WeakMap<Set<string>, FileIndex>();

const shorterPath = (a: string, b: string | undefined): boolean =>
  b === undefined || a.length < b.length || (a.length === b.length && a < b);

function indexFor(files: Set<string>): FileIndex {
  const cached = INDEX_CACHE.get(files);
  if (cached && cached.size === files.size) return cached;
  const idx: FileIndex = {
    size: files.size,
    pySuffix: new Map(),
    pyUnder: new Map(),
    goByDir: new Map(),
  };
  for (const f of files) {
    if (f.endsWith('.py')) {
      const mod = f.endsWith('/__init__.py') ? f.slice(0, -'/__init__.py'.length) : f.slice(0, -3);
      for (let i = mod.indexOf('/'); i >= 0; i = mod.indexOf('/', i + 1)) {
        const suffix = mod.slice(i + 1);
        if (shorterPath(f, idx.pySuffix.get(suffix))) idx.pySuffix.set(suffix, f);
      }
      for (let d = dirname(f); d !== ''; d = dirname(d)) {
        const cur = idx.pyUnder.get(d);
        if (cur === undefined || f < cur) idx.pyUnder.set(d, f);
      }
    } else if (f.endsWith('.go') && !f.endsWith('_test.go')) {
      const d = dirname(f);
      const cur = idx.goByDir.get(d);
      if (cur === undefined || f < cur) idx.goByDir.set(d, f);
    }
  }
  INDEX_CACHE.set(files, idx);
  return idx;
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
    // A package is exactly one directory: its files sit directly inside it.
    const best = indexFor(ctx.files).goByDir.get(dir);
    if (best) return best;
  }
  return null;
}

/**
 * Python stdlib modules we shouldn't try to resolve inside the project.
 * Matched against the FIRST dotted segment (`spec.split('.')[0]`), so
 * `import os.path` / `xml.etree` / `concurrent.futures` are covered by
 * 'os' / 'xml' / 'concurrent'. A comprehensive top-level list matters: a
 * project file that shadows a stdlib name (e.g. a root `glob.py`) would
 * otherwise capture `import glob` and emit a false internal dependency edge,
 * polluting cycle detection + health metrics deterministically.
 */
const PYTHON_STDLIB = new Set([
  // core runtime / language services
  '__future__',
  'builtins',
  'sys',
  'os',
  'io',
  'time',
  'types',
  'typing',
  'abc',
  'gc',
  'inspect',
  'atexit',
  'traceback',
  'warnings',
  'contextlib',
  'contextvars',
  'dataclasses',
  'enum',
  'weakref',
  'copy',
  'copyreg',
  'pickle',
  'pickletools',
  'marshal',
  'importlib',
  'pkgutil',
  'modulefinder',
  'runpy',
  'keyword',
  'token',
  'tokenize',
  'ast',
  'symtable',
  'dis',
  'code',
  'codeop',
  'sysconfig',
  'site',
  // data structures / numeric / functional
  'collections',
  'functools',
  'itertools',
  'operator',
  'heapq',
  'bisect',
  'array',
  'queue',
  'graphlib',
  'numbers',
  'decimal',
  'fractions',
  'statistics',
  'math',
  'cmath',
  'random',
  'secrets',
  // text / binary / serialization
  're',
  'string',
  'stringprep',
  'textwrap',
  'unicodedata',
  'struct',
  'codecs',
  'difflib',
  'pprint',
  'reprlib',
  'locale',
  'gettext',
  'base64',
  'binascii',
  'quopri',
  'json',
  'csv',
  'html',
  'xml',
  'configparser',
  'tomllib',
  'netrc',
  'plistlib',
  // dates / scheduling
  'datetime',
  'calendar',
  'zoneinfo',
  'sched',
  // filesystem / os services
  'pathlib',
  'glob',
  'fnmatch',
  'linecache',
  'fileinput',
  'stat',
  'filecmp',
  'shutil',
  'tempfile',
  'errno',
  'getopt',
  'argparse',
  'getpass',
  'platform',
  'ctypes',
  'mmap',
  'shlex',
  'signal',
  'selectors',
  'select',
  // compression / archives / persistence
  'zlib',
  'gzip',
  'bz2',
  'lzma',
  'zipfile',
  'tarfile',
  'zipapp',
  'dbm',
  'shelve',
  'sqlite3',
  // concurrency / subprocess
  'threading',
  '_thread',
  'multiprocessing',
  'concurrent',
  'subprocess',
  'asyncio',
  // networking / IPC / internet protocols
  'socket',
  'ssl',
  'socketserver',
  'http',
  'urllib',
  'ftplib',
  'poplib',
  'imaplib',
  'smtplib',
  'telnetlib',
  'uuid',
  'ipaddress',
  'email',
  'mailbox',
  'mimetypes',
  'xmlrpc',
  'wsgiref',
  'webbrowser',
  'cgi',
  'cgitb',
  // crypto / hashing
  'hashlib',
  'hmac',
  // logging / debug / test / profiling
  'logging',
  'unittest',
  'doctest',
  'pdb',
  'bdb',
  'faulthandler',
  'trace',
  'tracemalloc',
  'timeit',
  'profile',
  'cProfile',
  'pstats',
  'py_compile',
  'compileall',
  'venv',
  'ensurepip',
  // unix-only stdlib (still stdlib names to treat as external)
  'pwd',
  'grp',
  'fcntl',
  'termios',
  'tty',
  'pty',
  'resource',
  'syslog',
  'posix',
  // stdlib UI / interactive
  'tkinter',
  'turtle',
  'curses',
  'cmd',
  'readline',
  'rlcompleter',
]);

/**
 * Resolve a specifier to a project-relative file path, or null if external
 * / unresolvable. `importerPath` is project-relative (e.g. "packages/core/src/index.ts").
 */
export function resolveSpecifier(
  rawSpec: string,
  importerPath: string,
  ctx: ResolverContext,
): string | null {
  if (isNodeBuiltin(rawSpec)) return null;

  // ── Python path ────────────────────────────────────────────────────────
  if (isPythonPath(importerPath)) {
    return resolvePythonSpecifier(rawSpec, importerPath, ctx);
  }

  // ── Go path (F6) ─────────────────────────────────────────────────────────
  if (isGoPath(importerPath)) {
    return resolveGoSpecifier(rawSpec, ctx);
  }

  // `./x.yaml?raw` (Vite) imports x.yaml — the edge goes to the real file.
  const spec = stripSpecifierQuery(rawSpec);

  if (isRelative(spec)) {
    const baseDir = dirname(importerPath);
    const joined = normalize(baseDir, spec);
    if (joined === null) return null; // relative import escapes the project root → not resolvable in-tree
    return probe(joined, ctx.files);
  }

  // Workspace package — try longest-prefix match so sub-paths like
  // '@factstack/spec/agent' resolve to packages/spec/src/agent.
  const ws = matchWorkspace(spec, ctx.workspaces);
  if (ws) {
    const rest = spec.slice(ws.name.length).replace(/^\//, '');
    // The root package has dir '' — no leading slash, or nothing matches.
    const base = ws.dir ? ws.dir + '/' : '';
    if (!rest) {
      return (
        (ws.entry ? entrySource(ws.entry, base, ctx.files) : null) ??
        probe(base + 'src/index', ctx.files) ??
        probe(base + 'index', ctx.files)
      );
    }
    return probe(base + 'src/' + rest, ctx.files) ?? probe(base + rest, ctx.files);
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

/** Whether an alias rule governs the importing file (by scope subtree).
 *  Exported so callers that ask "should this specifier have resolved?" share the
 *  exact scope semantics resolveAlias uses to decide "did it resolve?" — keeping
 *  the two in lockstep (a drift here once produced false-positive broken-import
 *  risks in scoped-alias monorepos). */
export function aliasInScope(rule: AliasRule, importerPath: string): boolean {
  const scope = rule.scope;
  if (scope === undefined || scope === '') return true;
  return importerPath === scope || importerPath.startsWith(`${scope}/`);
}

/** A package.json entry as a scanned source file. The walker never scans
 *  build output, so `main: ./dist/index.js` maps to `src/index.*`. */
function entrySource(entry: string, base: string, files: Set<string>): string | null {
  if (files.has(entry)) return entry;
  const built = /^(?:dist|lib|build|out)\/(.+?)(?:\.d)?\.[cm]?[jt]s$/.exec(
    entry.slice(base.length),
  );
  return built && entry.startsWith(base) ? probe(base + 'src/' + built[1], files) : null;
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

/** POSIX-style normalize("packages/core/src", "../../spec") → "packages/spec".
 *  Returns null when the path escapes the project root (more `..` than depth) —
 *  the caller must NOT fabricate an in-project edge for a target outside the
 *  tree. Previously the over-bounds `..` was silently swallowed, mapping e.g.
 *  `../../../../x` to a phantom root-relative file. */
function normalize(baseDir: string, rel: string): string | null {
  const parts = baseDir === '' ? [] : baseDir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // escaped the root
      parts.pop();
    } else parts.push(seg);
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
  return locatePython(spec, importerPath, ctx).file;
}

/** Where a Python module name lands. `file` is the project file (what
 *  resolveSpecifier returns); `dir` is the directory its submodules live
 *  in — the package's `__init__.py` dir or the namespace dir — and null for
 *  a plain module or an unresolved name. */
interface PyTarget {
  file: string | null;
  dir: string | null;
}

const PY_NONE: PyTarget = { file: null, dir: null };

function locatePython(spec: string, importerPath: string, ctx: ResolverContext): PyTarget {
  if (PYTHON_STDLIB.has(spec.split('.')[0] ?? '')) return PY_NONE;
  const idx = indexFor(ctx.files);
  const importerDir = dirname(importerPath);

  // Relative imports: leading-dot count controls how many levels to climb.
  if (spec.startsWith('.')) {
    const leading = /^\.+/.exec(spec)?.[0] ?? '';
    const rest = spec.slice(leading.length);
    const parts = importerDir === '' ? [] : importerDir.split('/');
    // N dots → climb N-1 levels (single dot = same pkg).
    for (let i = 0; i < leading.length - 1; i++) parts.pop();
    const restParts = rest ? rest.split('.').filter(Boolean) : [];
    const base = [...parts, ...restParts].join('/');
    return probePy(base, ctx.files, idx, importerDir);
  }

  // Absolute dotted import. Python resolves it against sys.path; we
  // approximate with an ordered list of candidate roots (pythonSearchDirs),
  // then any deeper root (src/ layouts, other services), preferring the
  // shortest matching path — never an arbitrary walk-order hit. A nearer
  // namespace package that holds the importer (no file to land on) still
  // beats a same-named package in another service.
  const base = spec.split('.').filter(Boolean).join('/');
  if (!base) return PY_NONE;
  let near: PyTarget | null = null;
  for (const dir of pythonSearchDirs(importerDir, ctx.files)) {
    const hit = probePy(dir ? dir + '/' + base : base, ctx.files, idx, importerDir);
    if (hit.file) return hit;
    if (hit.dir !== null) near ??= hit;
  }
  if (near) return near;
  const far = idx.pySuffix.get(base);
  if (!far) return PY_NONE;
  return { file: far, dir: far.endsWith('/__init__.py') ? dirname(far) : null };
}

/**
 * Where an absolute import from `importerDir` is looked up, in order.
 *
 *  - Not inside any regular package (no `__init__.py` at or above the
 *    importer, below the root): nearest-first — the importer's own dir (a
 *    script's sys.path[0], so a sibling `helpers.py` wins), then each
 *    ancestor up to the project root.
 *  - Inside a regular package, audit correctness#4: Python 3 has no
 *    implicit relative import, and a package's own dirs are not on sys.path
 *    — `import utils` in pkg/mod.py never loads pkg/utils.py. The sys.path
 *    entry that CAN hold the importer's top-most package is that package's
 *    parent (`pkgRoot`), so: pkgRoot and its ancestors first (services/a
 *    before the root for services/a/app/*.py, the same answer a script in
 *    services/a gets — review CG-R1), then the project root, and only then
 *    the in-package dirs, nearest-first (a last resort for sys.path tweaks,
 *    still before a far match).
 *  - A namespace dir (no `__init__.py`) nested in a regular package (review
 *    CG-R3) keeps its OWN dir first — run as a script or collected by
 *    pytest it is sys.path[0] — but the enclosing package's dirs still come
 *    after pkgRoot and the root, as above.
 */
function pythonSearchDirs(importerDir: string, files: Set<string>): string[] {
  // `from` and each ancestor, stopping BEFORE `stop` (or after the root '').
  const climb = (from: string, stop: string | null): string[] => {
    const dirs: string[] = [];
    for (let dir = from; dir !== stop; dir = dirname(dir)) {
      dirs.push(dir);
      if (dir === '') break;
    }
    return dirs;
  };
  // The project root is never treated as a package (it is the outermost
  // sys.path entry).
  const isPkg = (dir: string): boolean => dir !== '' && files.has(dir + '/__init__.py');
  let pkg = importerDir; // nearest regular package at or above the importer
  while (pkg !== '' && !isPkg(pkg)) pkg = dirname(pkg);
  if (pkg === '') return climb(importerDir, null);
  let top = pkg; // climb while the parent is a regular package too
  while (isPkg(dirname(top))) top = dirname(top);
  const pkgRoot = dirname(top);
  const outer = [...climb(pkgRoot, ''), ''];
  if (pkg === importerDir) return [...outer, ...climb(importerDir, pkgRoot)];
  return [importerDir, ...outer, ...climb(dirname(importerDir), pkgRoot)];
}

function probePy(base: string, files: Set<string>, idx: FileIndex, importerDir: string): PyTarget {
  if (files.has(base + '.py')) return { file: base + '.py', dir: null };
  if (files.has(base + '/__init__.py')) return { file: base + '/__init__.py', dir: base };
  // Namespace package (PEP 420) — land on a .py file inside the dir. Not
  // for the importer's own package or an ancestor of it: every file there
  // is the importer itself or a sibling, so the "edge" would be made up
  // (`from . import c` landing on an unrelated a.py). Its submodules are
  // still real, so the dir is kept.
  if (base === '' || base === importerDir || importerDir.startsWith(base + '/')) {
    return { file: null, dir: base };
  }
  const under = idx.pyUnder.get(base);
  return under ? { file: under, dir: base } : PY_NONE;
}

/**
 * Every project file one import statement depends on. A Python
 * `from X import a, b` may name SUBMODULES: `from . import utils` imports
 * pkg/utils.py, not the package. X is located first (pythonSearchDirs); a
 * member is a submodule only when it sits INSIDE X's package directory —
 * never a same-named path elsewhere in the repo. The package X itself is a
 * target when some member is not a submodule. Everything else resolves its
 * specifier alone. The first entry is the import's primary target (what
 * `imports[].resolved` reports).
 */
export function resolveImportTargets(
  imp: { specifier: string; members?: string[] | undefined },
  importerPath: string,
  ctx: ResolverContext,
): string[] {
  const members = imp.members;
  if (!members?.length || !isPythonPath(importerPath)) {
    const to = resolveSpecifier(imp.specifier, importerPath, ctx);
    return to ? [to] : [];
  }
  const out: string[] = [];
  let needPackage = false;
  const pkg = locatePython(imp.specifier, importerPath, ctx);
  const idx = indexFor(ctx.files);
  const importerDir = dirname(importerPath);
  for (const m of members) {
    if (m === '*') {
      needPackage = true; // the package itself is imported too
      continue;
    }
    const sub =
      pkg.dir === null
        ? null
        : probePy(pkg.dir ? `${pkg.dir}/${m}` : m, ctx.files, idx, importerDir).file;
    if (!sub) needPackage = true;
    else if (!out.includes(sub)) out.push(sub);
  }
  // A row that began as `import X` keeps the package as its primary target.
  if (needPackage && pkg.file && !out.includes(pkg.file)) {
    if (members[0] === '*') out.unshift(pkg.file);
    else out.push(pkg.file);
  }
  return out;
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
export function buildAliasIndex(tsconfigs: Array<{ path: string; text: string }>): AliasRule[] {
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
    if (effectiveBase === null) continue; // degenerate baseUrl escaping the root

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
        // normalize() preserves `*` (an ordinary path segment char); null = the
        // target escapes the root, so skip it rather than push a phantom path.
        const nt = normalize(effectiveBase, t);
        if (nt !== null) targets.push(nt);
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
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  'sqlite',
]);

/**
 * Query engine for the MCP `query_graph` tool + the CLI `factstack query`
 * subcommand. Pure data manipulation over a cached AgentArtifact — no
 * I/O, no mutation. Same verb set (`callers`, `imports`, `cycles`,
 * `orphans`) drives both entry points so behavior can't drift.
 */

import type { AgentArtifact, QueryVerb } from '@factstack/spec';

export interface QueryResult {
  verb: QueryVerb;
  target?: string;
  count: number;
  results: unknown;
}

export interface QueryOptions {
  verb: QueryVerb;
  path?: string;
  filter?: string;     // glob-style, falls back to substring
  limit?: number;
  depth?: number;
}

export function executeQuery(agent: AgentArtifact, opts: QueryOptions): QueryResult {
  const limit = opts.limit ?? 200;

  switch (opts.verb) {
    case 'callers':   return callersOf(agent, opts.path ?? '', limit, opts.filter);
    case 'imports':   return importsOf(agent, opts.path ?? '', limit, opts.filter, opts.depth ?? 1);
    case 'cycles':    return allCycles(agent, limit, opts.filter);
    case 'orphans':   return allOrphans(agent, limit, opts.filter);
  }
}

function callersOf(agent: AgentArtifact, path: string, limit: number, filter?: string): QueryResult {
  if (!path) return { verb: 'callers', target: path, count: 0, results: [] };
  // Prefer the cached `callers` on the graph node (v0.2 addition); fall
  // back to walking edges for older artifacts.
  const node = agent.graph.nodes.find((n) => n.path === path);
  let callers = Array.isArray(node?.callers)
    ? [...node!.callers]
    : agent.graph.edges.filter((e) => e.to === path).map((e) => e.from);
  if (filter) callers = callers.filter((p) => matches(p, filter));
  callers.sort();
  return {
    verb: 'callers',
    target: path,
    count: callers.length,
    results: callers.slice(0, limit),
  };
}

function importsOf(agent: AgentArtifact, path: string, limit: number, filter?: string, depth = 1): QueryResult {
  if (!path) return { verb: 'imports', target: path, count: 0, results: [] };
  // Breadth-first traversal of outgoing edges up to `depth` levels.
  // Build an adjacency map once so each depth pass is O(E_from_frontier)
  // instead of O(E_total). The previous version kept accumulating the
  // frontier instead of replacing it — O(depth × V × E) on large repos.
  const adj = new Map<string, string[]>();
  for (const e of agent.graph.edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to); else adj.set(e.from, [e.to]);
  }
  const visited = new Set<string>([path]);
  let frontier: string[] = [path];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const from of frontier) {
      const outs = adj.get(from);
      if (!outs) continue;
      for (const to of outs) {
        if (!visited.has(to)) {
          visited.add(to);
          next.push(to);
        }
      }
    }
    if (!next.length) break;
    frontier = next;                           // replace — don't accumulate
  }
  visited.delete(path);
  let out = [...visited];
  if (filter) out = out.filter((p) => matches(p, filter));
  out.sort();
  return { verb: 'imports', target: path, count: out.length, results: out.slice(0, limit) };
}

function allCycles(agent: AgentArtifact, limit: number, filter?: string): QueryResult {
  let cycles = agent.graph.cycles.map((c) => [...c]);
  if (filter) cycles = cycles.filter((c) => c.some((p) => matches(p, filter)));
  return { verb: 'cycles', count: cycles.length, results: cycles.slice(0, limit) };
}

function allOrphans(agent: AgentArtifact, limit: number, filter?: string): QueryResult {
  // A file is an "orphan" if it has no incoming edges AND participates in
  // the import graph at all. Three prior surprises we filter:
  //
  //  1. Manifests + dotfiles (package.json, tsconfig.json, .gitignore) were
  //     reported as orphans because they live in `graph.nodes`, even though
  //     they don't participate in JS/TS import edges. CXOs and AI agents
  //     reading the artifact see "package.json is orphan" and waste a
  //     query trying to figure out what's wrong. → `isSourceModule` filter.
  //
  //  2. Genuine entrypoints (src/cli.ts, app/page.tsx, etc.) have zero
  //     incoming edges by definition. They're not "dead code" — they're
  //     reached by the runtime, not by another module's import. We
  //     suppress them by checking `agent.project.entryPoints` and the
  //     declared route handler files.
  //
  //  3. Test files (vitest, jest, pytest) have zero JS-import callers
  //     because the runner invokes them via filesystem glob, not via
  //     import. Listing them as orphans makes "0 dead code" projects
  //     look noisy. → `isTestPath` filter.
  //
  // The escape hatch is still `filter` for callers who want the wider
  // set (e.g. a security audit might want every uncalled file). If you
  // want test files included, pass `--filter '*test*'` and they're back.
  const incoming = new Set(agent.graph.edges.map((e) => e.to));
  const outgoing = new Set(agent.graph.edges.map((e) => e.from));
  const entryPaths = new Set([
    ...agent.project.entryPoints,
    ...agent.routes.map((r) => r.handlerFile).filter(Boolean) as string[],
  ]);
  let orphans = agent.graph.nodes
    .filter((n) => isSourceModule(n.path, n.language))
    .filter((n) => !isTestPath(n.path))
    .filter((n) => !incoming.has(n.path))
    .filter((n) => !entryPaths.has(n.path))
    // True orphans should at minimum have an outgoing import — a leaf
    // node with no edges at all is most likely a config file we missed
    // classifying. If you want pure leaves, pass `--filter '*'`.
    .filter((n) => outgoing.has(n.path))
    .map((n) => n.path);
  if (filter) orphans = orphans.filter((p) => matches(p, filter));
  orphans.sort();
  return { verb: 'orphans', count: orphans.length, results: orphans.slice(0, limit) };
}

/**
 * Path-shape predicate for "this file is a test, not application code."
 * Mirrors the route extractor's `isTestOrFixturePath` but inlined here
 * to keep `@factstack/core` from depending on `@factstack/extractors`
 * (currently a one-way dep). Catches:
 *
 *   - `*.test.*` / `*.spec.*` (vitest, jest, mocha)
 *   - `__tests__/`, `__test__/` (jest convention)
 *   - `tests/`, `test/` (pytest, go test, cargo test convention)
 *   - `cypress/integration/`, `e2e/`, `playwright/` (e2e suites)
 *   - `examples/`, `fixtures/` (sample/golden code)
 *
 * If your test layout differs, pass `--filter` to override on the CLI.
 */
function isTestPath(p: string): boolean {
  const n = p.toLowerCase().replace(/\\/g, '/');
  if (/(?:^|\/)(?:__tests__|__test__|tests|test|cypress|e2e|playwright|examples|fixtures)\//.test(n)) return true;
  if (/\.(test|spec)\.[a-z]+$/.test(n)) return true;
  return false;
}

/**
 * True if a graph node is an importable source module. Excludes manifests
 * (package.json, tsconfig.json), dotfiles (.gitignore, .editorconfig),
 * and lockfiles. We use `language` from the analyzer when present and
 * fall back to extension matching.
 */
function isSourceModule(path: string, language: string): boolean {
  const lang = language.toLowerCase();
  if (['typescript', 'javascript', 'tsx', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'ruby', 'php', 'svelte', 'vue'].includes(lang)) return true;
  if (lang === 'json' || lang === 'yaml' || lang === 'toml' || lang === 'markdown' || lang === 'html' || lang === 'css' || lang === 'gitignore' || lang === 'dockerignore') return false;
  // Fallback: look at the extension.
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.svelte', '.vue'].includes(ext);
}

/**
 * Simple glob → regex converter, or plain substring match when the
 * pattern has no glob chars. Supports `*` and `?` only; anything more
 * complex is beyond v0.2's needs.
 */
function matches(s: string, pattern: string): boolean {
  if (!pattern) return true;
  if (!/[*?]/.test(pattern)) return s.includes(pattern);
  const re = new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.') + '$',
  );
  return re.test(s);
}

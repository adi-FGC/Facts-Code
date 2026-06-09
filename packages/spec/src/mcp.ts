/**
 * MCP resource + tool surface for the FACTS analyzer.
 *
 * v0.1 sketches this shape so the CLI's command vocabulary aligns with
 * what the v0.5 MCP server will expose. When the server ships, it becomes
 * a thin adapter over @factstack/core rather than a re-design.
 */

import { z } from 'zod';
import { ConfidenceSchema } from './agent.js';

export const FACTS_MCP_URI_SCHEME = 'facts' as const;

export const McpResourceUris = {
  project: `${FACTS_MCP_URI_SCHEME}://project` as const,
  file: (path: string) => `${FACTS_MCP_URI_SCHEME}://file/${path}` as const,
  graph: `${FACTS_MCP_URI_SCHEME}://graph` as const,
  routes: `${FACTS_MCP_URI_SCHEME}://routes` as const,
  risks: `${FACTS_MCP_URI_SCHEME}://risks` as const,
} as const;

/**
 * MCP resource catalog — what an MCP `ListResources` handler enumerates.
 * Concrete resources (no path parameter) appear here with `mimeType` +
 * `description` for agent-friendly listing; the parametric `file`
 * resource is advertised via a URI template in the server's register
 * code because the SDK's resource list is flat.
 */
export const McpResourceCatalog = [
  {
    uri: McpResourceUris.project,
    mimeType: 'application/json',
    name: 'Project meta',
    description: 'Top-level project metadata: name, languages, frameworks, entry points, stats.',
  },
  {
    uri: McpResourceUris.graph,
    mimeType: 'application/json',
    name: 'Dependency graph',
    description: 'Full file-level import graph: nodes, edges, cycles, callers.',
  },
  {
    uri: McpResourceUris.routes,
    mimeType: 'application/json',
    name: 'Routes',
    description: 'Detected HTTP/page routes across Next.js, Remix, Express, FastAPI, Flask, Django.',
  },
  {
    uri: McpResourceUris.risks,
    mimeType: 'application/json',
    name: 'Risks',
    description: 'Findings from secrets + license + broken-import + cycle scanners.',
  },
] as const;

export const AnalyzeInputSchema = z.object({
  path: z.string().default('.'),
  useCache: z.boolean().default(true),
});

export const ReanalyzeFileInputSchema = z.object({
  path: z.string(),
});

/** Verbs shared by `factstack query` (CLI) and the MCP `query_graph` tool.
 *  The array is the canonical source of truth; the Zod enum and the
 *  `QueryVerb` type both derive from it so there's exactly one place
 *  to add a verb. */
export const QUERY_VERBS = [
  'callers',       // files that import the given path
  'imports',       // files imported BY the given path
  'cycles',        // all SCCs in the dependency graph
  'orphans',       // files with zero incoming edges
  // F3 — declarative-engine verbs (sugar over runGraphQuery). The first four
  // stay as-is; these add symbol-graph reach + path finding.
  'neighbors',     // nodes adjacent to a target (direction-controlled)
  'path-between',  // shortest path from `path` to `to`
  'references',    // symbols that reference a target symbol (symbol graph, in-edges)
  'implementers',  // symbols that implement/extend a target symbol (symbol graph)
  // F5 — blast radius: everything transitively affected by changing the target.
  'impact',        // reverse reachability (in-edges, depth-bounded)
] as const;
export const QueryVerbSchema = z.enum(QUERY_VERBS);
export type QueryVerb = z.infer<typeof QueryVerbSchema>;

/* ─────────── F3 declarative graph-query model ───────────
 *
 * One small pattern query interpreted over in-memory adjacency. The four
 * legacy verbs above are reimplemented as `GraphQuery` literals in
 * `@factstack/core` so the verb set can't drift from the engine.
 */

/** Every edge kind across BOTH graph levels. A `GraphQuery` picks which level
 *  it walks purely by which `edgeKinds` it allows: file paths only connect via
 *  import kinds, symbol ids only via symbol kinds — the two id-spaces never
 *  share an edge. Mirrors `GraphEdgeSchema.kind` + `SymbolEdgeSchema.kind` in
 *  agent.ts; keep in sync if either enum changes. */
export const EDGE_KINDS = [
  'import', 'dynamic-import', 'type-import',                  // file-level (GraphEdge)
  'call', 'read', 'jsx', 'type-ref', 'implements', 'extends', // symbol-level (SymbolEdge)
] as const;
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

/** How to seed a query: one or more of an exact id, a glob, a name, a kind.
 *  An "id" is a file path OR a symbol id (`path#name@line`). Multiple fields
 *  AND together (e.g. `{ kind: 'function', glob: 'src/auth/*' }`). */
export const NodeSelectorSchema = z
  .object({
    id: z.string().optional(),
    glob: z.string().optional(),
    name: z.string().optional(),
    kind: z.string().optional(),
  })
  .refine((s) => Boolean(s.id || s.glob || s.name || s.kind), {
    message: 'NodeSelector needs at least one of id / glob / name / kind.',
  });
export type NodeSelector = z.infer<typeof NodeSelectorSchema>;

export const TraverseSchema = z.object({
  /** Limit traversal to these edge kinds. Omit → all kinds (which also picks
   *  the graph level implicitly via the seed id-space). */
  edgeKinds: z.array(EdgeKindSchema).optional(),
  direction: z.enum(['out', 'in', 'both']).default('out'),
  maxDepth: z.number().int().nonnegative().default(1),
});
export type Traverse = z.infer<typeof TraverseSchema>;

export const GraphWhereSchema = z.object({
  /** Keep only nodes of this symbol kind (function/class/…); ignored for files. */
  kind: z.string().optional(),
  /** Keep only nodes whose path matches this glob. */
  pathGlob: z.string().optional(),
  /** Drop edges below this certainty during traversal (`extracted` > `inferred`
   *  > `ambiguous`). */
  minConfidence: ConfidenceSchema.optional(),
});
export type GraphWhere = z.infer<typeof GraphWhereSchema>;

export const GraphQuerySchema = z.object({
  start: NodeSelectorSchema,
  traverse: TraverseSchema.optional(),
  where: GraphWhereSchema.optional(),
  select: z.enum(['nodes', 'edges', 'subgraph']).default('subgraph'),
  limit: z.number().int().positive().default(200),
});
export type GraphQuery = z.infer<typeof GraphQuerySchema>;

/** Input for the F3 `query` MCP tool: either a free-text question (`q`,
 *  resolved deterministically to a plan — INV3) or a structured `GraphQuery`.
 *  Exactly one is required. */
export const QueryInputSchema = z
  .object({
    q: z.string().optional(),
    query: GraphQuerySchema.optional(),
  })
  .refine((v) => Boolean(v.q) !== Boolean(v.query), {
    message: 'query requires exactly one of `q` (free-text) or `query` (structured GraphQuery).',
  });
export type QueryInput = z.infer<typeof QueryInputSchema>;

export const QueryGraphInputSchema = z.object({
  /** Structured verb selector. Defaults to `callers` for backward compat
   *  with tool callers that only pass a `filter`. */
  verb: QueryVerbSchema.default('callers'),
  /** Target path/symbol-id for the single-target verbs (`callers`, `imports`,
   *  `neighbors`, `references`, `implementers`) and the source endpoint for
   *  `path-between` — REQUIRED for those. Ignored for `cycles` / `orphans`.
   *  The schema's refine guards this so callers don't silently get empty
   *  results when they forget. */
  path: z.string().optional(),
  /** F3 — destination endpoint for `path-between` (the `path` field is the
   *  source). Ignored by every other verb. */
  to: z.string().optional(),
  /** F3 — traversal direction for `neighbors` (`out` = depends-on,
   *  `in` = depended-on-by, `both` = either). Defaults to `both` in the
   *  engine; other verbs fix their own direction. */
  direction: z.enum(['out', 'in', 'both']).optional(),
  /** Glob-style filter matching file paths in the graph. Optional; when
   *  present, further restricts the result set for any verb. */
  filter: z.string().optional(),
  /** Maximum nodes to return. Default prevents accidentally huge responses. */
  limit: z.number().int().positive().default(200),
  /** Include transitive imports up to this depth from each matching node.
   *  Also bounds `neighbors` / `references` / `implementers` / `impact` reach.
   *  Intentionally NOT defaulted here: `executeQuery` applies the
   *  verb-appropriate default when omitted (1 for most verbs, 3 for `impact`'s
   *  blast radius). A blanket `.default(1)` here would mask `impact`'s deeper
   *  default — the omitted value would arrive as 1, never reaching the `?? 3`
   *  fallback. */
  depth: z.number().int().nonnegative().optional(),
  /** F1 — keep only edges at least this certain (`extracted` > `inferred` >
   *  `ambiguous`). Omit for all edges. `cycles` ignores it (SCCs are
   *  precomputed). */
  minConfidence: ConfidenceSchema.optional(),
}).refine(
  // Single-target verbs need `path`.
  (v) => !(
    (v.verb === 'callers' || v.verb === 'imports' || v.verb === 'neighbors' ||
     v.verb === 'references' || v.verb === 'implementers' || v.verb === 'path-between' ||
     v.verb === 'impact') && !v.path
  ),
  {
    message: 'this verb requires a `path` argument (the target symbol/file).',
    path: ['path'],
  },
).refine(
  // `path-between` additionally needs a destination.
  (v) => !(v.verb === 'path-between' && !v.to),
  {
    message: 'verb "path-between" requires a `to` argument (the destination).',
    path: ['to'],
  },
);

export const GetOutlineInputSchema = z.object({
  path: z.string(),
});

export const ListRisksInputSchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  category: z
    .enum([
      'secret',
      'license',
      'supply-chain',
      'parse-error',
      'broken-import',
      'stale',
      'large-file',
      'cycle',
    ])
    .optional(),
});

/* ─────────── canonical MCP tool surface ─────────── */

/**
 * Every tool the FACTS MCP server ACTUALLY ships, in the order it
 * advertises them (`ListTools`). This tuple is the single source of
 * truth for MCP tool *names* across the monorepo:
 *
 *   - `apps/mcp-server` dispatches each call via `MCP_TOOL.<name>`, so
 *     renaming a tool there without updating this list fails `tsc`.
 *   - `@factstack/skills` types `ONBOARDING_SEQUENCE` as
 *     `readonly ShippedMcpToolName[]`, so a generated AGENTS.md /
 *     SKILL.md can never point an agent at a tool that doesn't exist.
 *
 * Add / rename / remove a server tool ⇒ edit this tuple; tsc then points
 * at every site that must change. (Distinct from the legacy `McpTools`
 * map below, which carries Zod input schemas for a 5-of-13 subset.)
 */
export const MCP_TOOL_NAMES = [
  'analyze',
  'query_graph',
  'query',
  'get_outline',
  'list_risks',
  'read_memory',
  'since',
  'log_learning',
  'query_learnings',
  'get_config',
  'list_credentials',
  'list_vulnerabilities',
  'get_diagram',
  'review_change',
  'count_tokens',
] as const;

/** Union of every tool name the FACTS MCP server ships. */
export type ShippedMcpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Reference tools by identifier instead of a bare string literal:
 * `MCP_TOOL.read_memory` is both the value `'read_memory'` AND a
 * compile-time existence check — remove the tool from `MCP_TOOL_NAMES`
 * and every `MCP_TOOL.read_memory` site stops compiling. The `satisfies`
 * clause guarantees this map stays a complete, key-equals-value mirror
 * of the tuple above (missing key, extra key, or typo'd value all fail tsc).
 */
export const MCP_TOOL = {
  analyze: 'analyze',
  query_graph: 'query_graph',
  query: 'query',
  get_outline: 'get_outline',
  list_risks: 'list_risks',
  read_memory: 'read_memory',
  since: 'since',
  log_learning: 'log_learning',
  query_learnings: 'query_learnings',
  get_config: 'get_config',
  list_credentials: 'list_credentials',
  list_vulnerabilities: 'list_vulnerabilities',
  get_diagram: 'get_diagram',
  review_change: 'review_change',
  count_tokens: 'count_tokens',
} as const satisfies { [K in ShippedMcpToolName]: K };

/** F7 — input for the `count_tokens` tool: count a project file's tokens (by
 *  `path`, from the cached artifact or a live read) OR a raw `text` snippet.
 *  Exactly one is required. */
export const CountTokensInputSchema = z
  .object({
    path: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((v) => Boolean(v.path) !== Boolean(v.text), {
    message: 'count_tokens requires exactly one of `path` or `text`.',
  });
export type CountTokensInput = z.infer<typeof CountTokensInputSchema>;

/* ─────────── (legacy) partial input-schema catalog ─────────── */

export const McpTools = {
  analyze: {
    name: 'analyze',
    description: 'Run a full FACTS analysis of a project directory.',
    input: AnalyzeInputSchema,
  },
  /**
   * @deprecated v0.2: stubs to a full re-analyze (no incremental path
   *   until the v0.3 SQLite index lands). `path` is accepted but not
   *   honored today — clients should call `analyze` instead.
   */
  reanalyze_file: {
    name: 'reanalyze_file',
    description: 'DEPRECATED in v0.2: triggers a full re-analyze of the project. True per-file incremental analysis lands with the v0.3 SQLite index.',
    input: ReanalyzeFileInputSchema,
  },
  query_graph: {
    name: 'query_graph',
    description: 'Query a subgraph by filter + depth. Rate-limited; large results chunked.',
    input: QueryGraphInputSchema,
  },
  get_outline: {
    name: 'get_outline',
    description: 'Get the symbol/route/component outline for a single file.',
    input: GetOutlineInputSchema,
  },
  list_risks: {
    name: 'list_risks',
    description: 'List risks found during analysis, optionally filtered by severity or category.',
    input: ListRisksInputSchema,
  },
} as const;

/**
 * @deprecated Names of the tools that carry a Zod input schema in the
 * partial `McpTools` catalog above (a 5-of-13 subset). For the complete,
 * authoritative list of shipped tool names use `ShippedMcpToolName` /
 * `MCP_TOOL_NAMES`.
 */
export type McpToolName = keyof typeof McpTools;

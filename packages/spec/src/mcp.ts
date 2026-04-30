/**
 * MCP resource + tool surface for the FACTS analyzer.
 *
 * v0.1 sketches this shape so the CLI's command vocabulary aligns with
 * what the v0.5 MCP server will expose. When the server ships, it becomes
 * a thin adapter over @factstack/core rather than a re-design.
 */

import { z } from 'zod';

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
  'callers',    // files that import the given path
  'imports',    // files imported BY the given path
  'cycles',     // all SCCs in the dependency graph
  'orphans',    // files with zero incoming edges
] as const;
export const QueryVerbSchema = z.enum(QUERY_VERBS);
export type QueryVerb = z.infer<typeof QueryVerbSchema>;

export const QueryGraphInputSchema = z.object({
  /** Structured verb selector. Defaults to `callers` for backward compat
   *  with tool callers that only pass a `filter`. */
  verb: QueryVerbSchema.default('callers'),
  /** Target path for `callers` / `imports` — REQUIRED for those verbs.
   *  Ignored for `cycles` / `orphans`. The schema's refine guards this
   *  so callers don't silently get empty results when they forget. */
  path: z.string().optional(),
  /** Glob-style filter matching file paths in the graph. Optional; when
   *  present, further restricts the result set for any verb. */
  filter: z.string().optional(),
  /** Maximum nodes to return. Default prevents accidentally huge responses. */
  limit: z.number().int().positive().default(200),
  /** Include transitive imports up to this depth from each matching node. */
  depth: z.number().int().nonnegative().default(1),
}).refine(
  (v) => !((v.verb === 'callers' || v.verb === 'imports') && !v.path),
  {
    message: 'verb "callers" and "imports" require a `path` argument.',
    path: ['path'],
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

export type McpToolName = keyof typeof McpTools;

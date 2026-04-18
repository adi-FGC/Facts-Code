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

export const AnalyzeInputSchema = z.object({
  path: z.string().default('.'),
  useCache: z.boolean().default(true),
});

export const ReanalyzeFileInputSchema = z.object({
  path: z.string(),
});

export const QueryGraphInputSchema = z.object({
  /** Glob-style filter matching file paths in the graph. */
  filter: z.string().optional(),
  /** Maximum nodes to return. Default prevents accidentally huge responses. */
  limit: z.number().int().positive().default(200),
  /** Include transitive imports up to this depth from each matching node. */
  depth: z.number().int().nonnegative().default(1),
});

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
  reanalyze_file: {
    name: 'reanalyze_file',
    description: 'Incrementally re-analyze a single file and update the cached index.',
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

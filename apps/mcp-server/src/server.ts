#!/usr/bin/env node
/**
 * FACTS Model Context Protocol server — stdio transport, single-project.
 *
 * v0.2 surface:
 *   Resources:
 *     facts://project       — project meta + stats
 *     facts://graph         — dependency graph (nodes, edges, cycles, callers)
 *     facts://routes        — detected routes
 *     facts://risks         — scanner findings
 *     facts://file/{path}   — per-file FileOutline (parametric)
 *
 *   Tools:
 *     analyze               — run a full FACTS analysis (writes .facts/)
 *     reanalyze_file        — DEPRECATED stub; runs a full analyze + warns
 *     query_graph           — structured verb query (callers/imports/cycles/orphans)
 *     get_outline           — per-file symbol outline (reuses extractors)
 *     list_risks            — filter risks by severity/category
 *
 * Designed for agent consumption: every resource returns JSON matching
 * the Zod schemas in `@factstack/spec` so tools can validate.
 */

import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { analyze, executeQuery } from '@factstack/core';
import { gzippedBytes, writeArtifacts } from '@factstack/emit';
import { mineGitStats, nodeFS } from '@factstack/fs-node';
import { extractOutline } from '@factstack/extractors';
import {
  FACTS_MCP_URI_SCHEME,
  McpResourceCatalog,
  QUERY_VERBS,
  QueryGraphInputSchema,
  type AgentArtifact,
  type HumanArtifact,
} from '@factstack/spec';

// ── Bootstrap ──────────────────────────────────────────────────────────

const root = resolveRoot();
const projectName = path.basename(root);

/**
 * Mutable cache of the latest analyzer output. Populated on startup and
 * replaced by every `analyze` / `reanalyze_file` tool call. Every tool
 * + resource handler reads from here — there's no background file watch
 * in the MCP server (clients trigger updates explicitly).
 */
let cached: { agent: AgentArtifact; human: HumanArtifact } | null = null;

// Serialize analyze calls so two concurrent tool invocations can't race
// into writeArtifacts. Same pattern as the CLI's `ui` command.
let analyzeChain: Promise<unknown> = Promise.resolve();

async function runAnalyze(): Promise<AgentArtifact['stats']> {
  const fs = nodeFS(root);
  const result = await analyze(fs, {
    root: '.',
    projectName,
    gzip: gzippedBytes,
    gitStats: mineGitStats(root),
  });
  await writeArtifacts({
    root,
    agent: result.agent,
    human: result.human,
    addGitignoreEntry: true,
    writeSnapshot: true,
  });
  cached = { agent: result.agent, human: result.human };
  return result.agent.stats;
}

function resolveRoot(): string {
  const fromArg = process.argv.find((a, i) => (a === '--root' || a === '-r') && i < process.argv.length - 1);
  const argIdx = fromArg ? process.argv.indexOf(fromArg) + 1 : -1;
  const root =
    argIdx > 0 && process.argv[argIdx]
      ? process.argv[argIdx]!
      : process.env.FACTS_ROOT || '.';
  return path.resolve(root);
}

// ── MCP server wiring ──────────────────────────────────────────────────

const server = new Server(
  { name: 'factstack', version: '0.2.0' },
  { capabilities: { resources: {}, tools: {} } },
);

// List resources (flat catalog from @factstack/spec).
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: McpResourceCatalog.map((r) => ({ ...r })),
}));

// Read a resource by URI.
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (!cached) await ensureAnalyzed();
  const uri = req.params.uri;
  const { agent, human } = cached!;

  if (uri === `${FACTS_MCP_URI_SCHEME}://project`) {
    return jsonResource(uri, {
      ...agent.project,
      generatedAt: agent.generatedAt,
      stats: agent.stats,
      health: human.summary.health,
    });
  }
  if (uri === `${FACTS_MCP_URI_SCHEME}://graph`) {
    return jsonResource(uri, agent.graph);
  }
  if (uri === `${FACTS_MCP_URI_SCHEME}://routes`) {
    return jsonResource(uri, agent.routes);
  }
  if (uri === `${FACTS_MCP_URI_SCHEME}://risks`) {
    return jsonResource(uri, agent.risks);
  }
  // Parametric file resource. Normalize backslashes (Windows paths the
  // client may have constructed with `\`) and strip the `./` prefix —
  // mirrors the CLI's `/api/file` endpoint so both surfaces handle the
  // same path shapes consistently.
  const filePrefix = `${FACTS_MCP_URI_SCHEME}://file/`;
  if (uri.startsWith(filePrefix)) {
    const relPath = decodeURIComponent(uri.slice(filePrefix.length))
      .replace(/^\/+/, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    const outline = agent.files.find((f) => f.path === relPath);
    if (!outline) {
      // Soft 404 with a hint instead of a thrown error — clients can
      // distinguish "no such file" from "server is broken".
      const matches = agent.files
        .filter((f) => f.path.endsWith('/' + relPath.split('/').pop()))
        .slice(0, 5)
        .map((f) => f.path);
      throw new Error(
        `Unknown file: ${relPath}` +
        (matches.length ? ` (did you mean: ${matches.join(', ')})` : ''),
      );
    }
    return jsonResource(uri, outline);
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// Resource templates — advertise the parametric `facts://file/{path}`
// resource so MCP clients can discover it via resources/templates/list.
// Without this, listResources only returns the 4 concrete URIs and the
// per-file outline is invisible to clients that don't know it exists.
server.setRequestHandler(
  ListResourceTemplatesRequestSchema,
  async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${FACTS_MCP_URI_SCHEME}://file/{path}`,
        name: 'File outline',
        description: 'Per-file FileOutline (declarations, imports, status, LOC, tokens). Substitute {path} with a project-relative path.',
        mimeType: 'application/json',
      },
    ],
  }),
);

// List tools.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'analyze',
      description: 'Run a full FACTS analysis of the configured project. Writes .facts/ artifacts and refreshes the server cache.',
      inputSchema: {
        type: 'object',
        properties: {
          useCache: { type: 'boolean', description: 'Return cached result if still valid.', default: true },
        },
      },
    },
    {
      // @deprecated — stubs to a full re-analyze; the `path` argument is
      // accepted but not honored. Kept until v0.3 SQLite incremental.
      name: 'reanalyze_file',
      description: 'DEPRECATED in v0.2: runs a full analyze. The `path` argument is accepted but ignored. True per-file incremental lands with the v0.3 SQLite index.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
    {
      name: 'query_graph',
      description: 'Query the dependency graph. Verbs: callers (files importing X), imports (files imported BY X), cycles, orphans.',
      inputSchema: {
        type: 'object',
        properties: {
          verb: { type: 'string', enum: [...QUERY_VERBS], default: 'callers' },
          path: { type: 'string' },
          filter: { type: 'string' },
          limit: { type: 'number', default: 200 },
          depth: { type: 'number', default: 1 },
        },
      },
    },
    {
      name: 'get_outline',
      description: 'Return the symbol outline (declarations) for a single file, computed live from the source.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    },
    {
      name: 'list_risks',
      description: 'List scanner findings, optionally filtered by severity or category.',
      inputSchema: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
          category: { type: 'string', enum: ['secret', 'license', 'supply-chain', 'parse-error', 'broken-import', 'stale', 'large-file', 'cycle'] },
        },
      },
    },
  ],
}));

// Handle tool calls.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  if (name === 'analyze') {
    const stats = await enqueueAnalyze();
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stats }) }] };
  }

  if (name === 'reanalyze_file') {
    // Stub: run a full analyze but warn the caller. This matches the
    // locked decision (#4) — real incremental ships with v0.3 SQLite.
    process.stderr.write('[factstack-mcp] reanalyze_file is a full re-analyze in v0.2; true incremental lands with the SQLite index.\n');
    const stats = await enqueueAnalyze();
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stats, warning: 'reanalyze_file runs a full analyze in v0.2' }) }] };
  }

  if (name === 'query_graph') {
    if (!cached) await ensureAnalyzed();
    // Zod refine catches the missing-path-for-callers/imports case. Return
    // a structured error so callers see "missing required argument" rather
    // than a stack trace or an empty result with no signal.
    const parseResult = QueryGraphInputSchema.safeParse(args);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
      }));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: false, error: 'invalid query_graph input', issues }, null, 2),
        }],
        isError: true,
      };
    }
    const parsed = parseResult.data;
    const result = executeQuery(cached!.agent, {
      verb: parsed.verb,
      ...(parsed.path !== undefined ? { path: parsed.path } : {}),
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      limit: parsed.limit,
      depth: parsed.depth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  if (name === 'get_outline') {
    if (!cached) await ensureAnalyzed();
    const relPath = String(args.path ?? '');
    // Prefer pre-extracted declarations from the cached artifact; fall
    // back to a live extractor call for parity with the CLI endpoint.
    const outline = cached!.agent.files.find((f) => f.path === relPath);
    if (outline && outline.declarations.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ path: relPath, outline: outline.declarations }) }] };
    }
    const abs = path.resolve(root, relPath);
    if (!existsSync(abs)) throw new Error(`File not found: ${relPath}`);
    try {
      const source = readFileSync(abs, 'utf8');
      const ext = path.extname(relPath).toLowerCase();
      const live = extractOutline(source, ext);
      return { content: [{ type: 'text', text: JSON.stringify({ path: relPath, outline: live }) }] };
    } catch (err) {
      throw new Error(`Failed to extract outline for ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (name === 'list_risks') {
    if (!cached) await ensureAnalyzed();
    const sev = args.severity as string | undefined;
    const cat = args.category as string | undefined;
    let risks = cached!.agent.risks;
    if (sev) risks = risks.filter((r) => r.severity === sev);
    if (cat) risks = risks.filter((r) => r.category === cat);
    return { content: [{ type: 'text', text: JSON.stringify({ count: risks.length, risks }) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ── Helpers ────────────────────────────────────────────────────────────

function jsonResource(uri: string, payload: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function ensureAnalyzed(): Promise<void> {
  if (cached) return;
  await enqueueAnalyze();
}

function enqueueAnalyze(): Promise<AgentArtifact['stats']> {
  const next = analyzeChain.then(() => runAnalyze());
  analyzeChain = next.catch(() => undefined);
  return next;
}

// ── Run ────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(`[factstack-mcp] project root: ${root}\n`);
  await ensureAnalyzed();
  process.stderr.write(
    `[factstack-mcp] cached ${cached!.agent.files.length} files, ` +
    `${cached!.agent.graph.edges.length} edges, ` +
    `${cached!.agent.risks.length} risks\n`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[factstack-mcp] listening on stdio\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`[factstack-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

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
 *     query_graph           — structured verb query (callers/imports/cycles/orphans)
 *     get_outline           — per-file symbol outline (reuses extractors)
 *     list_risks            — filter risks by severity/category
 *     read_memory           — fetch the compact MEMORY.md session brief
 *     since                 — what changed since an ISO timestamp (v0.3.2)
 *     log_learning          — append a proposal/outcome to learnings.jsonl (v0.3.4)
 *     query_learnings       — filter the learnings log (v0.3.4)
 *     get_config            — env-var inventory + read sites (v0.3.6)
 *
 * Designed for agent consumption: every resource returns JSON matching
 * the Zod schemas in `@factstack/spec` so tools can validate.
 *
 * Removed in v0.3.9: `reanalyze_file` — was a deprecated stub that
 * silently triggered a full re-analyze regardless of the `path`
 * argument. Agents calling it expecting incremental work hit a
 * footgun. Until SQLite-backed incremental lands, just use `analyze`.
 */

import * as path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  analyze,
  buildMemory,
  executeQuery,
  formatLearningEvent,
  parseLearningsJsonl,
  proposalEvent,
  queryLearnings,
  selfCalibrateEvent,
  since as buildSinceReport,
  type LearningEvent,
} from '@factstack/core';
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
 * replaced by every `analyze` tool call. Every tool + resource handler
 * reads from here — there's no background file watch in the MCP server
 * (clients trigger updates explicitly).
 */
let cached: { agent: AgentArtifact; human: HumanArtifact; memory: string } | null = null;

// Serialize analyze calls so two concurrent tool invocations can't race
// into writeArtifacts. Same pattern as the CLI's `ui` command.
let analyzeChain: Promise<unknown> = Promise.resolve();

async function runAnalyze(): Promise<AgentArtifact['stats']> {
  const fs = nodeFS(root);
  const startedAt = Date.now();
  const result = await analyze(fs, {
    root: '.',
    projectName,
    gzip: gzippedBytes,
    gitStats: mineGitStats(root),
  });
  const memoryBody = buildMemory(result.agent, result.human);
  await writeArtifacts({
    root,
    agent: result.agent,
    human: result.human,
    addGitignoreEntry: true,
    writeSnapshot: true,
    memoryBody,
  });
  cached = { agent: result.agent, human: result.human, memory: memoryBody };
  /* v0.3.4 — emit a self-calibrate event so learnings.jsonl begins
     accumulating from day one. Even with no external agent connected,
     FACTS itself becomes a tracked time series (file count, token
     count, risk count, analyze duration). */
  try {
    appendLearning(
      selfCalibrateEvent({
        fileCount: result.agent.stats.fileCount,
        totalLoc: result.agent.stats.loc,
        totalTokens: result.agent.stats.totalTokenCost,
        riskCount: result.agent.risks.length,
        durationMs: Date.now() - startedAt,
      }),
    );
  } catch {
    // Non-fatal — never fail an analyze because we couldn't append a
    // calibration row.
  }
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
    {
      // v0.3.1: the brief AI agents read FIRST when joining the project.
      // Returns a 2-10 KB markdown digest synthesized from agent.json
      // + human.json. Cheaper than walking agent.json by 10-100x for
      // the cold-start case. Re-run `analyze` to refresh.
      name: 'read_memory',
      description: 'Read .facts/MEMORY.md — a compact (2-10 KB) markdown brief that summarizes the project for AI agents. ALWAYS call this first when joining a new project; it replaces a 40-200 KB cold-read of agent.json.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      // v0.3.2: cross-session state recovery for long-running agents.
      // Returns a structured "what changed since X" report — added /
      // modified / removed files + new routes + new risks — so the
      // agent reads ~5 KB instead of re-fetching the full artifact.
      name: 'since',
      description: 'What changed since an ISO timestamp. Returns added/modified/removed files plus new + removed routes + risks. Uses the most recent snapshot in .facts/snapshots/ as a baseline when available; falls back to mtime-only mode otherwise. The hasBaseline field tells the caller which mode produced the report.',
      inputSchema: {
        type: 'object',
        required: ['timestamp'],
        properties: {
          timestamp: { type: 'string', description: 'ISO 8601 timestamp lower bound, e.g. "2026-04-30T00:00:00Z".' },
        },
      },
    },
    {
      // v0.3.4: append a proposal/outcome event to .facts/learnings.jsonl.
      // Foundation for the v0.6 trust framework — every accepted vs
      // rejected proposal accumulates as calibration data.
      name: 'log_learning',
      description: 'Append a proposal/outcome event to .facts/learnings.jsonl. Use to record what your agent proposed and whether the human accepted, rejected, or left it pending. Required: agent (your stable id), action (verb-form, ≤64 chars), outcome (accepted|rejected|pending|self-calibrate). Optional: model, ticketId, reasoning, filesAffected, confidence (0..1), tags.',
      inputSchema: {
        type: 'object',
        required: ['agent', 'action', 'outcome'],
        properties: {
          agent: { type: 'string' },
          action: { type: 'string' },
          outcome: { type: 'string', enum: ['accepted', 'rejected', 'pending', 'self-calibrate'] },
          model: { type: 'string' },
          ticketId: { type: 'string' },
          reasoning: { type: 'string' },
          filesAffected: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      // v0.3.4: read + filter the learnings log. Lets the next agent
      // session pick up calibration context without re-reading every
      // line.
      name: 'query_learnings',
      description: 'Filter .facts/learnings.jsonl by since/until/agent/outcome/action/tag. Returns most-recent-first, capped at 5000 events. Use for "what has this codebase\'s agents been right about?" calibration questions.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO timestamp lower bound.' },
          until: { type: 'string', description: 'ISO timestamp upper bound.' },
          agent: { type: 'string' },
          outcome: { type: 'string', enum: ['accepted', 'rejected', 'pending', 'self-calibrate'] },
          action: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'number', default: 200, maximum: 5000 },
        },
      },
    },
    {
      // v0.3.6: env-var inventory. Returns the same data the UI's
      // Config tab renders — every var name, read sites, captured
      // defaults, primary access pattern.
      name: 'get_config',
      description: 'List every environment variable read by the codebase, with read sites + captured defaults. Sorted by read count desc. Empty when no env reads are detected.',
      inputSchema: { type: 'object', properties: {} },
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

  if (name === 'read_memory') {
    if (!cached) await ensureAnalyzed();
    // Return as plain text so agents render it as markdown directly.
    // A JSON wrapper would force them to unwrap before reading.
    return { content: [{ type: 'text', text: cached!.memory }] };
  }

  // v0.3.2 — what changed since X?
  if (name === 'since') {
    if (!cached) await ensureAnalyzed();
    const ts = typeof args.timestamp === 'string' ? args.timestamp : '';
    if (!ts) throw new Error("since: 'timestamp' (ISO 8601) is required");
    /* Try to load the most recent snapshot as a baseline. We pick the
       latest .facts/snapshots/<dir>/agent.json by sort order — snapshot
       directories are date-stamped so lexical sort = chronological. */
    const baseline = readLatestSnapshot();
    const report = buildSinceReport(cached!.agent, ts, baseline ?? undefined);
    return { content: [{ type: 'text', text: JSON.stringify(report) }] };
  }

  // v0.3.4 — append a learning event to .facts/learnings.jsonl.
  if (name === 'log_learning') {
    /* Validate via the schema BEFORE we write — every line in the
       JSONL must be valid; an invalid event is a caller error and
       returning a structured complaint is more useful than a bad
       file write. */
    let event: LearningEvent;
    try {
      event = proposalEvent({
        agent: String(args.agent ?? ''),
        action: String(args.action ?? ''),
        outcome: args.outcome as Parameters<typeof proposalEvent>[0]['outcome'],
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.ticketId === 'string' ? { ticketId: args.ticketId } : {}),
        ...(typeof args.reasoning === 'string' ? { reasoning: args.reasoning } : {}),
        ...(Array.isArray(args.filesAffected) ? { filesAffected: args.filesAffected as string[] } : {}),
        ...(typeof args.confidence === 'number' ? { confidence: args.confidence } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
      });
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (err as Error).message }) }] };
    }
    appendLearning(event);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, timestamp: event.timestamp }) }] };
  }

  // v0.3.4 — read + filter learnings.jsonl.
  if (name === 'query_learnings') {
    const events = readLearnings();
    const result = queryLearnings(events, {
      ...(typeof args.since === 'string' ? { since: args.since } : {}),
      ...(typeof args.until === 'string' ? { until: args.until } : {}),
      ...(typeof args.agent === 'string' ? { agent: args.agent } : {}),
      ...(typeof args.outcome === 'string' ? { outcome: args.outcome as Parameters<typeof queryLearnings>[1] extends infer Q ? (Q extends { outcome?: infer O } ? O : never) : never } : {}),
      ...(typeof args.action === 'string' ? { action: args.action } : {}),
      ...(typeof args.tag === 'string' ? { tag: args.tag } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    });
    return { content: [{ type: 'text', text: JSON.stringify({ count: result.length, events: result }) }] };
  }

  // v0.3.6 — env-var inventory.
  if (name === 'get_config') {
    if (!cached) await ensureAnalyzed();
    const config = cached!.agent.config ?? { envVars: [], schemas: [] };
    return { content: [{ type: 'text', text: JSON.stringify(config) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

/* ─── v0.3.2 / v0.3.4 helpers ───────────────────────────────────── */

function readLatestSnapshot(): import('@factstack/spec').AgentArtifact | null {
  try {
    const snapDir = path.join(root, '.facts', 'snapshots');
    if (!existsSync(snapDir)) return null;
    const dirs = readdirSyncSafe(snapDir).sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
      const candidate = path.join(snapDir, dirs[i]!, 'agent.json');
      if (existsSync(candidate)) {
        const text = readFileSync(candidate, 'utf8');
        return JSON.parse(text);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readdirSyncSafe(p: string): string[] {
  try {
    /* Avoid a top-level node:fs import we don't actually need
       elsewhere — inline the fs.readdirSync via require. The MCP server
       is Node-only by design, so this is fine. */
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    return fs.readdirSync(p);
  } catch { return []; }
}

function learningsPath(): string {
  return path.join(root, '.facts', 'learnings.jsonl');
}

function appendLearning(event: LearningEvent): void {
  const factsDir = path.join(root, '.facts');
  if (!existsSync(factsDir)) mkdirSync(factsDir, { recursive: true });
  appendFileSync(learningsPath(), formatLearningEvent(event), 'utf8');
}

function readLearnings(): LearningEvent[] {
  const p = learningsPath();
  if (!existsSync(p)) return [];
  const text = readFileSync(p, 'utf8');
  const { events } = parseLearningsJsonl(text);
  return events;
}

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

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
 *     sync_pack             — fetch agent.pack as a small diff when the caller
 *                             already holds the prior master (F8 consumer)
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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolveInRoot } from './paths.js';
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
  assembleContext,
  buildChangeVerdict,
  buildContextStore,
  buildMemory,
  computeHealth,
  buildDiagram,
  lastServedEntities,
  recentSessionEntities,
  sessionActionEvent,
  executeQuery,
  runGraphQuery,
  planFromQuestion,
  formatLearningEvent,
  parseLearningsJsonl,
  proposalEvent,
  queryLearnings,
  renderVerdictMarkdown,
  selfCalibrateEvent,
  since as buildSinceReport,
  type DiagramView,
  type LearningEvent,
} from '@factstack/core';
import {
  queryGraphToPack,
  listRisksToPack,
  getOutlineToPack,
  getConfigToPack,
  queryLearningsToPack,
  subgraphToPack,
  contextToPack,
  verbResultNodes,
  packSnapshotId,
} from './pack-responses.js';
import { gzippedBytes, writeArtifacts } from '@factstack/emit';
import { mineGitStats, nodeFS } from '@factstack/fs-node';
import { resolveSyncPack } from './sync-pack.js';
import {
  approximateTokens,
  flattenManifests,
  normalizeNpmVersion,
  noopCache,
  osvResultsToVulnerabilities,
  queryOsvBatch,
  reconcileVulnerabilities,
  type OsvQuery,
} from '@factstack/scanners';
import { extractOutline } from '@factstack/extractors';
import { validSession, authRequiredResult, login, firestoreSet } from './auth.js';
import {
  FACTS_MCP_URI_SCHEME,
  McpResourceCatalog,
  MCP_TOOL_CATALOG,
  QueryGraphInputSchema,
  QueryInputSchema,
  CountTokensInputSchema,
  ContextInputSchema,
  SyncPackInputSchema,
  jsonSchemaByKind,
  MCP_TOOL,
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
  // v0.11 — a re-analyze must not wipe the last CVE scan (analyze itself is
  // network-free per INV6 and returns an empty list). Mirrors the CLI.
  restoreVulnScanInto(result.agent);
  // v0.3 — re-grade health after the CVE carry-forward so vulnerabilities land
  // in the score/headline (analyze() grades before the restore). Mirrors the CLI.
  result.human.summary.health = computeHealth(result.agent);
  // F9 — fold the durable context store (decisions / open tasks / questions
  // recorded in learnings.jsonl) into MEMORY.md's "Working context" section.
  const memoryBody = buildMemory(result.agent, result.human, {
    contextStore: buildContextStore(readLearnings()),
  });
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
  // AUTH GATE (parity with the CallTool gate) — facts:// resources return the
  // SAME project analysis (graph / routes / risks / per-file outlines, incl. any
  // leaked-secret findings) the gated tools do, so reading them requires the same
  // one-time Google sign-in. Resources have no {isError} channel, so signal the
  // requirement by throwing the login hint. ListResources / ListResourceTemplates
  // stay open on purpose — they return only static descriptors from @factstack/spec
  // (no project data), exactly like ListTools — so a client can still connect and
  // discover the surface before signing in; only the actual data read is gated.
  if (!(await validSession())) throw new Error(authRequiredResult().content[0]!.text);
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
  /* v0.3.10 — schema introspection. Return the JSON Schema for the
     requested artifact kind so connecting agents can learn the shape
     without reading megabytes of agent.json. */
  const schemaPrefix = `${FACTS_MCP_URI_SCHEME}://schema/`;
  if (uri.startsWith(schemaPrefix)) {
    const kind = uri.slice(schemaPrefix.length);
    const schema = jsonSchemaByKind(kind);
    if (schema === null) {
      throw new Error(`Unknown schema kind: ${kind} (try 'agent' or 'human')`);
    }
    return jsonResource(uri, schema);
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
      {
        uriTemplate: `${FACTS_MCP_URI_SCHEME}://schema/{kind}`,
        name: 'JSON Schema for FACTS artifacts',
        description: 'JSON Schema (draft-07) for the named FACTS artifact. {kind} is "agent" or "human". Use this to validate decoded responses or to generate types in any language without reading the full artifact.',
        mimeType: 'application/json',
      },
    ],
  }),
);

// List tools. The catalog in @factstack/spec is the single source of
// truth — the emitted payload maps each entry to just the three wire
// fields (name / description / inputSchema), dropping the onboarding
// metadata the discoverability artifacts use. Byte-identical to the
// former inline literal; the spec's compile-time + runtime completeness
// checks (mcpCatalogMatchesNames) guarantee all 17 tools stay listed.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: MCP_TOOL_CATALOG.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

/**
 * v0.3.10 — pull the `format` arg off a tool call. Default `'pack'`
 * for the five tools that adopted PACK; the remaining tools (analyze,
 * read_memory, since, log_learning) ignore this entirely and return
 * their own shapes.
 *
 * Returns 'json' when the caller explicitly asks for it; otherwise
 * 'pack'. Anything other than those two values falls back to 'pack'
 * silently — the JSON Schema enum on the tool input is the load-
 * bearing validator.
 */
function pickFormat(args: Record<string, unknown>): 'pack' | 'json' {
  return args.format === 'json' ? 'json' : 'pack';
}

// Handle tool calls.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  // AUTH GATE — using the FACTS MCP requires a one-time Google sign-in so each
  // user's analysis + learnings are stored PRIVATELY per-account in Firestore.
  // Unauthenticated calls get login instructions instead of running the tool.
  // Only the MCP is gated; the public site + CLI stay open. `session` (non-null
  // past the guard) carries the uid the per-user Firestore writes key on.
  const session = await validSession();
  if (!session) return authRequiredResult();

  if (name === MCP_TOOL.analyze) {
    const stats = await enqueueAnalyze();
    /* v0.3.11 AI5: include version metadata so a connecting agent can
       version-check the artifact + the wire formats it'll consume.
       Three layers documented:
         - facts:  the spec's FACTS_SCHEMA_VERSION (artifact shape)
         - schemas: the per-format schema names + versions
         - producer: this MCP server's identity for cache + log keying
       Forward-compat: an agent that doesn't recognize a layer should
       fall back to JSON via `format: "json"` on each tool call. */
    const versionInfo = {
      facts: '0.1.0',
      schemas: {
        agent: 'agent-v4',     // agent.pack wire format (FactsPack standard v0.2: in-band `;` legend + hot hints, sha256 trailer, leading `top` table, unified F namespace, mtime_d, chain header fields). agent.json shape is additive → `facts: '0.1.0'` above is unchanged.
        human: 'human.v1',     // human.json
        memory: 'factstack-memory.v1',
        learnings: 'factstack-learnings.v1',
        pack: { agent: 'agent-v4', risks: 'risks-v1', envs: 'envs-v1', outline: 'outline-v2', learnings: 'learnings-v1', queryGraph: 'query-graph-v1', subgraph: 'subgraph-v1' },
      },
      producer: 'factstack-mcp/0.3.11',
    };
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stats, version: versionInfo }) }] };
  }

  if (name === MCP_TOOL.query_graph) {
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
      ...(parsed.to !== undefined ? { to: parsed.to } : {}),
      ...(parsed.direction !== undefined ? { direction: parsed.direction } : {}),
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.minConfidence !== undefined ? { minConfidence: parsed.minConfidence } : {}),
      limit: parsed.limit,
      // `depth` is intentionally undefined-when-omitted (no schema default) so
      // executeQuery applies the per-verb default — notably 3 for `impact`.
      ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
    });
    if (pickFormat(args) === 'pack') {
      return { content: [{ type: 'text', text: queryGraphToPack(result, packSnapshotId(cached!.agent)) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  if (name === MCP_TOOL.query) {
    if (!cached) await ensureAnalyzed();
    const parseResult = QueryInputSchema.safeParse(args);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid query input', issues }, null, 2) }],
        isError: true,
      };
    }
    const agent = cached!.agent;
    const snapshotId = packSnapshotId(agent);
    const wantPack = pickFormat(args) === 'pack';

    // Structured GraphQuery → run directly.
    if (parseResult.data.query) {
      const sub = runGraphQuery(agent, parseResult.data.query);
      if (wantPack) {
        return { content: [{ type: 'text', text: subgraphToPack(agent, sub, snapshotId) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(sub) }] };
    }

    // Free-text → deterministic plan (INV3). No confident match → did-you-mean.
    const plan = planFromQuestion(agent, parseResult.data.q!);
    if (!plan.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: plan.reason, candidates: plan.candidates }, null, 2) }] };
    }
    // Resolve the plan to a subgraph: GraphQuery plans run on the engine;
    // verb plans (orphans/cycles/path-between) run on the verb engine and are
    // lifted into a node-list subgraph so the response shape is uniform.
    let sub: { nodes: string[]; edges: Array<{ from: string; to: string; kind: string; confidence?: string }>; truncated: boolean };
    if (plan.plan.graphQuery) {
      sub = runGraphQuery(agent, plan.plan.graphQuery);
    } else {
      const r = executeQuery(agent, {
        verb: plan.plan.verb!,
        ...(plan.plan.path !== undefined ? { path: plan.plan.path } : {}),
        ...(plan.plan.to !== undefined ? { to: plan.plan.to } : {}),
      });
      // Lift the verb result into a flat node list. `cycles` (string[][]) is
      // flattened by verbResultNodes so a free-text "circular dependencies?"
      // question doesn't silently return an empty subgraph.
      sub = { nodes: verbResultNodes(r), edges: [], truncated: false };
    }
    if (wantPack) {
      return { content: [{ type: 'text', text: subgraphToPack(agent, sub, snapshotId) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ interpretation: plan.plan.interpretation, entities: plan.plan.entities, ...sub }) }] };
  }

  if (name === MCP_TOOL.get_diagram) {
    if (!cached) await ensureAnalyzed();
    /* Validate view against the union; default to package. Focal needs a
       focus path — surface that as a structured error (like query_graph)
       rather than letting buildDiagram throw. */
    const view = (['package', 'hub', 'focal'].includes(String(args.view))
      ? (args.view as DiagramView)
      : 'package');
    const focus = typeof args.focus === 'string' && args.focus.length > 0 ? args.focus : undefined;
    if (view === 'focal' && !focus) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'view=focal requires a "focus" file path' }, null, 2) }],
        isError: true,
      };
    }
    const depthRaw = typeof args.depth === 'number' ? args.depth : 2;
    const depth = Math.max(1, Math.min(5, Math.trunc(depthRaw)));
    const mermaid = buildDiagram(cached!.agent, {
      view,
      ...(focus ? { focus } : {}),
      depth,
    });
    return { content: [{ type: 'text', text: mermaid }] };
  }

  if (name === MCP_TOOL.get_outline) {
    if (!cached) await ensureAnalyzed();
    const relPath = String(args.path ?? '');
    const fmt = pickFormat(args);
    /* F2: outgoing symbol-graph edges whose `from` declaration lives in
       this file — "what does this file reference, and how certain are
       we?". We map edges back to the file via the symbol NODES (whose
       `path` is authoritative) rather than parsing the `path#name@line`
       id, so a path containing `#` can't break the match. Empty unless
       analysis ran with `--symbols`; the converter still emits the table. */
    const fileSymbolIds = new Set(
      (cached!.agent.graph.symbolNodes ?? [])
        .filter((n) => n.path === relPath)
        .map((n) => n.id),
    );
    const fileRefs = (cached!.agent.graph.symbolEdges ?? []).filter((e) => fileSymbolIds.has(e.from));
    // Prefer pre-extracted declarations from the cached artifact; fall
    // back to a live extractor call for parity with the CLI endpoint.
    const outline = cached!.agent.files.find((f) => f.path === relPath);
    if (outline && outline.declarations.length) {
      if (fmt === 'pack') {
        const text = getOutlineToPack(relPath, outline.declarations as Parameters<typeof getOutlineToPack>[1], packSnapshotId(cached!.agent), fileRefs);
        return { content: [{ type: 'text', text }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ path: relPath, outline: outline.declarations, refs: fileRefs }) }] };
    }
    const abs = resolveInRoot(root, relPath); // SEC: reject paths escaping the project root
    if (!existsSync(abs)) throw new Error(`File not found: ${relPath}`);
    try {
      const source = readFileSync(abs, 'utf8');
      const ext = path.extname(relPath).toLowerCase();
      const live = extractOutline(source, ext);
      if (fmt === 'pack') {
        /* Live outline returns OutlineNode[]; cast to ExtractedSymbol[]
           shape — both share { name, kind, startLine, endLine,
           exported, children? } so the converter handles both. */
        const text = getOutlineToPack(relPath, live as unknown as Parameters<typeof getOutlineToPack>[1], packSnapshotId(cached!.agent), fileRefs);
        return { content: [{ type: 'text', text }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ path: relPath, outline: live, refs: fileRefs }) }] };
    } catch (err) {
      throw new Error(`Failed to extract outline for ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (name === MCP_TOOL.list_risks) {
    if (!cached) await ensureAnalyzed();
    const sev = args.severity as string | undefined;
    const cat = args.category as string | undefined;
    let risks = cached!.agent.risks;
    if (sev) risks = risks.filter((r) => r.severity === sev);
    if (cat) risks = risks.filter((r) => r.category === cat);
    if (pickFormat(args) === 'pack') {
      return { content: [{ type: 'text', text: listRisksToPack(risks, packSnapshotId(cached!.agent)) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ count: risks.length, risks }) }] };
  }

  /* v0.6 — credentials = filtered risks. Same data, different lens.
     Defined as its own tool so agents asking "any leaked secrets?"
     don't have to know the category-filter trick. */
  if (name === MCP_TOOL.list_credentials) {
    if (!cached) await ensureAnalyzed();
    const sev = args.severity as string | undefined;
    let creds = cached!.agent.risks.filter((r) => r.category === 'secret');
    if (sev) creds = creds.filter((r) => r.severity === sev);
    return { content: [{ type: 'text', text: JSON.stringify({ count: creds.length, credentials: creds }) }] };
  }

  /* v0.6 — vulnerabilities pulled from agent.vulnerabilities (populated
     by `factstack scan-vulns`). When empty, signal "scan not run" vs
     "scan ran, zero findings" so agents can react accordingly. */
  if (name === MCP_TOOL.list_vulnerabilities) {
    if (!cached) await ensureAnalyzed();

    /* v0.11 — refresh: re-query OSV.dev live and PERSIST, so agents can
       update the vulnerability list on demand instead of waiting for a human
       `scan-vulns` run. Opt-in network (analyze itself stays network-free,
       INV6). The persisted artifact + scan metadata then survive future
       re-analyzes via restoreVulnScanInto. */
    if (args.refresh === true) {
      const flat = flattenManifests(cached!.agent.dependencyManifests);
      const queries: OsvQuery[] = [];
      let skipped = 0;
      for (const e of flat) {
        const concrete = e.ecosystem === 'npm' ? normalizeNpmVersion(e.version) : e.version;
        if (!concrete) { skipped++; continue; }
        queries.push({ ecosystem: e.ecosystem, name: e.name, version: concrete, manifestPath: e.manifestPaths[0] ?? '' });
      }
      try {
        const results = await queryOsvBatch(queries, { cache: noopCache });
        const vulnerabilities = osvResultsToVulnerabilities(results);
        // EH-3: surface how many advisories degraded to id-only (detail fetch
        // failed) so a degraded scan is distinguishable from a clean one.
        const detailsFailed = results.reduce((n, r) => n + (r.detailsFailed ?? 0), 0);
        const nextAgent: AgentArtifact = {
          ...cached!.agent,
          vulnerabilities,
          vulnerabilityScan: {
            scannedAt: new Date().toISOString(),
            source: 'osv.dev',
            packagesQueried: queries.length,
            packagesSkipped: skipped,
            findings: vulnerabilities.length,
            ...(detailsFailed > 0 ? { detailsFailed } : {}),
          },
        };
        // v0.3 — re-grade health so the freshly-fetched CVEs land in the
        // score/headline written to human.json + MEMORY.md. Build the updated
        // human immutably and only swap `cached` AFTER the write succeeds — a
        // failed write must leave the in-memory cache consistent (old agent +
        // old health together), matching the catch block's "stale data stays
        // untouched" promise.
        const updatedHuman: HumanArtifact = {
          ...cached!.human,
          summary: { ...cached!.human.summary, health: computeHealth(nextAgent) },
        };
        const memoryBody = buildMemory(nextAgent, updatedHuman, { contextStore: buildContextStore(readLearnings()) });
        // CONC-1: serialize this write+swap through the SAME fence `analyze`
        // uses, so a concurrent analyze + refresh can't interleave two
        // writeArtifacts calls (which would leave disk and `cached` pointing at
        // different graph states). Mirror enqueueAnalyze: keep the chain alive
        // with `.catch`, but `await work` (not the chain) so a failed write
        // still propagates to the catch below — preserving the "swap `cached`
        // only after the write succeeds" crash-safety contract above.
        const work = analyzeChain.then(async () => {
          await writeArtifacts({ root, agent: nextAgent, human: updatedHuman, addGitignoreEntry: false, memoryBody });
          cached = { agent: nextAgent, human: updatedHuman, memory: memoryBody };
        });
        analyzeChain = work.catch(() => undefined);
        await work;
      } catch (err) {
        /* A failed refresh must NEVER look like a successful empty scan —
           return an explicit error; the stale data stays untouched on disk. */
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `OSV refresh failed: ${(err as Error).message}`, hint: 'Network/OSV.dev issue — the previously scanned data is unchanged. Retry later or run `factstack scan-vulns`.' }) }],
          isError: true,
        };
      }
    }

    const sev = args.severity as string | undefined;
    const eco = args.ecosystem as string | undefined;
    const pkg = args.package as string | undefined;
    let findings = cached!.agent.vulnerabilities;
    if (sev) findings = findings.filter((v) => v.severity === sev);
    if (eco) findings = findings.filter((v) => v.ecosystem === eco);
    if (pkg) findings = findings.filter((v) => v.package === pkg);
    /* Most-recent lastChecked across all findings — null when array
       is empty. Kept for backward compat; `scan` (v0.11) is the better
       signal because it also marks a scanned-and-CLEAN artifact. */
    const lastChecked = cached!.agent.vulnerabilities.reduce(
      (m, v) => Math.max(m, v.lastChecked), 0,
    ) || null;
    const scan = cached!.agent.vulnerabilityScan ?? null;
    const VULN_SCAN_STALE_DAYS = 7;
    const scanAgeDays = scan ? Math.max(0, Math.floor((Date.now() - Date.parse(scan.scannedAt)) / 86_400_000)) : null;
    const stale = scanAgeDays !== null && scanAgeDays >= VULN_SCAN_STALE_DAYS;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: findings.length,
          lastChecked,
          scan,
          scanAgeDays,
          stale,
          manifestCount: cached!.agent.dependencyManifests.length,
          hint: scan === null
            ? 'No vulnerability scan recorded for this artifact. Pass refresh:true (queries OSV.dev live) or run `factstack scan-vulns .`.'
            : stale
              ? `Scan is ${scanAgeDays}d old — new CVEs are published daily. Pass refresh:true to update.`
              : undefined,
          findings,
        }),
      }],
    };
  }

  if (name === MCP_TOOL.read_memory) {
    if (!cached) await ensureAnalyzed();
    // Return as plain text so agents render it as markdown directly.
    // A JSON wrapper would force them to unwrap before reading.
    return { content: [{ type: 'text', text: cached!.memory }] };
  }

  // v0.3.2 — what changed since X?
  if (name === MCP_TOOL.since) {
    if (!cached) await ensureAnalyzed();
    const ts = typeof args.timestamp === 'string' ? args.timestamp : '';
    if (!ts) throw new Error("since: 'timestamp' (ISO 8601) is required");
    /* Load the most recent PRIOR full snapshot as a baseline. requireFull=true
       skips stats-only rollup snapshots (which lack files[]) — without it,
       sinceFromBaseline runs prior.files.map(...) and throws a TypeError on
       essentially every real call (the server writes a rollup snapshot each
       boot). Excluding the head's own generatedAt avoids a head-vs-head no-op
       diff, mirroring review_change. No full baseline -> undefined -> the
       since() dispatcher falls back to mtime-only mode. */
    const baseline = readLatestSnapshot(cached!.agent.generatedAt, true);
    const report = buildSinceReport(cached!.agent, ts, baseline ?? undefined);
    return { content: [{ type: 'text', text: JSON.stringify(report) }] };
  }

  // v0.3.4 — append a learning event to .facts/learnings.jsonl.
  if (name === MCP_TOOL.log_learning) {
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
      // EH-1: a validation failure is a caller error — signal it with
      // isError:true (clients gate on that, like every other validation path in
      // this file) and surface structured Zod issues when available.
      const issues = err && typeof err === 'object' && Array.isArray((err as { issues?: unknown }).issues)
        ? (err as { issues: Array<{ path?: unknown[]; message?: unknown }> }).issues.map((i) => ({
            field: Array.isArray(i.path) ? i.path.join('.') : '',
            message: String(i.message ?? ''),
          }))
        : undefined;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (err as Error).message, ...(issues ? { issues } : {}) }) }], isError: true };
    }
    try {
      appendLearning(event);
      // Mirror to the user's PRIVATE per-account Firestore store (best-effort;
      // firestoreSet swallows network errors so a hiccup never fails the tool).
      // Rules scope users/{uid} to its owner — no other user can read it.
      const learnId = String(event.timestamp).replace(/[^0-9A-Za-z_-]/g, '_');
      await firestoreSet(session, `users/${session.uid}/learnings/${learnId}`, {
        agent: event.agent,
        action: event.action,
        outcome: event.outcome,
        at: event.timestamp,
      });
      await firestoreSet(session, `users/${session.uid}`, {
        email: session.email ?? '',
        uid: session.uid,
        lastSeen: event.timestamp,
      });
    } catch (appendErr) {
      // The write can fail (ENOSPC / EACCES / EROFS / Windows EBUSY). The event
      // validated, so report a structured failure rather than throwing a raw MCP
      // protocol error — mirrors the wrapped append in get_context.
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `event validated but write failed: ${appendErr instanceof Error ? appendErr.message : String(appendErr)}` }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, timestamp: event.timestamp }) }] };
  }

  // v0.3.4 — read + filter learnings.jsonl.
  if (name === MCP_TOOL.query_learnings) {
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
    if (pickFormat(args) === 'pack') {
      const sid = cached ? packSnapshotId(cached.agent) : new Date().toISOString();
      return { content: [{ type: 'text', text: queryLearningsToPack(result, sid) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ count: result.length, events: result }) }] };
  }

  // v0.3.6 — env-var inventory.
  if (name === MCP_TOOL.get_config) {
    if (!cached) await ensureAnalyzed();
    const config = cached!.agent.config ?? { envVars: [], schemas: [] };
    if (pickFormat(args) === 'pack') {
      return { content: [{ type: 'text', text: getConfigToPack(config.envVars, packSnapshotId(cached!.agent)) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(config) }] };
  }

  // Change Verdict: head (current analysis) vs latest snapshot baseline.
  if (name === MCP_TOOL.review_change) {
    if (!cached) await ensureAnalyzed();
    // Exclude the head's own snapshot (analyze writes one each run) so we
    // compare against the PRIOR state, not head-vs-head.
    const baseline = readLatestSnapshot(cached!.agent.generatedAt, true);
    if (!baseline) {
      // EH-2: a missing baseline is an actionable precondition failure, not a
      // silent empty result — signal isError:true so clients surface it.
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'No baseline snapshot in .facts/snapshots/ to compare against. Run `factstack analyze` after a change to create one, then retry.' }) }],
        isError: true,
      };
    }
    const verdict = buildChangeVerdict(baseline, cached!.agent);
    if (args.format === 'markdown') {
      return { content: [{ type: 'text', text: renderVerdictMarkdown(verdict) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(verdict) }] };
  }

  // F7 — token cost of a file or a raw snippet.
  if (name === MCP_TOOL.count_tokens) {
    const parsed = CountTokensInputSchema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid count_tokens input', issues }, null, 2) }],
        isError: true,
      };
    }
    // Raw text → pure estimate, no analysis needed.
    if (parsed.data.text !== undefined) {
      const text = parsed.data.text;
      return { content: [{ type: 'text', text: JSON.stringify({ tokens: approximateTokens(text), chars: text.length, source: 'estimate' }) }] };
    }
    // Path → prefer the artifact's exact pre-computed tokenCost; else live-read.
    if (!cached) await ensureAnalyzed();
    const relPath = String(parsed.data.path);
    const fileEntry = cached!.agent.files.find((f) => f.path === relPath);
    if (fileEntry) {
      return { content: [{ type: 'text', text: JSON.stringify({ path: relPath, tokens: fileEntry.tokenCost, source: 'artifact' }) }] };
    }
    let abs: string;
    try {
      abs = resolveInRoot(root, relPath); // SEC: reject paths escaping the project root
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Path outside project root' }) }], isError: true };
    }
    if (!existsSync(abs)) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `File not found: ${relPath}` }) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ path: relPath, tokens: approximateTokens(readFileSync(abs, 'utf8')), source: 'estimate' }) }] };
  }

  // F4 — assemble a ranked, token-budgeted context block for a task.
  if (name === MCP_TOOL.get_context) {
    if (!cached) await ensureAnalyzed();
    const parsed = ContextInputSchema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid get_context input', issues }, null, 2) }],
        isError: true,
      };
    }
    const agent = cached!.agent;
    const snapshotId = packSnapshotId(agent);
    // F9 — re-rank by what the agent recently served/read/edited (session
    // actions in the learnings log). Best-effort: a missing/corrupt log just
    // means no boost, never a failed call.
    const sessionEvents = readLearnings();
    const recentEntities = recentSessionEntities(sessionEvents);
    const result = assembleContext(agent, {
      query: parsed.data.query,
      ...(parsed.data.seeds !== undefined ? { seeds: parsed.data.seeds } : {}),
      budgetTokens: parsed.data.budgetTokens,
      maxHops: parsed.data.maxHops,
      ...(recentEntities.length ? { recentEntities } : {}),
    });
    // F9 — record what we served so the NEXT call (this session or the next)
    // re-ranks toward the entities in flight. Best-effort by the same logic.
    // Consecutive-dedup: an agent re-asking the same question must not grow the
    // log one identical `served` line per call.
    try {
      const servedIds = result.items.map((i) => i.id);
      if (JSON.stringify(servedIds) !== JSON.stringify(lastServedEntities(sessionEvents))) {
        appendLearning(sessionActionEvent({
          action: 'served',
          entities: servedIds,
          tokens: result.totalTokens,
        }));
      }
    } catch { /* serving context must never fail on a log write */ }
    if (pickFormat(args) === 'pack') {
      return { content: [{ type: 'text', text: contextToPack(result, snapshotId) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  if (name === MCP_TOOL.sync_pack) {
    if (!cached) await ensureAnalyzed();
    const parsed = SyncPackInputSchema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'invalid sync_pack input', issues }) }],
        isError: true,
      };
    }
    const have = parsed.data.have;
    const masterPath = path.join(root, '.facts', 'agent.pack');
    const diffPath = path.join(root, '.facts', 'agent.diff.pack');

    // The on-disk master IS the current pack — analyze() writes it in lockstep
    // with cached.agent. Read it + the diff sidecar (best-effort) and let the
    // pure resolver decide current/diff/full.
    let masterBody: string;
    try {
      masterBody = readFileSync(masterPath, 'utf8');
    } catch {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: 'no readable agent.pack — run analyze first' }) }],
        isError: true,
      };
    }
    let diffBody: string | undefined;
    if (existsSync(diffPath)) {
      try { diffBody = readFileSync(diffPath, 'utf8'); } catch { diffBody = undefined; }
    }

    const result = resolveSyncPack(masterBody, diffBody, have);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.status === 'error' ? { isError: true } : {}),
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

/* ─── v0.3.2 / v0.3.4 helpers ───────────────────────────────────── */

type SnapshotArtifact = import('@factstack/spec').AgentArtifact;

/** Load a single snapshot entry: a flat `<ts>.json` file (the format CLI
 *  `analyze` writes) OR a legacy `<ts>/agent.json` directory. Returns null
 *  on anything unreadable. */
function loadSnapshotEntry(snapDir: string, entry: string): SnapshotArtifact | null {
  const candidate = entry.endsWith('.json')
    ? path.join(snapDir, entry)
    : path.join(snapDir, entry, 'agent.json');
  if (!existsSync(candidate)) return null;
  try {
    return JSON.parse(readFileSync(candidate, 'utf8')) as SnapshotArtifact;
  } catch {
    return null;
  }
}

/**
 * Newest snapshot artifact, scanning timestamp-sorted entries from the end.
 * `excludeGeneratedAt` skips a snapshot whose generatedAt matches it — used
 * by review_change so it compares the head against the PRIOR state, not the
 * snapshot `analyze` just wrote for this same head (which would always read
 * as "no change").
 */
function readLatestSnapshot(excludeGeneratedAt?: string, requireFull = false): SnapshotArtifact | null {
  try {
    const snapDir = path.join(root, '.facts', 'snapshots');
    if (!existsSync(snapDir)) return null;
    const entries = readdirSyncSafe(snapDir).sort();
    for (let i = entries.length - 1; i >= 0; i--) {
      const art = loadSnapshotEntry(snapDir, entries[i]!);
      if (!art) continue;
      if (excludeGeneratedAt && art.generatedAt === excludeGeneratedAt) continue;
      // review_change needs a FULL artifact (files[] + graph) to diff +
      // compute blast radius. Snapshots can be rolled-up stat summaries
      // without files[]; skip those so we land on a usable baseline.
      if (requireFull && (!Array.isArray(art.files) || !art.graph)) continue;
      return art;
    }
    return null;
  } catch {
    return null;
  }
}

function readdirSyncSafe(p: string): string[] {
  // The server is ESM ("type":"module"), so `require` is not defined here —
  // the previous require('node:fs') threw on every call, silently returning
  // [] and breaking snapshot-baseline discovery for both `since` and
  // `review_change`. Use the static import instead.
  try {
    return readdirSync(p);
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
  // Best-effort: a missing, locked (Windows EBUSY), or otherwise unreadable
  // learnings log must NOT throw inside a tool handler — return []. Mirrors the
  // CLI's readLearningEvents. Callers treat absence as "no working context".
  try {
    const p = learningsPath();
    if (!existsSync(p)) return [];
    const text = readFileSync(p, 'utf8');
    return parseLearningsJsonl(text).events;
  } catch {
    return [];
  }
}

/* v0.11 — carry the last vulnerability scan across the server's own
 * re-analyzes, reconciled against the FRESH manifests so removed/upgraded
 * deps drop their stale findings. Raw parse (not schema validation): the
 * prior artifact may predate the current schema and we only need two
 * additive fields. Best-effort — an unreadable prior artifact just means
 * nothing to carry; `scan-vulns` / `list_vulnerabilities refresh:true`
 * rebuilds. */
function restoreVulnScanInto(agent: AgentArtifact): void {
  try {
    const p = path.join(root, '.facts', 'agent.json');
    if (!existsSync(p)) return;
    const prev = JSON.parse(readFileSync(p, 'utf8')) as Partial<AgentArtifact>;
    if (!prev.vulnerabilityScan) return;
    agent.vulnerabilities = reconcileVulnerabilities(prev.vulnerabilities ?? [], agent.dependencyManifests);
    /* Recompute `findings` to mirror the reconciled array — the spec's
       scanned-and-clean marker must not contradict agent.vulnerabilities.length
       (list_vulnerabilities returns both in one payload). */
    agent.vulnerabilityScan = { ...prev.vulnerabilityScan, findings: agent.vulnerabilities.length };
  } catch { /* best-effort */ }
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
  // `factstack-mcp login` — one-time Google sign-in (loopback), then exit.
  // Gated tool calls (see the CallTool handler) tell the user to run this.
  if (process.argv.includes('login')) {
    try {
      const s = await login();
      process.stderr.write(
        `[factstack-mcp] signed in as ${s.email ?? s.uid}. Your FACTS data is now private to your account.\n`,
      );
      process.exit(0);
    } catch (e) {
      process.stderr.write(`[factstack-mcp] login failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  }
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

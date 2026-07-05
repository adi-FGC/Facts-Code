/**
 * MCP tool catalog — the single source of truth for shipped MCP tool metadata
 * (name / description / inputSchema + onboarding metadata).
 *
 * NOTE: currently re-exported from the package barrel (`index.ts`), so the ~20 KB
 * of tool descriptions/schemas lands in browser bundles that import `@factstack/spec`
 * (apps/ui-remix) — that's why the UI bundle-size caps were bumped. Splitting it back
 * to a subpath-only export (`@factstack/spec/mcp-catalog`) to trim that weight is a
 * tracked follow-up (see the cap notes in apps/ui-remix/scripts/check-bundle-size.mjs);
 * it needs a working workspace subpath link, which the broken pnpm in this env blocks.
 *
 * Consumers: apps/mcp-server (ListTools), @factstack/registry, @factstack/skills.
 */
import { MCP_TOOL, QUERY_VERBS, MCP_TOOL_NAMES } from './mcp.js';
import type { ShippedMcpToolName } from './mcp.js';

/* ─────────── MCP tool catalog: the single source of truth ─────────── */

/**
 * Full, wire-shaped description of a shipped MCP tool — everything the
 * server's `ListTools` handler needs (`name` / `description` /
 * `inputSchema`) plus optional onboarding metadata the discoverability
 * artifacts (llms.txt, .well-known/mcp.json, AGENTS.md, README tables)
 * derive from.
 *
 * `MCP_TOOL_CATALOG` below is the ONE place these live. The MCP server
 * maps this array straight into its ListTools payload — so the README
 * can no longer claim "5 tools" while the server ships 17. The catalog
 * is completeness-checked against `MCP_TOOL_NAMES` at compile time (see
 * the `satisfies`-backed assertion after the array).
 */
export interface McpToolMeta {
  name: ShippedMcpToolName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** One-line note for the curated onboarding sequence. Present only on
   *  the 6 onboarding tools; undefined on the other 11. */
  onboardingNote?: string;
  /** 1-based position in the curated cold-start sequence (1..6). Only the
   *  6 onboarding tools carry it; the rest are undefined. Mirrors
   *  `@factstack/skills` ONBOARDING_SEQUENCE. */
  onboardingOrder?: number;
}

/**
 * Every tool the FACTS MCP server ships, in `ListTools` order, with the
 * EXACT `name` / `description` / `inputSchema` the server advertises.
 * `apps/mcp-server` renders its ListTools payload from this array, so the
 * two can never drift.
 *
 * PORTED VERBATIM from `apps/mcp-server/src/server.ts`'s
 * `ListToolsRequestSchema` handler — the wire contract is byte-identical.
 * `query_graph`'s `verb` enum references `QUERY_VERBS` (the shared verb
 * tuple above) exactly as the server did.
 */
export const MCP_TOOL_CATALOG: readonly McpToolMeta[] = [
  {
    name: MCP_TOOL.analyze,
    description: 'Run a full FACTS analysis of the configured project. Writes .facts/ artifacts and refreshes the server cache. Response includes a `version` block: `facts` (artifact schema version), `schemas` (per-format wire-format names + versions), `producer` (this MCP server\'s identity). Agents SHOULD reject mismatched versions loudly per spec §11.',
    inputSchema: {
      type: 'object',
      properties: {
        useCache: { type: 'boolean', description: 'Return cached result if still valid.', default: true },
      },
    },
    onboardingOrder: 2,
    onboardingNote: 'kick a fresh analysis if MEMORY.md is stale',
  },
  {
    name: MCP_TOOL.query_graph,
    description: 'Query the graph by verb. File-level: callers (files importing X), imports (files imported BY X), cycles, orphans, impact (blast radius — everything transitively affected by changing X). Symbol-level (needs --symbols analysis): neighbors (adjacent nodes; pass direction), references (symbols that reference X), implementers (symbols that extend/implement X), path-between (shortest path from `path` to `to`). Returns FactsPack by default (line-oriented, ~80% cheaper than JSON; see docs/FACTSPACK_PROMPT.md). Pass format:"json" for the legacy JSON shape.',
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', enum: [...QUERY_VERBS], default: 'callers' },
        path: { type: 'string', description: 'Target file path or symbol id (path#name@line); source endpoint for path-between.' },
        to: { type: 'string', description: 'Destination endpoint — path-between only.' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Traversal direction for neighbors (default both).' },
        filter: { type: 'string' },
        limit: { type: 'number', default: 200 },
        depth: { type: 'number', description: 'Transitive depth. Default 1 for most verbs; 3 for `impact` (blast radius) when omitted.' },
        minConfidence: { type: 'string', enum: ['extracted', 'inferred', 'ambiguous'], description: 'Keep only edges at least this certain.' },
        format: { type: 'string', enum: ['pack', 'json'], default: 'pack' },
      },
    },
    onboardingOrder: 3,
    onboardingNote: 'answer "who calls X?" / "what imports X?"',
  },
  {
    name: MCP_TOOL.query,
    description: 'Free-text or declarative graph query → a connected subgraph with file:line citations. Pass `q` (a question like "who calls buildMemory" / "what does src/auth.ts import" / "path between A and B" / "unused files") resolved deterministically against real entity names (no LLM, INV3), OR a structured `query` GraphQuery object. Returns FactsPack (schema subgraph-v1: nodes + edges + citations + a truncation marker) by default; pass format:"json" for JSON. When a name is ambiguous or unmatched, returns a ranked "did you mean" candidate list instead of guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free-text question.' },
        query: { type: 'object', description: 'Structured GraphQuery (start/traverse/where/select/limit).' },
        format: { type: 'string', enum: ['pack', 'json'], default: 'pack' },
      },
    },
  },
  {
    name: MCP_TOOL.get_outline,
    description: 'Return the symbol outline (declarations) for a single file, computed live from the source, plus a `refs` table of outgoing symbol-graph edges with confidence (populated when the project was analyzed with --symbols). Returns FactsPack by default; pass format:"json" for the legacy JSON shape.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        format: { type: 'string', enum: ['pack', 'json'], default: 'pack' },
      },
    },
  },
  {
    name: MCP_TOOL.list_risks,
    description: 'List scanner findings, optionally filtered by severity or category. Returns FactsPack by default; pass format:"json" for the legacy JSON shape.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
        category: { type: 'string', enum: ['secret', 'license', 'supply-chain', 'parse-error', 'broken-import', 'stale', 'large-file', 'cycle'] },
        format: { type: 'string', enum: ['pack', 'json'], default: 'pack' },
      },
    },
    onboardingOrder: 4,
    onboardingNote: 'full risk surface (filterable by severity/category)',
  },
  {
    // v0.3.1: the brief AI agents read FIRST when joining the project.
    // Returns a 2-10 KB markdown digest synthesized from agent.json
    // + human.json. Cheaper than walking agent.json by 10-100x for
    // the cold-start case. Re-run `analyze` to refresh.
    name: MCP_TOOL.read_memory,
    description: 'Read .facts/MEMORY.md — a compact (2-10 KB) markdown brief that summarizes the project for AI agents. ALWAYS call this first when joining a new project; it replaces a 40-200 KB cold-read of agent.json.',
    inputSchema: { type: 'object', properties: {} },
    onboardingOrder: 1,
    onboardingNote: 'fast 2-10 KB project brief — call this first',
  },
  {
    // v0.3.2: cross-session state recovery for long-running agents.
    // Returns a structured "what changed since X" report — added /
    // modified / removed files + new routes + new risks — so the
    // agent reads ~5 KB instead of re-fetching the full artifact.
    name: MCP_TOOL.since,
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
    name: MCP_TOOL.log_learning,
    description: 'Append a proposal/outcome event to .facts/learnings.jsonl. Use to record what your agent proposed and whether the human accepted, rejected, or left it pending. Required: agent (your stable id), action (verb-form, ≤64 chars), outcome (accepted|rejected|pending|self-calibrate). Optional: model, ticketId, reasoning, filesAffected, confidence (0..1), tags. F9 conventions: action decision|fact|task|question records DURABLE working context (text in `reasoning`; outcome pending = open task/question, re-log with accepted to close) — it surfaces in MEMORY.md\'s Working context and biases get_context; action served|read|edited|queried records session activity (entity ids in filesAffected) that re-ranks the next get_context call.',
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
    name: MCP_TOOL.query_learnings,
    description: 'Filter .facts/learnings.jsonl by since/until/agent/outcome/action/tag. Returns most-recent-first, capped at 5000 events. Use for "what has this codebase\'s agents been right about?" calibration questions. Returns FactsPack by default; pass format:"json" for the legacy JSON shape.',
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
        format: { type: 'string', enum: ['pack', 'json'], default: 'pack' },
      },
    },
  },
  {
    // v0.3.6: env-var inventory. Returns the same data the UI's
    // Config tab renders — every var name, read sites, captured
    // defaults, primary access pattern.
    name: MCP_TOOL.get_config,
    description: 'List every environment variable read by the codebase, with read sites + captured defaults. Sorted by read count desc. Empty when no env reads are detected. Returns FactsPack by default (one row per read site); pass format:"json" for the legacy JSON shape (one entry per name, with reads[] nested).',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['pack', 'json'], default: 'pack' },
      },
    },
  },
  {
    /* v0.6 — flat view of secret-scanner findings (subset of risks
       filtered to category === 'secret'). Convenience for agents
       auditing credential hygiene without re-deriving the filter. */
    name: MCP_TOOL.list_credentials,
    description: 'List leaked-credential findings from the secrets scanner — all `risks` entries with category === "secret". Each finding includes ruleId, file, line, severity, and a redacted preview (raw secrets are NEVER emitted; enforced at the type level in @factstack/scanners). JSON-only response.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
      },
    },
    onboardingOrder: 5,
    onboardingNote: 'leaked-secrets sub-view',
  },
  {
    /* v0.6 — CVE findings from the last `factstack scan-vulns` run.
       Empty when scan-vulns hasn't been run; tells the agent
       explicitly so it can advise running it. */
    name: MCP_TOOL.list_vulnerabilities,
    description: 'List known CVE/GHSA advisories matched against the project\'s dependency manifests. Returns {findings, scan, scanAgeDays, stale, lastChecked, manifestCount}. `scan` carries the last scan\'s metadata (scannedAt, packagesQueried, findings) — scan:null means never scanned; scan present with findings:0 means scanned-and-clean. When `stale` is true (scan older than 7 days) or scan is null, pass refresh:true to UPDATE the list: it re-queries OSV.dev live and persists the result into .facts/ (survives future re-analyzes). Refresh is the only network call; plain listing reads the artifact. Filterable by severity / ecosystem / package name.',
    inputSchema: {
      type: 'object',
      properties: {
        severity:  { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'unknown'] },
        ecosystem: { type: 'string', enum: ['npm', 'pypi', 'cargo', 'go', 'maven', 'rubygems', 'unknown'] },
        package:   { type: 'string', description: 'Filter to advisories affecting this exact package name.' },
        refresh:   { type: 'boolean', description: 'Re-query OSV.dev live and persist the updated list + scan metadata before returning (the update mechanism). Default false (artifact read only).', default: false },
      },
    },
    onboardingOrder: 6,
    onboardingNote: 'CVE findings from `factstack scan-vulns`',
  },
  {
    /* v0.7.1 — the dependency graph as a Mermaid flowchart. Lets an
       agent SEE the architecture as cheap text instead of inferring
       it from query_graph calls. Three views:
         package — inter-package edges (the architectural summary)
         hub     — the most-imported files + their importers
         focal   — caller graph rooted on one file (--focus), depth-capped
       Returns bare Mermaid source (drops into any ```mermaid block). */
    name: MCP_TOOL.get_diagram,
    description: 'Render the dependency graph as a Mermaid flowchart. view=package (inter-package edges, the architectural summary) | hub (most-imported files + importers) | focal (caller graph rooted on `focus`, requires it). Returns ready-to-embed Mermaid source — paste into a PR/README, or read it to grasp the shape without walking query_graph. Edge style: --> import, -.-> type-import, ==> dynamic.',
    inputSchema: {
      type: 'object',
      properties: {
        view:  { type: 'string', enum: ['package', 'hub', 'focal'], default: 'package' },
        focus: { type: 'string', description: 'Project-relative file path; required when view=focal.' },
        depth: { type: 'number', description: 'Max BFS depth for focal view (default 2, max 5).', default: 2 },
      },
    },
  },
  {
    name: MCP_TOOL.review_change,
    description: 'Change Verdict: compares the current analysis (head) against the most recent .facts/snapshots/ baseline and returns ONE opinionated risk verdict — severity + headline + grounded findings (new secrets, new CVEs, new dependency cycles, blast radius). Structured JSON by default; pass format:"markdown" for a PR-comment-ready block. When no baseline snapshot exists, returns {ok:false} advising to run `factstack analyze` again to create one. Cheaper + more decisive than walking the diff yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'markdown'], description: 'Response shape (default json).', default: 'json' },
      },
    },
  },
  {
    name: MCP_TOOL.count_tokens,
    description: 'Estimate the AI-context token cost of a project file (by `path`) or a raw `text` snippet. For a `path` already in the analyzed artifact this returns the EXACT pre-computed tokenCost; otherwise it live-reads + estimates (char-based cl100k approximation, within ~8% of tiktoken). Answers "does this fit in context?" / "how much will reading this cost?". JSON response. Exactly one of path/text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        text: { type: 'string', description: 'Raw text to estimate instead of a file.' },
      },
    },
  },
  {
    name: MCP_TOOL.get_context,
    description: 'F4 — assemble a task-scoped, ranked, token-budgeted CONTEXT BLOCK for a coding task. Give a free-text `query` (e.g. "add a role field to User") and optionally explicit `seeds`; FACTS resolves seeds in the graph, expands `maxHops` (default 2), ranks candidates by importance (PageRank) + proximity + name-match + recency, and packs the best anchors under `budgetTokens` (default 8000). Returns a FactsPack `context-v1`: ranked file/symbol anchors with file:line citations + per-item token cost, plus the connecting edges. Read this UP FRONT instead of issuing many exploratory reads. Seeds are never dropped; a budget-capped or cold-start (no match) result is flagged in `meta`. PACK by default; pass format:"json" for JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The coding task in plain words, e.g. "add a role field to User".' },
        seeds: { type: 'array', items: { type: 'string' }, description: 'Optional explicit seed file paths or symbol ids to anchor on.' },
        budgetTokens: { type: 'number', description: 'Token budget for the assembled context (default 8000).', default: 8000 },
        maxHops: { type: 'number', description: 'Graph expansion radius from the seeds (default 2).', default: 2 },
        format: { type: 'string', enum: ['pack', 'json'], description: 'Response shape (default pack).', default: 'pack' },
      },
      required: ['query'],
    },
  },
  {
    name: MCP_TOOL.sync_pack,
    description: 'F8 — fetch the current agent.pack as a SMALL DIFF when you already hold the previous master, instead of re-reading the whole pack. Pass `have` = the 12-hex sha256 from the trailer of the pack you last received (omit on first fetch). JSON envelope: `{ status, sha, pack? }`. status="current" (you are up to date; no pack), "diff" (pack is the row-level delta — read the + added / x removed rows and apply them onto your held master), or "full" (pack is the complete master — adopt it). `sha` is the current master sha; pass it back as `have` next time. Reads the cached analysis (call `analyze` first to refresh against changed code).',
    inputSchema: {
      type: 'object',
      properties: {
        have: {
          type: 'string',
          description: 'The 12-hex sha256 of the agent.pack master you currently hold (from a prior sync_pack `sha` / the pack trailer). Omit on first fetch.',
        },
      },
    },
  },
];

/**
 * Compile-time completeness assertion: the tuple of catalog names must
 * equal `MCP_TOOL_NAMES` element-for-element, in the SAME ORDER, with no
 * gaps, extras, or reordering. Because `MCP_TOOL_CATALOG` is annotated as
 * `readonly McpToolMeta[]` its positional literals are erased, so we build
 * the expected name tuple from `MCP_TOOL_NAMES` itself and `satisfies`
 * it against the McpToolMeta['name'] union — this fails `tsc` if any
 * catalog entry names a tool outside the union. The runtime helper below
 * pins ORDER + COUNT (the part types can't see through the widened array
 * annotation) and is exercised by the spec + registry test suites.
 *
 * (Same spirit as the `MCP_TOOL` map's `satisfies` check above.)
 */
const _MCP_TOOL_NAMES_COMPLETE = MCP_TOOL_NAMES satisfies readonly ShippedMcpToolName[];
void _MCP_TOOL_NAMES_COMPLETE;

/** True when the catalog lists exactly `MCP_TOOL_NAMES`, in order. Kept as
 *  an exported predicate so the MCP server + spec tests can assert the
 *  wire contract at runtime (the widened `readonly McpToolMeta[]`
 *  annotation hides positional literals from the type system). */
export function mcpCatalogMatchesNames(): boolean {
  const names = MCP_TOOL_CATALOG.map((t) => t.name);
  return (
    names.length === MCP_TOOL_NAMES.length &&
    names.every((n, i) => n === MCP_TOOL_NAMES[i])
  );
}

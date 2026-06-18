/**
 * MCP tool response → FactsPack converters.
 *
 * One file, one helper per tool that returns tabular data. Each
 * helper takes the same input shape the JSON branch consumes and
 * returns a PACK string ready to send back to the agent.
 *
 * Why per-tool helpers instead of a generic `anyToPack(rows)`? Because
 * each tool's column choices (which fields to intern, what to call
 * the primary key, whether to flatten nested data) is a deliberate
 * decision. A generic helper either over-interns (wasting `@` lines on
 * unique values) or under-interns (paying full path bytes per row).
 *
 * Pure / no Node imports — just data manipulation. Each returns a
 * PACK string that includes its own header line.
 */

import { encode, type PackHeader, type PackRow, type PackTable } from '@factstack/factspack';
import type { AgentArtifact, Risk, RouteDecl, EnvVar, SymbolEdge } from '@factstack/spec';
import type { ExtractedSymbol } from '@factstack/extractors';
import type { LearningEvent, QueryResult } from '@factstack/core';

const PRODUCER = 'factstack/0.3.10';

function header(schema: string, snapshotId: string): PackHeader {
  return { producer: PRODUCER, schema, snapshotId, rowCount: null };
}

/* ───────────── query_graph → PACK ─────────────
 *
 * The four verbs return three different row shapes:
 *
 *   callers / imports / orphans  → single-column table `paths`
 *                                   with interned `F` column
 *   cycles                       → two-column flattened table
 *                                   `cycles` with `cycleId` (literal,
 *                                   PK) + interned `F`
 *
 * Each path repeats heavily across calls, so interning shines here.
 */
export function queryGraphToPack(result: QueryResult, snapshotId: string): string {
  const tables: PackTable[] = [];

  if (result.verb === 'cycles') {
    const cycles = (result.results as string[][]) ?? [];
    const rows: PackRow[] = [];
    cycles.forEach((cycle, i) => {
      cycle.forEach((path) => {
        rows.push([String(i), path]);
      });
    });
    tables.push({
      name: 'cycles',
      columns: [{ name: 'cycleId' }, { name: 'F' }],
      rows,
    });
  } else {
    /* callers / imports / orphans all return string[]. The PK is the
       index — agents iterate in order. `F` interns repeated paths
       (rare in a single call's results but consistent with the
       multi-call dictionary the agent will accumulate via the
       8-line preamble). */
    const paths = (result.results as string[]) ?? [];
    const rows: PackRow[] = paths.map((p, i) => [String(i), p]);
    tables.push({
      name: result.verb === 'orphans' ? 'orphans' : 'paths',
      columns: [{ name: 'id' }, { name: 'F' }],
      rows,
    });
  }

  return encode({ header: header('query-graph-v1', snapshotId), tables });
}

/* ───────────── list_risks → PACK ─────────────
 *
 * Same shape as agent.pack's `risks` table — keeping the schema
 * identical means an agent that learned the columns once doesn't
 * re-learn them per tool call.
 */
export function listRisksToPack(risks: Risk[], snapshotId: string): string {
  const rows: PackRow[] = risks.map((r, i) => [
    String(i),
    r.severity,
    r.category,
    r.rule,
    r.file ?? null,
    r.line != null ? String(r.line) : null,
    r.message,
    r.messageTechnical ?? null,
  ]);
  const tables: PackTable[] = [{
    name: 'risks',
    columns: [
      { name: 'id' }, { name: 'sev' }, { name: 'cat' }, { name: 'rule' },
      { name: 'F' }, { name: 'line' }, { name: 'msg' }, { name: 'tech' },
    ],
    rows,
  }];
  return encode({ header: header('risks-v1', snapshotId), tables });
}

/* ───────────── get_outline → PACK ─────────────
 *
 * Per-file declaration outline. Same column shape as agent.pack's
 * `declarations` table. Children (class methods) are flattened into
 * separate rows with a `parent` column pointing at the parent
 * symbol's name; null parent = top-level.
 *
 * F2 (outline-v2): a second `refs` table carries the symbol-graph
 * EDGES that originate in this file — "what does this file reference,
 * and how sure are we?". Mirrors agent.pack's `calls` table (`S`/`T`
 * intern the from/to symbol ids; `kind` + `conf` stay literal). The
 * table is always emitted for a stable two-table shape; it's empty
 * unless analysis ran with `--symbols` (so no caller has to branch on
 * presence). Pinning `outline-v2` signals "may contain a refs table".
 */
export function getOutlineToPack(
  filePath: string,
  symbols: ExtractedSymbol[],
  snapshotId: string,
  refs: SymbolEdge[] = [],
): string {
  const rows: PackRow[] = [];
  let id = 0;
  for (const s of symbols) {
    rows.push([
      String(id++),
      s.name,
      s.kind,
      String(s.startLine),
      String(s.endLine),
      s.exported ? '1' : '0',
      null, // top-level
    ]);
    for (const child of s.children ?? []) {
      rows.push([
        String(id++),
        child.name,
        child.kind,
        String(child.startLine),
        String(child.endLine),
        child.exported ? '1' : '0',
        s.name, // parent symbol
      ]);
    }
  }
  const refRows: PackRow[] = refs.map((e, i) => [
    String(i),
    e.from,
    e.to,
    e.kind,
    e.confidence ?? 'extracted',
  ]);
  return encode({
    header: header('outline-v2', snapshotId),
    tables: [
      {
        name: 'declarations',
        columns: [
          { name: 'id' }, { name: 'name' }, { name: 'kind' },
          { name: 'start' }, { name: 'end' }, { name: 'exp' }, { name: 'parent' },
        ],
        rows,
      },
      {
        name: 'refs',
        columns: [
          { name: 'id' }, { name: 'S' }, { name: 'T' }, { name: 'kind' }, { name: 'conf' },
        ],
        rows: refRows,
      },
    ],
  });
}

/* ───────────── query (subgraph) → PACK ─────────────
 *
 * F3 — the declarative `query` tool returns a connected subgraph. Three tables
 * plus a 1-row meta:
 *   - `nodes`   : every node id in the subgraph + its file/kind/name.
 *   - `edges`   : the traversed edges (`S`/`T` intern the from/to ids).
 *   - `citations`: `file:line` anchors so the agent can jump straight to source.
 *   - `meta`    : a single row carrying the truncation marker + counts — so a
 *                 capped result is NEVER a silent drop (the design invariant).
 * Schema `subgraph-v1`. Node metadata (path / line / name / kind) is recovered
 * from the agent's file + symbol node lists, keyed by id.
 */
export interface SubgraphLike {
  nodes: string[];
  edges: Array<{ from: string; to: string; kind: string; confidence?: string }>;
  truncated: boolean;
}

function subgraphBaseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Lift a legacy-verb QueryResult into a flat, sorted, deduped node-id list for
 * the F3 `query` tool's uniform subgraph response. `cycles` returns
 * `string[][]` (one array per SCC) and MUST be flattened — a naive
 * string filter would drop every (array) element and silently return an empty
 * subgraph. Every other lifted verb (orphans / path-between) returns `string[]`.
 */
export function verbResultNodes(result: QueryResult): string[] {
  const raw = Array.isArray(result.results) ? (result.results as unknown[]) : [];
  if (result.verb === 'cycles') {
    return [...new Set((raw as string[][]).flat())].sort();
  }
  return raw.filter((x): x is string => typeof x === 'string');
}

export function subgraphToPack(
  agent: AgentArtifact,
  result: SubgraphLike,
  snapshotId: string,
): string {
  // id → { path, line, name, kind } for every file + symbol node.
  const meta = new Map<string, { path: string; line: number | null; name: string; kind: string }>();
  for (const n of agent.graph.nodes) {
    meta.set(n.path, { path: n.path, line: null, name: subgraphBaseName(n.path), kind: 'file' });
  }
  for (const s of agent.graph.symbolNodes ?? []) {
    meta.set(s.id, { path: s.path, line: s.startLine, name: s.name, kind: s.kind });
  }

  const nodeRows: PackRow[] = result.nodes.map((id, i) => {
    const m = meta.get(id);
    return [String(i), id, m?.path ?? id, m?.kind ?? '-', m?.name ?? '-'];
  });

  const edgeRows: PackRow[] = result.edges.map((e, i) => [
    String(i),
    e.from,
    e.to,
    e.kind,
    e.confidence ?? 'extracted',
  ]);

  // One citation per node: its file + line (+ symbol name when it's a symbol).
  const citeRows: PackRow[] = result.nodes.map((id, i) => {
    const m = meta.get(id);
    return [
      String(i),
      m?.path ?? id,
      m && m.line != null ? String(m.line) : null,
      m && m.kind !== 'file' ? m.name : null,
    ];
  });

  const metaRow: PackRow = [
    result.truncated ? '1' : '0',
    String(result.nodes.length),
    String(result.edges.length),
  ];

  const tables: PackTable[] = [
    {
      name: 'nodes',
      // `node` (the id) is unique per row → literal PK; `F` (path) interns.
      columns: [{ name: 'id' }, { name: 'node' }, { name: 'F' }, { name: 'kind' }, { name: 'name' }],
      rows: nodeRows,
    },
    {
      name: 'edges',
      columns: [{ name: 'id' }, { name: 'S' }, { name: 'T' }, { name: 'kind' }, { name: 'conf' }],
      rows: edgeRows,
    },
    {
      name: 'citations',
      columns: [{ name: 'id' }, { name: 'F' }, { name: 'line' }, { name: 'sym' }],
      rows: citeRows,
    },
    {
      name: 'meta',
      columns: [{ name: 'truncated' }, { name: 'nodes' }, { name: 'edges' }],
      rows: [metaRow],
    },
  ];

  return encode({ header: header('subgraph-v1', snapshotId), tables });
}

/* ───────────── get_context (F4) → PACK ─────────────
 *
 * F4 — a task-scoped, ranked, token-budgeted context block. Two tables + a
 * 1-row meta:
 *   - `ranked`: the ranked anchors. Carries the ranking columns (`score`,
 *               `tok`, `hops`, `seed`) AND the `F`/`line`/`name` citation, so
 *               this one table doubles as the jump-list (no separate, duplicate
 *               citations table — INV8 token-first).
 *   - `edges` : edges connecting the included anchors (`S`/`T` intern ids).
 *   - `meta`  : a single row with the budget stats + the `truncated`/`coldStart`
 *               markers, so a capped or fallback result is NEVER silent.
 * Schema `context-v1`.
 */
export interface ContextLike {
  items: Array<{
    id: string;
    path: string;
    name: string;
    kind: string;
    line: number | null;
    score: number;
    tokenCost: number;
    hops: number;
    isSeed: boolean;
  }>;
  edges: Array<{ from: string; to: string; kind: string; confidence?: string }>;
  totalTokens: number;
  budgetTokens: number;
  truncated: boolean;
  coldStart: boolean;
}

export function contextToPack(result: ContextLike, snapshotId: string): string {
  const rankedRows: PackRow[] = result.items.map((it, i) => [
    String(i),
    it.id,
    it.path,
    it.kind,
    it.name,
    it.line != null ? String(it.line) : null,
    String(it.score),
    String(it.tokenCost),
    String(it.hops),
    it.isSeed ? '1' : '0',
  ]);

  const edgeRows: PackRow[] = result.edges.map((e, i) => [
    String(i),
    e.from,
    e.to,
    e.kind,
    e.confidence ?? 'extracted',
  ]);

  const metaRow: PackRow = [
    String(result.totalTokens),
    String(result.budgetTokens),
    result.truncated ? '1' : '0',
    result.coldStart ? '1' : '0',
    String(result.items.length),
    String(result.edges.length),
  ];

  const tables: PackTable[] = [
    {
      name: 'ranked',
      // `node` (id) is unique → literal PK; `F` (path) interns across rows.
      columns: [
        { name: 'id' }, { name: 'node' }, { name: 'F' }, { name: 'kind' },
        { name: 'name' }, { name: 'line' }, { name: 'score' }, { name: 'tok' },
        { name: 'hops' }, { name: 'seed' },
      ],
      rows: rankedRows,
    },
    {
      name: 'edges',
      columns: [{ name: 'id' }, { name: 'S' }, { name: 'T' }, { name: 'kind' }, { name: 'conf' }],
      rows: edgeRows,
    },
    {
      name: 'meta',
      columns: [
        { name: 'totalTokens' }, { name: 'budget' }, { name: 'truncated' },
        { name: 'coldStart' }, { name: 'items' }, { name: 'edges' },
      ],
      rows: [metaRow],
    },
  ];

  return encode({ header: header('context-v1', snapshotId), tables });
}

/* ───────────── get_config → PACK ─────────────
 *
 * Flatten env vars: one row per (name, file, line). Same shape as
 * agent.pack's `envs` table.
 */
export function getConfigToPack(envVars: EnvVar[], snapshotId: string): string {
  const rows: PackRow[] = [];
  let id = 0;
  for (const v of envVars) {
    for (const read of v.reads) {
      rows.push([
        String(id++),
        v.name,
        read.file,
        String(read.line),
        read.access,
        read.defaultValue ?? null,
      ]);
    }
  }
  return encode({
    header: header('envs-v1', snapshotId),
    tables: [{
      name: 'envs',
      columns: [
        { name: 'id' }, { name: 'N' }, { name: 'F' },
        { name: 'line' }, { name: 'access' }, { name: 'default' },
      ],
      rows,
    }],
  });
}

/* ───────────── query_learnings → PACK ─────────────
 *
 * Learning events into a single table. The `meta` field is JSON-shaped
 * (heterogeneous payload) — we serialize it as a JSON literal in a
 * single column rather than promoting to a separate table, because
 * meta keys vary per event and PACK doesn't model nested objects.
 *
 * `agent` and `model` are interned (`A` and `M`) — same agent emits
 * many events; same model spans many agents.
 */
export function queryLearningsToPack(events: LearningEvent[], snapshotId: string): string {
  const rows: PackRow[] = events.map((e, i) => [
    String(i),
    e.timestamp,
    e.agent,
    e.model ?? null,
    e.action,
    e.outcome,
    e.ticketId ?? null,
    e.confidence != null ? String(e.confidence) : null,
    e.reasoning ?? null,
    e.meta ? JSON.stringify(e.meta) : null,
  ]);
  return encode({
    header: header('learnings-v1', snapshotId),
    tables: [{
      name: 'learnings',
      columns: [
        { name: 'id' }, { name: 'ts' }, { name: 'A' }, { name: 'M' },
        { name: 'action' }, { name: 'outcome' }, { name: 'ticket' },
        { name: 'conf' }, { name: 'reason' }, { name: 'meta' },
      ],
      rows,
    }],
  });
}

/**
 * Compute a stable snapshot id for an analyze run — used as the PACK
 * header's `snapshotId` field so consumers can cache responses by it.
 * We use the artifact's `generatedAt` since it changes only when the
 * analysis runs (the right granularity for cache invalidation).
 */
export function packSnapshotId(agent: AgentArtifact): string {
  return agent.generatedAt;
}

/* Re-export the route type alias used by callers above. Avoids a
 * cross-package type import in the call site. */
export type { Risk, RouteDecl, EnvVar };

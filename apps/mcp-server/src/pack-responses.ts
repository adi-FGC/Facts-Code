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
import type { AgentArtifact, Risk, RouteDecl, EnvVar } from '@factstack/spec';
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
 */
export function getOutlineToPack(
  filePath: string,
  symbols: ExtractedSymbol[],
  snapshotId: string,
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
  return encode({
    header: header('outline-v1', snapshotId),
    tables: [{
      name: 'declarations',
      columns: [
        { name: 'id' }, { name: 'name' }, { name: 'kind' },
        { name: 'start' }, { name: 'end' }, { name: 'exp' }, { name: 'parent' },
      ],
      rows,
    }],
  });
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

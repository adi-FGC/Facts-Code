/**
 * Encode an `AgentArtifact` into a FactsPack `.pack` string.
 *
 * Six tables in fixed order — the schema name is `agent-v1` and the
 * order is part of the contract. Consumers reading the pack can either
 * walk all tables in declaration order or jump to a named table; both
 * work because every table carries its own `&` schema line.
 *
 * Dictionary strategy:
 *   - File paths are interned ONLY in tables where they repeat across
 *     rows (`imports`, `routes`, `risks`, `envs`, `declarations`).
 *     The `files` table uses `path` as a literal primary-key column
 *     because each value is unique-per-row — interning unique values
 *     wastes a `@` line per row (spec §13).
 *   - Language labels are interned (`L` column in `files`) because a
 *     typical project has 5-10 distinct languages across hundreds of
 *     files.
 *   - Short enum values (`kind`, `status`, `severity`, `category`,
 *     `access`) stay literal — the `@ K=V` overhead would exceed the
 *     savings on values < 10 chars.
 *
 * Pure: no Node imports, no I/O. The caller (`writeArtifacts()`)
 * writes the returned string to `agent.pack`.
 */

import type { AgentArtifact } from '@factstack/spec';
import { encode, type PackHeader, type PackRow, type PackTable } from '@factstack/factspack';

const PRODUCER = 'factstack/0.3.10';
const SCHEMA = 'agent-v1';

/**
 * Build the multi-table FactsPack representation of an agent artifact.
 * The header's snapshotId defaults to the artifact's `generatedAt`
 * timestamp; callers can override it for cache-key purposes (e.g. a
 * commit SHA).
 */
export function encodeAgentPack(agent: AgentArtifact, opts: { snapshotId?: string } = {}): string {
  const header: PackHeader = {
    producer: PRODUCER,
    schema: SCHEMA,
    snapshotId: opts.snapshotId ?? agent.generatedAt,
    rowCount: null, // encoder computes the total
  };

  return encode({
    header,
    tables: [
      buildFilesTable(agent),
      buildImportsTable(agent),
      buildRoutesTable(agent),
      buildRisksTable(agent),
      buildEnvsTable(agent),
      buildDeclarationsTable(agent),
    ],
  });
}

/* ───────────── file table ───────────── */

function buildFilesTable(agent: AgentArtifact): PackTable {
  /* `path` is the primary key, kept literal (unique per row).
     `L` (lang) is interned — a 200-file project usually has 5-10
     distinct languages, so interning saves real bytes.
     Numeric fields are stringified; `null` means "not measured" and
     serializes as a bare `-` per spec §4.4. */
  const rows: PackRow[] = agent.files.map((f) => [
    f.path,
    f.language || '',
    String(f.loc),
    String(f.tokenCost),
    String(f.bytes),
    f.bundleSize ? String(f.bundleSize.gzipped) : null,
    f.status,
    f.lastModifiedMs != null ? String(Math.round(f.lastModifiedMs)) : null,
    f.churnScore != null ? String(f.churnScore) : null,
    typeof f.readingMinutes === 'number' ? String(f.readingMinutes) : null,
  ]);
  return {
    name: 'files',
    columns: [
      { name: 'path' }, { name: 'L' }, { name: 'loc' }, { name: 'tok' },
      { name: 'bytes' }, { name: 'gz' }, { name: 'status' },
      { name: 'mtime' }, { name: 'churn' }, { name: 'read' },
    ],
    rows,
  };
}

/* ───────────── imports table ───────────── */

function buildImportsTable(agent: AgentArtifact): PackTable {
  /* `F` and `T` are separate intern pools (per-column dict per spec
     §4.2 convention). Same path appearing as both `from` and `to`
     gets two dict entries — minor waste, accepted to keep the schema
     readable. `kind` stays literal: ~3 distinct values, average value
     length under 8 chars, dict overhead would exceed the savings. */
  const edges = agent.graph?.edges ?? [];
  const rows: PackRow[] = edges.map((e, i) => [
    String(i),
    e.from,
    e.to,
    e.kind ?? 'import',
  ]);
  return {
    name: 'imports',
    columns: [{ name: 'id' }, { name: 'F' }, { name: 'T' }, { name: 'kind' }],
    rows,
  };
}

/* ───────────── routes table ───────────── */

function buildRoutesTable(agent: AgentArtifact): PackTable {
  /* The `path` column here is the URL path (e.g. `/api/users`), NOT
     a file path. Lowercase = literal because URLs rarely repeat. The
     handler file IS interned via `F` because multiple routes often
     share a handler module. */
  const rows: PackRow[] = (agent.routes ?? []).map((r, i) => [
    String(i),
    r.framework,
    r.method ?? null,
    r.path,
    r.handlerFile,
    r.handlerSymbol ?? null,
  ]);
  return {
    name: 'routes',
    columns: [
      { name: 'id' }, { name: 'framework' }, { name: 'method' },
      { name: 'path' }, { name: 'F' }, { name: 'sym' },
    ],
    rows,
  };
}

/* ───────────── risks table ───────────── */

function buildRisksTable(agent: AgentArtifact): PackTable {
  /* `messageTechnical` rides alongside `message` (one carries CXO
     prose, the other the rule's raw text — both are valuable to
     agents per the v0.3.8 design). `preview` is intentionally
     omitted: it can contain redacted-but-still-jagged secret
     fragments and PACK has no built-in quoting; literal escaping
     is enough but the value is rarely consumed by AI tools. */
  const rows: PackRow[] = agent.risks.map((r, i) => [
    String(i),
    r.severity,
    r.category,
    r.rule,
    r.file ?? null,
    r.line != null ? String(r.line) : null,
    r.message,
    r.messageTechnical ?? null,
  ]);
  return {
    name: 'risks',
    columns: [
      { name: 'id' }, { name: 'sev' }, { name: 'cat' }, { name: 'rule' },
      { name: 'F' }, { name: 'line' }, { name: 'msg' }, { name: 'tech' },
    ],
    rows,
  };
}

/* ───────────── envs table ───────────── */

function buildEnvsTable(agent: AgentArtifact): PackTable {
  /* Flattened: one row per (env-var, read-site). The aggregated
     "primaryAccess" + "defaults union" lives in the JSON artifact;
     the agent reading the pack can group by `name` to recover it.
     `name` is interned (`N`) — the same env var typically reads in
     2-12 places. `F` interns the read-site file. */
  const rows: PackRow[] = [];
  let id = 0;
  for (const v of agent.config?.envVars ?? []) {
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
  return {
    name: 'envs',
    columns: [
      { name: 'id' }, { name: 'N' }, { name: 'F' },
      { name: 'line' }, { name: 'access' }, { name: 'default' },
    ],
    rows,
  };
}

/* ───────────── declarations table ───────────── */

function buildDeclarationsTable(agent: AgentArtifact): PackTable {
  /* Top-level declarations only. Nested declarations (class methods)
     stay inside `agent.json`'s `declarations[].children` — they're
     a small minority and PACK's positional rows don't model nesting
     cleanly. The "exp" (exported) column uses 1/0 instead of
     true/false to save a byte per row × thousands of rows.

     `kind` stays literal: 12 distinct values (function, class,
     method, ...) repeat heavily, but each is short (avg 6 chars) so
     the per-key dict overhead `@ K1=function` (12 bytes) costs about
     the same as 2 row repetitions. Marginal win not worth the
     readability hit. */
  const rows: PackRow[] = [];
  let id = 0;
  for (const f of agent.files) {
    for (const d of f.declarations) {
      rows.push([
        String(id++),
        f.path,
        d.name,
        d.kind,
        String(d.startLine),
        String(d.endLine),
        d.exported ? '1' : '0',
      ]);
    }
  }
  return {
    name: 'declarations',
    columns: [
      { name: 'id' }, { name: 'F' }, { name: 'name' },
      { name: 'kind' }, { name: 'start' }, { name: 'end' }, { name: 'exp' },
    ],
    rows,
  };
}

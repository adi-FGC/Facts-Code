/**
 * FactsPack encoder — produces baseline + incremental packs.
 *
 * Two entry points share a private Encoder class so the dictionary
 * state, the column validation, and the line-emission logic are all
 * defined in one place:
 *
 *   - `encode({ header, tables })` → baseline pack with `-` rows.
 *   - `encodeIncremental({ header, tables })` → patch pack with `+` and
 *     `x` rows. The header's `rowCount` should be `0` per spec §7
 *     to signal "patch only" to the consumer; the encoder enforces
 *     this convention by writing `0` if the caller leaves rowCount
 *     null in incremental mode.
 *
 * Layout strategy: two-pass. We render rows first (interning as we
 * go), THEN concatenate the `# header`, then all `@` dict entries,
 * then all table lines. This is simpler than a true streaming encoder
 * and satisfies spec §4.2 — "Producers SHOULD emit dictionary entries
 * before any row that uses them."
 *
 * Row count enforcement: every row's cell array must match the
 * column count of its parent table. Mismatch throws PackEncodeError —
 * we don't pad or truncate.
 */

import { escapeCell } from './escape.js';
import {
  isInternedColumn,
  type EncodeOptions,
  type IncrementalEncodeOptions,
  type IncrementalTable,
  type PackColumn,
  type PackHeader,
  type PackRow,
  type PackTable,
} from './types.js';

export class PackEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackEncodeError';
  }
}

/**
 * Encode a baseline pack.
 *
 * Output ends with a trailing newline (spec §10: "Producers MUST emit
 * a `\n` at end of file").
 */
export function encode(opts: EncodeOptions): string {
  const enc = new Encoder();
  /* For each baseline table, declare schema once then emit a `-` line
     per row. The encoder interns repeated values for any column whose
     name starts uppercase. */
  const tableLines: string[] = [];
  for (const table of opts.tables) {
    enc.assertSchemaShape(table.name, table.columns, table.rows);
    tableLines.push(declSchemaLine(table.name, table.columns));
    for (const row of table.rows) {
      tableLines.push(rowLine('-', row, table.columns, enc));
    }
  }
  /* Compute total rowCount when caller left it `null` in baseline
     mode: a baseline pack's row count is the sum across all tables. */
  const total = opts.tables.reduce((s, t) => s + t.rows.length, 0);
  const headerOut = renderHeader({
    ...opts.header,
    rowCount: opts.header.rowCount ?? total,
  });

  return assemble(headerOut, enc.dictLines(), tableLines);
}

/**
 * Encode an incremental (patch) pack with `+` additions and `x`
 * deletions. The header's `rowCount` is forced to `0` per spec §7 if
 * the caller left it null — that's the documented "patch-only"
 * convention.
 */
export function encodeIncremental(opts: IncrementalEncodeOptions): string {
  const enc = new Encoder();
  const tableLines: string[] = [];
  for (const table of opts.tables) {
    enc.assertSchemaShape(table.name, table.columns, table.addedRows);
    tableLines.push(declSchemaLine(table.name, table.columns));
    for (const row of table.addedRows) {
      tableLines.push(rowLine('+', row, table.columns, enc));
    }
    for (const id of table.deletedIds) {
      assertNotEmpty(id, `Deleted id in table ${table.name} is empty`);
      tableLines.push(`x ${escapeCell(id)}`);
    }
  }
  const headerOut = renderHeader({
    ...opts.header,
    rowCount: opts.header.rowCount ?? 0,
  });
  return assemble(headerOut, enc.dictLines(), tableLines);
}

/* ───────────────────── private helpers ───────────────────── */

function renderHeader(h: PackHeader): string {
  /* Header field separator is the same tab the rest of the format
     uses (spec §4.1 + §4 — "Field separator: ASCII tab"). The
     producer/version, schema/version, snapshotId fields can't contain
     tabs themselves — we reject any input that would corrupt the
     header line. */
  for (const [k, v] of Object.entries({ producer: h.producer, schema: h.schema, snapshotId: h.snapshotId })) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new PackEncodeError(`Header.${k} must be a non-empty string`);
    }
    if (v.indexOf('\t') >= 0 || v.indexOf('\n') >= 0) {
      throw new PackEncodeError(`Header.${k} must not contain tab or newline`);
    }
  }
  const rc = h.rowCount === null ? '-' : String(h.rowCount);
  return `# ${h.producer}\t${h.schema}\t${h.snapshotId}\t${rc}`;
}

function declSchemaLine(name: string, columns: PackColumn[]): string {
  if (!name || name.indexOf('\t') >= 0 || name.indexOf('\n') >= 0) {
    throw new PackEncodeError(`Table name '${name}' is invalid (empty or contains tab/newline)`);
  }
  for (const c of columns) {
    if (!c.name || c.name.indexOf('\t') >= 0 || c.name.indexOf('\n') >= 0) {
      throw new PackEncodeError(`Column name '${c.name}' is invalid (empty or contains tab/newline)`);
    }
  }
  return `& ${name}\t${columns.map((c) => c.name).join('\t')}`;
}

function rowLine(prefix: '-' | '+', row: PackRow, columns: PackColumn[], enc: Encoder): string {
  const cells = row.map((cell, i) => {
    const col = columns[i]!;
    if (cell === null) return '-';
    if (cell === '') return '';
    if (isInternedColumn(col.name)) {
      // Spec §4.4: interned cells MUST be dictionary keys. We let the
      // encoder produce the key; raw user input has been escaped if
      // needed when stored in the dict.
      return enc.intern(col.name, cell);
    }
    return escapeCell(cell);
  });
  return `${prefix} ${cells.join('\t')}`;
}

function assemble(headerLine: string, dictLines: string[], tableLines: string[]): string {
  const parts: string[] = [headerLine];
  if (dictLines.length > 0) parts.push(...dictLines);
  if (tableLines.length > 0) parts.push(...tableLines);
  // Trailing newline per spec §10.
  return parts.join('\n') + '\n';
}

function assertNotEmpty(value: string, msg: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PackEncodeError(msg);
  }
}

/**
 * Internal encoder state — owns the dictionary keyed by column name.
 * Each interned column gets its own counter (`F1`, `F2`, ... for
 * column `F`; independently `R1`, `R2`, ... for column `R`).
 *
 * Why per-column instead of global counters? Spec convention §4.2:
 * "a single-letter prefix tied to the column it serves." Per-column
 * keeps the keys readable in a multi-table pack where multiple
 * columns intern unrelated value spaces.
 */
class Encoder {
  /** colName → (literal → key). */
  private readonly maps = new Map<string, Map<string, string>>();
  /** colName → next counter. */
  private readonly counters = new Map<string, number>();
  /** Dict lines in the order they were minted (preserves spec
   *  preference for "before first use" ordering when concatenated
   *  ahead of the table lines). */
  private readonly dict: string[] = [];

  /** Validate that every row in `rows` has exactly `columns.length`
   *  cells. Spec §4.4: "Tab-separated cells, one per column." */
  assertSchemaShape(tableName: string, columns: PackColumn[], rows: PackRow[]): void {
    const expected = columns.length;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      if (row.length !== expected) {
        throw new PackEncodeError(
          `Table '${tableName}' row ${r}: expected ${expected} cells, got ${row.length}`,
        );
      }
    }
  }

  /** Look up or mint the dictionary key for a literal. Newly-minted
   *  keys append a `@ K=V` line to `this.dict`. */
  intern(colName: string, literal: string): string {
    let map = this.maps.get(colName);
    if (!map) {
      map = new Map();
      this.maps.set(colName, map);
    }
    const existing = map.get(literal);
    if (existing) return existing;
    const next = (this.counters.get(colName) ?? 0) + 1;
    this.counters.set(colName, next);
    const key = `${colName}${next}`;
    map.set(literal, key);
    this.dict.push(`@ ${key}=${escapeCell(literal)}`);
    return key;
  }

  dictLines(): string[] {
    return this.dict;
  }
}

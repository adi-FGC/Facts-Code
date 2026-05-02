/**
 * FactsPack decoder — line-oriented, single-pass with one resolution
 * sweep at the end for forward dictionary references.
 *
 * Decoder responsibilities (per spec §4 + §10 + §11):
 *
 *   1. Parse the `# header` line first; reject malformed headers.
 *   2. Build the dictionary from every `@ K=V` line; tolerate forward
 *      references (the literal may appear AFTER the row that uses it).
 *   3. Track active table from the most recent `&` line. Multiple `&`
 *      blocks in one pack are allowed (multi-table composition, §8).
 *   4. Bind `-`, `+`, `x` rows to the active table.
 *   5. After the full pack is read, walk every row and resolve any
 *      interned cells against the final dictionary. An unresolved key
 *      is a reject — no silent best-effort.
 *
 * Reserved-byte enforcement: any line whose first byte is outside
 * `# @ & - + x` (and which isn't an empty line, which is permitted)
 * triggers a `PackDecodeError`. Spec §4: "Anything else on the first
 * byte of a line is undefined and MUST be rejected."
 *
 * Schema-version mismatch is a separate concern — the decoder reads
 * the header faithfully but doesn't enforce a particular version. The
 * caller checks `decoded.header.schema` against what it understands
 * and rejects loudly on mismatch (spec §11).
 */

import { unescapeCell } from './escape.js';
import {
  isInternedColumn,
  type DecodedPack,
  type DecodedTable,
  type PackColumn,
  type PackHeader,
  type PackRow,
} from './types.js';

export class PackDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackDecodeError';
  }
}

/**
 * Decode a complete pack from text. The input MAY end with or without
 * a trailing `\n` (spec §10: "Consumers MUST accept a missing final
 * `\n`").
 */
export function decode(text: string): DecodedPack {
  if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) {
    /* Spec §10: BOM is forbidden. Reject loudly so producers can fix
       their writer instead of silently appearing fine in some
       consumers and broken in others. */
    throw new PackDecodeError('BOM detected at start of pack — forbidden by spec §10');
  }

  const lines = text.split('\n');
  let header: PackHeader | null = null;
  /* Dict: key → escaped value as it appeared on the `@` line. We
     unescape AFTER lookup, not at insertion, so the decoder makes a
     single allocation per cell instead of one per dict entry. */
  const dict = new Map<string, string>();
  /* Tables we've seen by name. Multiple `&` declarations of the same
     name MUST share columns (spec §4.3 implies it but doesn't spell
     it out — we enforce here so two divergent declarations can't
     silently merge). */
  const tables = new Map<string, DecodedTable>();
  let active: DecodedTable | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue; // empty lines permitted, ignored
    const prefix = line.charCodeAt(0);

    /* Required: `<prefix><space><body>` for every non-empty line.
       The space at index 1 is part of the line shape ("# fields",
       "@ K=V", etc.). Lines too short to contain it are malformed. */
    if (line.length < 2 || line.charCodeAt(1) !== 0x20 /* space */) {
      throw new PackDecodeError(
        `Line ${i + 1}: missing required space after prefix '${line[0]}'`,
      );
    }
    const body = line.slice(2);

    switch (prefix) {
      case 0x23 /* # */: {
        if (header !== null) {
          throw new PackDecodeError(`Line ${i + 1}: duplicate header`);
        }
        header = parseHeader(body, i + 1);
        break;
      }
      case 0x40 /* @ */: {
        const eq = body.indexOf('=');
        if (eq <= 0) {
          throw new PackDecodeError(`Line ${i + 1}: malformed @ entry (no '=' or empty key)`);
        }
        const key = body.slice(0, eq);
        const escapedValue = body.slice(eq + 1);
        if (dict.has(key)) {
          throw new PackDecodeError(
            `Line ${i + 1}: duplicate dictionary key '${key}' (re-defining keys is forbidden)`,
          );
        }
        dict.set(key, escapedValue);
        break;
      }
      case 0x26 /* & */: {
        const fields = body.split('\t');
        const name = fields[0];
        if (!name) {
          throw new PackDecodeError(`Line ${i + 1}: schema declaration missing table name`);
        }
        const columns: PackColumn[] = fields.slice(1).map((n) => ({ name: n }));
        if (columns.length === 0) {
          throw new PackDecodeError(`Line ${i + 1}: schema for '${name}' has zero columns`);
        }
        const existing = tables.get(name);
        if (existing) {
          // Re-declared schema must match column-for-column.
          if (existing.columns.length !== columns.length ||
              existing.columns.some((c, j) => c.name !== columns[j]!.name)) {
            throw new PackDecodeError(
              `Line ${i + 1}: schema for '${name}' redeclared with different columns`,
            );
          }
          active = existing;
        } else {
          active = { name, columns, rows: [], addedRows: [], deletedIds: [] };
          tables.set(name, active);
        }
        break;
      }
      case 0x2D /* - */: {
        if (!active) {
          throw new PackDecodeError(`Line ${i + 1}: row '-' with no active schema`);
        }
        const row = parseRow(body, active.columns, i + 1);
        active.rows.push(row);
        break;
      }
      case 0x2B /* + */: {
        if (!active) {
          throw new PackDecodeError(`Line ${i + 1}: row '+' with no active schema`);
        }
        const row = parseRow(body, active.columns, i + 1);
        active.addedRows.push(row);
        break;
      }
      case 0x78 /* x */: {
        if (!active) {
          throw new PackDecodeError(`Line ${i + 1}: row 'x' with no active schema`);
        }
        // The `x` line carries a single field — the deleted row's
        // primary-key value. It's NOT split on tabs even if the value
        // contains escaped tabs; the whole body is the id.
        active.deletedIds.push(unescapeCell(body));
        break;
      }
      default: {
        const ch = String.fromCharCode(prefix);
        throw new PackDecodeError(
          `Line ${i + 1}: reserved-byte violation — unknown line prefix '${ch}'`,
        );
      }
    }
  }

  if (!header) {
    throw new PackDecodeError('Pack has no `# header` line');
  }

  /* Resolution sweep: for every interned-column cell across every
     table (both `rows` and `addedRows`), look up the dict and replace
     the key with the unescaped literal. Forward references are now
     legal because the dict is fully populated. */
  for (const table of tables.values()) {
    resolveRows(table.rows, table.columns, dict);
    resolveRows(table.addedRows, table.columns, dict);
  }

  return { header, tables };
}

function parseHeader(body: string, lineNo: number): PackHeader {
  const fields = body.split('\t');
  if (fields.length < 4) {
    throw new PackDecodeError(
      `Line ${lineNo}: header has ${fields.length} fields, expected 4`,
    );
  }
  const [producer, schema, snapshotId, rowCountField] = fields;
  if (!producer || !schema || !snapshotId) {
    throw new PackDecodeError(`Line ${lineNo}: header has empty required field`);
  }
  let rowCount: number | null;
  if (rowCountField === '-') {
    rowCount = null;
  } else {
    const n = Number(rowCountField);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new PackDecodeError(
        `Line ${lineNo}: header rowCount '${rowCountField}' is not a non-negative integer or '-'`,
      );
    }
    rowCount = n;
  }
  return { producer: producer!, schema: schema!, snapshotId: snapshotId!, rowCount };
}

function parseRow(body: string, columns: PackColumn[], lineNo: number): PackRow {
  const cells = body.split('\t');
  if (cells.length !== columns.length) {
    throw new PackDecodeError(
      `Line ${lineNo}: row has ${cells.length} cells, schema expects ${columns.length}`,
    );
  }
  /* During parse we ONLY decode literal-column cells. Interned-column
     cells stay as raw dictionary keys until the resolution sweep — see
     the comment in `decode()` for why deferred resolution lets us
     accept forward references. */
  return cells.map((raw, i) => {
    if (raw === '-') return null;
    if (raw === '') return '';
    const col = columns[i]!;
    if (isInternedColumn(col.name)) {
      return raw; // dictionary key, resolved later
    }
    return unescapeCell(raw);
  });
}

function resolveRows(rows: PackRow[], columns: PackColumn[], dict: Map<string, string>): void {
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const col = columns[i]!;
      if (!isInternedColumn(col.name)) continue;
      const cell = row[i];
      if (cell === null || cell === '') continue;
      const escaped = dict.get(cell as string);
      if (escaped === undefined) {
        throw new PackDecodeError(
          `Unresolved dictionary key '${cell}' in column '${col.name}'`,
        );
      }
      row[i] = unescapeCell(escaped);
    }
  }
}

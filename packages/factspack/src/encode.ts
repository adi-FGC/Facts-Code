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
 * go), THEN concatenate the `# header`, then `;` meta lines (legend +
 * hot hints, v0.2), then all `@` dict entries, then all table lines,
 * then the `; end` trailer. This is simpler than a true streaming
 * encoder and satisfies spec §4.2 — "Producers SHOULD emit dictionary
 * entries before any row that uses them."
 *
 * Row count enforcement: every row's cell array must match the
 * column count of its parent table. Mismatch throws PackEncodeError —
 * we don't pad or truncate.
 *
 * v0.2 (S4): every pack ends with the integrity trailer
 * `; end rows=<n> tables=<m> sha256=<12hex>` — rows is the total data
 * row count (`-`/`+`/`x` lines), tables the distinct table count, and
 * the hash covers every byte preceding the trailer line. decode()
 * verifies all three, converting silent truncation into a hard error.
 */

import { escapeCell } from './escape.js';
import { sha256hex } from './sha256.js';
import {
  isInternedColumn,
  type EncodeOptions,
  type IncrementalEncodeOptions,
  type IncrementalTable,
  type PackColumn,
  type PackHeader,
  type PackMeta,
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
  /* v0.2a — the baseline encoder produces a `master`. A caller asking
     for `kind=diff` here is a category error; route them to
     encodeIncremental so the count semantics stay disentangled. */
  if (opts.header.kind === 'diff') {
    throw new PackEncodeError("encode() produces a 'master'; use encodeIncremental() for kind='diff'");
  }
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
  /* v0.2a — a master's header rowCount MUST equal the baseline total so
     the strict decoder's header↔trailer check holds. Reject an explicit
     mismatch rather than silently emitting an unverifiable pack. */
  if (opts.header.rowCount != null && opts.header.rowCount !== total) {
    throw new PackEncodeError(
      `master header rowCount=${opts.header.rowCount} must equal the baseline row total ${total} (or be null)`,
    );
  }
  const headerOut = renderHeader({
    ...opts.header,
    rowCount: opts.header.rowCount ?? total,
  });

  return assemble(headerOut, metaLines(withCapsTyped(opts.meta, opts.tables), enc), enc.dictLines(), tableLines, {
    rows: total,
    tables: distinctTableCount(opts.tables),
  });
}

/**
 * Encode an incremental (patch) pack with `+` additions and `x`
 * deletions. The header's `rowCount` is forced to `0` per spec §7 if
 * the caller left it null — that's the documented "patch-only"
 * convention.
 */
export function encodeIncremental(opts: IncrementalEncodeOptions): string {
  /* v0.2a — the incremental encoder produces a `diff`, and its header
     rowCount is the `0` sentinel (spec §4.5/§7). Reject a `master` kind
     or a non-zero rowCount so a diff can never masquerade as a master. */
  if (opts.header.kind === 'master') {
    throw new PackEncodeError("encodeIncremental() produces a 'diff'; use encode() for kind='master'");
  }
  if (opts.header.rowCount != null && opts.header.rowCount !== 0) {
    throw new PackEncodeError(
      `diff header rowCount must be the 0 sentinel (or null), got ${opts.header.rowCount}`,
    );
  }
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
    /* v0.2a — this entry point ONLY produces diffs, so STAMP kind=diff on the
       wire even when the caller omits it. Without this a kindless diff header
       decodes as a master and the strict decoder rejects the encoder's own
       valid output (it carries +/x operations). */
    kind: 'diff',
  });
  /* Trailer rows for a patch pack = `+` additions + `x` deletions —
     the same "total data row lines" formula decode() recomputes. */
  const total = opts.tables.reduce((s, t) => s + t.addedRows.length + t.deletedIds.length, 0);
  return assemble(headerOut, metaLines(withCapsTyped(opts.meta, opts.tables), enc), enc.dictLines(), tableLines, {
    rows: total,
    tables: distinctTableCount(opts.tables),
  });
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
  return `# ${h.producer}\t${h.schema}\t${h.snapshotId}\t${rc}${renderHeaderExtras(h)}`;
}

/**
 * v0.2 (S5) — optional appended header fields 5-8: seq, parent, kind,
 * generated. Positional, so emitting a later field forces `-`
 * placeholders for earlier absent ones. Nothing is emitted when all
 * four are absent (the v3 4-field header stays byte-identical).
 */
function renderHeaderExtras(h: PackHeader): string {
  if (h.seq === undefined && h.parent === undefined && h.kind === undefined
    && h.generated === undefined && h.corpus === undefined) {
    return '';
  }
  if (h.seq !== undefined && (!Number.isInteger(h.seq) || h.seq < 0)) {
    throw new PackEncodeError(`Header.seq must be a non-negative integer, got ${h.seq}`);
  }
  if (h.kind !== undefined && h.kind !== 'master' && h.kind !== 'diff') {
    throw new PackEncodeError(`Header.kind must be 'master' or 'diff', got '${h.kind}'`);
  }
  for (const [k, v] of Object.entries({ parent: h.parent, generated: h.generated, corpus: h.corpus })) {
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0 || /[\t\n\r]/.test(v)) {
      throw new PackEncodeError(`Header.${k} must be a non-empty string without tab/newline/CR`);
    }
  }
  /* `-` is the reserved ABSENT placeholder for the seq/kind/generated/corpus
     slots, so passing it as a real value would silently decode back as absent
     (a round-trip hole). parent='-' is the meaningful genesis value and is
     exempt. Reject the others, mirroring the rowLine '-' guard. */
  if (h.generated === '-') throw new PackEncodeError("Header.generated must not be '-' (the reserved absent placeholder)");
  if (h.corpus === '-') throw new PackEncodeError("Header.corpus must not be '-' (the reserved absent placeholder)");
  const slots = [
    h.seq !== undefined ? String(h.seq) : '-',
    h.parent ?? '-',
    h.kind ?? '-',
    h.generated ?? '-',
    h.corpus ?? '-', // agent-v5 field 9
  ];
  // Trim trailing placeholders — emit only up to the last real field.
  let last = slots.length - 1;
  const defined = [h.seq !== undefined, h.parent !== undefined, h.kind !== undefined,
    h.generated !== undefined, h.corpus !== undefined];
  while (last >= 0 && !defined[last]) last--;
  return '\t' + slots.slice(0, last + 1).join('\t');
}

function declSchemaLine(name: string, columns: PackColumn[]): string {
  if (!name || name.indexOf('\t') >= 0 || name.indexOf('\n') >= 0) {
    throw new PackEncodeError(`Table name '${name}' is invalid (empty or contains tab/newline)`);
  }
  for (const c of columns) {
    if (!c.name || c.name.indexOf('\t') >= 0 || c.name.indexOf('\n') >= 0) {
      throw new PackEncodeError(`Column name '${c.name}' is invalid (empty or contains tab/newline)`);
    }
    if (c.type !== undefined) {
      /* agent-v5 typed token `name:type`. The decoder splits on the FIRST ':',
         so the NAME must not contain ':' and the type must be a clean token. */
      if (c.name.indexOf(':') >= 0) {
        throw new PackEncodeError(`Column '${c.name}' carries a type but its name contains ':' (ambiguous with the type token)`);
      }
      if (!c.type || /[\t\n:]/.test(c.type)) {
        throw new PackEncodeError(`Column '${c.name}' type '${c.type}' is invalid (empty or contains tab/newline/':')`);
      }
    }
    if (c.internGroup !== undefined) {
      /* internGroup is encoder-side metadata for interned columns only.
         On a literal (lowercase) column it would silently do nothing —
         the decoder resolves by COLUMN name casing, not group — so we
         reject the contradiction. The group becomes the dictionary key
         prefix; `=`/whitespace would corrupt `@ K=V` lines. */
      if (!isInternedColumn(c.name)) {
        throw new PackEncodeError(
          `Column '${c.name}' is literal (lowercase) but declares internGroup '${c.internGroup}'`,
        );
      }
      if (!c.internGroup || /[\t\n =]/.test(c.internGroup)) {
        throw new PackEncodeError(
          `internGroup '${c.internGroup}' on column '${c.name}' is invalid (empty or contains tab/newline/space/'=')`,
        );
      }
    }
  }
  return `& ${name}\t${columns.map((c) => (c.type !== undefined ? `${c.name}:${c.type}` : c.name)).join('\t')}`;
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
      return enc.intern(col, cell);
    }
    if (cell === '-') {
      /* v0.2 (S12) — a literal cell that IS the single dash would
         decode back as null: a silent round-trip hole. Producer-side
         strictness closes it; the wire grammar is unchanged. */
      throw new PackEncodeError(
        `Literal column '${col.name}' cell is exactly "-" — it would decode as null (spec §10/S12); map it to a sentinel at the producer`,
      );
    }
    return escapeCell(cell);
  });
  return `${prefix} ${cells.join('\t')}`;
}

/**
 * v0.2 (S2/S3) — render the `;` meta lines: caller-supplied legend
 * first, then the encoder-derived `; hot:` reference hints. Must be
 * called AFTER all rows are rendered (the hot ranking reads the
 * encoder's use counters).
 */
function metaLines(meta: PackMeta | undefined, enc: Encoder): string[] {
  const out: string[] = [];
  for (const text of meta?.legend ?? []) {
    if (text.indexOf('\n') >= 0) {
      throw new PackEncodeError('Legend lines must not contain newlines (one entry per line)');
    }
    /* v0.2a — the `; end rows=… tables=… sha256=…` trailer is an encoder-minted
       reserved form. A legend line matching it would be re-read by the decoder as
       THE trailer, rejecting the rest of the pack ("content after the trailer").
       Refuse it at emit so the encoder never produces output its decoder rejects. */
    if (/^end rows=\d+ tables=\d+ sha256=[0-9a-f]{12}$/.test(text)) {
      throw new PackEncodeError(
        `Legend line collides with the reserved \`; end\` trailer form: ${text}`,
      );
    }
    out.push(`; ${text}`);
  }
  if (meta?.hot) {
    const hot = enc.hotLine(meta.hot.group, meta.hot.top ?? 20);
    if (hot) out.push(hot);
  }
  return out;
}

/**
 * agent-v5 — if any column carries a type, ensure a leading `; caps typed`
 * capability line so the pack SELF-DECLARES its typed tokens. Then a default
 * decode() parses the types (round-trips) and the caps line always precedes the
 * `&` schemas it governs. No-op when nothing is typed (so v0.2 packs stay byte
 * unchanged) and idempotent when the caller already declared it.
 */
function withCapsTyped(
  meta: PackMeta | undefined,
  tables: ReadonlyArray<{ columns: PackColumn[] }>,
): PackMeta | undefined {
  const hasTyped = tables.some((t) => t.columns.some((c) => c.type !== undefined));
  if (!hasTyped) return meta;
  const legend = meta?.legend ?? [];
  const declared = legend.some((l) => l.startsWith('caps ') && l.slice(5).split(/\s+/).includes('typed'));
  if (declared) return meta;
  return { ...meta, legend: ['caps typed', ...legend] };
}

function distinctTableCount(tables: ReadonlyArray<{ name: string }>): number {
  return new Set(tables.map((t) => t.name)).size;
}

function assemble(
  headerLine: string,
  metaOut: string[],
  dictLines: string[],
  tableLines: string[],
  totals: { rows: number; tables: number },
): string {
  const parts: string[] = [headerLine];
  if (metaOut.length > 0) parts.push(...metaOut);
  if (dictLines.length > 0) parts.push(...dictLines);
  if (tableLines.length > 0) parts.push(...tableLines);
  // Trailing newline per spec §10.
  const body = parts.join('\n') + '\n';
  /* v0.2 (S4) — integrity trailer, always the FINAL line. The sha256
     covers every byte before the trailer line, so any truncation or
     edit upstream of it breaks verification at decode(). */
  const sha = sha256hex(body).slice(0, 12);
  return `${body}; end rows=${totals.rows} tables=${totals.tables} sha256=${sha}\n`;
}

function assertNotEmpty(value: string, msg: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PackEncodeError(msg);
  }
}

/**
 * Internal encoder state — owns the dictionary keyed by namespace:
 * `internGroup ?? colName` (v0.2 S8). Columns without a group keep
 * the v1 behavior — their own counter (`F1`, `F2`, ... for column
 * `F`; independently `R1`, `R2`, ... for column `R`). Columns
 * sharing a group share one pool, so the same literal gets ONE key
 * across every table (kills the F/T aliasing ambiguity).
 *
 * Why per-namespace instead of global counters? Spec convention §4.2:
 * "a single-letter prefix tied to the column it serves." The group
 * name doubles as the key prefix so keys stay readable.
 */
class Encoder {
  /** namespace → (literal → key). */
  private readonly maps = new Map<string, Map<string, string>>();
  /** namespace → next counter. */
  private readonly counters = new Map<string, number>();
  /** Dict lines in the order they were minted (preserves spec
   *  preference for "before first use" ordering when concatenated
   *  ahead of the table lines). */
  private readonly dict: string[] = [];
  /** v0.2 (S3) — per-key reference count + literal, for `; hot:`. */
  private readonly uses = new Map<string, { ns: string; literal: string; count: number }>();

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
   *  keys append a `@ K=V` line to `this.dict`. The namespace (and
   *  key prefix) is the column's internGroup when set, else its name. */
  intern(col: PackColumn, literal: string): string {
    const ns = col.internGroup ?? col.name;
    let map = this.maps.get(ns);
    if (!map) {
      map = new Map();
      this.maps.set(ns, map);
    }
    let key = map.get(literal);
    if (!key) {
      const next = (this.counters.get(ns) ?? 0) + 1;
      this.counters.set(ns, next);
      key = `${ns}${next}`;
      map.set(literal, key);
      this.dict.push(`@ ${key}=${escapeCell(literal)}`);
      this.uses.set(key, { ns, literal, count: 0 });
    }
    this.uses.get(key)!.count++;
    return key;
  }

  dictLines(): string[] {
    return this.dict;
  }

  /** v0.2 (S3) — `; hot: F12~cli.ts F7~engine.ts …` for the `top`
   *  most-referenced keys of namespace `ns`. Hint = basename of the
   *  literal (escaped). Returns null when the namespace is unused.
   *  Ties break by key number so output stays deterministic. */
  hotLine(ns: string, top: number): string | null {
    const ranked = [...this.uses.entries()]
      .filter(([, u]) => u.ns === ns)
      .sort(([ka, a], [kb, b]) => b.count - a.count
        || Number(ka.slice(ns.length)) - Number(kb.slice(ns.length)))
      .slice(0, top);
    if (ranked.length === 0) return null;
    const hints = ranked.map(([key, u]) => {
      const base = u.literal.slice(u.literal.lastIndexOf('/') + 1) || u.literal;
      return `${key}~${escapeCell(base)}`;
    });
    return `; hot: ${hints.join(' ')}`;
  }
}

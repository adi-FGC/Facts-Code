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
 * `# @ & - + x ;` (and which isn't an empty line, which is permitted)
 * triggers a `PackDecodeError`. Spec §4: "Anything else on the first
 * byte of a line is undefined and MUST be rejected."
 *
 * v0.2 additions:
 *   - `;` meta lines (S1/S2/S3) are accepted ANYWHERE and collected
 *     into `DecodedPack.meta` — unknown forms are never rejected
 *     (forward-compatible by design).
 *   - The `; end rows=<n> tables=<m> sha256=<12hex>` trailer (S4) is
 *     verified when present: it must be the final line, its counts
 *     must match what was decoded, and its sha256 must match the
 *     preceding bytes — otherwise the pack is truncated or tampered
 *     and we reject. Packs WITHOUT a trailer (v3) still decode.
 *
 * Schema-version mismatch is a separate concern — the decoder reads
 * the header faithfully but doesn't enforce a particular version. The
 * caller checks `decoded.header.schema` against what it understands
 * and rejects loudly on mismatch (spec §11).
 */

import { unescapeCell } from './escape.js';
import { sha256hex } from './sha256.js';
import {
  isInternedColumn,
  STRICT_DEFAULT_LIMITS,
  type DecodedPack,
  type DecodedTable,
  type DecodeLimits,
  type DecodeOptions,
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
 *
 * v0.2a — `opts.mode` defaults to `'strictV02'`: the trailer is REQUIRED,
 * master header rowCount must equal the trailer count, a diff header must
 * carry the `0` sentinel, operations must be legal for the declared kind,
 * and resource ceilings apply. Pass `{ mode: 'legacy' }` (or call
 * `decodeLegacy`) for the pre-v0.2a permissive behavior.
 */
export function decode(text: string, opts?: DecodeOptions): DecodedPack {
  const mode = opts?.mode ?? 'strictV02';
  /* Strict mode layers the generous default ceilings under any caller
     overrides; legacy applies caps only when explicitly asked. */
  const limits: DecodeLimits = mode === 'strictV02'
    ? { ...STRICT_DEFAULT_LIMITS, ...opts?.limits }
    : { ...opts?.limits };
  /* agent-v5 — parse inline `name:type` schema tokens. Enabled by the caller
     option, or self-enabled when the pack declares it via a `; caps … typed`
     line (which always precedes the `&` schema lines). */
  let typedColumns = opts?.typedColumns ?? false;
  let sawSchema = false; // any `&` line parsed yet (for the caps-ordering guard)

  if (text.length > 0 && text.charCodeAt(0) === 0xFEFF) {
    /* Spec §10: BOM is forbidden. Reject loudly so producers can fix
       their writer instead of silently appearing fine in some
       consumers and broken in others. */
    throw new PackDecodeError('BOM detected at start of pack — forbidden by spec §10');
  }
  if (limits.maxBytes !== undefined && text.length > limits.maxBytes) {
    throw new PackDecodeError(`Pack exceeds maxBytes limit: ${text.length} > ${limits.maxBytes}`);
  }

  const lines = text.split('\n');
  if (limits.maxLines !== undefined && lines.length > limits.maxLines) {
    throw new PackDecodeError(`Pack exceeds maxLines limit: ${lines.length} > ${limits.maxLines}`);
  }
  /* Running data-row tally (`-`/`+`/`x`) for the maxRows ceiling. */
  let totalRows = 0;
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
  /* v0.2 — non-trailer `;` bodies in source order. */
  const meta: string[] = [];
  /* v0.2 — the `; end …` trailer, if seen. `offset` tracks where each
     line starts in `text` so the sha256 can cover the exact preceding
     bytes. */
  let trailer: { rows: number; tables: number; sha256: string; lineNo: number; start: number } | null = null;
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = offset;
    offset += line.length + 1; // +1 for the '\n' split() consumed
    if (line.length === 0) continue; // empty lines permitted, ignored
    if (trailer !== null) {
      throw new PackDecodeError(
        `Line ${i + 1}: content after the \`; end\` trailer — the trailer must be the final line`,
      );
    }
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
        if (limits.maxDictEntries !== undefined && dict.size >= limits.maxDictEntries) {
          throw new PackDecodeError(`Line ${i + 1}: pack exceeds maxDictEntries limit (${limits.maxDictEntries})`);
        }
        dict.set(key, escapedValue);
        break;
      }
      case 0x26 /* & */: {
        sawSchema = true;
        const fields = body.split('\t');
        const name = fields[0];
        if (!name) {
          throw new PackDecodeError(`Line ${i + 1}: schema declaration missing table name`);
        }
        const columns: PackColumn[] = fields.slice(1).map((n) => {
          // agent-v5 typed token: split on the FIRST ':' into name + type. A
          // MALFORMED token (empty name, empty type, or a type that itself
          // contains ':') is NOT typed — it folds to an untyped name, so the
          // decoder never accepts a token the encoder would reject and
          // decode→re-encode stays total. (encode.ts mirrors these rules.)
          if (typedColumns) {
            const ci = n.indexOf(':');
            if (ci > 0 && ci < n.length - 1 && n.indexOf(':', ci + 1) < 0) {
              return { name: n.slice(0, ci), type: n.slice(ci + 1) };
            }
          }
          return { name: n };
        });
        if (columns.length === 0) {
          throw new PackDecodeError(`Line ${i + 1}: schema for '${name}' has zero columns`);
        }
        if (limits.maxColumns !== undefined && columns.length > limits.maxColumns) {
          throw new PackDecodeError(`Line ${i + 1}: table '${name}' exceeds maxColumns limit (${limits.maxColumns})`);
        }
        const existing = tables.get(name);
        if (existing) {
          // Re-declared schema must match column-for-column, INCLUDING the
          // agent-v5 type token (a contradictory `id:int` then `id:str` is a
          // real divergence, not a benign repeat).
          if (existing.columns.length !== columns.length ||
              existing.columns.some((c, j) => c.name !== columns[j]!.name || c.type !== columns[j]!.type)) {
            throw new PackDecodeError(
              `Line ${i + 1}: schema for '${name}' redeclared with different columns`,
            );
          }
          active = existing;
        } else {
          if (limits.maxTables !== undefined && tables.size >= limits.maxTables) {
            throw new PackDecodeError(`Line ${i + 1}: pack exceeds maxTables limit (${limits.maxTables})`);
          }
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
        if (limits.maxRows !== undefined && ++totalRows > limits.maxRows) {
          throw new PackDecodeError(`Line ${i + 1}: pack exceeds maxRows limit (${limits.maxRows})`);
        }
        active.rows.push(row);
        break;
      }
      case 0x2B /* + */: {
        if (!active) {
          throw new PackDecodeError(`Line ${i + 1}: row '+' with no active schema`);
        }
        const row = parseRow(body, active.columns, i + 1);
        if (limits.maxRows !== undefined && ++totalRows > limits.maxRows) {
          throw new PackDecodeError(`Line ${i + 1}: pack exceeds maxRows limit (${limits.maxRows})`);
        }
        active.addedRows.push(row);
        break;
      }
      case 0x78 /* x */: {
        if (!active) {
          throw new PackDecodeError(`Line ${i + 1}: row 'x' with no active schema`);
        }
        if (limits.maxRows !== undefined && ++totalRows > limits.maxRows) {
          throw new PackDecodeError(`Line ${i + 1}: pack exceeds maxRows limit (${limits.maxRows})`);
        }
        // The `x` line carries a single field — the deleted row's
        // primary-key value. It's NOT split on tabs even if the value
        // contains escaped tabs; the whole body is the id.
        active.deletedIds.push(unescapeCell(body));
        break;
      }
      case 0x3B /* ; */: {
        /* v0.2 (S1) — meta line. Unknown forms are collected, never
           rejected. The one structural form is the `; end` trailer. */
        const t = parseTrailer(body);
        if (t) {
          trailer = { ...t, lineNo: i + 1, start: lineStart };
        } else {
          /* agent-v5 — a `; caps … typed` line self-declares that the `&`
             schema lines (which follow) carry inline `name:type` tokens. Match
             `typed` as an EXACT whitespace-delimited capability token, never as a
             substring of prose (`strongly-typed`, `"typed"`), which would
             otherwise silently split literal column names that contain ':'. */
          if (body.startsWith('caps ') && body.slice(5).split(/\s+/).includes('typed')) {
            if (sawSchema) {
              // A capability MUST be declared before the schema it governs; a
              // late caps line would split-brain the parse (early tables untyped,
              // later ones typed). Fail closed rather than mis-parse.
              throw new PackDecodeError(
                `Line ${i + 1}: '; caps … typed' appears after an '&' schema line; capabilities must precede the schemas they govern`,
              );
            }
            typedColumns = true;
          }
          meta.push(body);
        }
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

  /* v0.2a strict enforcement — the checks legacy mode tolerates. The
     trailer-required gate runs here (fail-closed before the trailer block);
     the kind-legality + count invariants live in enforceStrictV02() so the
     v0.2a contract is one named, locatable unit. */
  if (mode === 'strictV02') {
    if (!trailer) {
      throw new PackDecodeError(
        'strict v0.2: pack requires a `; end` trailer — use decodeLegacy() for pre-v0.2 packs',
      );
    }
    enforceStrictV02(header, tables, trailer);
  }

  /* v0.2 (S4) — trailer verification. In strict mode the trailer is
     guaranteed present (checked above); in legacy mode it's gated on
     presence so pre-v0.2 packs still decode. When present, every check
     is a MUST. */
  if (trailer) {
    let rowsTotal = 0;
    for (const t of tables.values()) {
      rowsTotal += t.rows.length + t.addedRows.length + t.deletedIds.length;
    }
    if (rowsTotal !== trailer.rows) {
      throw new PackDecodeError(
        `Pack appears truncated or tampered: trailer says rows=${trailer.rows} but ${rowsTotal} data rows decoded`,
      );
    }
    if (tables.size !== trailer.tables) {
      throw new PackDecodeError(
        `Pack appears truncated or tampered: trailer says tables=${trailer.tables} but ${tables.size} tables decoded`,
      );
    }
    const sha = sha256hex(text.slice(0, trailer.start)).slice(0, 12);
    if (sha !== trailer.sha256) {
      throw new PackDecodeError(
        `Pack appears truncated or tampered: trailer sha256=${trailer.sha256} but preceding bytes hash to ${sha}`,
      );
    }
    return {
      header, tables, meta,
      trailer: { rows: trailer.rows, tables: trailer.tables, sha256: trailer.sha256 },
    };
  }

  return { header, tables, meta };
}

/**
 * Decode in strict v0.2a mode (identical to the default `decode()`),
 * optionally tightening the resource ceilings.
 */
export function decodeStrict(text: string, limits?: DecodeLimits): DecodedPack {
  return decode(text, limits ? { mode: 'strictV02', limits } : { mode: 'strictV02' });
}

/**
 * Decode in legacy mode: tolerate a trailer-less (pre-v0.2) pack, skip
 * the header↔trailer count cross-checks and kind-legality, and apply no
 * resource ceilings unless `limits` are supplied. Use this only for
 * genuinely old packs; new code should prefer strict `decode()`.
 */
export function decodeLegacy(text: string, limits?: DecodeLimits): DecodedPack {
  return decode(text, limits ? { mode: 'legacy', limits } : { mode: 'legacy' });
}

/**
 * v0.2a strict-mode contract enforcement (spec §4.5): kind-legal operations and
 * the three-count model. Throws on the first violation; returns void when the
 * pack satisfies every MUST. Factored out of decode() so the strict invariants
 * live in one named, locatable, independently-readable place. `trailer` is
 * guaranteed non-null by the caller (decode() requires it before invoking this).
 */
function enforceStrictV02(
  header: PackHeader,
  tables: Map<string, DecodedTable>,
  trailer: { rows: number; tables: number; sha256: string },
): void {
  // Kind-legal operations: a master carries only '-' rows; a diff only '+'/'x'.
  for (const t of tables.values()) {
    if (header.kind === 'diff') {
      if (t.rows.length > 0) {
        throw new PackDecodeError(
          `strict v0.2: kind=diff but table '${t.name}' carries ${t.rows.length} baseline '-' row(s)`,
        );
      }
    } else if (t.addedRows.length > 0 || t.deletedIds.length > 0) {
      throw new PackDecodeError(
        `strict v0.2: kind=${header.kind ?? 'master'} but table '${t.name}' carries incremental '+'/'x' operations`,
      );
    }
  }
  // Count semantics: a diff's header rowCount is the 0 sentinel; a master's header
  // rowCount (when present) equals the trailer/operation count.
  if (header.kind === 'diff') {
    if (header.rowCount !== 0) {
      throw new PackDecodeError(
        `strict v0.2: kind=diff header rowCount must be the 0 sentinel, got ${header.rowCount}`,
      );
    }
  } else if (header.rowCount !== null && header.rowCount !== trailer.rows) {
    throw new PackDecodeError(
      `strict v0.2: master header rowCount=${header.rowCount} but trailer rows=${trailer.rows}`,
    );
  }
}

/** Match the v0.2 (S4) trailer form `end rows=<n> tables=<m>
 *  sha256=<12hex>`. Returns null for every other `;` body. */
function parseTrailer(body: string): { rows: number; tables: number; sha256: string } | null {
  const m = /^end rows=(\d+) tables=(\d+) sha256=([0-9a-f]{12})$/.exec(body);
  if (!m) return null;
  return { rows: Number(m[1]), tables: Number(m[2]), sha256: m[3]! };
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
  } else if (/^\d+$/.test(rowCountField!)) {
    // Digits-only — reject Number() leniency (''→0, '1e2', '0x10', ' 5 ') so the
    // count field is unambiguous, matching the seq field's strictness.
    rowCount = Number(rowCountField);
  } else {
    throw new PackDecodeError(
      `Line ${lineNo}: header rowCount '${rowCountField}' is not a non-negative integer or '-'`,
    );
  }
  const header: PackHeader = { producer: producer!, schema: schema!, snapshotId: snapshotId!, rowCount };

  /* v0.2 (S5) — optional appended fields 5-8: seq, parent, kind,
     generated. A `-` slot means absent for seq/kind/generated; for
     parent it is the meaningful genesis value and is kept verbatim.
     Fields beyond the 8th are ignored (the forward-compat seam this
     release itself relied on). */
  if (fields.length > 4 && fields[4] !== '-') {
    // Digits-only, same as rowCount — reject Number() leniency ('1e2', '0x10', ' 5 ').
    if (!/^\d+$/.test(fields[4]!)) {
      throw new PackDecodeError(
        `Line ${lineNo}: header seq '${fields[4]}' is not a non-negative integer or '-'`,
      );
    }
    header.seq = Number(fields[4]);
  }
  if (fields.length > 5 && fields[5] !== '') {
    header.parent = fields[5]!;
  }
  if (fields.length > 6 && fields[6] !== '-' && fields[6] !== '') {
    const kind = fields[6]!;
    if (kind !== 'master' && kind !== 'diff') {
      throw new PackDecodeError(
        `Line ${lineNo}: header kind '${kind}' is not 'master', 'diff', or '-'`,
      );
    }
    header.kind = kind;
  }
  if (fields.length > 7 && fields[7] !== '-' && fields[7] !== '') {
    header.generated = fields[7]!;
  }
  // agent-v5 — header field 9: repo-scoped corpus name (additive; older packs
  // omit it, older decoders ignored fields beyond the 8th).
  if (fields.length > 8 && fields[8] !== '-' && fields[8] !== '') {
    header.corpus = fields[8]!;
  }
  return header;
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

/**
 * FactsPack types — the contract every encoder/decoder caller speaks.
 *
 * Faithfully reflects the wire format documented in `docs/FACTSPACK.md`
 * (the spec). The naming choices here matter because consumer code
 * reads back like the spec: a `PackTable` has a `name`, an array of
 * `PackColumn`s, and an array of `PackRow`s.
 *
 * Cells are nullable: a `null` cell serializes as the literal `-`
 * (spec §4.4 — "the literal `-` (single dash) means 'no value / null'").
 * Empty string is distinct from null and serializes as the empty cell
 * between two tabs.
 *
 * No Zod here on purpose — this package is a wire-format library, and
 * every Zod dep would inflate the bundle for consumers (browsers,
 * extensions) that just want fast text manipulation. Validation lives
 * either in the producer (the analyzer assembles correct shapes) or in
 * the optional consumer-side pass we leave to callers.
 */

/**
 * One column in a table schema. Casing of `name` is contractual:
 * - **Uppercase first byte** (A-Z) ⇒ interned column. Cell values are
 *   short dictionary keys (`F1`, `F2`, ...) that the encoder maps to
 *   full literals via `@ K=V` lines.
 * - **Lowercase first byte** ⇒ literal column. Cell values are raw
 *   strings (with `\t` `\n` `\\` escapes when needed).
 *
 * Spec §4.3.
 */
export interface PackColumn {
  name: string;
}

/**
 * One row's cells in column order. `null` ⇒ no value (serializes as
 * a bare `-`). Empty string is a valid distinct value and serializes
 * as the empty cell between two tabs.
 */
export type PackRow = (string | null)[];

/**
 * Baseline table — a name, a schema, and the rows under it. The
 * encoder emits a `& <name> ...columns` line followed by `- ...cells`
 * lines (one per row).
 */
export interface PackTable {
  name: string;
  columns: PackColumn[];
  rows: PackRow[];
}

/**
 * Incremental table — the same schema, but with rows expressed as
 * additions and deletions instead of a full rebuild. Spec §4.4 + §7.
 *
 * `addedRows` emit as `+ ...cells` lines. `deletedIds` emit as
 * `x <id>` lines, where `<id>` is the value of the row's primary-key
 * column (column 1 by convention).
 *
 * The schema MUST still be declared even when both arrays are empty —
 * a multi-table incremental pack tracks active schema by `&` lines and
 * drifting from that grammar invalidates the pack.
 */
export interface IncrementalTable {
  name: string;
  columns: PackColumn[];
  addedRows: PackRow[];
  deletedIds: string[];
}

/**
 * Pack header — the single `# ...` line at the top of every pack.
 * Spec §4.1.
 *
 * - `producer` is `<toolName>/<version>` (e.g. `factstack/0.3.10`).
 *   Identifies the producer well enough to caller can opt-in or out
 *   based on origin.
 * - `schema` is `<schemaName>-v<n>` (e.g. `agent-v1`). The version is
 *   bumped on breaking changes; consumers MUST reject mismatches.
 * - `snapshotId` is an opaque string the producer chooses (commit SHA,
 *   analyze id, etc.) — used by callers as a cache key.
 * - `rowCount` is the total expected rows. `null` here serializes as
 *   `-` and signals streaming/patch-only mode (spec §7).
 */
export interface PackHeader {
  producer: string;
  schema: string;
  snapshotId: string;
  rowCount: number | null;
}

/**
 * Encoder input — header plus baseline tables. The encoder is
 * responsible for dictionary management; callers just hand over the
 * full literals and the encoder interns repeated values automatically
 * for any column whose name is uppercase.
 */
export interface EncodeOptions {
  header: PackHeader;
  tables: PackTable[];
}

/**
 * Incremental encoder input — header plus per-table additions and
 * deletions. Consumers apply the resulting pack on top of an earlier
 * baseline to produce the new state (spec §7).
 */
export interface IncrementalEncodeOptions {
  header: PackHeader;
  tables: IncrementalTable[];
}

/**
 * Decoder output table — same shape as `PackTable`, plus a separate
 * `deletedIds[]` array for `x` lines encountered during decode. In
 * baseline-only packs `deletedIds` is empty.
 */
export interface DecodedTable {
  name: string;
  columns: PackColumn[];
  rows: PackRow[];
  /** Rows added via `+` lines (incremental packs). Empty when the
   *  pack is a baseline. */
  addedRows: PackRow[];
  /** Primary-key values from `x` lines (incremental packs). Empty
   *  when the pack is a baseline. */
  deletedIds: string[];
}

/**
 * Full decoded pack: header plus a name-keyed map of tables. Iteration
 * order of the map matches the `&` declaration order in the source —
 * useful for reconstructing the original wire output byte-for-byte if
 * the dictionary keys land in the same slots.
 */
export interface DecodedPack {
  header: PackHeader;
  tables: Map<string, DecodedTable>;
}

/**
 * True when `colName` is an interned-column name (first byte A-Z).
 * Spec §4.3.
 */
export function isInternedColumn(colName: string): boolean {
  if (colName.length === 0) return false;
  const c = colName.charCodeAt(0);
  return c >= 0x41 && c <= 0x5A; // A..Z
}

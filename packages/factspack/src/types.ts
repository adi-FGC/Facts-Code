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
  /**
   * agent-v5 — optional logical datatype emitted inline on the `&` schema line
   * as `name:type` (e.g. `loc:int`, `score:ratio`, `F:dict`). Resolves the
   * value-ambiguity criticism: readers no longer infer a column's meaning from
   * its name. BREAKING for pre-agent-v5 readers (they parse `name:type` as the
   * whole name), so it is opt-in on both sides: the encoder emits it only when
   * set, and the decoder parses it only under `DecodeOptions.typedColumns`
   * (a pack self-declares this via a `; caps … typed` line; spec §agent-v5).
   */
  type?: string;
  /**
   * v0.2 (S8) — shared intern namespace. Columns in the SAME group
   * (across any table) draw dictionary keys from one pool, so the same
   * literal gets one id pack-wide (e.g. `imports.F` + `imports.T` both
   * in group `F` ⇒ one key per file). Encoder-side only: the wire dict
   * is flat and the decoder never inspects key shape. Only meaningful
   * on interned (uppercase-named) columns — the encoder rejects it on
   * literal columns.
   */
  internGroup?: string;
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
 * - `snapshotId` is field 3 on the wire. v0.2 (S5) narrows it
 *   normatively to the git commit SHA (or `working`) when available;
 *   the name stays `snapshotId` for source compat — used by callers
 *   as a cache key.
 * - `rowCount` is the total expected rows. `null` here serializes as
 *   `-` and signals streaming/patch-only mode (spec §7).
 *
 * v0.2 (S5) appends four optional fields (positions 5-8): `seq`,
 * `parent`, `kind`, `generated`. Old 4-field headers still decode;
 * old decoders ignore the extras. On the wire a `-` in the seq /
 * kind / generated slot reads back as absent; `-` in the parent
 * slot is meaningful (genesis master — no predecessor).
 */
export interface PackHeader {
  producer: string;
  schema: string;
  snapshotId: string;
  rowCount: number | null;
  /** v0.2 — monotonic sequence number per chain. */
  seq?: number;
  /** v0.2 — 12-hex sha256 of the predecessor pack file; `-` for a
   *  genesis master. */
  parent?: string;
  /** v0.2 — pack role: full `master` or incremental `diff`. */
  kind?: 'master' | 'diff';
  /** v0.2 — ISO-8601 UTC generation timestamp (the one timestamp;
   *  data cells carry relative days against it). */
  generated?: string;
  /** agent-v5 — header field 9. A repo-scoped corpus name (Kythe VName
   *  lesson) so symbol ids from multiple repos concatenate without
   *  colliding. Additive: a `-` slot or absence means single-corpus;
   *  pre-agent-v5 decoders ignore fields beyond the 8th. */
  corpus?: string;
}

/**
 * v0.2 (S2/S3) — non-data `;` meta lines the encoder emits between
 * the header and the dictionary.
 */
export interface PackMeta {
  /** Legend lines (S2): each entry emits as one `; <text>` line, in
   *  order, immediately after the header. */
  legend?: readonly string[];
  /** Hot-reference hints (S3): emit a `; hot:` line listing the
   *  `top` (default 20) most-referenced dictionary keys of intern
   *  group / column `group`, each as `<key>~<basename>`. */
  hot?: { group: string; top?: number };
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
  /** v0.2 — optional `;` meta lines (legend + hot hints). The
   *  end-of-pack trailer is NOT optional and is always appended. */
  meta?: PackMeta;
}

/**
 * Incremental encoder input — header plus per-table additions and
 * deletions. Consumers apply the resulting pack on top of an earlier
 * baseline to produce the new state (spec §7).
 */
export interface IncrementalEncodeOptions {
  header: PackHeader;
  tables: IncrementalTable[];
  /** v0.2 — optional `;` meta lines (legend + hot hints). */
  meta?: PackMeta;
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
  /** v0.2 — bodies of every non-trailer `;` line, in source order
   *  (legend + hot hints + unknown future forms). Empty on v3 packs. */
  meta: string[];
  /** v0.2 — parsed end-of-pack trailer, present when the pack carried
   *  one (always verified before decode() returns). Absent on v3
   *  packs, which have no trailer and no truncation detection. */
  trailer?: { rows: number; tables: number; sha256: string };
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

/**
 * Decoder profile (v0.2a). The seam between "verify everything" and
 * "tolerate a pre-v0.2 (v0.1) pack with no trailer".
 *
 * - `strictV02` (the default): a v0.2 pack MUST carry a valid trailer;
 *   master header rowCount MUST equal the trailer rows; a diff header
 *   rowCount MUST be the `0` sentinel; operations MUST be legal for the
 *   declared `kind` (no `+`/`x` in a master, no `-` in a diff); resource
 *   ceilings apply. Anything else is rejected, fail-closed.
 * - `legacy`: the pre-v0.2a permissive behavior — a trailer is verified
 *   only when present, header counts are not cross-checked, and no
 *   ceilings apply. For decoding genuinely old v0.1 packs.
 */
export type DecodeMode = 'legacy' | 'strictV02';

/**
 * Resource ceilings enforced DURING the parse (before allocation), so a
 * hostile or runaway pack fails fast instead of exhausting memory. Every
 * field is optional; `undefined` means "no cap for this dimension".
 * Strict mode layers in `STRICT_DEFAULT_LIMITS` for any field the caller
 * does not override; legacy mode applies no ceilings unless asked.
 */
export interface DecodeLimits {
  /** Max total input bytes (UTF-16 length), checked before splitting. */
  maxBytes?: number;
  /** Max physical lines. */
  maxLines?: number;
  /** Max data rows (`-`/`+`/`x`) across the whole pack. */
  maxRows?: number;
  /** Max columns in any one table schema. */
  maxColumns?: number;
  /** Max distinct tables. */
  maxTables?: number;
  /** Max `@ K=V` dictionary entries. */
  maxDictEntries?: number;
}

/** Decoder options. Omitting `opts` entirely ⇒ `mode: 'strictV02'`. */
export interface DecodeOptions {
  mode?: DecodeMode;
  /** Per-dimension overrides; merged over the mode's defaults. */
  limits?: DecodeLimits;
  /**
   * agent-v5 — parse inline `name:type` tokens on `&` schema lines into
   * `PackColumn.type`. Off by default (pre-agent-v5 column names are taken
   * verbatim). A pack declares it carries typed tokens via a `; caps … typed`
   * line; a self-describing decoder sets this when it sees that line.
   */
  typedColumns?: boolean;
}

/**
 * Strict-mode default ceilings. Deliberately generous — a real code map
 * is thousands of rows, not millions — so legitimate packs never trip
 * them while pathological inputs fail fast. Override via `opts.limits`.
 */
export const STRICT_DEFAULT_LIMITS: Required<DecodeLimits> = {
  maxBytes: 64 * 1024 * 1024, // 64 MiB
  maxLines: 5_000_000,
  maxRows: 5_000_000,
  maxColumns: 4096,
  maxTables: 65_536,
  maxDictEntries: 5_000_000,
};

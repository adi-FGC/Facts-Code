/**
 * Diff-chain primitives — compute a diff between two decoded packs, and
 * apply a master + an ordered list of diffs back to a reconstructed state.
 *
 * Why these operate on DECODED packs (not raw artifacts): a `.pack`'s
 * dictionary keys (`F1`, `S2`, …) are assigned per-pack by reference
 * frequency, so the SAME literal can get a different key in the next
 * pack (see the legend rule "Ids are stable within this file only").
 * A sound diff therefore matches **literal** rows by a **stable primary
 * key** — and `decode()` has already resolved every cell to its literal.
 *
 * Row identity: the column-1 value is the primary key by convention
 * (types.ts / spec §4.4 — `x <id>` removes by the row's column-1 value).
 * Callers whose key is not column 0 pass `opts.keyIndex`. A null PK is a
 * contract violation and throws.
 *
 * `computeDiff` → `IncrementalTable[]` ready for `encodeIncremental()`.
 * `applyChain`  → reconstructed `Map<name, {columns, rows}>`.
 *
 * Note: `applyChain` reconstructs row CONTENT (a table is a set of rows);
 * it does not promise the same row ORDER as a fresh master. The chain's
 * value is that you keep the cached master and append small diffs — you
 * never re-encode, so ordering parity is unnecessary.
 *
 * Author: CC (Claude Code), 2026-06-14.
 */
import type { DecodedPack, DecodedTable, IncrementalTable, PackColumn, PackRow } from './types.js';

/** A reconstructed table: schema + the live row set after applying diffs. */
export interface AppliedTable {
  columns: PackColumn[];
  rows: PackRow[];
}

function keyOf(row: PackRow, keyIndex: number, where: string): string {
  const k = row[keyIndex];
  if (k === null || k === undefined) {
    throw new Error(`computeDiff/applyChain: null primary key at column ${keyIndex} in ${where}`);
  }
  return k;
}

/** Order-independent identity of a full row (for change detection). */
function serializeRow(row: PackRow): string {
  // Injective: JSON.stringify keeps null distinct from "null" and quotes every
  // cell, so distinct rows never alias (a bare concat collides ["a","b"] with ["ab"]).
  return JSON.stringify(row);
}

/**
 * Compute the per-table additions/deletions that turn `prev` into `next`,
 * keyed by the column-1 primary key. A changed row (same key, different
 * cells) becomes a delete (old key) + an add (new row), so applying the
 * result reproduces `next` exactly. Unchanged tables are omitted, so the
 * diff stays small. The returned shape feeds `encodeIncremental()`.
 */
export function computeDiff(
  prev: DecodedPack,
  next: DecodedPack,
  opts: { keyIndex?: number } = {},
): IncrementalTable[] {
  const ki = opts.keyIndex ?? 0;
  const out: IncrementalTable[] = [];
  const names = new Set<string>([...prev.tables.keys(), ...next.tables.keys()]);

  for (const name of names) {
    const p = prev.tables.get(name);
    const n = next.tables.get(name);

    // table only in next → every row is an addition. DI-2: emit even a ZERO-row
    // new table so applyChain materializes the new (schema-only) table —
    // previously an empty new table was silently dropped, so a schema-only
    // addition couldn't propagate through the diff chain. encodeIncremental
    // always emits the table's schema-decl line, so this round-trips cleanly.
    if (n && !p) {
      out.push({ name, columns: n.columns, addedRows: n.rows.map((r) => r.slice()), deletedIds: [] });
      continue;
    }
    // table only in prev → delete every row by key
    if (p && !n) {
      const deletedIds = p.rows.map((r) => keyOf(r, ki, `prev.${name}`));
      if (deletedIds.length > 0) out.push({ name, columns: p.columns, addedRows: [], deletedIds });
      continue;
    }
    if (!p || !n) continue; // unreachable, narrows types

    const prevByKey = new Map<string, string>(); // key → serialized row
    for (const r of p.rows) {
      const pk = keyOf(r, ki, `prev.${name}`);
      if (prevByKey.has(pk)) throw new Error(`computeDiff: duplicate primary key "${pk}" in prev.${name} — the PK column must be unique for a sound diff`);
      prevByKey.set(pk, serializeRow(r));
    }

    const addedRows: PackRow[] = [];
    const deletedIds: string[] = [];
    const seen = new Set<string>();
    for (const r of n.rows) {
      const k = keyOf(r, ki, `next.${name}`);
      if (seen.has(k)) throw new Error(`computeDiff: duplicate primary key "${k}" in next.${name} — the PK column must be unique`);
      seen.add(k);
      const prevSer = prevByKey.get(k);
      if (prevSer === undefined) {
        addedRows.push(r.slice()); // new key
      } else if (prevSer !== serializeRow(r)) {
        addedRows.push(r.slice()); // changed → re-add new version
        deletedIds.push(k); //        and delete the old
      }
    }
    for (const r of p.rows) {
      const k = keyOf(r, ki, `prev.${name}`);
      if (!seen.has(k)) deletedIds.push(k); // present in prev, gone in next
    }
    if (addedRows.length > 0 || deletedIds.length > 0) {
      out.push({ name, columns: n.columns, addedRows, deletedIds });
    }
  }
  return out;
}

/**
 * Apply a master and an ordered list of decoded diffs, producing the
 * reconstructed table set. Each diff's `deletedIds` are removed (matched
 * by column-1 PK) before its `addedRows` are appended, so a same-diff
 * delete+add (an update) lands correctly. Tables a diff never mentions
 * are carried through unchanged.
 *
 * Known limitation — dropped tables leave an empty residue: if a table
 * existed in the master but not in `next`, computeDiff emits a delete of
 * all its rows; applyChain empties it but keeps the (now zero-row) table in
 * the map. A fresh decode of `next` would omit that table entirely, so the
 * reconstructed table SET can carry an extra empty table. Faithfully
 * pruning it needs an explicit "table removed" signal in the wire diff,
 * because applyChain cannot distinguish "all rows deleted, table still
 * exists" from "table removed" (and the FACTS encoder emits all empty
 * tables on purpose, so blindly pruning empties would be wrong). This is
 * inert for FACTS itself: the agent encoder always emits the same fixed
 * table set, so the table-add/drop branches never fire on real packs. The
 * residue only appears in synthetic table-drop cases (see chain.test.ts).
 */
export function applyChain(
  master: DecodedPack,
  diffs: readonly DecodedPack[],
  opts: { keyIndex?: number } = {},
): Map<string, AppliedTable> {
  const ki = opts.keyIndex ?? 0;
  const tables = new Map<string, AppliedTable>();
  for (const [name, t] of master.tables) {
    tables.set(name, { columns: t.columns, rows: t.rows.map((r) => r.slice()) });
  }
  for (const diff of diffs) {
    for (const [name, dt] of diff.tables as Map<string, DecodedTable>) {
      let t = tables.get(name);
      if (!t) {
        t = { columns: dt.columns, rows: [] };
        tables.set(name, t);
      }
      if (dt.deletedIds.length > 0) {
        const del = new Set(dt.deletedIds);
        t.rows = t.rows.filter((r) => !del.has(keyOf(r, ki, `applied.${name}`)));
      }
      for (const r of dt.addedRows) t.rows.push(r.slice());
    }
  }
  return tables;
}

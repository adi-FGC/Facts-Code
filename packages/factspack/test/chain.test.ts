/**
 * Diff-chain primitives — computeDiff() + applyChain().
 *
 * The codec already encodes/decodes `kind=diff` packs (encode.ts /
 * decode.ts), but until now nothing COMPUTED a diff between two analyses
 * or APPLIED a master+diff chain back to a state. These tests pin both,
 * operating on DECODED (de-interned, literal) tables keyed by the
 * column-1 primary key (types.ts: "deletedIds ... value of the row's
 * primary-key column (column 1 by convention)").
 *
 * Cross-verified 2026-06-14: dict keys (F1/S2…) reorder per pack, so a
 * sound diff must match LITERAL rows by a stable PK — which is exactly
 * what these decoded-table primitives do.
 *
 * Author: CC (Claude Code), 2026-06-14.
 */
import { describe, expect, it } from 'vitest';
import { encode, encodeIncremental } from '../src/encode.js';
import { decode } from '../src/decode.js';
import { computeDiff, applyChain } from '../src/chain.js';
import type { DecodedPack, DecodedTable, PackHeader, PackRow, PackTable } from '../src/types.js';

const HEADER: PackHeader = { producer: 'factstack/0.3.10', schema: 'agent-v1', snapshotId: 's', rowCount: null };

/** Encode then decode a baseline table-set → a DecodedPack we can diff. */
function pack(tables: PackTable[]): DecodedPack {
  return decode(encode({ header: HEADER, tables }));
}
/** Content compare ignoring row order (rows are a set). */
function rowsByKey(rows: PackRow[]): string {
  return [...rows].map((r) => JSON.stringify(r)).sort().join('\n');
}
function tableContent(p: DecodedPack, name: string): string {
  const t = p.tables.get(name);
  return t ? rowsByKey(t.rows) : '<<missing>>';
}

describe('computeDiff — add / remove / update / unchanged by column-1 PK', () => {
  const prev = pack([{ name: 'files', columns: [{ name: 'path' }, { name: 'loc' }], rows: [['a.ts', '10'], ['b.ts', '20'], ['c.ts', '30']] }]);
  const next = pack([{ name: 'files', columns: [{ name: 'path' }, { name: 'loc' }], rows: [['a.ts', '10'], ['b.ts', '99'], ['d.ts', '40']] }]);
  const diff = computeDiff(prev, next);

  it('emits exactly one changed table', () => {
    expect(diff).toHaveLength(1);
    expect(diff[0]!.name).toBe('files');
  });
  it('adds new rows (d.ts) and the new version of changed rows (b.ts)', () => {
    const added = diff[0]!.addedRows.map((r) => r[0]).sort();
    expect(added).toEqual(['b.ts', 'd.ts']); // b changed (re-added), d new
  });
  it('deletes removed (c.ts) and the old version of changed rows (b.ts)', () => {
    expect(diff[0]!.deletedIds.sort()).toEqual(['b.ts', 'c.ts']);
  });
  it('leaves unchanged rows (a.ts) out of the diff entirely', () => {
    expect(diff[0]!.addedRows.some((r) => r[0] === 'a.ts')).toBe(false);
    expect(diff[0]!.deletedIds).not.toContain('a.ts');
  });
});

describe('computeDiff — table-level add/remove and unchanged omission', () => {
  const prev = pack([
    { name: 'files', columns: [{ name: 'path' }], rows: [['a.ts']] },
    { name: 'gone', columns: [{ name: 'path' }], rows: [['x.ts']] },
  ]);
  const next = pack([
    { name: 'files', columns: [{ name: 'path' }], rows: [['a.ts']] }, // unchanged
    { name: 'fresh', columns: [{ name: 'path' }], rows: [['y.ts']] }, // new table
  ]);
  const diff = computeDiff(prev, next);
  it('omits the unchanged table (files)', () => {
    expect(diff.find((t) => t.name === 'files')).toBeUndefined();
  });
  it('adds the whole new table (fresh) and deletes the whole removed table (gone)', () => {
    expect(diff.find((t) => t.name === 'fresh')!.addedRows).toEqual([['y.ts']]);
    expect(diff.find((t) => t.name === 'gone')!.deletedIds).toEqual(['x.ts']);
  });
});

describe('full chain round-trip — master + encoded diff, applied, equals next', () => {
  it('encodeIncremental(computeDiff(...)) decodes strict and applyChain reconstructs next', () => {
    const prev = pack([
      { name: 'files', columns: [{ name: 'path' }, { name: 'loc' }], rows: [['a.ts', '10'], ['b.ts', '20'], ['c.ts', '30']] },
      { name: 'symbols', columns: [{ name: 'id' }, { name: 'name' }], rows: [['a#f@1', 'f'], ['b#g@2', 'g']] },
    ]);
    const next = pack([
      { name: 'files', columns: [{ name: 'path' }, { name: 'loc' }], rows: [['a.ts', '10'], ['b.ts', '99'], ['d.ts', '40']] },
      { name: 'symbols', columns: [{ name: 'id' }, { name: 'name' }], rows: [['a#f@1', 'f'], ['c#h@3', 'h']] },
    ]);
    const incTables = computeDiff(prev, next);
    const masterSha = prev.trailer!.sha256;
    const diffText = encodeIncremental({
      header: { ...HEADER, snapshotId: 'next', rowCount: 0, seq: 2, parent: masterSha, kind: 'diff' },
      tables: incTables,
    });
    const diffDec = decode(diffText); // strict by default — proves the diff contract holds
    expect(diffDec.header.kind).toBe('diff');
    expect(diffDec.header.rowCount).toBe(0); // 0 sentinel; trailer carries the real count
    expect(diffDec.trailer).toBeDefined();

    const rebuilt = applyChain(prev, [diffDec]);
    expect(rowsByKey([...rebuilt.get('files')!.rows])).toBe(tableContent(next, 'files'));
    expect(rowsByKey([...rebuilt.get('symbols')!.rows])).toBe(tableContent(next, 'symbols'));
  });
});

describe('applyChain — multi-diff sequence', () => {
  it('master → d1 → d2 reconstructs the final state', () => {
    const s0 = pack([{ name: 'files', columns: [{ name: 'path' }, { name: 'loc' }], rows: [['a.ts', '1']] }]);
    const s1 = pack([{ name: 'files', columns: [{ name: 'path' }, { name: 'loc' }], rows: [['a.ts', '1'], ['b.ts', '2']] }]);
    const s2 = pack([{ name: 'files', columns: [{ name: 'path' }, { name: 'loc' }], rows: [['b.ts', '22'], ['c.ts', '3']] }]);
    const d1 = decode(encodeIncremental({ header: { ...HEADER, rowCount: 0, kind: 'diff' }, tables: computeDiff(s0, s1) }));
    const d2 = decode(encodeIncremental({ header: { ...HEADER, rowCount: 0, kind: 'diff' }, tables: computeDiff(s1, s2) }));
    const rebuilt = applyChain(s0, [d1, d2]);
    expect(rowsByKey([...rebuilt.get('files')!.rows])).toBe(tableContent(s2, 'files'));
  });
});

describe('computeDiff — identical states produce an empty diff', () => {
  it('no changed tables when nothing changed', () => {
    const a = pack([{ name: 'files', columns: [{ name: 'path' }], rows: [['a.ts'], ['b.ts']] }]);
    const b = pack([{ name: 'files', columns: [{ name: 'path' }], rows: [['a.ts'], ['b.ts']] }]);
    expect(computeDiff(a, b)).toEqual([]);
  });
});

/** Build a DecodedPack directly so a guard can be hit with cells (null PK,
 *  duplicate PK) the encoder would otherwise normalize — these test
 *  computeDiff's contract checks in isolation. */
function raw(tables: { name: string; columns: { name: string }[]; rows: PackRow[] }[]): DecodedPack {
  const m = new Map<string, DecodedTable>();
  for (const t of tables) m.set(t.name, { name: t.name, columns: t.columns, rows: t.rows, addedRows: [], deletedIds: [] });
  return { header: HEADER, tables: m, meta: [] };
}

describe('computeDiff — contract guards throw (a sound diff needs a unique, non-null PK)', () => {
  const files = [{ name: 'path' }, { name: 'loc' }];
  it('throws on a null primary key', () => {
    const prev = raw([{ name: 'files', columns: files, rows: [[null, '10']] }]);
    const next = raw([{ name: 'files', columns: files, rows: [['a.ts', '10']] }]);
    expect(() => computeDiff(prev, next)).toThrow(/null primary key/);
  });
  it('throws on a duplicate primary key in prev', () => {
    const prev = raw([{ name: 'files', columns: files, rows: [['a.ts', '1'], ['a.ts', '2']] }]);
    const next = raw([{ name: 'files', columns: files, rows: [['a.ts', '1']] }]);
    expect(() => computeDiff(prev, next)).toThrow(/duplicate primary key/);
  });
  it('throws on a duplicate primary key in next', () => {
    const prev = raw([{ name: 'files', columns: files, rows: [['a.ts', '1']] }]);
    const next = raw([{ name: 'files', columns: files, rows: [['a.ts', '1'], ['a.ts', '2']] }]);
    expect(() => computeDiff(prev, next)).toThrow(/duplicate primary key/);
  });
});

describe('applyChain — a dropped table leaves a documented empty residue', () => {
  it('keeps a fully-deleted table as an empty residue, where a fresh decode omits it', () => {
    const prev = pack([
      { name: 'files', columns: [{ name: 'path' }], rows: [['a.ts']] },
      { name: 'gone', columns: [{ name: 'path' }], rows: [['x.ts']] },
    ]);
    const next = pack([{ name: 'files', columns: [{ name: 'path' }], rows: [['a.ts']] }]);
    const diff = decode(encodeIncremental({ header: { ...HEADER, rowCount: 0, kind: 'diff' }, tables: computeDiff(prev, next) }));
    const rebuilt = applyChain(prev, [diff]);
    // Documented limitation (see chain.ts): the dropped table survives as an
    // EMPTY residue rather than vanishing...
    expect(rebuilt.has('gone')).toBe(true);
    expect(rebuilt.get('gone')!.rows).toEqual([]);
    // ...whereas a fresh decode of `next` has no such table at all.
    expect(next.tables.has('gone')).toBe(false);
    // The tables that remain still reconstruct exactly.
    expect(rebuilt.get('files')!.rows).toEqual([['a.ts']]);
  });
});

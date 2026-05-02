/**
 * Round-trip + fuzz tests — the PRD's headline test surface.
 *
 * Property: for any well-formed input `T`, `decode(encode(T))` returns
 * a table set that's value-equivalent to `T`. Dictionary key
 * assignment may differ in ordering (the encoder is deterministic for
 * a given input but the consumer cares only about the resolved
 * literals), so we assert on the resolved row arrays, not on the
 * intermediate dict keys.
 *
 * Fuzz strategy: a hand-rolled seeded RNG generates 30 random table
 * shapes with random column counts (1..6), random row counts (0..40),
 * random cells (literal/null/empty/with-escapes), randomized intern
 * column ratios. Reproducible because the seed is fixed.
 */

import { describe, expect, it } from 'vitest';
import { encode, encodeIncremental } from '../src/encode.js';
import { decode } from '../src/decode.js';
import type { PackHeader, PackRow, PackTable } from '../src/types.js';

const HEADER: PackHeader = {
  producer: 'factstack/0.3.10',
  schema: 'agent-v1',
  snapshotId: 'roundtrip',
  rowCount: null,
};

function roundTrip(tables: PackTable[]): PackTable[] {
  const text = encode({ header: HEADER, tables });
  const decoded = decode(text);
  return Array.from(decoded.tables.values()).map((t) => ({
    name: t.name,
    columns: t.columns,
    rows: t.rows,
  }));
}

function expectTablesEqual(actual: PackTable[], expected: PackTable[]): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]!;
    const e = expected[i]!;
    expect(a.name).toBe(e.name);
    expect(a.columns.map((c) => c.name)).toEqual(e.columns.map((c) => c.name));
    expect(a.rows).toEqual(e.rows);
  }
}

describe('round-trip — fixed cases', () => {
  it('single table, no interning', () => {
    const tables: PackTable[] = [
      {
        name: 't',
        columns: [{ name: 'a' }, { name: 'b' }],
        rows: [['1', '2'], ['3', '4']],
      },
    ];
    expectTablesEqual(roundTrip(tables), tables);
  });

  it('single table, all interned', () => {
    const tables: PackTable[] = [
      {
        name: 't',
        columns: [{ name: 'F' }, { name: 'R' }],
        rows: [
          ['src/a.ts', 'react'],
          ['src/a.ts', 'lodash'],
          ['src/b.ts', 'react'],
        ],
      },
    ];
    expectTablesEqual(roundTrip(tables), tables);
  });

  it('null + empty cells survive', () => {
    const tables: PackTable[] = [
      {
        name: 't',
        columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
        rows: [
          ['x', null, ''],
          [null, '', 'z'],
          ['', 'y', null],
        ],
      },
    ];
    expectTablesEqual(roundTrip(tables), tables);
  });

  it('cells with all three escape characters', () => {
    const tables: PackTable[] = [
      {
        name: 't',
        columns: [{ name: 'msg' }],
        rows: [
          ['has\ttab'],
          ['has\nnewline'],
          ['has\\backslash'],
          ['all\t\n\\at\tonce'],
        ],
      },
    ];
    expectTablesEqual(roundTrip(tables), tables);
  });

  it('multi-table with shared interned column', () => {
    const tables: PackTable[] = [
      {
        name: 'symbols',
        columns: [{ name: 'id' }, { name: 'F' }],
        rows: [['1', 'src/a.ts'], ['2', 'src/b.ts']],
      },
      {
        name: 'imports',
        columns: [{ name: 'id' }, { name: 'F' }, { name: 'to' }],
        rows: [['1', 'src/a.ts', 'react'], ['2', 'src/a.ts', 'lodash']],
      },
    ];
    expectTablesEqual(roundTrip(tables), tables);
  });

  it('UTF-8 multi-byte characters survive', () => {
    const tables: PackTable[] = [
      {
        name: 't',
        columns: [{ name: 'name' }],
        rows: [['日本語'], ['emoji 🚀'], ['mixed: 日 + 🚀 + \\']],
      },
    ];
    expectTablesEqual(roundTrip(tables), tables);
  });
});

describe('round-trip — incremental packs', () => {
  it('+ rows + x deletions decode back to addedRows + deletedIds', () => {
    const text = encodeIncremental({
      header: HEADER,
      tables: [
        {
          name: 'symbols',
          columns: [{ name: 'id' }, { name: 'k' }, { name: 'F' }],
          addedRows: [
            ['6', 'fn', 'src/auth.ts'],
            ['7', 'cls', 'src/users.ts'],
          ],
          deletedIds: ['3', '4'],
        },
      ],
    });
    const decoded = decode(text);
    const t = decoded.tables.get('symbols')!;
    expect(t.rows).toHaveLength(0); // no baseline rows
    expect(t.addedRows).toHaveLength(2);
    expect(t.addedRows[0]).toEqual(['6', 'fn', 'src/auth.ts']);
    expect(t.addedRows[1]).toEqual(['7', 'cls', 'src/users.ts']);
    expect(t.deletedIds).toEqual(['3', '4']);
  });
});

/* ───────────── Fuzz suite ───────────── */

/**
 * Mulberry32 — small, fast, fully deterministic seeded RNG. Vitest
 * doesn't ship a property-test helper by default; this gives us
 * reproducible randomness without pulling in fast-check.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = r + Math.imul(r ^ (r >>> 7), 61 | r) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandomTable(rng: () => number, idx: number): PackTable {
  const colCount = 1 + Math.floor(rng() * 6); // 1..6
  /* Mix interned (uppercase) and literal (lowercase) columns. First
     column is conventionally `id` (a primary key) — keep it lowercase
     so deletions reference the literal value, not a dict key. */
  const columns = Array.from({ length: colCount }, (_, c) => {
    if (c === 0) return { name: 'id' };
    const interned = rng() < 0.4;
    const letter = String.fromCharCode((interned ? 0x41 : 0x61) + ((c * 7) % 26)); // A..Z or a..z
    return { name: letter };
  });

  const rowCount = Math.floor(rng() * 40); // 0..39
  /* For interned columns, draw from a small fixed pool so values
     repeat — that's where the interning win comes from and where
     the encoder/decoder relationship is most easily wrong. */
  const internPool = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
  const literalChars = 'abcdefghij \t\n\\日';
  const rows: PackRow[] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: (string | null)[] = columns.map((col, c) => {
      const roll = rng();
      if (roll < 0.05) return null;
      if (roll < 0.10) return '';
      if (col.name.charCodeAt(0) >= 0x41 && col.name.charCodeAt(0) <= 0x5A) {
        // interned — pick from the small repeating pool
        return internPool[Math.floor(rng() * internPool.length)]!;
      }
      // literal — random length, random chars (including escape-worthy)
      const len = 1 + Math.floor(rng() * 12);
      let s = '';
      for (let i = 0; i < len; i++) {
        s += literalChars[Math.floor(rng() * literalChars.length)];
      }
      return s;
    });
    // Ensure id (column 0) is unique-ish per row
    row[0] = `r${idx}-${r}`;
    rows.push(row);
  }

  return { name: `t${idx}`, columns, rows };
}

describe('round-trip — fuzz (30 deterministic cases)', () => {
  // Fixed seed so failures are reproducible. Bump if you change the
  // generator and want to re-cover the input space.
  const SEED = 0xFAC75AC4;

  for (let i = 0; i < 30; i++) {
    it(`case ${i}: random table shape`, () => {
      const rng = mulberry32(SEED + i);
      const tableCount = 1 + Math.floor(rng() * 3); // 1..3 tables per pack
      const tables: PackTable[] = [];
      for (let t = 0; t < tableCount; t++) {
        tables.push(makeRandomTable(rng, t));
      }
      try {
        expectTablesEqual(roundTrip(tables), tables);
      } catch (err) {
        // Surface the input that broke us to the test output for
        // reproducibility.
        // eslint-disable-next-line no-console
        console.error('FUZZ FAIL — case', i, 'tables:', JSON.stringify(tables, null, 2));
        throw err;
      }
    });
  }
});

describe('round-trip — token cost rough check', () => {
  it('PACK output is smaller than equivalent JSON for a heavy-intern table', () => {
    /* This is a rough sanity check — not a precise tokenization
       comparison — but the PACK output for a 100-row table where every
       file path repeats 4 times should be comfortably smaller than the
       equivalent JSON.array.of.objects representation. The PRD targets
       ~80% reduction; we accept anything < 50% of JSON byte-size as
       "the format is doing its job." */
    const rows: PackRow[] = [];
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    for (let i = 0; i < 100; i++) {
      rows.push([String(i), 'fn', `name${i}`, files[i % files.length]!, String(i + 10)]);
    }
    const tables: PackTable[] = [
      {
        name: 'symbols',
        columns: [{ name: 'id' }, { name: 'k' }, { name: 'n' }, { name: 'F' }, { name: 'l' }],
        rows,
      },
    ];

    const pack = encode({ header: HEADER, tables });
    const json = JSON.stringify(rows.map((r) => ({
      id: r[0], kind: r[1], name: r[2], file: r[3], line: r[4],
    })));

    expect(pack.length).toBeLessThan(json.length * 0.5);
  });
});

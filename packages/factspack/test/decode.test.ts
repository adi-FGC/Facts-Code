/**
 * Decoder tests — header parsing, schema binding, dictionary
 * resolution (including forward references), reserved-byte rejection,
 * malformed-input rejection.
 *
 * The encoder is exercised separately; this file feeds hand-written
 * pack strings to the decoder so we can probe edge cases the encoder
 * would never produce on its own.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decode, decodeLegacy, decodeStrict, PackDecodeError } from '../src/decode.js';
import { encode, encodeIncremental } from '../src/encode.js';

const HEADER_LINE = '# facts/0.1\tsymbols-v1\t88e9a1b\t5\n';

/** Append a correct v0.2 trailer to a hand-written pack body. */
function withTrailer(body: string, rows: number, tables: number): string {
  const sha = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
  return `${body}; end rows=${rows} tables=${tables} sha256=${sha}\n`;
}

describe('decode — happy path', () => {
  it('decodes the spec §6 single-table example', () => {
    const text =
      HEADER_LINE +
      '@ F1=src/auth.ts\n' +
      '@ F2=src/users.ts\n' +
      '& symbols\tid\tk\tn\tF\tl\n' +
      '- 1\tfn\tlogin\tF1\t42\n' +
      '- 2\tfn\tlogout\tF1\t58\n' +
      '- 3\tcls\tUser\tF1\t10\n' +
      '- 4\tfn\tsignup\tF2\t12\n' +
      '- 5\tfn\tlist\tF2\t25\n';

    const decoded = decodeLegacy(text);
    expect(decoded.header.producer).toBe('facts/0.1');
    expect(decoded.header.schema).toBe('symbols-v1');
    expect(decoded.header.snapshotId).toBe('88e9a1b');
    expect(decoded.header.rowCount).toBe(5);

    const symbols = decoded.tables.get('symbols');
    expect(symbols).toBeDefined();
    expect(symbols!.rows).toHaveLength(5);
    // Interned column F is fully resolved.
    expect(symbols!.rows[0]).toEqual(['1', 'fn', 'login', 'src/auth.ts', '42']);
    expect(symbols!.rows[3]).toEqual(['4', 'fn', 'signup', 'src/users.ts', '12']);
  });

  it('tolerates forward dictionary references', () => {
    // Dict entries appear AFTER the rows that use them — must still
    // resolve at end-of-stream.
    const text =
      HEADER_LINE +
      '& symbols\tid\tF\n' +
      '- 1\tF1\n' +
      '- 2\tF2\n' +
      '@ F1=src/auth.ts\n' +
      '@ F2=src/users.ts\n';

    const decoded = decodeLegacy(text);
    const rows = decoded.tables.get('symbols')!.rows;
    expect(rows[0]).toEqual(['1', 'src/auth.ts']);
    expect(rows[1]).toEqual(['2', 'src/users.ts']);
  });

  it('handles missing trailing newline (spec §10)', () => {
    const text = HEADER_LINE.slice(0, -1) + // drop final \n
      '\n@ F1=a.ts\n& t\tF\n- F1'; // and the body has none either
    expect(() => decodeLegacy(text)).not.toThrow();
  });

  it('skips empty lines', () => {
    const text =
      HEADER_LINE +
      '\n' +
      '@ F1=a.ts\n' +
      '\n' +
      '& t\tF\n' +
      '\n' +
      '- F1\n';
    const decoded = decodeLegacy(text);
    expect(decoded.tables.get('t')!.rows).toEqual([['a.ts']]);
  });

  it('decodes null cells (bare `-`) and empty cells', () => {
    const text =
      HEADER_LINE +
      '& t\ta\tb\n' +
      '- x\t-\n' +    // null
      '- y\t\n';      // empty string
    const decoded = decodeLegacy(text);
    const rows = decoded.tables.get('t')!.rows;
    expect(rows[0]).toEqual(['x', null]);
    expect(rows[1]).toEqual(['y', '']);
  });

  it('decodes multi-table packs (spec §8)', () => {
    const text =
      '# facts/0.1\tmulti-v1\tabc\t4\n' +
      '@ F1=a.ts\n' +
      '@ F2=b.ts\n' +
      '& symbols\tid\tF\n' +
      '- 1\tF1\n' +
      '- 2\tF2\n' +
      '& imports\tid\tF\tto\n' +
      '- 1\tF1\treact\n' +
      '- 2\tF1\t./jwt\n';

    const decoded = decodeLegacy(text);
    expect(decoded.tables.size).toBe(2);
    expect(decoded.tables.get('symbols')!.rows).toHaveLength(2);
    expect(decoded.tables.get('imports')!.rows).toHaveLength(2);
    expect(decoded.tables.get('imports')!.rows[1]).toEqual(['2', 'a.ts', './jwt']);
  });

  it('decodes incremental packs with + and x rows', () => {
    const text =
      '# facts/0.1\tsymbols-v1\tabc\t0\n' +
      '@ F1=src/auth.ts\n' +
      '& symbols\tid\tk\tn\tF\tl\n' +
      '+ 6\tfn\treset\tF1\t70\n' +
      'x 3\n';
    const decoded = decodeLegacy(text);
    const t = decoded.tables.get('symbols')!;
    expect(t.rows).toHaveLength(0);
    expect(t.addedRows).toHaveLength(1);
    expect(t.addedRows[0]).toEqual(['6', 'fn', 'reset', 'src/auth.ts', '70']);
    expect(t.deletedIds).toEqual(['3']);
  });

  it('decodes streaming-mode header (rowCount = "-")', () => {
    const text = '# facts/0.1\tsymbols-v1\tabc\t-\n& t\ta\n- x\n';
    const decoded = decodeLegacy(text);
    expect(decoded.header.rowCount).toBeNull();
  });
});

describe('decode — v0.2 header extras (S5)', () => {
  it('reads seq/parent/kind/generated from fields 5-8', () => {
    const text = '# factstack/0.4\tagent-v4\tdeadbeef\t10\t2\tabcdef012345\tdiff\t2026-06-12T00:00:00.000Z\n& t\ta\n';
    const h = decodeLegacy(text).header;
    expect(h.seq).toBe(2);
    expect(h.parent).toBe('abcdef012345');
    expect(h.kind).toBe('diff');
    expect(h.generated).toBe('2026-06-12T00:00:00.000Z');
  });

  it('tolerates the old 4-field header (extras undefined)', () => {
    const h = decodeLegacy(HEADER_LINE + '& t\ta\n- x\n').header;
    expect(h.seq).toBeUndefined();
    expect(h.parent).toBeUndefined();
    expect(h.kind).toBeUndefined();
    expect(h.generated).toBeUndefined();
  });

  it('reads `-` placeholders as absent (parent keeps `-` = genesis)', () => {
    const text = '# f/1\ts-v1\tabc\t0\t-\t-\tmaster\t-\n& t\ta\n';
    const h = decodeLegacy(text).header;
    expect(h.seq).toBeUndefined();
    expect(h.parent).toBe('-'); // genesis marker is a meaningful value
    expect(h.kind).toBe('master');
    expect(h.generated).toBeUndefined();
  });

  it('ignores header fields beyond the 8th (forward compat)', () => {
    const text = '# f/1\ts-v1\tabc\t0\t1\t-\tmaster\t2026-01-01T00:00:00Z\tfuture-field\n& t\ta\n';
    expect(() => decodeLegacy(text)).not.toThrow();
  });

  it('rejects a non-integer or lenient seq', () => {
    expect(() => decode('# f/1\ts-v1\tabc\t0\tx\n')).toThrow(/seq/);     // non-numeric
    expect(() => decode('# f/1\ts-v1\tabc\t0\t1e2\n')).toThrow(/seq/);   // Number() leniency
    expect(() => decode('# f/1\ts-v1\tabc\t0\t0x2\n')).toThrow(/seq/);   // hex
  });

  it('rejects an unknown kind', () => {
    expect(() => decode('# f/1\ts-v1\tabc\t0\t1\t-\tweird\n')).toThrow(/kind/);
  });
});

describe('decode — v0.2 `;` meta lines (S1/S2/S3)', () => {
  it('collects `;` bodies into meta, in order, from anywhere', () => {
    const text =
      HEADER_LINE +
      '; legend line one\n' +
      '@ F1=a.ts\n' +
      '; surprise mid-pack note\n' +
      '& t\tF\n' +
      '- F1\n' +
      '; hot: F1~a.ts\n';
    const decoded = decodeLegacy(text);
    expect(decoded.meta).toEqual(['legend line one', 'surprise mid-pack note', 'hot: F1~a.ts']);
    expect(decoded.tables.get('t')!.rows).toEqual([['a.ts']]);
  });

  it('never rejects unknown `;` forms', () => {
    expect(() => decodeLegacy(HEADER_LINE + '; future: whatever=1\n& t\ta\n- x\n')).not.toThrow();
  });

  it('returns empty meta for a v3 pack', () => {
    expect(decodeLegacy(HEADER_LINE + '& t\ta\n- x\n').meta).toEqual([]);
  });
});

describe('decode — v0.2 trailer verification (S4)', () => {
  const body =
    '# facts/0.1\tsymbols-v1\t88e9a1b\t2\n' +
    '@ F1=src/a.ts\n' +
    '& t\tid\tF\n' +
    '- 1\tF1\n' +
    '- 2\tF1\n';

  it('golden: a correct trailer verifies and is surfaced', () => {
    const decoded = decode(withTrailer(body, 2, 1));
    expect(decoded.trailer).toBeDefined();
    expect(decoded.trailer!.rows).toBe(2);
    expect(decoded.trailer!.tables).toBe(1);
    expect(decoded.trailer!.sha256).toMatch(/^[0-9a-f]{12}$/);
  });

  it('encode → decode verifies its own trailer end-to-end', () => {
    const out = encode({
      header: { producer: 'f/1', schema: 's-v1', snapshotId: 'abc', rowCount: null },
      tables: [{ name: 't', columns: [{ name: 'a' }], rows: [['x'], ['y']] }],
    });
    const decoded = decode(out);
    expect(decoded.trailer!.rows).toBe(2);
  });

  it('a v3 pack without a trailer still decodes under legacy (trailer undefined)', () => {
    const decoded = decodeLegacy(body);
    expect(decoded.trailer).toBeUndefined();
    expect(decoded.tables.get('t')!.rows).toHaveLength(2);
  });

  it('rejects when a data row was dropped (rows mismatch)', () => {
    // Trailer claims 2 rows but the body only carries one — truncated.
    const cut = body.replace('- 2\tF1\n', '');
    const sha = createHash('sha256').update(cut, 'utf8').digest('hex').slice(0, 12);
    expect(() => decode(`${cut}; end rows=2 tables=1 sha256=${sha}\n`))
      .toThrow(/truncated or tampered.*rows=2/);
  });

  it('rejects when the table count mismatches', () => {
    const sha = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
    expect(() => decode(`${body}; end rows=2 tables=5 sha256=${sha}\n`))
      .toThrow(/truncated or tampered.*tables=5/);
  });

  it('rejects when the sha256 mismatches (tampered byte)', () => {
    const ok = withTrailer(body, 2, 1);
    const tampered = ok.replace('src/a.ts', 'src/b.ts'); // same length, same counts
    expect(() => decode(tampered)).toThrow(/truncated or tampered.*sha256/);
  });

  it('rejects content after the trailer (trailer must be last)', () => {
    expect(() => decode(withTrailer(body, 2, 1) + '- 3\tF1\n'))
      .toThrow(/trailer must be the final line/);
  });

  it('tolerates trailing empty lines after the trailer', () => {
    expect(() => decode(withTrailer(body, 2, 1) + '\n')).not.toThrow();
  });

  it('mid-pack truncation of an encoded pack throws', () => {
    const out = encode({
      header: { producer: 'f/1', schema: 's-v1', snapshotId: 'abc', rowCount: null },
      tables: [{
        name: 't',
        columns: [{ name: 'id' }, { name: 'F' }],
        rows: Array.from({ length: 50 }, (_, i) => [String(i), `src/file${i % 7}.ts`] as [string, string]),
      }],
    });
    expect(() => decode(out.slice(0, out.length - 120))).toThrow(PackDecodeError);
  });
});

describe('decode — rejection cases', () => {
  it('rejects pack with no header', () => {
    expect(() => decode('& t\ta\n- x\n')).toThrow(/no `# header`/);
  });

  it('rejects header missing fields', () => {
    expect(() => decode('# facts/0.1\tonly-two-fields\n')).toThrow(PackDecodeError);
  });

  it('rejects duplicate header', () => {
    expect(() => decode(HEADER_LINE + HEADER_LINE)).toThrow(/duplicate header/);
  });

  it('rejects unknown line prefix (reserved-byte)', () => {
    expect(() => decode(HEADER_LINE + '? something\n')).toThrow(/reserved-byte violation/);
  });

  it('rejects schema with zero columns', () => {
    expect(() => decode(HEADER_LINE + '& t\n')).toThrow(/zero columns/);
  });

  it('rejects row with wrong cell count', () => {
    expect(() => decode(HEADER_LINE + '& t\ta\tb\n- onlyone\n')).toThrow(/1 cells, schema expects 2/);
  });

  it('rejects row with no active schema', () => {
    expect(() => decode(HEADER_LINE + '- x\n')).toThrow(/no active schema/);
  });

  it('rejects unresolved dictionary key', () => {
    expect(() => decode(HEADER_LINE + '& t\tF\n- F99\n')).toThrow(/Unresolved dictionary key/);
  });

  it('rejects duplicate dictionary key', () => {
    expect(() => decode(HEADER_LINE + '@ F1=a\n@ F1=b\n')).toThrow(/duplicate dictionary key/);
  });

  it('rejects schema redeclared with different columns', () => {
    const text = HEADER_LINE + '& t\ta\tb\n& t\ta\tc\n';
    expect(() => decode(text)).toThrow(/redeclared with different columns/);
  });

  it('rejects malformed @ entry (no =)', () => {
    expect(() => decode(HEADER_LINE + '@ F1noeq\n')).toThrow(/malformed @ entry/);
  });

  it('rejects missing space after prefix', () => {
    expect(() => decode(HEADER_LINE + '&t\ta\n')).toThrow(/missing required space/);
  });

  it('rejects BOM at start', () => {
    expect(() => decode('﻿' + HEADER_LINE)).toThrow(/BOM/);
  });

  it('rejects header rowCount that is not a number', () => {
    expect(() => decode('# facts/0.1\tsymbols-v1\tabc\tabc\n')).toThrow(/non-negative integer/);
  });

  it('rejects negative rowCount', () => {
    expect(() => decode('# facts/0.1\tsymbols-v1\tabc\t-5\n')).toThrow(/non-negative integer/);
  });
});

describe('decode — escapes inside cells', () => {
  it('unescapes \\t \\n \\\\ in literal columns', () => {
    const text = HEADER_LINE + '& t\tmsg\n- line1\\nline2\\tend\\\\here\n';
    const rows = decodeLegacy(text).tables.get('t')!.rows;
    expect(rows[0]![0]).toBe('line1\nline2\tend\\here');
  });

  it('unescapes dict values', () => {
    const text =
      HEADER_LINE +
      '@ F1=weird\\tname\n' +
      '& t\tF\n' +
      '- F1\n';
    expect(decodeLegacy(text).tables.get('t')!.rows[0]![0]).toBe('weird\tname');
  });
});

describe('decode — strict v0.2a profile (the default)', () => {
  it('accepts a well-formed master emitted by encode()', () => {
    const out = encode({
      header: { producer: 'f/1', schema: 's-v1', snapshotId: 'abc', rowCount: null, kind: 'master' },
      tables: [{ name: 't', columns: [{ name: 'a' }], rows: [['x'], ['y']] }],
    });
    expect(() => decode(out)).not.toThrow();
    expect(decode(out).trailer!.rows).toBe(2);
    expect(decode(out).header.rowCount).toBe(2); // master header == trailer
  });

  it('accepts a well-formed diff emitted by encodeIncremental()', () => {
    const out = encodeIncremental({
      header: { producer: 'f/1', schema: 's-v1', snapshotId: 'abc', rowCount: null, kind: 'diff' },
      tables: [{ name: 't', columns: [{ name: 'id' }], addedRows: [['9']], deletedIds: ['3'] }],
    });
    const d = decode(out);
    expect(d.header.kind).toBe('diff');
    expect(d.header.rowCount).toBe(0); // the 0 sentinel
    expect(d.tables.get('t')!.addedRows).toHaveLength(1);
    expect(d.tables.get('t')!.deletedIds).toEqual(['3']);
  });

  it('encodeIncremental STAMPS kind=diff even when the caller omits it (round-trip safe by default)', () => {
    const out = encodeIncremental({
      header: { producer: 'f/1', schema: 's-v1', snapshotId: 'abc', rowCount: null }, // no kind!
      tables: [{ name: 't', columns: [{ name: 'id' }], addedRows: [['9']], deletedIds: ['3'] }],
    });
    expect(out).toContain('\tdiff\n'); // kind=diff is on the wire
    const d = decode(out); // strict default must accept the encoder's own output
    expect(d.header.kind).toBe('diff');
    expect(d.tables.get('t')!.addedRows).toHaveLength(1);
  });

  it('rejects an empty or lenient header rowCount field (not just non-numeric)', () => {
    expect(() => decode('# f/1\ts-v1\tabc\t\n')).toThrow(/non-negative integer/);    // empty
    expect(() => decode('# f/1\ts-v1\tabc\t1e2\n')).toThrow(/non-negative integer/);  // Number() leniency
    expect(() => decode('# f/1\ts-v1\tabc\t0x10\n')).toThrow(/non-negative integer/); // hex
  });

  it('rejects a trailer-less pack (kills the v0.1/v0.2 truncation ambiguity)', () => {
    expect(() => decode(HEADER_LINE + '& t\ta\n- x\n')).toThrow(/requires a `; end` trailer/);
  });

  it('rejects a master whose header rowCount disagrees with the trailer', () => {
    const b = '# f/1\ts-v1\tabc\t99\t-\t-\tmaster\n& t\ta\n- 1\n- 2\n';
    expect(() => decode(withTrailer(b, 2, 1))).toThrow(/master header rowCount=99 but trailer rows=2/);
  });

  it('rejects a diff whose header rowCount is not the 0 sentinel', () => {
    const b = '# f/1\ts-v1\tabc\t5\t-\t-\tdiff\n& t\ta\n+ 1\n';
    expect(() => decode(withTrailer(b, 1, 1))).toThrow(/kind=diff header rowCount must be the 0 sentinel/);
  });

  it('rejects a master carrying incremental + / x operations', () => {
    const b = '# f/1\ts-v1\tabc\t1\t-\t-\tmaster\n& t\ta\n+ 1\n';
    expect(() => decode(withTrailer(b, 1, 1))).toThrow(/kind=master but table 't' carries incremental/);
  });

  it('rejects a diff carrying baseline - rows', () => {
    const b = '# f/1\ts-v1\tabc\t0\t-\t-\tdiff\n& t\ta\n- 1\n';
    expect(() => decode(withTrailer(b, 1, 1))).toThrow(/kind=diff but table 't' carries 1 baseline/);
  });

  it('enforces resource ceilings (maxRows)', () => {
    const out = encode({
      header: { producer: 'f/1', schema: 's-v1', snapshotId: 'abc', rowCount: null },
      tables: [{ name: 't', columns: [{ name: 'a' }], rows: [['x'], ['y'], ['z']] }],
    });
    expect(() => decode(out, { limits: { maxRows: 2 } })).toThrow(/maxRows/);
    expect(() => decodeStrict(out, { maxRows: 2 })).toThrow(/maxRows/);
    expect(() => decode(out)).not.toThrow(); // the generous strict default never trips
  });

  it('encode() refuses kind=diff; encodeIncremental() refuses kind=master', () => {
    expect(() => encode({
      header: { producer: 'f/1', schema: 's-v1', snapshotId: 'abc', rowCount: null, kind: 'diff' },
      tables: [{ name: 't', columns: [{ name: 'a' }], rows: [['x']] }],
    })).toThrow(/encode\(\) produces a 'master'/);
    expect(() => encodeIncremental({
      header: { producer: 'f/1', schema: 's-v1', snapshotId: 'abc', rowCount: null, kind: 'master' },
      tables: [{ name: 't', columns: [{ name: 'a' }], addedRows: [['x']], deletedIds: [] }],
    })).toThrow(/encodeIncremental\(\) produces a 'diff'/);
  });

  it('legacy mode still tolerates the trailer-less pack strict rejects', () => {
    expect(() => decodeLegacy(HEADER_LINE + '& t\ta\n- x\n')).not.toThrow();
  });
});

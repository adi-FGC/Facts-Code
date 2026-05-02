/**
 * Decoder tests — header parsing, schema binding, dictionary
 * resolution (including forward references), reserved-byte rejection,
 * malformed-input rejection.
 *
 * The encoder is exercised separately; this file feeds hand-written
 * pack strings to the decoder so we can probe edge cases the encoder
 * would never produce on its own.
 */

import { describe, expect, it } from 'vitest';
import { decode, PackDecodeError } from '../src/decode.js';

const HEADER_LINE = '# facts/0.1\tsymbols-v1\t88e9a1b\t5\n';

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

    const decoded = decode(text);
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

    const decoded = decode(text);
    const rows = decoded.tables.get('symbols')!.rows;
    expect(rows[0]).toEqual(['1', 'src/auth.ts']);
    expect(rows[1]).toEqual(['2', 'src/users.ts']);
  });

  it('handles missing trailing newline (spec §10)', () => {
    const text = HEADER_LINE.slice(0, -1) + // drop final \n
      '\n@ F1=a.ts\n& t\tF\n- F1'; // and the body has none either
    expect(() => decode(text)).not.toThrow();
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
    const decoded = decode(text);
    expect(decoded.tables.get('t')!.rows).toEqual([['a.ts']]);
  });

  it('decodes null cells (bare `-`) and empty cells', () => {
    const text =
      HEADER_LINE +
      '& t\ta\tb\n' +
      '- x\t-\n' +    // null
      '- y\t\n';      // empty string
    const decoded = decode(text);
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

    const decoded = decode(text);
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
    const decoded = decode(text);
    const t = decoded.tables.get('symbols')!;
    expect(t.rows).toHaveLength(0);
    expect(t.addedRows).toHaveLength(1);
    expect(t.addedRows[0]).toEqual(['6', 'fn', 'reset', 'src/auth.ts', '70']);
    expect(t.deletedIds).toEqual(['3']);
  });

  it('decodes streaming-mode header (rowCount = "-")', () => {
    const text = '# facts/0.1\tsymbols-v1\tabc\t-\n& t\ta\n- x\n';
    const decoded = decode(text);
    expect(decoded.header.rowCount).toBeNull();
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
    const rows = decode(text).tables.get('t')!.rows;
    expect(rows[0]![0]).toBe('line1\nline2\tend\\here');
  });

  it('unescapes dict values', () => {
    const text =
      HEADER_LINE +
      '@ F1=weird\\tname\n' +
      '& t\tF\n' +
      '- F1\n';
    expect(decode(text).tables.get('t')!.rows[0]![0]).toBe('weird\tname');
  });
});

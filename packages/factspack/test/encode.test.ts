/**
 * Encoder tests — golden output, malformed-input rejection,
 * dictionary-key minting, multi-table layout.
 *
 * Golden tests use the exact examples from the spec (§6 single-table
 * symbols and §8 multi-table) so any drift between code and spec is
 * caught immediately.
 */

import { describe, expect, it } from 'vitest';
import { encode, encodeIncremental, PackEncodeError } from '../src/encode.js';
import type { PackHeader, PackTable } from '../src/types.js';

const HEADER: PackHeader = {
  producer: 'facts/0.1',
  schema: 'symbols-v1',
  snapshotId: '88e9a1b',
  rowCount: null, // let encoder compute
};

describe('encode — golden: spec §6 single-table example', () => {
  it('produces the canonical 5-row symbols pack', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 'symbols',
          columns: [
            { name: 'id' },
            { name: 'k' },
            { name: 'n' },
            { name: 'F' },
            { name: 'l' },
          ],
          rows: [
            ['1', 'fn', 'login', 'src/auth.ts', '42'],
            ['2', 'fn', 'logout', 'src/auth.ts', '58'],
            ['3', 'cls', 'User', 'src/auth.ts', '10'],
            ['4', 'fn', 'signup', 'src/users.ts', '12'],
            ['5', 'fn', 'list', 'src/users.ts', '25'],
          ],
        },
      ],
    });

    /* The golden checks the structural pieces, not the exact tab
       columns of the spec's whitespace-padded illustration: tabs are
       semantically significant but the visual padding in the spec is
       for human eyes only. */
    expect(out).toContain('# facts/0.1\tsymbols-v1\t88e9a1b\t5\n');
    expect(out).toContain('@ F1=src/auth.ts\n');
    expect(out).toContain('@ F2=src/users.ts\n');
    expect(out).toContain('& symbols\tid\tk\tn\tF\tl\n');
    expect(out).toContain('- 1\tfn\tlogin\tF1\t42\n');
    expect(out).toContain('- 4\tfn\tsignup\tF2\t12\n');
    // Trailing newline (spec §10).
    expect(out.endsWith('\n')).toBe(true);
  });

  it('orders dict entries before table rows', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 'symbols',
          columns: [{ name: 'F' }],
          rows: [['src/auth.ts'], ['src/users.ts']],
        },
      ],
    });
    const dictPos = out.indexOf('@ F1=src/auth.ts');
    const rowPos = out.indexOf('- F1');
    expect(dictPos).toBeGreaterThan(0);
    expect(rowPos).toBeGreaterThan(dictPos);
  });

  it('reuses a dict key for repeated literals', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 'symbols',
          columns: [{ name: 'F' }],
          rows: [['a.ts'], ['a.ts'], ['a.ts']],
        },
      ],
    });
    expect((out.match(/@ F1=a\.ts/g) ?? []).length).toBe(1);
    expect((out.match(/^- F1$/gm) ?? []).length).toBe(3);
  });

  it('per-column counters are independent', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 't',
          columns: [{ name: 'F' }, { name: 'R' }],
          rows: [
            ['a.ts', 'react'],
            ['b.ts', 'react'],
            ['a.ts', 'lodash'],
          ],
        },
      ],
    });
    expect(out).toContain('@ F1=a.ts');
    expect(out).toContain('@ F2=b.ts');
    expect(out).toContain('@ R1=react');
    expect(out).toContain('@ R2=lodash');
  });
});

describe('encode — multi-table (spec §8)', () => {
  it('emits multiple & blocks with shared dictionary', () => {
    const out = encode({
      header: { ...HEADER, schema: 'multi-v1' },
      tables: [
        {
          name: 'symbols',
          columns: [{ name: 'id' }, { name: 'F' }],
          rows: [['1', 'src/auth.ts'], ['2', 'src/users.ts']],
        },
        {
          name: 'imports',
          columns: [{ name: 'id' }, { name: 'F' }, { name: 'to' }],
          rows: [['1', 'src/auth.ts', 'react'], ['2', 'src/auth.ts', './jwt']],
        },
      ],
    });

    // Both & lines are present.
    expect(out).toContain('& symbols\t');
    expect(out).toContain('& imports\t');
    // The shared file dictionary key is reused across tables.
    const f1Decls = (out.match(/^@ F1=/gm) ?? []).length;
    expect(f1Decls).toBe(1);
  });
});

describe('encode — null + empty cells', () => {
  it('serializes null as bare `-`', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 't',
          columns: [{ name: 'a' }, { name: 'b' }],
          rows: [['x', null]],
        },
      ],
    });
    expect(out).toContain('- x\t-');
  });

  it('serializes empty string distinct from null', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 't',
          columns: [{ name: 'a' }, { name: 'b' }],
          rows: [['x', '']],
        },
      ],
    });
    // empty cell = nothing between the tab and the newline
    expect(out).toMatch(/- x\t(?:\n|$)/);
  });
});

describe('encode — escaping inside cells', () => {
  it('escapes tabs and newlines in literal columns', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 't',
          columns: [{ name: 'msg' }],
          rows: [['line1\nline2\tend']],
        },
      ],
    });
    expect(out).toContain('- line1\\nline2\\tend');
  });

  it('escapes the dict value when interning a literal that contains tabs', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 't',
          columns: [{ name: 'F' }],
          rows: [['weird\tname']],
        },
      ],
    });
    expect(out).toContain('@ F1=weird\\tname');
  });
});

describe('encode — rejection cases', () => {
  const ok: PackTable = { name: 't', columns: [{ name: 'a' }], rows: [['x']] };

  it('rejects header.producer with a tab', () => {
    expect(() => encode({ header: { ...HEADER, producer: 'a\tb' }, tables: [ok] })).toThrow(PackEncodeError);
  });

  it('rejects empty table name', () => {
    expect(() => encode({
      header: HEADER,
      tables: [{ name: '', columns: [{ name: 'a' }], rows: [] }],
    })).toThrow(PackEncodeError);
  });

  it('rejects column name with a tab', () => {
    expect(() => encode({
      header: HEADER,
      tables: [{ name: 't', columns: [{ name: 'a\tb' }], rows: [] }],
    })).toThrow(PackEncodeError);
  });

  it('rejects row with wrong number of cells', () => {
    expect(() => encode({
      header: HEADER,
      tables: [{ name: 't', columns: [{ name: 'a' }, { name: 'b' }], rows: [['x']] }],
    })).toThrow(/expected 2 cells, got 1/);
  });
});

describe('encode — v0.2 header extras (S5)', () => {
  const table: PackTable = { name: 't', columns: [{ name: 'a' }], rows: [['x']] };

  it('appends seq/parent/kind/generated after rowCount when present', () => {
    const out = encode({
      header: { ...HEADER, seq: 3, parent: 'abcdef012345', kind: 'master', generated: '2026-06-12T00:00:00.000Z' },
      tables: [table],
    });
    expect(out).toContain('# facts/0.1\tsymbols-v1\t88e9a1b\t1\t3\tabcdef012345\tmaster\t2026-06-12T00:00:00.000Z\n');
  });

  it('emits the plain 4-field header when no extras are set', () => {
    const out = encode({ header: HEADER, tables: [table] });
    expect(out).toContain('# facts/0.1\tsymbols-v1\t88e9a1b\t1\n');
  });

  it('fills `-` placeholders for absent earlier extras', () => {
    // kind is set but seq/parent are absent → they render as `-` placeholders.
    // (Uses kind=master so the baseline encoder accepts it; v0.2a routes diffs
    // through encodeIncremental, covered in the round-trip + decode strict suites.)
    const out = encode({ header: { ...HEADER, kind: 'master' }, tables: [table] });
    expect(out).toContain('\t1\t-\t-\tmaster\n');
  });

  it('rejects a non-integer seq', () => {
    expect(() => encode({ header: { ...HEADER, seq: 1.5 }, tables: [table] })).toThrow(PackEncodeError);
  });

  it('rejects generated containing a tab', () => {
    expect(() => encode({ header: { ...HEADER, generated: 'a\tb' }, tables: [table] })).toThrow(PackEncodeError);
  });
});

describe('encode — v0.2 meta lines (S2/S3)', () => {
  const table: PackTable = {
    name: 't',
    columns: [{ name: 'F' }],
    rows: [['src/a.ts'], ['src/a.ts'], ['src/b.ts']],
  };

  it('emits legend `;` lines between the header and the dictionary', () => {
    const out = encode({
      header: HEADER,
      tables: [table],
      meta: { legend: ['first legend line', 'second legend line'] },
    });
    const lines = out.split('\n');
    expect(lines[1]).toBe('; first legend line');
    expect(lines[2]).toBe('; second legend line');
    expect(lines[3]!.startsWith('@ ')).toBe(true);
  });

  it('emits a `; hot:` line ranking keys by reference count', () => {
    const out = encode({
      header: HEADER,
      tables: [table],
      meta: { hot: { group: 'F' } },
    });
    // a.ts referenced twice, b.ts once — a.ts ranks first.
    expect(out).toContain('; hot: F1~a.ts F2~b.ts\n');
  });

  it('caps the hot line at meta.hot.top entries', () => {
    const out = encode({
      header: HEADER,
      tables: [table],
      meta: { hot: { group: 'F', top: 1 } },
    });
    expect(out).toContain('; hot: F1~a.ts\n');
    expect(out).not.toContain('F2~b.ts');
  });

  it('rejects a legend line containing a newline', () => {
    expect(() => encode({ header: HEADER, tables: [table], meta: { legend: ['a\nb'] } }))
      .toThrow(PackEncodeError);
  });

  it('rejects a legend line that collides with the reserved `; end` trailer form', () => {
    // Otherwise the decoder re-reads it AS the trailer and rejects the rest of the
    // pack — an encoder that produces output its own decoder rejects.
    expect(() => encode({
      header: HEADER, tables: [table],
      meta: { legend: ['end rows=1 tables=1 sha256=abcdef012345'] },
    })).toThrow(/reserved `; end` trailer/);
    // a near-miss that is NOT the exact trailer grammar is still fine
    expect(() => encode({
      header: HEADER, tables: [table], meta: { legend: ['rows=1 tables=1'] },
    })).not.toThrow();
  });
});

describe('encode — v0.2 trailer (S4)', () => {
  it('always appends `; end` as the final line with row/table counts', () => {
    const out = encode({
      header: HEADER,
      tables: [
        { name: 'a', columns: [{ name: 'x' }], rows: [['1'], ['2']] },
        { name: 'b', columns: [{ name: 'y' }], rows: [['3']] },
      ],
    });
    const lines = out.split('\n');
    expect(lines[lines.length - 1]).toBe(''); // trailing \n
    expect(lines[lines.length - 2]).toMatch(/^; end rows=3 tables=2 sha256=[0-9a-f]{12}$/);
  });

  it('incremental packs count + and x lines as trailer rows', () => {
    const out = encodeIncremental({
      header: HEADER,
      tables: [{
        name: 't',
        columns: [{ name: 'id' }],
        addedRows: [['6'], ['7']],
        deletedIds: ['3'],
      }],
    });
    expect(out).toMatch(/; end rows=3 tables=1 sha256=[0-9a-f]{12}\n$/);
  });
});

describe('encode — v0.2 shared intern namespaces (S8)', () => {
  it('columns with the same internGroup share one key pool across tables', () => {
    const out = encode({
      header: HEADER,
      tables: [
        {
          name: 'imports',
          columns: [{ name: 'F', internGroup: 'F' }, { name: 'T', internGroup: 'F' }],
          rows: [['src/a.ts', 'src/b.ts'], ['src/b.ts', 'src/a.ts']],
        },
        {
          name: 'risks',
          columns: [{ name: 'F', internGroup: 'F' }],
          rows: [['src/b.ts']],
        },
      ],
    });
    // One id per file, everywhere: no T-prefixed keys, two dict lines total.
    expect(out).toContain('@ F1=src/a.ts\n');
    expect(out).toContain('@ F2=src/b.ts\n');
    expect(out).not.toMatch(/^@ T\d+=/m);
    expect((out.match(/^@ /gm) ?? []).length).toBe(2);
    // Rows in both tables reference the same keys.
    expect(out).toContain('- F1\tF2\n');
    expect(out).toContain('- F2\tF1\n');
    expect(out).toContain('- F2\n');
  });

  it('keeps per-column pools when internGroup is absent (v1 behavior)', () => {
    const out = encode({
      header: HEADER,
      tables: [{
        name: 'imports',
        columns: [{ name: 'F' }, { name: 'T' }],
        rows: [['src/a.ts', 'src/a.ts']],
      }],
    });
    expect(out).toContain('@ F1=src/a.ts');
    expect(out).toContain('@ T1=src/a.ts');
  });

  it('rejects internGroup on a literal (lowercase) column', () => {
    expect(() => encode({
      header: HEADER,
      tables: [{ name: 't', columns: [{ name: 'path', internGroup: 'F' }], rows: [] }],
    })).toThrow(/literal/);
  });

  it('rejects internGroup containing "="', () => {
    expect(() => encode({
      header: HEADER,
      tables: [{ name: 't', columns: [{ name: 'F', internGroup: 'a=b' }], rows: [] }],
    })).toThrow(PackEncodeError);
  });
});

describe('encode — v0.2 literal "-" guard (S12)', () => {
  it('rejects a literal-column cell whose value is exactly "-"', () => {
    expect(() => encode({
      header: HEADER,
      tables: [{ name: 't', columns: [{ name: 'a' }], rows: [['-']] }],
    })).toThrow(/decode as null/);
  });

  it('allows "-" as an interned-column value (rides in the dict)', () => {
    const out = encode({
      header: HEADER,
      tables: [{ name: 't', columns: [{ name: 'F' }], rows: [['-']] }],
    });
    expect(out).toContain('@ F1=-\n');
    expect(out).toContain('- F1\n');
  });

  it('still serializes null as bare "-"', () => {
    const out = encode({
      header: HEADER,
      tables: [{ name: 't', columns: [{ name: 'a' }, { name: 'b' }], rows: [['x', null]] }],
    });
    expect(out).toContain('- x\t-\n');
  });
});

describe('encodeIncremental — patch packs', () => {
  it('emits + and x lines under the schema declaration', () => {
    const out = encodeIncremental({
      header: HEADER,
      tables: [
        {
          name: 'symbols',
          columns: [{ name: 'id' }, { name: 'k' }, { name: 'n' }, { name: 'F' }, { name: 'l' }],
          addedRows: [['6', 'fn', 'reset', 'src/auth.ts', '70']],
          deletedIds: ['3'],
        },
      ],
    });
    // v0.2a: rowCount forced to the 0 sentinel AND kind=diff stamped on the wire,
    // so the diff is round-trip-safe under the strict default even with a bare HEADER.
    expect(out).toContain('# facts/0.1\tsymbols-v1\t88e9a1b\t0\t-\t-\tdiff\n');
    expect(out).toContain('& symbols\t');
    expect(out).toContain('@ F1=src/auth.ts');
    expect(out).toContain('+ 6\tfn\treset\tF1\t70');
    expect(out).toContain('x 3');
  });

  it('rejects empty deleted id', () => {
    expect(() => encodeIncremental({
      header: HEADER,
      tables: [{
        name: 't',
        columns: [{ name: 'a' }],
        addedRows: [],
        deletedIds: [''],
      }],
    })).toThrow(PackEncodeError);
  });
});

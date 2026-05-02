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
    expect(out).toContain('# facts/0.1\tsymbols-v1\t88e9a1b\t0\n'); // rowCount forced to 0 in incremental
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

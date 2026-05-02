/**
 * Escape primitives — ground-truth test before anything else relies on
 * them. Spec §4 + §10.
 *
 * Every other module (encode, decode, round-trip) implicitly tests
 * escape too, but explicit tests here pin down the exact behavior on
 * empty strings, multi-byte UTF-8, and malformed escape sequences.
 */

import { describe, expect, it } from 'vitest';
import { escapeCell, unescapeCell, PackEscapeError } from '../src/escape.js';

describe('escapeCell — happy path', () => {
  it('returns identity for an empty string', () => {
    expect(escapeCell('')).toBe('');
  });

  it('returns identity when no reserved bytes are present', () => {
    expect(escapeCell('hello world')).toBe('hello world');
    expect(escapeCell('src/foo/bar.ts')).toBe('src/foo/bar.ts');
    expect(escapeCell('日本語')).toBe('日本語');
  });

  it('escapes a literal tab', () => {
    expect(escapeCell('a\tb')).toBe('a\\tb');
  });

  it('escapes a literal newline', () => {
    expect(escapeCell('a\nb')).toBe('a\\nb');
  });

  it('escapes a literal backslash', () => {
    expect(escapeCell('a\\b')).toBe('a\\\\b');
  });

  it('escapes all three reserved bytes together', () => {
    expect(escapeCell('a\tb\nc\\d')).toBe('a\\tb\\nc\\\\d');
  });

  it('preserves UTF-8 bytes that look like ASCII control codes', () => {
    // U+2028 (LINE SEPARATOR) is NOT a newline in PACK terms — only
    // 0x0A is reserved. We must NOT escape it.
    expect(escapeCell('a b')).toBe('a b');
  });
});

describe('unescapeCell — happy path', () => {
  it('returns identity for an empty string', () => {
    expect(unescapeCell('')).toBe('');
  });

  it('returns identity when no escape sequences are present', () => {
    expect(unescapeCell('hello world')).toBe('hello world');
  });

  it('unescapes \\t to tab', () => {
    expect(unescapeCell('a\\tb')).toBe('a\tb');
  });

  it('unescapes \\n to newline', () => {
    expect(unescapeCell('a\\nb')).toBe('a\nb');
  });

  it('unescapes \\\\ to backslash', () => {
    expect(unescapeCell('a\\\\b')).toBe('a\\b');
  });

  it('unescapes interleaved escapes correctly', () => {
    expect(unescapeCell('a\\tb\\nc\\\\d')).toBe('a\tb\nc\\d');
  });
});

describe('unescapeCell — rejection cases', () => {
  it('rejects a trailing backslash with nothing after it', () => {
    expect(() => unescapeCell('foo\\')).toThrow(PackEscapeError);
  });

  it('rejects an unknown escape character', () => {
    expect(() => unescapeCell('foo\\xbar')).toThrow(PackEscapeError);
  });

  it('rejects a backslash followed by a tab', () => {
    // Reserved chars after \ are still unknown escapes — only \t is
    // the two-char sequence; a literal \ + literal tab is invalid.
    expect(() => unescapeCell('foo\\\tbar')).toThrow(PackEscapeError);
  });
});

describe('escape ↔ unescape round-trip', () => {
  const cases: string[] = [
    '',
    'plain',
    'with\ttab',
    'with\nnewline',
    'with\\backslash',
    'multiple\t\n\\at once',
    'long path: src/a/b/c.ts',
    '日本語 contains \\ and \t',
    String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)), // every byte 1..32
  ];

  for (const input of cases) {
    it(`round-trips: ${JSON.stringify(input).slice(0, 60)}`, () => {
      expect(unescapeCell(escapeCell(input))).toBe(input);
    });
  }
});

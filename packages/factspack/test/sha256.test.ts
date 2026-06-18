/**
 * The pack integrity trailer hashes with our vendored pure-JS SHA-256 (factspack
 * is a pure tier — no `node:crypto`). These tests pin it to the FIPS 180-4 test
 * vectors AND assert byte-for-byte parity with `node:crypto` over UTF-8 input,
 * so trailers minted by the old (createHash) code keep verifying and the digest
 * can never silently drift. Importing `node:crypto` HERE is fine — test files run
 * in Node; only the library shipped to the browser must stay pure.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256hex } from '../src/sha256.js';

function nodeSha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('sha256hex — FIPS 180-4 vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the 448-bit two-block message', () => {
    expect(sha256hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
});

describe('sha256hex — parity with node:crypto over UTF-8', () => {
  const cases = [
    '',
    'a',
    'abc',
    'hello world',
    // exactly 55 bytes (one byte short of forcing a second padding block)
    'x'.repeat(55),
    // exactly 56 bytes (forces the length into the next block)
    'x'.repeat(56),
    'x'.repeat(64),
    'x'.repeat(1000),
    // multi-byte UTF-8: the TextEncoder path must match node's utf8 update
    'café — naïve — 日本語 — 🚀',
    // pack-shaped content with tabs, newlines, and `;` trailer-like text
    '# factstack/0.3.10\tagent-v4\tabc123\n& files\nx\ty\tz\n; not-the-trailer\n',
  ];
  for (const [i, s] of cases.entries()) {
    it(`case ${i} (len ${s.length})`, () => {
      expect(sha256hex(s)).toBe(nodeSha(s));
    });
  }
});

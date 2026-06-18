/**
 * Canonicalization tests (v0.3) — producer-side path/number normalization for
 * cross-platform byte determinism. Spec §canonicalization.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizePath, canonicalizeNumber } from '../src/canonicalize.js';

describe('canonicalizePath', () => {
  it('normalizes Windows separators to POSIX', () => {
    expect(canonicalizePath('src\\auth\\session.ts')).toBe('src/auth/session.ts');
  });
  it('leaves a POSIX path unchanged (idempotent)', () => {
    expect(canonicalizePath('src/auth/session.ts')).toBe('src/auth/session.ts');
    expect(canonicalizePath(canonicalizePath('a\\b'))).toBe('a/b');
  });
  it('makes Windows and POSIX forms of the same path equal', () => {
    expect(canonicalizePath('a\\b\\c.ts')).toBe(canonicalizePath('a/b/c.ts'));
  });
  it('does not touch non-separator content', () => {
    expect(canonicalizePath('weird name.ts')).toBe('weird name.ts');
  });
});

describe('canonicalizeNumber', () => {
  it('renders integers and floats locale-independently', () => {
    expect(canonicalizeNumber(42)).toBe('42');
    expect(canonicalizeNumber(0.0242)).toBe('0.0242');
    expect(canonicalizeNumber(0)).toBe('0');
  });
  it('rejects non-finite values rather than emitting them', () => {
    expect(() => canonicalizeNumber(Infinity)).toThrow(/Non-finite/);
    expect(() => canonicalizeNumber(NaN)).toThrow(/Non-finite/);
  });
});

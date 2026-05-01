import { describe, expect, it } from 'vitest';
import { approximateTokens } from '../src/tokencost.js';

describe('approximateTokens', () => {
  it('returns a positive integer for non-empty text', () => {
    const t = approximateTokens('hello world');
    expect(t).toBeGreaterThan(0);
    expect(Number.isInteger(t)).toBe(true);
  });

  it('returns 0 for empty input', () => {
    expect(approximateTokens('')).toBe(0);
  });

  it('scales monotonically with input length', () => {
    const a = approximateTokens('a'.repeat(100));
    const b = approximateTokens('a'.repeat(1000));
    expect(b).toBeGreaterThan(a);
  });

  it('handles unicode + multibyte characters without throwing', () => {
    expect(() => approximateTokens('こんにちは 世界 🌍')).not.toThrow();
    expect(approximateTokens('こんにちは')).toBeGreaterThan(0);
  });
});

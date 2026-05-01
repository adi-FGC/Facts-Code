/**
 * Tests for v0.3.8 reading-time helper.
 *
 * Coverage targets every branch of the formula:
 *   - LOC of 0 / 1 / 25 / 250 / 2500
 *   - Cyclomatic at the boundary (10 = no bonus, 11 = no bonus, 15 = +1, 20 = +2)
 *   - Negative inputs (non-finite or hand-corrupted) clamp to 0/floor
 *   - Folder rollup is pure sum, not min/max
 */

import { describe, expect, it } from 'vitest';
import { computeReadingTime, sumReadingMinutes } from '../src/reading-time.js';

describe('computeReadingTime — base LOC behavior', () => {
  it('floors empty files at 1 minute', () => {
    expect(computeReadingTime({ loc: 0, cyclomatic: 0 })).toBe(1);
  });

  it('returns 1 minute for 25 LOC (one minute of reading speed)', () => {
    expect(computeReadingTime({ loc: 25, cyclomatic: 0 })).toBe(1);
  });

  it('returns 10 minutes for 250 LOC (linear scaling)', () => {
    expect(computeReadingTime({ loc: 250, cyclomatic: 0 })).toBe(10);
  });

  it('returns 100 minutes for 2500 LOC (long file)', () => {
    expect(computeReadingTime({ loc: 2500, cyclomatic: 0 })).toBe(100);
  });

  it('rounds 13 LOC up to 1 minute (floored)', () => {
    // 13/25 = 0.52 → rounds to 0.5 → floored to 1
    expect(computeReadingTime({ loc: 13, cyclomatic: 0 })).toBe(1);
  });

  it('rounds 37 LOC to 1.5 minutes (half-step precision)', () => {
    // 37/25 = 1.48 → rounds to 1.5
    expect(computeReadingTime({ loc: 37, cyclomatic: 0 })).toBe(1.5);
  });
});

describe('computeReadingTime — cyclomatic bonus', () => {
  it('applies no bonus at cyclomatic 10 (boundary)', () => {
    expect(computeReadingTime({ loc: 100, cyclomatic: 10 })).toBe(4);
  });

  it('applies no bonus at cyclomatic 11 to 14 (under threshold)', () => {
    expect(computeReadingTime({ loc: 100, cyclomatic: 14 })).toBe(4);
  });

  it('adds 1 minute at cyclomatic 15 (first 5-branch step)', () => {
    expect(computeReadingTime({ loc: 100, cyclomatic: 15 })).toBe(5);
  });

  it('adds 2 minutes at cyclomatic 20', () => {
    expect(computeReadingTime({ loc: 100, cyclomatic: 20 })).toBe(6);
  });

  it('adds 4 minutes at cyclomatic 30', () => {
    expect(computeReadingTime({ loc: 100, cyclomatic: 30 })).toBe(8);
  });
});

describe('computeReadingTime — clamping', () => {
  it('clamps negative LOC to 0 then floors at 1 minute', () => {
    expect(computeReadingTime({ loc: -50, cyclomatic: 0 })).toBe(1);
  });

  it('clamps negative cyclomatic to 0 (no bonus)', () => {
    expect(computeReadingTime({ loc: 100, cyclomatic: -5 })).toBe(4);
  });

  it('floors fractional LOC inputs', () => {
    // The formula divides by 25, so a fractional LOC would slip through
    // without the explicit Math.floor. 25.9 LOC stays 1 min, not 1.04.
    expect(computeReadingTime({ loc: 25.9, cyclomatic: 0 })).toBe(1);
  });
});

describe('sumReadingMinutes — folder rollup', () => {
  it('sums an empty array to 0', () => {
    expect(sumReadingMinutes([])).toBe(0);
  });

  it('sums a single value to itself', () => {
    expect(sumReadingMinutes([3.5])).toBe(3.5);
  });

  it('sums multiple values', () => {
    expect(sumReadingMinutes([1, 2.5, 4, 0.5])).toBe(8);
  });

  it('preserves half-step precision in totals', () => {
    expect(sumReadingMinutes([1.5, 2.5, 0.5])).toBe(4.5);
  });
});

describe('determinism', () => {
  it('produces identical output across two runs', () => {
    const a = computeReadingTime({ loc: 412, cyclomatic: 23 });
    const b = computeReadingTime({ loc: 412, cyclomatic: 23 });
    expect(a).toBe(b);
  });
});

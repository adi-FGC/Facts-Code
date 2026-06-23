import { describe, expect, it } from 'vitest';
import { nextRovingIndex } from './roving.ts';

describe('nextRovingIndex', () => {
  it('advances on ArrowRight/ArrowDown, retreats on ArrowLeft/ArrowUp (orientation: both)', () => {
    expect(nextRovingIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextRovingIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextRovingIndex('ArrowLeft', 2, 3)).toBe(1);
    expect(nextRovingIndex('ArrowUp', 2, 3)).toBe(1);
  });

  it('wraps at the ends when loop is on (the default)', () => {
    expect(nextRovingIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextRovingIndex('ArrowLeft', 0, 3)).toBe(2);
  });

  it('clamps at the ends when loop:false', () => {
    expect(nextRovingIndex('ArrowRight', 2, 3, { loop: false })).toBe(2);
    expect(nextRovingIndex('ArrowLeft', 0, 3, { loop: false })).toBe(0);
  });

  it('Home -> first, End -> last', () => {
    expect(nextRovingIndex('Home', 2, 3)).toBe(0);
    expect(nextRovingIndex('End', 0, 3)).toBe(2);
  });

  it('orientation: horizontal ignores vertical arrows', () => {
    expect(nextRovingIndex('ArrowDown', 0, 3, { orientation: 'horizontal' })).toBeNull();
    expect(nextRovingIndex('ArrowUp', 0, 3, { orientation: 'horizontal' })).toBeNull();
    expect(nextRovingIndex('ArrowRight', 0, 3, { orientation: 'horizontal' })).toBe(1);
  });

  it('orientation: vertical ignores horizontal arrows', () => {
    expect(nextRovingIndex('ArrowRight', 0, 3, { orientation: 'vertical' })).toBeNull();
    expect(nextRovingIndex('ArrowDown', 0, 3, { orientation: 'vertical' })).toBe(1);
  });

  it('returns null for non-roving keys (so the caller leaves the event alone)', () => {
    expect(nextRovingIndex('Enter', 0, 3)).toBeNull();
    expect(nextRovingIndex(' ', 0, 3)).toBeNull();
    expect(nextRovingIndex('a', 0, 3)).toBeNull();
    expect(nextRovingIndex('Tab', 0, 3)).toBeNull();
  });

  it('returns null when the group is empty', () => {
    expect(nextRovingIndex('ArrowRight', 0, 0)).toBeNull();
    expect(nextRovingIndex('Home', 0, 0)).toBeNull();
  });

  it('treats a negative current (nothing selected yet) as index 0', () => {
    expect(nextRovingIndex('ArrowRight', -1, 3)).toBe(1);
    expect(nextRovingIndex('ArrowLeft', -1, 3)).toBe(2); // 0 - 1 wraps to last
  });
});

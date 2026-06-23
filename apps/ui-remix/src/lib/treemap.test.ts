import { describe, expect, it } from 'vitest';
import { computeTreemap, type TreemapItem } from './treemap.ts';

const opts = { width: 400, height: 300, padding: 0 };

function area(r: { w: number; h: number }) {
  return r.w * r.h;
}

describe('computeTreemap', () => {
  it('makes rectangle area proportional to value', () => {
    const items: TreemapItem[] = [
      { id: 'a', label: 'A', value: 75 },
      { id: 'b', label: 'B', value: 25 },
    ];
    const out = computeTreemap(items, opts);
    const a = out.rects.find((r) => r.id === 'a')!;
    const b = out.rects.find((r) => r.id === 'b')!;
    // a is 3× b in value → ~3× in area
    expect(area(a) / area(b)).toBeCloseTo(3, 1);
  });

  it('tiles cover the full rectangle (no overlap-free gaps with padding 0)', () => {
    const items: TreemapItem[] = Array.from({ length: 12 }, (_, i) => ({
      id: `n${i}`,
      label: `N${i}`,
      value: i + 1,
    }));
    const out = computeTreemap(items, opts);
    const covered = out.rects.reduce((s, r) => s + area(r), 0);
    expect(covered).toBeCloseTo(opts.width * opts.height, 2);
  });

  it('keeps every tile inside the bounds', () => {
    const items: TreemapItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      label: `N${i}`,
      value: Math.round(100 / (i + 1)),
    }));
    const out = computeTreemap(items, opts);
    for (const r of out.rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(opts.width + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(opts.height + 1e-6);
    }
  });

  it('drops zero/negative-value items', () => {
    const items: TreemapItem[] = [
      { id: 'a', label: 'A', value: 10 },
      { id: 'b', label: 'B', value: 0 },
      { id: 'c', label: 'C', value: -5 },
    ];
    const out = computeTreemap(items, opts);
    expect(out.rects.map((r) => r.id)).toEqual(['a']);
  });

  it('single item fills the canvas', () => {
    const out = computeTreemap([{ id: 'a', label: 'A', value: 1 }], opts);
    expect(out.rects).toHaveLength(1);
    expect(area(out.rects[0]!)).toBeCloseTo(opts.width * opts.height, 2);
  });

  it('returns empty for no positive items', () => {
    expect(computeTreemap([], opts).rects).toEqual([]);
    expect(computeTreemap([{ id: 'a', label: 'A', value: 0 }], opts).rects).toEqual([]);
  });

  it('is deterministic across runs', () => {
    const items: TreemapItem[] = [
      { id: 'a', label: 'A', value: 5 },
      { id: 'b', label: 'B', value: 5 }, // tie → broken by id
      { id: 'c', label: 'C', value: 9 },
    ];
    const a = computeTreemap(items, opts);
    const b = computeTreemap(items, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('preserves the gap inset with padding', () => {
    const out = computeTreemap([{ id: 'a', label: 'A', value: 1 }], { width: 100, height: 100, padding: 2 });
    const r = out.rects[0]!;
    expect(r.x).toBeCloseTo(2, 5);
    expect(r.w).toBeCloseTo(96, 5);
  });
});

/**
 * The savings ladder's geometry.
 *
 * The chart asserts one thing visually: on a log axis, the artifact moves
 * every model LEFT BY THE SAME DISTANCE. If that stops being true the picture
 * silently starts lying — it would look fine, just mean something else. That
 * invariant is the first test here and the reason this file exists.
 */
import { describe, expect, it } from 'vitest';
import { computeSavingsLadder, fmtLadderUsd, type LadderModel } from './savingsLadder.ts';

const project = { fullTokens: 1_400_000, artifactTokens: 58_000 };
const opts = { width: 760 };

const m = (
  id: string,
  inputPerMTok: number | null,
  extra: Partial<LadderModel> = {},
): LadderModel => ({
  id,
  label: id,
  vendor: 'V',
  inputPerMTok,
  ...extra,
});

describe('the constant-translation invariant', () => {
  it('separates every model’s two marks by the same distance', () => {
    const layout = computeSavingsLadder(
      [m('cheap', 0.15), m('mid', 2), m('dear', 10), m('dearest', 50)],
      project,
      opts,
    );
    const deltas = layout.rows.map((r) => r.fullX - r.artifactX);
    for (const d of deltas) {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeCloseTo(deltas[0]!, 6);
    }
  });

  it('keeps that true when the price spread is ~1000x', () => {
    const layout = computeSavingsLadder([m('a', 0.05), m('b', 50)], project, opts);
    const [d0, d1] = layout.rows.map((r) => r.fullX - r.artifactX);
    expect(d1).toBeCloseTo(d0!, 6);
  });
});

describe('ordering and readouts', () => {
  it('puts the cheapest artifact cost first, so the sort needs no explaining', () => {
    const layout = computeSavingsLadder(
      [m('dear', 10), m('cheap', 0.15), m('mid', 2)],
      project,
      opts,
    );
    expect(layout.rows.map((r) => r.id)).toEqual(['cheap', 'mid', 'dear']);
  });

  it('reports the saving as the gap between the two costs', () => {
    const layout = computeSavingsLadder([m('x', 10)], project, opts);
    const row = layout.rows[0]!;
    expect(row.fullCost).toBeCloseTo(14, 6); // 1.4M tok * $10/M
    expect(row.artifactCost).toBeCloseTo(0.58, 6); // 58k tok * $10/M
    expect(row.savedCost).toBeCloseTo(13.42, 6);
  });

  it('flags a price that is not from a primary vendor source', () => {
    const layout = computeSavingsLadder(
      [m('agg', 1, { confidence: 'aggregator' }), m('prim', 2, { confidence: 'primary' })],
      project,
      opts,
    );
    expect(layout.rows.find((r) => r.id === 'agg')!.flagged).toBe(true);
    expect(layout.rows.find((r) => r.id === 'prim')!.flagged).toBe(false);
  });
});

describe('models the chart cannot plot', () => {
  it('lists unpriced models instead of dropping them', () => {
    const layout = computeSavingsLadder([m('priced', 2), m('nopricetag', null)], project, opts);
    expect(layout.rows.map((r) => r.id)).toEqual(['priced']);
    expect(layout.unpriced.map((u) => u.id)).toEqual(['nopricetag']);
  });

  it('still lists them when NOTHING is priced', () => {
    const layout = computeSavingsLadder([m('a', null), m('b', null)], project, opts);
    expect(layout.rows).toHaveLength(0);
    expect(layout.unpriced).toHaveLength(2);
  });

  it('clamps a genuinely free model to the floor and marks it, rather than plotting log(0)', () => {
    const layout = computeSavingsLadder([m('free', 0), m('paid', 5)], project, opts);
    const free = layout.rows.find((r) => r.id === 'free')!;
    expect(free.clampedLow).toBe(true);
    expect(Number.isFinite(free.artifactX)).toBe(true);
    expect(Number.isFinite(free.fullX)).toBe(true);
  });
});

describe('degenerate inputs produce geometry, not NaN', () => {
  it('survives a single model (hi === lo would divide by zero)', () => {
    const layout = computeSavingsLadder([m('only', 3)], project, opts);
    for (const r of layout.rows) {
      expect(Number.isFinite(r.fullX)).toBe(true);
      expect(Number.isFinite(r.artifactX)).toBe(true);
    }
  });

  it('survives every model being priced identically', () => {
    const layout = computeSavingsLadder([m('a', 2), m('b', 2), m('c', 2)], project, opts);
    expect(layout.rows.every((r) => Number.isFinite(r.artifactX))).toBe(true);
  });

  it('returns an empty layout for no models or zero width', () => {
    expect(computeSavingsLadder([], project, opts).rows).toHaveLength(0);
    expect(computeSavingsLadder([m('a', 1)], project, { width: 0 }).rows).toHaveLength(0);
  });

  it('does not divide by zero when the project has no artifact', () => {
    const layout = computeSavingsLadder([m('a', 1)], { fullTokens: 1000, artifactTokens: 0 }, opts);
    expect(layout.ratio).toBe(0);
    expect(layout.rows.every((r) => Number.isFinite(r.artifactX))).toBe(true);
  });
});

describe('the computed finding', () => {
  it('counts how many models were dearer on the repo than the dearest is on the artifact', () => {
    // artifact costs: 0.0087 / 0.116 / 0.58 ; full costs: 0.21 / 2.8 / 14.
    // Dearest artifact cost is $0.58, so only b ($2.80) and c ($14.00) were
    // dearer on the whole codebase — a's whole-repo run ($0.21) genuinely was
    // cheaper. The count must be 2 of 3, not a flattering 3 of 3.
    const layout = computeSavingsLadder([m('a', 0.15), m('b', 2), m('c', 10)], project, opts);
    expect(layout.crossover).not.toBeNull();
    expect(layout.crossover!.caption).toContain('2 of 3');
  });

  it('states no finding when the artifact beats nothing', () => {
    const flat = { fullTokens: 1000, artifactTokens: 1000 };
    const layout = computeSavingsLadder([m('a', 1)], flat, opts);
    expect(layout.crossover).toBeNull();
  });

  it('describes the whole chart for a screen reader', () => {
    const layout = computeSavingsLadder([m('a', 1), m('b', 10), m('c', null)], project, opts);
    expect(layout.ariaSummary).toMatch(/2 priced models/);
    expect(layout.ariaSummary).toMatch(/publishes? no per-token price/);
  });

  it('pluralises the model and vendor counts too', () => {
    const solo = computeSavingsLadder([m('only', 3)], project, opts);
    expect(solo.ariaSummary).toContain('1 priced model across 1 vendor.');
  });

  it('agrees with itself grammatically — a screen reader speaks this aloud', () => {
    const one = computeSavingsLadder([m('a', 1), m('x', null)], project, opts);
    expect(one.ariaSummary).toContain('1 model publishes no per-token price and is listed');
    const many = computeSavingsLadder([m('a', 1), m('x', null), m('y', null)], project, opts);
    expect(many.ariaSummary).toContain('2 models publish no per-token price and are listed');
  });
});

describe('fmtLadderUsd keeps sub-cent costs meaningful', () => {
  it('does not collapse small numbers to $0.00', () => {
    expect(fmtLadderUsd(0.0087)).toBe('$0.0087');
    expect(fmtLadderUsd(0.58)).toBe('$0.58');
    expect(fmtLadderUsd(14)).toBe('$14.00');
    expect(fmtLadderUsd(0)).toBe('$0');
  });
});

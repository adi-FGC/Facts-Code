/** Steps and time estimates over raw worker ticks (lib/scanProgress.ts). */
import { describe, expect, it } from 'vitest';
import { GITHUB_STAGES, LOCAL_STAGES, StageTracker, formatEta, stagesFor } from './scanProgress.ts';

const clock = (start = 0) => {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
};

describe('StageTracker — steps', () => {
  it('names the GitHub steps in order and hides the step line for one-step scans', () => {
    const c = clock();
    const gh = new StageTracker(GITHUB_STAGES, c.now);
    expect(gh.update({ phase: 'walking', current: 0, total: 0 }).stage).toEqual({
      index: 1,
      count: 3,
      name: 'Listing files',
    });
    expect(gh.update({ phase: 'reading', current: 0, total: 10 }).stage).toEqual({
      index: 2,
      count: 3,
      name: 'Fetching files',
    });
    expect(gh.update({ phase: 'analyzing', current: 0, total: 100 }).stage).toEqual({
      index: 3,
      count: 3,
      name: 'Analyzing',
    });
    const local = new StageTracker(LOCAL_STAGES, c.now);
    expect(local.update({ phase: 'analyzing', current: 5, total: 100 }).stage).toBeNull();
    expect(stagesFor('scan:github')).toBe(GITHUB_STAGES);
    expect(stagesFor('scan:local')).toBe(LOCAL_STAGES);
    expect(stagesFor('scan:files')).toBe(LOCAL_STAGES);
  });

  it('an unknown phase has no step and no estimate', () => {
    const t = new StageTracker(GITHUB_STAGES, clock().now);
    expect(t.update({ phase: 'mystery', current: 1, total: 2 })).toEqual({
      stage: null,
      etaMs: null,
    });
  });
});

describe('StageTracker — estimate', () => {
  it('estimates the rest of the step from the observed rate, after a warm-up', () => {
    const c = clock();
    const t = new StageTracker(GITHUB_STAGES, c.now);
    // 10 files every 500 ms = 20 files/s; 100 files in total.
    let eta = t.update({ phase: 'reading', current: 0, total: 100 }).etaMs;
    for (let i = 1; i <= 3; i++) {
      c.tick(500);
      eta = t.update({ phase: 'reading', current: i * 10, total: 100 }).etaMs;
      if (i < 4) expect(eta).toBeNull(); // 1.5 s watched: still warming up
    }
    c.tick(500);
    eta = t.update({ phase: 'reading', current: 40, total: 100 }).etaMs;
    expect(eta).not.toBeNull();
    expect(eta!).toBeGreaterThan(2_500);
    expect(eta!).toBeLessThan(3_500); // 60 files left at 20/s ≈ 3 s
  });

  it('does not count a resumed download’s opening jump as speed', () => {
    const c = clock();
    const t = new StageTracker(GITHUB_STAGES, c.now);
    // 900 of 1000 files arrive at once from the browser's cache…
    t.update({ phase: 'reading', current: 900, total: 1000 });
    // …then the rest download at 10 files/s.
    for (let i = 1; i <= 5; i++) {
      c.tick(500);
      t.update({ phase: 'reading', current: 900 + i * 5, total: 1000 });
    }
    const { etaMs } = t.update({ phase: 'reading', current: 925, total: 1000 });
    expect(etaMs!).toBeGreaterThan(6_000); // 75 left at 10/s = 7.5 s, not ~0
    expect(etaMs!).toBeLessThan(9_000);
  });

  it('resets per step, gives nothing for label-only ticks, and nothing once a step is done', () => {
    const c = clock();
    const t = new StageTracker(GITHUB_STAGES, c.now);
    for (let i = 0; i <= 6; i++) {
      t.update({ phase: 'reading', current: i * 10, total: 100 });
      c.tick(500);
    }
    expect(t.update({ phase: 'reading', current: 70, total: 100 }).etaMs).not.toBeNull();
    expect(t.update({ phase: 'reading', current: 100, total: 100 }).etaMs).toBeNull();
    expect(t.update({ phase: 'analyzing', current: 0, total: 100 }).etaMs).toBeNull();
    c.tick(3000);
    // A new step with no second sample yet: no rate, no estimate.
    expect(t.update({ phase: 'analyzing', current: 0, total: 0 }).etaMs).toBeNull();
  });
});

describe('formatEta', () => {
  it('rounds up in coarse steps and says nothing under a second', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(400)).toBeNull();
    expect(formatEta(1_200)).toBe('~5s left');
    expect(formatEta(41_000)).toBe('~45s left');
    expect(formatEta(60_000)).toBe('~1m left');
    expect(formatEta(65_000)).toBe('~1m 10s left');
    expect(formatEta(119_000)).toBe('~2m left');
    expect(formatEta(3_900_000)).toBe('~1h 05m left');
    expect(formatEta(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

/**
 * The weekly self-refresh rules.
 *
 * A deployed dashboard shows advisories that were true when it was built. The
 * rules below decide when the page goes and checks again — too eager and every
 * reader pays a network round trip and OSV takes the load; too lazy and the
 * page keeps presenting month-old advisories as current. Both failures are
 * silent in a browser, so they are pinned here.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  AUTO_REFRESH_AFTER_MS,
  manifestFingerprint,
  queriesFromManifests,
  readAutoRefresh,
  weeklyRefreshDecision,
  writeAutoRefresh,
} from './osvScanner.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-23T12:00:00Z');
const base = { now: NOW, online: true, queryCount: 12 };

describe('weeklyRefreshDecision', () => {
  it('leaves a build-time scan alone while it is still inside the week', () => {
    expect(weeklyRefreshDecision({ ...base, bakedAt: NOW - 2 * DAY })).toBe('skip');
    expect(weeklyRefreshDecision({ ...base, bakedAt: NOW - (7 * DAY - 1000) })).toBe('skip');
  });

  it('re-checks once the build-time scan has aged past a week', () => {
    expect(weeklyRefreshDecision({ ...base, bakedAt: NOW - 7 * DAY })).toBe('refresh');
    expect(weeklyRefreshDecision({ ...base, bakedAt: NOW - 40 * DAY })).toBe('refresh');
  });

  it('re-checks when the build shipped no scan at all', () => {
    expect(weeklyRefreshDecision({ ...base, bakedAt: 0 })).toBe('refresh');
    expect(weeklyRefreshDecision({ ...base })).toBe('refresh');
  });

  it('serves this browser its own recent answer instead of querying again', () => {
    const d = weeklyRefreshDecision({ ...base, bakedAt: NOW - 30 * DAY, cachedAt: NOW - 2 * DAY });
    expect(d).toBe('use-cache');
  });

  it('queries again once the cached answer is itself a week old', () => {
    expect(
      weeklyRefreshDecision({ ...base, bakedAt: NOW - 30 * DAY, cachedAt: NOW - 8 * DAY }),
    ).toBe('refresh');
  });

  it('ignores a cached answer older than the build it would replace', () => {
    // A redeploy with a newer scan makes this browser's older copy pointless.
    expect(weeklyRefreshDecision({ ...base, bakedAt: NOW - DAY, cachedAt: NOW - 2 * DAY })).toBe(
      'skip',
    );
  });

  it('never reaches the network while the browser reports itself offline', () => {
    expect(weeklyRefreshDecision({ ...base, bakedAt: NOW - 30 * DAY, online: false })).toBe('skip');
    // …but a cached answer still shows, because that costs nothing.
    expect(
      weeklyRefreshDecision({
        ...base,
        bakedAt: NOW - 30 * DAY,
        cachedAt: NOW - DAY,
        online: false,
      }),
    ).toBe('use-cache');
  });

  it('does nothing when there is nothing to ask about', () => {
    expect(weeklyRefreshDecision({ ...base, bakedAt: 0, queryCount: 0 })).toBe('skip');
  });

  it('uses a one-week window by default', () => {
    expect(AUTO_REFRESH_AFTER_MS).toBe(7 * DAY);
  });
});

describe('queriesFromManifests', () => {
  it('asks about each pinned npm dependency exactly once', () => {
    const q = queriesFromManifests([
      {
        path: 'package.json',
        ecosystem: 'npm',
        dependencies: { vite: '^8.0.16' },
        devDependencies: { vitest: '^4.1.11' },
      },
      // A monorepo pins the same dep in many manifests; OSV needs one query.
      { path: 'apps/ui/package.json', ecosystem: 'npm', dependencies: { vite: '^8.0.16' } },
    ]);
    expect(q.map((x) => `${x.name}@${x.version}`).sort()).toEqual(['vite@8.0.16', 'vitest@4.1.11']);
  });

  it('skips versions OSV cannot answer for, and ecosystems the parser does not cover', () => {
    const q = queriesFromManifests([
      {
        path: 'package.json',
        ecosystem: 'npm',
        dependencies: {
          '@factstack/spec': 'workspace:*',
          local: 'file:../local',
          forked: 'git+https://example.invalid/x.git',
          real: '1.2.3',
        },
      },
      { path: 'pyproject.toml', ecosystem: 'pypi', dependencies: { requests: '2.31.0' } },
    ]);
    expect(q.map((x) => x.name)).toEqual(['real']);
  });

  it('records which manifest a dependency came from', () => {
    const [q] = queriesFromManifests([
      { path: 'apps/cli/package.json', ecosystem: 'npm', dependencies: { commander: '12.0.0' } },
    ]);
    expect(q?.manifestPath).toBe('apps/cli/package.json');
  });
});

describe('the per-browser cache', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it('round-trips a refresh for the same dependency set', () => {
    const fp = manifestFingerprint([{ ecosystem: 'npm', name: 'vite', version: '8.0.16' }]);
    writeAutoRefresh({ at: NOW, fingerprint: fp, results: [] });
    expect(readAutoRefresh(fp)?.at).toBe(NOW);
  });

  it('ignores an answer recorded for a different dependency set', () => {
    const before = manifestFingerprint([{ ecosystem: 'npm', name: 'vite', version: '8.0.8' }]);
    const after = manifestFingerprint([{ ecosystem: 'npm', name: 'vite', version: '8.0.16' }]);
    writeAutoRefresh({ at: NOW, fingerprint: before, results: [] });
    expect(readAutoRefresh(after)).toBeNull();
  });

  it('fingerprints by content, not by the order dependencies happen to be listed', () => {
    const a = manifestFingerprint([
      { ecosystem: 'npm', name: 'b', version: '1.0.0' },
      { ecosystem: 'npm', name: 'a', version: '2.0.0' },
    ]);
    const b = manifestFingerprint([
      { ecosystem: 'npm', name: 'a', version: '2.0.0' },
      { ecosystem: 'npm', name: 'b', version: '1.0.0' },
    ]);
    expect(a).toBe(b);
  });

  it('survives a browser that refuses storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    });
    expect(() => writeAutoRefresh({ at: NOW, fingerprint: 'x', results: [] })).not.toThrow();
    expect(readAutoRefresh('x')).toBeNull();
  });
});

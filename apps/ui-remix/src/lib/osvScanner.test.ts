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
import { buildOsvQueries } from '@factstack/scanners';
import {
  AUTO_REFRESH_AFTER_MS,
  AUTO_REFRESH_PARTIAL_MS,
  bucketSeverity,
  isPartialAnswer,
  manifestFingerprint,
  parseNpmManifestForOsv,
  pickFixedVersion,
  queriesFromManifests,
  readAutoRefresh,
  summarizeOsvResults,
  weeklyRefreshDecision,
  writeAutoRefresh,
  type OsvResult,
  type OsvVuln,
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

  /* UI-R3 — a partial answer (details that loaded id-only) used to be
     refused by the cache entirely, so every page view re-asked OSV; it is
     reused for an hour instead — never the week. */
  it('reuses a partial answer for an hour, then asks again', () => {
    const HOUR = 60 * 60 * 1000;
    expect(AUTO_REFRESH_PARTIAL_MS).toBe(HOUR);
    const stale = { ...base, bakedAt: NOW - 30 * DAY, cachedPartial: true };
    expect(weeklyRefreshDecision({ ...stale, cachedAt: NOW - 30 * 60 * 1000 })).toBe('use-cache');
    expect(weeklyRefreshDecision({ ...stale, cachedAt: NOW - HOUR })).toBe('refresh');
    expect(weeklyRefreshDecision({ ...stale, cachedAt: NOW - 2 * DAY })).toBe('refresh');
    // A full answer of the same age is still inside its week.
    expect(weeklyRefreshDecision({ ...stale, cachedPartial: false, cachedAt: NOW - 2 * DAY })).toBe(
      'use-cache',
    );
  });

  it('reads the partial state off the answer itself', () => {
    const q = { name: 'lodash', ecosystem: 'npm' as const, version: '4.17.20' };
    expect(isPartialAnswer([{ query: q, vulns: [{ id: 'GHSA-x' } as OsvVuln] }])).toBe(false);
    expect(
      isPartialAnswer([{ query: q, vulns: [{ id: 'GHSA-x' } as OsvVuln], detailsFailed: 1 }]),
    ).toBe(true);
    expect(isPartialAnswer([])).toBe(false);
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

  it('skips versions OSV cannot answer for', () => {
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
    ]);
    expect(q.map((x) => x.name)).toEqual(['real']);
  });

  it('asks exactly what the CLI scan asked (shared buildOsvQueries, INV7)', () => {
    const manifests = [
      {
        path: 'package.json',
        ecosystem: 'npm',
        dependencies: { lodash: '^4.17.20', ws: '8.16.0', 'my-lodash': 'npm:lodash@^4.17.21' },
        devDependencies: { vitest: '1.x' },
        // Installed versions the artifact carried from analyze time.
        resolved: { ws: '8.17.0' },
      },
      { path: 'pyproject.toml', ecosystem: 'pypi', dependencies: { requests: '2.31.0' } },
    ];
    expect(queriesFromManifests(manifests)).toEqual(
      buildOsvQueries(manifests as unknown as Parameters<typeof buildOsvQueries>[0]).queries,
    );
    const by = new Map(queriesFromManifests(manifests).map((x) => [`${x.name}@${x.version}`, x]));
    expect(by.get('ws@8.17.0')?.versionSource).toBe('lockfile');
    expect(by.get('lodash@4.17.20')?.versionSource).toBe('declared-range');
    expect(by.has('lodash@4.17.21')).toBe(true); // the alias, under its real name
    expect(by.get('vitest@1.0.0')?.scope).toBe('dev');
    expect(by.has('requests@2.31.0')).toBe(true); // other ecosystems, as the CLI does
  });

  it('tolerates a raw dataset manifest with no dependency maps', () => {
    expect(queriesFromManifests([{ path: 'package.json', ecosystem: 'npm' }])).toEqual([]);
  });

  it('records which manifest a dependency came from', () => {
    const [q] = queriesFromManifests([
      { path: 'apps/cli/package.json', ecosystem: 'npm', dependencies: { commander: '12.0.0' } },
    ]);
    expect(q?.manifestPath).toBe('apps/cli/package.json');
  });
});

describe('parseNpmManifestForOsv (the paste flow)', () => {
  const pasted = JSON.stringify({
    name: 'demo',
    dependencies: { lodash: '4.17.20', alias: 'npm:left-pad@^1.3.0' },
    devDependencies: { vitest: '^1.2.0' },
  });

  it('parses a pasted package.json (a paste has no file name to detect from)', () => {
    const q = parseNpmManifestForOsv(pasted, 'pasted-manifest');
    expect(q.map((x) => `${x.name}@${x.version}`).sort()).toEqual([
      'left-pad@1.3.0',
      'lodash@4.17.20',
      'vitest@1.2.0',
    ]);
    expect(q.every((x) => x.manifestPath === 'pasted-manifest')).toBe(true);
    expect(q.every((x) => x.versionSource === 'declared-range')).toBe(true);
    expect(q.find((x) => x.name === 'vitest')?.scope).toBe('dev');
  });

  it('returns nothing for text that is not a package.json', () => {
    expect(parseNpmManifestForOsv('not json')).toEqual([]);
  });
});

describe('summarizeOsvResults', () => {
  const vuln = (id: string, over: Partial<OsvVuln> = {}): OsvVuln => ({ id, ...over });
  const result = (name: string, vulns: OsvVuln[], extra: Partial<OsvResult> = {}): OsvResult => ({
    query: { ecosystem: 'npm', name, version: '1.0.0', ...(extra.query ?? {}) },
    vulns,
    ...(extra.detailsFailed ? { detailsFailed: extra.detailsFailed } : {}),
  });

  it('grades with the shared bucketer: a reviewed GHSA label wins over the vector', () => {
    // CVSS:3.1 C:H/I:H/A:H with AV:L/AC:H/PR:H is a 6.4, and GHSA says HIGH.
    const v = vuln('GHSA-x', {
      database_specific: { severity: 'HIGH' },
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:H/I:H/A:H' }],
    });
    const s = summarizeOsvResults([result('lodash', [v])]);
    expect(s.critical).toBe(0);
    expect(s.high).toBe(1);
    expect(bucketSeverity(v)).toBe('high');
  });

  it('counts dev and transitive advisories as shown, not graded', () => {
    const s = summarizeOsvResults([
      result('a', [vuln('A', { database_specific: { severity: 'CRITICAL' } })], {
        query: { ecosystem: 'npm', name: 'a', version: '1.0.0', scope: 'dev' },
      }),
      result('b', [vuln('B', { database_specific: { severity: 'LOW' } })], {
        query: { ecosystem: 'npm', name: 'b', version: '1.0.0', scope: 'direct' },
      }),
      result('c', []),
    ]);
    expect(s).toMatchObject({
      critical: 0,
      low: 1,
      total: 2,
      ungraded: 1,
      cleanPackages: 1,
      vulnerablePackages: 2,
    });
  });

  it('adds up advisories whose details could not be loaded', () => {
    const s = summarizeOsvResults([
      result('a', [vuln('A'), vuln('B')], { detailsFailed: 2 }),
      result('b', [vuln('C')]),
    ]);
    expect(s.degraded).toBe(2);
    expect(s.unknown).toBe(3);
  });
});

describe('pickFixedVersion (shared) never suggests a downgrade', () => {
  it('names the fix on the installed release line (ws@8.16.0 → 8.17.1, not 5.2.4)', () => {
    const ws: OsvVuln = {
      id: 'GHSA-3h5v-q93c-6h6q',
      affected: [
        {
          package: { name: 'ws', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER',
              events: [
                { introduced: '2.1.0' },
                { fixed: '5.2.4' },
                { introduced: '8.0.0' },
                { fixed: '8.17.1' },
              ],
            },
          ],
        },
      ],
    };
    expect(pickFixedVersion(ws, 'ws', '8.16.0')).toBe('8.17.1');
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

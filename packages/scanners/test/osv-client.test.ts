/**
 * TC-1 — coverage for the OSV client surface that previously had none:
 * queryOsvBatch (stage-1 batch + stage-2 detail hydration, EH-3 detailsFailed),
 * bucketSeverity, osvResultsToVulnerabilities, pickFixedVersion, pickAdvisoryUrl
 * (incl. the SEC-1 scheme allowlist), and makeCacheKey (incl. CONC-3 cyrb53 +
 * order-independence). `fetch` is stubbed via vi.stubGlobal so these run offline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  queryOsvBatch,
  bucketSeverity,
  cvss3BaseScore,
  osvResultsToVulnerabilities,
  pickFixedVersion,
  pickAdvisoryUrl,
  makeCacheKey,
  type OsvQuery,
  type OsvVuln,
} from '../src/vulnerabilities.js';

afterEach(() => vi.unstubAllGlobals());

/** Stub both OSV endpoints. `batch[i]` = vuln ids for query i; `details[id]` =
 *  the hydrated record, or 'fail' to simulate a detail-fetch failure (EH-3). */
function stubFetch(batch: string[][], details: Record<string, Partial<OsvVuln> | 'fail'> = {}) {
  const fn = async (url: string) => {
    if (url.includes('/querybatch')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ results: batch.map((ids) => ({ vulns: ids.map((id) => ({ id })) })) }),
      };
    }
    const id = decodeURIComponent(url.split('/v1/vulns/')[1] ?? '');
    const d = details[id];
    if (d === 'fail') return { ok: false, status: 500, statusText: 'ERR', json: async () => ({}) };
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id, ...(d ?? {}) }) };
  };
  vi.stubGlobal('fetch', fn);
}

const q = (name: string, version = '1.0.0'): OsvQuery => ({ ecosystem: 'npm', name, version });

describe('queryOsvBatch', () => {
  it('hydrates details and returns one result per query, in order', async () => {
    stubFetch([['GHSA-1'], []], { 'GHSA-1': { summary: 'boom' } });
    const res = await queryOsvBatch([q('lodash'), q('react')], { bypassCache: true });
    expect(res).toHaveLength(2);
    expect(res[0]!.vulns[0]).toMatchObject({ id: 'GHSA-1', summary: 'boom' });
    expect(res[1]!.vulns).toEqual([]); // clean package
  });

  it('EH-3: records detailsFailed when a stage-2 detail fetch fails', async () => {
    stubFetch([['GHSA-bad']], { 'GHSA-bad': 'fail' });
    const res = await queryOsvBatch([q('lodash')], { bypassCache: true });
    expect(res[0]!.detailsFailed).toBe(1);
    expect(res[0]!.vulns[0]).toEqual({ id: 'GHSA-bad' }); // degraded to id-only
  });

  it('omits detailsFailed entirely on a fully-hydrated (clean) scan', async () => {
    stubFetch([['GHSA-1']], { 'GHSA-1': { summary: 'ok' } });
    const res = await queryOsvBatch([q('lodash')], { bypassCache: true });
    expect(res[0]!.detailsFailed).toBeUndefined();
  });

  it('serves a cache hit without fetching', async () => {
    const store = new Map<string, ReturnType<typeof Object>>();
    const cache = {
      get: (k: string) => (store.get(k) as never) ?? null,
      set: (k: string, v: never) => void store.set(k, v),
    };
    stubFetch([['GHSA-1']], { 'GHSA-1': { summary: 'first' } });
    await queryOsvBatch([q('lodash')], { cache });
    vi.stubGlobal('fetch', () => {
      throw new Error('should not fetch on cache hit');
    });
    const res = await queryOsvBatch([q('lodash')], { cache });
    expect(res[0]!.vulns[0]).toMatchObject({ id: 'GHSA-1' });
  });

  it('SCN-16: does NOT cache a degraded scan (a detail fetch failed)', async () => {
    const set = vi.fn();
    stubFetch([['GHSA-bad']], { 'GHSA-bad': 'fail' });
    await queryOsvBatch([q('lodash')], { cache: { get: () => null, set } });
    expect(set).not.toHaveBeenCalled();
    // …but a fully hydrated scan is cached as before.
    stubFetch([['GHSA-1']], { 'GHSA-1': { summary: 'ok' } });
    await queryOsvBatch([q('lodash')], { cache: { get: () => null, set } });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('a cache hit carries the CURRENT query labels, in the current order', async () => {
    const store = new Map<string, never>();
    const cache = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: never) => void store.set(k, v),
    };
    stubFetch([['GHSA-1'], []], { 'GHSA-1': {} });
    await queryOsvBatch([{ ...q('lodash'), scope: 'transitive' }, q('react')], { cache });
    const res = await queryOsvBatch([q('react'), { ...q('lodash'), scope: 'direct' }], { cache });
    expect(res.map((r) => r.query.name)).toEqual(['react', 'lodash']);
    expect(res[1]!.query.scope).toBe('direct');
    expect(res[1]!.vulns[0]!.id).toBe('GHSA-1');
  });

  it('SCN-P2-03: a corrupt persisted cache entry is a miss (refetch), never a throw', async () => {
    const qs = [q('lodash'), q('react')];
    const corruptEntries: unknown[] = [
      [{ query: qs[0] }, { query: qs[1], vulns: [] }], // row missing `vulns`
      [
        { query: qs[0], vulns: 'x' },
        { query: qs[1], vulns: [] },
      ],
      [
        { query: qs[0], vulns: [null] },
        { query: qs[1], vulns: [] },
      ], // null advisory
      [
        { query: qs[0], vulns: [{ summary: 'no id' }] },
        { query: qs[1], vulns: [] },
      ],
      [null, { query: qs[1], vulns: [] }],
    ];
    for (const corrupt of corruptEntries) {
      const set = vi.fn();
      stubFetch([['GHSA-1'], []], { 'GHSA-1': { summary: 'fresh' } });
      const res = await queryOsvBatch(qs, { cache: { get: () => corrupt as never, set } });
      expect(res[0]!.vulns[0]).toMatchObject({ id: 'GHSA-1', summary: 'fresh' });
      expect(osvResultsToVulnerabilities(res, 1)).toHaveLength(1);
      expect(set).toHaveBeenCalledTimes(1); // the refetched scan replaces the bad entry
    }
  });

  it('SCN-P2-02: a non-object detail body degrades to id-only; a detail with no id keeps the ref id', async () => {
    vi.stubGlobal('fetch', async (url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () =>
        url.includes('/querybatch')
          ? { results: [{ vulns: [{ id: 'GHSA-null' }, { id: 'GHSA-noid' }] }] }
          : url.endsWith('GHSA-null')
            ? null
            : { summary: 's' },
    }));
    const res = await queryOsvBatch([q('lodash')], { bypassCache: true });
    expect(res[0]!.detailsFailed).toBe(1);
    expect(res[0]!.vulns).toEqual([{ id: 'GHSA-null' }, { id: 'GHSA-noid', summary: 's' }]);
    expect(osvResultsToVulnerabilities(res, 1).map((v) => v.id)).toEqual([
      'GHSA-null',
      'GHSA-noid',
    ]);
  });
});

describe('bucketSeverity', () => {
  it('reads a CVSS vector with C:H/I:H/A:H as critical', () => {
    expect(
      bucketSeverity({
        id: 'x',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      } as OsvVuln),
    ).toBe('critical');
  });
  it('falls back to database_specific severity', () => {
    expect(bucketSeverity({ id: 'x', database_specific: { severity: 'HIGH' } } as OsvVuln)).toBe(
      'high',
    );
    expect(
      bucketSeverity({ id: 'x', database_specific: { severity: 'MODERATE' } } as OsvVuln),
    ).toBe('medium');
  });
  it('returns unknown with no severity signal', () => {
    expect(bucketSeverity({ id: 'x' } as OsvVuln)).toBe('unknown');
  });

  /* GHSA-35jh-r3h4-6jhm (lodash CVE-2021-23337): CVSS 7.2 (PR:H), GHSA label HIGH.
     The old C/I/A-only heuristic graded it critical. */
  const LODASH_VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H';

  it('SCN-08: the reviewed advisory label wins over the vector', () => {
    expect(
      bucketSeverity({
        id: 'GHSA-35jh-r3h4-6jhm',
        severity: [{ type: 'CVSS_V3', score: LODASH_VECTOR }],
        database_specific: { severity: 'HIGH' },
      } as OsvVuln),
    ).toBe('high');
  });

  it('SCN-08: without a label, a v3 vector is graded by its real base score', () => {
    expect(cvss3BaseScore(LODASH_VECTOR)).toBe(7.2);
    expect(bucketSeverity({ id: 'x', severity: [{ type: 'CVSS_V3', score: LODASH_VECTOR }] })).toBe(
      'high',
    );
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
    expect(cvss3BaseScore('CVSS:3.0/AV:L/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N')).toBe(2.5);
    expect(cvss3BaseScore('not a vector')).toBeNull();
  });

  it('SCN-08: CVSS v2 vectors are scored instead of falling through to unknown', () => {
    expect(
      bucketSeverity({
        id: 'x',
        severity: [{ type: 'CVSS_V2', score: 'AV:N/AC:L/Au:N/C:P/I:P/A:P' }],
      }),
    ).toBe('high'); // 7.5
    expect(
      bucketSeverity({
        id: 'x',
        severity: [{ type: 'CVSS_V2', score: 'AV:N/AC:M/Au:N/C:N/I:P/A:N' }],
      }),
    ).toBe('medium'); // 4.3
  });

  it('CVE-R4: a malformed severity entry (missing/null/number score) grades unknown, never throws', () => {
    const bad = [
      { type: 'CVSS_V3' },
      { type: 'CVSS_V3', score: 9.8 },
      { type: 'CVSS_V2', score: null },
      { type: 'CVSS_V4', score: undefined },
      null,
    ];
    for (const entry of bad) {
      expect(bucketSeverity({ id: 'x', severity: [entry] } as unknown as OsvVuln)).toBe('unknown');
    }
    // A non-array severity / non-string label are ignored too.
    expect(bucketSeverity({ id: 'x', severity: 'CVSS:3.1' } as unknown as OsvVuln)).toBe('unknown');
    expect(
      bucketSeverity({ id: 'x', database_specific: { severity: 7 } } as unknown as OsvVuln),
    ).toBe('unknown');
    // A malformed entry doesn't hide a valid one after it, and the label still wins.
    const valid = { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' };
    expect(
      bucketSeverity({ id: 'x', severity: [{ type: 'CVSS_V3' }, valid] } as unknown as OsvVuln),
    ).toBe('critical');
    // One bad record must not abort the whole conversion.
    const rows = osvResultsToVulnerabilities([
      {
        query: { ecosystem: 'npm', name: 'p', version: '1.0.0' },
        vulns: [{ id: 'BAD', severity: [{ type: 'CVSS_V3' }] } as unknown as OsvVuln],
      },
    ]);
    expect(rows.map((r) => r.severity)).toEqual(['unknown']);
  });
});

describe('pickFixedVersion', () => {
  it('returns the first fixed event', () => {
    expect(
      pickFixedVersion({
        id: 'x',
        affected: [
          { ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.3' }] }] },
        ],
      }),
    ).toBe('1.2.3');
  });
  it('returns null when no fixed event exists', () => {
    expect(
      pickFixedVersion({
        id: 'x',
        affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }],
      }),
    ).toBeNull();
  });

  /* GHSA-3h5v-q93c-6h6q (ws): four affected release lines. */
  const WS: OsvVuln = {
    id: 'GHSA-3h5v-q93c-6h6q',
    affected: (
      [
        ['2.1.0', '5.2.4'],
        ['6.0.0', '6.2.3'],
        ['7.0.0', '7.5.10'],
        ['8.0.0', '8.17.1'],
      ] as const
    ).map(([introduced, fixed]) => ({
      package: { name: 'ws', ecosystem: 'npm' },
      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced }, { fixed }] }],
    })),
  };

  it('SCN-07: picks the fix on the INSTALLED release line, not the first line', () => {
    expect(pickFixedVersion(WS, 'ws', '8.16.0')).toBe('8.17.1');
    expect(pickFixedVersion(WS, 'ws', '7.4.6')).toBe('7.5.10');
    expect(pickFixedVersion(WS, 'ws', '3.0.0')).toBe('5.2.4');
  });

  it('SCN-07: same-list introduced/fixed pairs and a gap between lines', () => {
    const v: OsvVuln = {
      id: 'x',
      affected: [
        {
          package: { name: 'p', ecosystem: 'npm' },
          ranges: [
            {
              type: 'SEMVER',
              events: [
                { introduced: '0' },
                { fixed: '1.2.3' },
                { introduced: '2.0.0' },
                { fixed: '2.4.0' },
              ],
            },
          ],
        },
      ],
    };
    expect(pickFixedVersion(v, 'p', '2.1.0')).toBe('2.4.0');
    expect(pickFixedVersion(v, 'p', '1.5.0')).toBe('2.4.0'); // unaffected gap → next fix above
    expect(pickFixedVersion(v, 'p', '3.0.0')).toBeNull(); // never suggest a downgrade
  });

  it('keeps the legacy first-fix answer when the installed version is unknown/unparseable', () => {
    expect(pickFixedVersion(WS, 'ws')).toBe('5.2.4');
    expect(pickFixedVersion(WS, 'ws', 'not-semver')).toBe('5.2.4');
  });

  it('SCN-07: osvResultsToVulnerabilities passes the installed version through', () => {
    const [row] = osvResultsToVulnerabilities([{ query: q('ws', '8.16.0'), vulns: [WS] }], 1);
    expect(row!.fixedVersion).toBe('8.17.1');
  });

  it('SCN-P2-02: malformed affected/ranges/events are skipped, never thrown on', () => {
    const junk = [
      { affected: [{ ranges: [{ type: 'SEMVER', events: null }] }] },
      { affected: [{ ranges: 'x' }] },
      { affected: [{ ranges: [{ type: 'SEMVER', events: [null, 7, 'x'] }] }] },
      { affected: [{ ranges: [null] }] },
      { affected: [null, 'x'] },
      { affected: 'x' },
      { affected: [{ ranges: [{ events: [{ introduced: 0, fixed: 5 }] }] }] },
    ].map((v, i) => ({ id: `x${i}`, ...v }) as unknown as OsvVuln);
    for (const v of junk) expect(pickFixedVersion(v, 'p', '1.0.0')).toBeNull();
    // One poisoned advisory no longer aborts the whole conversion.
    const rows = osvResultsToVulnerabilities([{ query: q('p'), vulns: junk }], 1);
    expect(rows.map((r) => r.fixedVersion)).toEqual(junk.map(() => null));
    // A valid fix after junk entries is still found.
    const mixed = {
      id: 'x',
      affected: [
        null,
        {
          package: { name: 'p', ecosystem: 'npm' },
          ranges: [
            null,
            {
              type: 'SEMVER',
              events: [null, { introduced: '0' }, { fixed: 1 }, { fixed: '1.2.3' }],
            },
          ],
        },
      ],
    } as unknown as OsvVuln;
    expect(pickFixedVersion(mixed, 'p', '1.0.0')).toBe('1.2.3');
  });
});

describe('pickAdvisoryUrl — SEC-1 scheme allowlist', () => {
  it('prefers an http(s) ADVISORY reference', () => {
    expect(
      pickAdvisoryUrl({
        id: 'x',
        references: [{ type: 'ADVISORY', url: 'https://example.test/a' }],
      } as OsvVuln),
    ).toBe('https://example.test/a');
  });
  it('rejects a javascript: URL and falls back to osv.dev', () => {
    expect(
      pickAdvisoryUrl({
        id: 'CVE-1',
        references: [{ type: 'ADVISORY', url: 'javascript:alert(1)' }],
      } as OsvVuln),
    ).toBe('https://osv.dev/vulnerability/CVE-1');
  });
  it('rejects a data: URL and falls back to osv.dev', () => {
    expect(
      pickAdvisoryUrl({
        id: 'CVE-3',
        references: [{ type: 'ADVISORY', url: 'data:text/html,<script>1</script>' }],
      } as OsvVuln),
    ).toBe('https://osv.dev/vulnerability/CVE-3');
  });
  it('falls back to osv.dev when no references exist', () => {
    expect(pickAdvisoryUrl({ id: 'CVE-2' } as OsvVuln)).toBe('https://osv.dev/vulnerability/CVE-2');
  });
  it('SCN-P2-02: skips malformed references instead of throwing', () => {
    expect(pickAdvisoryUrl({ id: 'CVE-4', references: 'x' } as unknown as OsvVuln)).toBe(
      'https://osv.dev/vulnerability/CVE-4',
    );
    const refs = [
      null,
      { type: 'ADVISORY', url: 5 },
      { type: 'WEB', url: 'https://example.test/w' },
    ];
    expect(pickAdvisoryUrl({ id: 'CVE-5', references: refs } as unknown as OsvVuln)).toBe(
      'https://example.test/w',
    );
  });
});

describe('osvResultsToVulnerabilities', () => {
  it('maps fields and skips clean (empty-vulns) results', () => {
    const out = osvResultsToVulnerabilities(
      [
        {
          query: { ...q('lodash'), manifestPath: 'package.json' },
          vulns: [{ id: 'GHSA-1', summary: 's', database_specific: { severity: 'HIGH' } }],
        },
        { query: q('react'), vulns: [] },
      ],
      123,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'GHSA-1',
      package: 'lodash',
      severity: 'high',
      lastChecked: 123,
      manifestPath: 'package.json',
    });
  });

  it('security#8: carries scope + versionSource labels from the query; omits them when absent', () => {
    const [tagged, plain] = osvResultsToVulnerabilities(
      [
        {
          query: { ...q('minimist', '1.2.5'), scope: 'transitive', versionSource: 'lockfile' },
          vulns: [{ id: 'GHSA-2' }],
        },
        { query: q('lodash'), vulns: [{ id: 'GHSA-3' }] },
      ],
      1,
    );
    expect(tagged).toMatchObject({ scope: 'transitive', versionSource: 'lockfile' });
    expect(plain).not.toHaveProperty('scope');
    expect(plain).not.toHaveProperty('versionSource');
  });
});

describe('makeCacheKey — CONC-3', () => {
  it('is independent of query order', () => {
    expect(makeCacheKey([q('a'), q('b')])).toBe(makeCacheKey([q('b'), q('a')]));
  });
  it('differs for different query sets', () => {
    expect(makeCacheKey([q('a')])).not.toBe(makeCacheKey([q('b')]));
  });
  it('carries the v2 (cyrb53) namespace so stale 32-bit djb2 entries cannot collide', () => {
    expect(makeCacheKey([q('a')]).startsWith('osv:v2:')).toBe(true);
  });
});

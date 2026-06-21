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
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ results: batch.map((ids) => ({ vulns: ids.map((id) => ({ id })) })) }) };
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
    const cache = { get: (k: string) => (store.get(k) as never) ?? null, set: (k: string, v: never) => void store.set(k, v) };
    stubFetch([['GHSA-1']], { 'GHSA-1': { summary: 'first' } });
    await queryOsvBatch([q('lodash')], { cache });
    vi.stubGlobal('fetch', () => { throw new Error('should not fetch on cache hit'); });
    const res = await queryOsvBatch([q('lodash')], { cache });
    expect(res[0]!.vulns[0]).toMatchObject({ id: 'GHSA-1' });
  });
});

describe('bucketSeverity', () => {
  it('reads a CVSS vector with C:H/I:H/A:H as critical', () => {
    expect(bucketSeverity({ id: 'x', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] } as OsvVuln)).toBe('critical');
  });
  it('falls back to database_specific severity', () => {
    expect(bucketSeverity({ id: 'x', database_specific: { severity: 'HIGH' } } as OsvVuln)).toBe('high');
    expect(bucketSeverity({ id: 'x', database_specific: { severity: 'MODERATE' } } as OsvVuln)).toBe('medium');
  });
  it('returns unknown with no severity signal', () => {
    expect(bucketSeverity({ id: 'x' } as OsvVuln)).toBe('unknown');
  });
});

describe('pickFixedVersion', () => {
  it('returns the first fixed event', () => {
    expect(pickFixedVersion({ id: 'x', affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '1.2.3' }] }] }] } as OsvVuln)).toBe('1.2.3');
  });
  it('returns null when no fixed event exists', () => {
    expect(pickFixedVersion({ id: 'x', affected: [{ ranges: [{ events: [{ introduced: '0' }] }] }] } as OsvVuln)).toBeNull();
  });
});

describe('pickAdvisoryUrl — SEC-1 scheme allowlist', () => {
  it('prefers an http(s) ADVISORY reference', () => {
    expect(pickAdvisoryUrl({ id: 'x', references: [{ type: 'ADVISORY', url: 'https://example.test/a' }] } as OsvVuln)).toBe('https://example.test/a');
  });
  it('rejects a javascript: URL and falls back to osv.dev', () => {
    expect(pickAdvisoryUrl({ id: 'CVE-1', references: [{ type: 'ADVISORY', url: 'javascript:alert(1)' }] } as OsvVuln)).toBe('https://osv.dev/vulnerability/CVE-1');
  });
  it('rejects a data: URL and falls back to osv.dev', () => {
    expect(pickAdvisoryUrl({ id: 'CVE-3', references: [{ type: 'ADVISORY', url: 'data:text/html,<script>1</script>' }] } as OsvVuln)).toBe('https://osv.dev/vulnerability/CVE-3');
  });
  it('falls back to osv.dev when no references exist', () => {
    expect(pickAdvisoryUrl({ id: 'CVE-2' } as OsvVuln)).toBe('https://osv.dev/vulnerability/CVE-2');
  });
});

describe('osvResultsToVulnerabilities', () => {
  it('maps fields and skips clean (empty-vulns) results', () => {
    const out = osvResultsToVulnerabilities([
      { query: { ...q('lodash'), manifestPath: 'package.json' }, vulns: [{ id: 'GHSA-1', summary: 's', database_specific: { severity: 'HIGH' } }] },
      { query: q('react'), vulns: [] },
    ], 123);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'GHSA-1', package: 'lodash', severity: 'high', lastChecked: 123, manifestPath: 'package.json' });
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

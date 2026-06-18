/**
 * Tests for the npm-registry freshness checker (ft-4).
 *
 * `fetch` is injected as a stub so these run offline + deterministically:
 * the stub maps a package name → a canned `latest` version (or an HTTP
 * error / thrown rejection), and records the URLs it was called with so we
 * can assert scoped-name encoding and the non-npm short-circuit.
 */

import { describe, expect, it } from 'vitest';
import {
  checkOutdated,
  cleanVersion,
  compareSemver,
  parseSemver,
  summarizeOutdated,
  type OutdatedQuery,
} from '../src/outdated.js';

/** Build a stub `fetch` from a name → outcome map. Outcome is a version
 *  string (200 OK), `{ status }` (HTTP error), or 'reject' (thrown). */
function stubFetch(versions: Record<string, string | { status: number } | 'reject'>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const m = url.match(/registry\.npmjs\.org\/(.+)\/latest$/);
    const name = m ? decodeURIComponent(m[1]!) : '';
    const v = versions[name];
    if (v === 'reject') throw new Error('network down');
    if (v && typeof v === 'object') return { ok: false, status: v.status, json: async () => ({}) };
    if (v === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ version: v }) };
  };
  return { fn, calls };
}

describe('cleanVersion', () => {
  it('strips leading range operators + whitespace', () => {
    expect(cleanVersion('^1.2.3')).toBe('1.2.3');
    expect(cleanVersion('~4.0.0')).toBe('4.0.0');
    expect(cleanVersion('>=2.1.0')).toBe('2.1.0');
    expect(cleanVersion('  3.0.0 ')).toBe('3.0.0');
    expect(cleanVersion('5.6.7')).toBe('5.6.7');
  });
});

describe('checkOutdated', () => {
  it('flags a dep behind the registry latest', async () => {
    const { fn } = stubFetch({ lodash: '4.17.21' });
    const [r] = await checkOutdated([{ ecosystem: 'npm', name: 'lodash', current: '4.17.20' }], { fetch: fn });
    expect(r).toMatchObject({ name: 'lodash', current: '4.17.20', latest: '4.17.21', isOutdated: true });
  });

  it('marks an up-to-date dep as not outdated', async () => {
    const { fn } = stubFetch({ react: '18.2.0' });
    const [r] = await checkOutdated([{ ecosystem: 'npm', name: 'react', current: '18.2.0' }], { fetch: fn });
    expect(r!.isOutdated).toBe(false);
    expect(r!.latest).toBe('18.2.0');
  });

  it('cleans a range marker before comparing', async () => {
    const up = stubFetch({ vite: '5.0.0' });
    const [same] = await checkOutdated([{ ecosystem: 'npm', name: 'vite', current: '^5.0.0' }], { fetch: up.fn });
    expect(same).toMatchObject({ current: '5.0.0', isOutdated: false });

    const behind = stubFetch({ vite: '5.4.0' });
    const [moved] = await checkOutdated([{ ecosystem: 'npm', name: 'vite', current: '^5.0.0' }], { fetch: behind.fn });
    expect(moved).toMatchObject({ current: '5.0.0', latest: '5.4.0', isOutdated: true });
  });

  it('skips non-npm ecosystems without calling fetch', async () => {
    const { fn, calls } = stubFetch({});
    const [r] = await checkOutdated([{ ecosystem: 'pypi', name: 'requests', current: '2.0.0' }], { fetch: fn });
    expect(r).toMatchObject({ latest: null, isOutdated: false, error: 'non-npm ecosystem' });
    expect(calls).toHaveLength(0);
  });

  it('tolerates HTTP errors (latest null, not outdated)', async () => {
    const { fn } = stubFetch({ 'ghost-pkg': { status: 404 } });
    const [r] = await checkOutdated([{ ecosystem: 'npm', name: 'ghost-pkg', current: '1.0.0' }], { fetch: fn });
    expect(r).toMatchObject({ latest: null, isOutdated: false });
    expect(r!.error).toContain('404');
  });

  it('tolerates a thrown/rejected fetch', async () => {
    const { fn } = stubFetch({ flaky: 'reject' });
    const [r] = await checkOutdated([{ ecosystem: 'npm', name: 'flaky', current: '1.0.0' }], { fetch: fn });
    expect(r).toMatchObject({ latest: null, isOutdated: false });
    expect(r!.error).toBe('network down');
  });

  it('preserves input order under concurrency', async () => {
    const { fn } = stubFetch({ a: '2.0.0', b: '1.0.0', c: '9.0.0', d: '1.0.0' });
    const qs: OutdatedQuery[] = [
      { ecosystem: 'npm', name: 'a', current: '1.0.0' },
      { ecosystem: 'npm', name: 'b', current: '1.0.0' },
      { ecosystem: 'npm', name: 'c', current: '1.0.0' },
      { ecosystem: 'npm', name: 'd', current: '1.0.0' },
    ];
    const res = await checkOutdated(qs, { fetch: fn, concurrency: 2 });
    expect(res.map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(res.map((r) => r.isOutdated)).toEqual([true, false, true, false]);
  });

  it('URL-encodes scoped package names', async () => {
    const { fn, calls } = stubFetch({ '@babel/core': '7.24.0' });
    await checkOutdated([{ ecosystem: 'npm', name: '@babel/core', current: '7.20.0' }], { fetch: fn });
    expect(calls[0]).toBe('https://registry.npmjs.org/%40babel%2Fcore/latest');
  });

  it('does NOT flag a dep AHEAD of latest (pinned RC / registry lag)', async () => {
    /* The old string-`!==` counted ANY difference as outdated, so a version
       newer than `latest` would trip a `--fail-on` CI gate on a current tree.
       Semver compare: only `current < latest` is behind. */
    const { fn } = stubFetch({ vite: '5.0.0' });
    const [r] = await checkOutdated([{ ecosystem: 'npm', name: 'vite', current: '5.4.0' }], { fetch: fn });
    expect(r!.isOutdated).toBe(false);
    expect(r!.latest).toBe('5.0.0');
  });

  it('treats a prerelease as behind its release', async () => {
    const { fn } = stubFetch({ next: '14.0.0' });
    const [r] = await checkOutdated([{ ecosystem: 'npm', name: 'next', current: '14.0.0-canary.3' }], { fetch: fn });
    expect(r!.isOutdated).toBe(true);
  });

  it('marks an unparseable registry version as errored, not outdated', async () => {
    const { fn } = stubFetch({ weird: 'next' }); // the `latest` dist-tag isn't semver
    const [r] = await checkOutdated([{ ecosystem: 'npm', name: 'weird', current: '1.0.0' }], { fetch: fn });
    expect(r!.isOutdated).toBe(false);
    expect(r!.error).toBe('unparseable version');
  });

  it('passes an abort signal to fetch (timeout wiring)', async () => {
    let sawSignal = false;
    const fn = async (_u: string, init?: { signal?: { aborted: boolean } }) => {
      sawSignal = !!init?.signal;
      return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) };
    };
    await checkOutdated([{ ecosystem: 'npm', name: 'x', current: '1.0.0' }], { fetch: fn, timeoutMs: 5000 });
    expect(sawSignal).toBe(true);
  });
});

describe('compareSemver', () => {
  it('orders release cores numerically, not lexically', () => {
    expect(compareSemver('1.9.0', '1.10.0')! < 0).toBe(true); // 9 < 10; lexical would flip it
    expect(compareSemver('2.0.0', '1.9.9')! > 0).toBe(true);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });
  it('ranks a prerelease below its release', () => {
    expect(compareSemver('1.0.0-rc.1', '1.0.0')! < 0).toBe(true);
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.1')! > 0).toBe(true);
  });
  it('returns null for an unparseable version', () => {
    expect(compareSemver('next', '1.0.0')).toBeNull();
    expect(compareSemver('1.0.0', 'workspace:*')).toBeNull();
  });
  it('rejects SemVer-invalid leading-zero identifiers (no silent valid compare)', () => {
    // SemVer §2/§9: numeric identifiers carry no leading zeroes. These must
    // read as unknown (null), not silently parse as a valid version.
    expect(parseSemver('01.0.0')).toBeNull();
    expect(parseSemver('1.0.0-01')).toBeNull();
    expect(compareSemver('1.0.0-01', '1.0.0-1')).toBeNull(); // Codex finding
    // A single zero is valid (not a leading-zero violation).
    expect(parseSemver('1.0.0-0')).not.toBeNull();
    expect(compareSemver('1.0.0-0', '1.0.0-1')! < 0).toBe(true);
  });
});

describe('summarizeOutdated', () => {
  it('counts total, outdated, and errored', async () => {
    const { fn } = stubFetch({ a: '2.0.0', b: '1.0.0', bad: { status: 500 } });
    const res = await checkOutdated(
      [
        { ecosystem: 'npm', name: 'a', current: '1.0.0' },
        { ecosystem: 'npm', name: 'b', current: '1.0.0' },
        { ecosystem: 'npm', name: 'bad', current: '1.0.0' },
      ],
      { fetch: fn },
    );
    const s = summarizeOutdated(res);
    expect(s.total).toBe(3);
    expect(s.outdated.map((r) => r.name)).toEqual(['a']);
    expect(s.errored).toBe(1);
  });
});

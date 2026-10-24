/**
 * scanSessions — the saved-scan store (D-10) against an in-memory IndexedDB.
 * Pins: round trips, the content-addressed blob and extraction caches, the
 * byte accounting, LRU eviction order, clear, and the no-IndexedDB fallback.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  SCAN_DB_NAME,
  SCAN_DB_VERSION,
  githubSessionId,
  localSessionId,
  openScanStore,
  utf8Bytes,
  type ScanSessionRecord,
  type ScanStore,
} from './scanSessions.ts';

/** A fresh database per test: fake-indexeddb's factory is per instance. */
async function fresh(clock: () => number = () => 1_000): Promise<ScanStore> {
  const store = await openScanStore(clock, new IDBFactory());
  if (!store) throw new Error('expected an IndexedDB store');
  return store;
}

const session = (id: string, over: Partial<ScanSessionRecord> = {}): ScanSessionRecord => ({
  id,
  kind: 'github',
  label: 'o/r@main',
  commit: 'c'.repeat(40),
  signature: null,
  status: 'fetching',
  producer: 'test',
  totals: { files: 10, fetched: 3, bytes: 1234 },
  extractionKeys: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const quad = (n: number) => ({
  imports: [{ specifier: `./m${n}`, kind: 'import', line: 1, names: [] } as never],
  symbols: [],
  refs: [],
  envReads: [],
});

describe('scanSessions — sessions', () => {
  it('round-trips a session and lists newest first', async () => {
    let t = 1_000;
    const s = await fresh(() => t);
    await s.putSession(session('gh:a/b@1'));
    t = 2_000;
    await s.putSession(
      session('gh:a/b@2', {
        status: 'done',
        result: {
          agent: { x: 1 },
          human: {},
          meta: { filesScanned: 1, filesSkipped: 0, elapsedMs: 1 },
        },
      }),
    );
    expect((await s.getSession('gh:a/b@2'))?.result).toEqual({
      agent: { x: 1 },
      human: {},
      meta: { filesScanned: 1, filesSkipped: 0, elapsedMs: 1 },
    });
    expect((await s.listSessions()).map((r) => r.id)).toEqual(['gh:a/b@2', 'gh:a/b@1']);
    await s.deleteSession('gh:a/b@1');
    expect(await s.getSession('gh:a/b@1')).toBeUndefined();
  });

  it('builds ids the way the dialog resolves them', () => {
    expect(githubSessionId('Antiwork', 'Gumroad', 'ABC')).toBe('gh:antiwork/gumroad@abc');
    expect(localSessionId('fsa:1', 'sig')).toBe('local:fsa:1@sig');
  });
});

describe('scanSessions — blobs and extractions', () => {
  it('reports which blobs exist without moving their text, then serves them', async () => {
    const s = await fresh();
    await s.putBlobs([
      { sha: 'a', text: 'alpha' },
      { sha: 'b', text: 'beta' },
    ]);
    expect(await s.hasBlobs(['a', 'b', 'c'])).toEqual(new Set(['a', 'b']));
    expect(await s.getBlobs(['b', 'c'])).toEqual(new Map([['b', { text: 'beta', bytes: 4 }]]));
  });

  it('keeps the byte size the source served, and exposes the fetcher-facing cache', async () => {
    const s = await fresh();
    const cache = s.blobCache();
    await cache.put([{ sha: 'u16', text: 'hi', bytes: 6 }]); // a UTF-16 blob: 2 chars, 6 bytes
    expect(await cache.has(['u16', 'none'])).toEqual(new Set(['u16']));
    expect(await cache.get(['u16'])).toEqual(new Map([['u16', { text: 'hi', bytes: 6 }]]));
    expect((await s.estimate()).trackedBytes).toBe(6);
  });

  it('round-trips extraction quads by key', async () => {
    const s = await fresh();
    await s.putExtractions([
      { key: 'k1', value: quad(1) },
      { key: 'k2', value: quad(2) },
    ]);
    const got = await s.getExtractions(['k1', 'k3']);
    expect([...got.keys()]).toEqual(['k1']);
    expect(got.get('k1')).toEqual(quad(1));
  });

  it('accounts bytes as UTF-8', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('€')).toBe(3);
    expect(utf8Bytes('😀')).toBe(4);
  });
});

describe('scanSessions — space', () => {
  it('evicts least-recently-used blobs first, then extractions, then old results', async () => {
    let t = 1_000;
    const s = await fresh(() => t);
    await s.putBlobs([{ sha: 'old', text: 'x'.repeat(100) }]);
    t = 200_000;
    await s.putBlobs([{ sha: 'new', text: 'y'.repeat(100) }]);
    await s.putExtractions([{ key: 'e', value: quad(1) }]);
    const before = (await s.estimate()).trackedBytes;
    expect(before).toBeGreaterThan(200);
    const freed = await s.evictToFit(before - 50); // needs one blob gone
    expect(freed).toBeGreaterThanOrEqual(100);
    expect(await s.hasBlobs(['old', 'new'])).toEqual(new Set(['new']));
    expect([...(await s.getExtractions(['e'])).keys()]).toEqual(['e']);
  });

  it('does nothing when under the cap, and clear empties every store', async () => {
    const s = await fresh();
    await s.putBlobs([{ sha: 'a', text: 'alpha' }]);
    await s.putSession(session('gh:a/b@1'));
    expect(await s.evictToFit(1_000_000)).toBe(0);
    await s.clear();
    expect(await s.hasBlobs(['a'])).toEqual(new Set());
    expect(await s.listSessions()).toEqual([]);
    expect((await s.estimate()).trackedBytes).toBe(0);
  });
});

describe('scanSessions — connection lifetime', () => {
  it('reports isOpen, and lets go of its connection when a newer opener upgrades', async () => {
    const factory = new IDBFactory();
    const s = await openScanStore(Date.now, factory);
    if (!s) throw new Error('fake-indexeddb missing');
    expect(s.isOpen).toBe(true);
    // Another tab, a newer build: a higher version. Without the store's
    // versionchange handler this open stays blocked forever.
    const upgrade = factory.open(SCAN_DB_NAME, SCAN_DB_VERSION + 1);
    await new Promise<void>((resolve, reject) => {
      upgrade.onsuccess = () => {
        upgrade.result.close();
        resolve();
      };
      upgrade.onblocked = () => reject(new Error('blocked: the store kept its connection'));
      upgrade.onerror = () => reject(upgrade.error);
    });
    expect(s.isOpen).toBe(false);
    // This (older) build cannot reopen the newer schema: "no store", so its
    // scans run in memory instead of hanging or failing.
    expect(await openScanStore(Date.now, factory)).toBeNull();
  });

  it('close() is observable', async () => {
    const s = await fresh();
    expect(s.isOpen).toBe(true);
    s.close();
    expect(s.isOpen).toBe(false);
  });
});

describe('scanSessions — availability', () => {
  it('returns null where there is no IndexedDB, so callers stay in memory', async () => {
    expect(await openScanStore(Date.now, null)).toBeNull();
  });
});

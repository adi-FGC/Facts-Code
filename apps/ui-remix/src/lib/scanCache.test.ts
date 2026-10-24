/**
 * Scan-cache glue (lib/scanCache.ts) over the IndexedDB scan store, against
 * fake-indexeddb. A fresh factory per test keeps stores independent.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { FileExtraction } from '@factstack/core';
import {
  RESULT_PRODUCER,
  RecordingExtractionCache,
  preloadExtractionCache,
  restorable,
  saveSession,
} from './scanCache.ts';
import { openScanStore, type ScanSessionRecord, type ScanStore } from './scanSessions.ts';

const quad = (n: number): FileExtraction => ({
  imports: [{ source: `m${n}`, line: n }] as unknown as FileExtraction['imports'],
  symbols: [],
  refs: [],
  envReads: [],
});

async function fresh(clock: () => number = Date.now): Promise<ScanStore> {
  const s = await openScanStore(clock, new IDBFactory());
  if (!s) throw new Error('fake-indexeddb missing');
  return s;
}

const session = (id: string, over: Partial<ScanSessionRecord> = {}): ScanSessionRecord => ({
  id,
  kind: 'github',
  label: id,
  commit: id.split('@')[1] ?? null,
  signature: null,
  status: 'done',
  producer: RESULT_PRODUCER,
  totals: { files: 1, fetched: 1, bytes: 10 },
  extractionKeys: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('RecordingExtractionCache', () => {
  it('serves preloaded quads, counts hits, and records every key it was asked for', () => {
    const c = new RecordingExtractionCache(new Map([['k1', quad(1)]]));
    expect(c.get('k1')).toEqual(quad(1));
    expect(c.get('k2')).toBeUndefined();
    expect(c.hits).toBe(1);
    expect([...c.used]).toEqual(['k1', 'k2']);
  });

  it('collects what analyze() stores, for the next run', () => {
    const c = new RecordingExtractionCache(new Map());
    c.set('k2', quad(2));
    expect(c.fresh).toEqual([{ key: 'k2', value: quad(2) }]);
  });
});

describe('preloadExtractionCache', () => {
  it('preloads the keys of the newest earlier session of the same project', async () => {
    let t = 1_000;
    const s = await fresh(() => t);
    await s.putExtractions([
      { key: 'old', value: quad(1) },
      { key: 'new', value: quad(2) },
    ]);
    await s.putSession(session('gh:o/r@aaa', { extractionKeys: ['old'], updatedAt: 1 }));
    t = 2_000;
    await s.putSession(session('gh:o/r@bbb', { extractionKeys: ['new'], updatedAt: 2 }));
    await s.putSession(session('gh:x/y@ccc', { extractionKeys: ['old'], updatedAt: 3 }));
    const c = await preloadExtractionCache(s, 'gh:o/r@');
    expect(c.get('new')).toEqual(quad(2));
    expect(c.get('old')).toBeUndefined();
    expect(c.hits).toBe(1);
  });

  it('is empty without a store, without a prior session, or when the store fails', async () => {
    expect((await preloadExtractionCache(null, 'gh:o/r@')).get('k')).toBeUndefined();
    const s = await fresh();
    expect((await preloadExtractionCache(s, 'gh:o/r@')).get('k')).toBeUndefined();
    s.close();
    expect((await preloadExtractionCache(s, 'gh:o/r@')).hits).toBe(0);
  });
});

describe('restorable', () => {
  const result = { agent: {}, human: {}, meta: { filesScanned: 1, filesSkipped: 0, elapsedMs: 1 } };
  it('needs a finished session, with a result, from this very analyzer', () => {
    expect(restorable(session('gh:o/r@a', { result }))).toBe(true);
    expect(restorable(undefined)).toBe(false);
    expect(restorable(session('gh:o/r@a'))).toBe(false);
    expect(restorable(session('gh:o/r@a', { result, status: 'analyzing' }))).toBe(false);
    expect(restorable(session('gh:o/r@a', { result, producer: 'x1:other' }))).toBe(false);
  });
});

describe('saveSession', () => {
  it('stores the fresh extractions and the record', async () => {
    const s = await fresh();
    const c = new RecordingExtractionCache(new Map());
    c.set('k9', quad(9));
    await saveSession(s, session('gh:o/r@a', { extractionKeys: ['k9'] }), c);
    expect((await s.getSession('gh:o/r@a'))?.extractionKeys).toEqual(['k9']);
    expect((await s.getExtractions(['k9'])).get('k9')).toEqual(quad(9));
  });

  it('drops the project’s earlier sessions when asked, and nobody else’s', async () => {
    const s = await fresh();
    await s.putSession(session('gh:o/r@old'));
    await s.putSession(session('gh:x/y@keep'));
    const c = new RecordingExtractionCache(new Map());
    await saveSession(s, session('gh:o/r@new'), c, 'gh:o/r@');
    expect((await s.listSessions()).map((x) => x.id).sort()).toEqual(['gh:o/r@new', 'gh:x/y@keep']);
  });

  it('never throws: no store, or a store that fails', async () => {
    const c = new RecordingExtractionCache(new Map());
    await expect(saveSession(null, session('gh:o/r@a'), c)).resolves.toBeUndefined();
    const s = await fresh();
    s.close();
    await expect(saveSession(s, session('gh:o/r@a'), c)).resolves.toBeUndefined();
  });
});

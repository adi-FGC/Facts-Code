/**
 * scanSessions — the browser's saved-scan store (D-10).
 *
 * One IndexedDB database, `factstack-scans`, separate from the recents list
 * so the two schemas never couple. Three stores:
 *
 *   sessions     one row per scan source + revision: what was scanned, how
 *                far it got, and (when finished) the result itself, so
 *                reopening the same commit restores without a scan.
 *   blobs        content-addressed file text, keyed by the GitHub blob sha
 *                (or a content hash): a download that stopped resumes
 *                without refetching, and an unchanged file never refetches
 *                across commits.
 *   extractions  the per-file parse quads of @factstack/core's extraction
 *                cache, keyed by its own SHA-256 key, so a warm re-scan
 *                skips every parse it has seen (INV2: a hit is
 *                indistinguishable from a fresh parse).
 *
 * Everything stays in this browser. The store is best-effort: a private
 * window, a denied quota or no IndexedDB at all yields `null` from
 * `openScanStore()` and callers run in memory as before. DOM-free so it
 * bundles into the scanner worker as well as the page.
 */
import type { FileExtraction } from '@factstack/core';
import type { BlobCache, CachedBlob } from '@factstack/fs-browser';
import type { ScanMeta } from '../scanner.worker.ts';

export const SCAN_DB_NAME = 'factstack-scans';
export const SCAN_DB_VERSION = 2;
/** Soft cap on tracked bytes (D-10): oldest-used entries go first. */
export const SCAN_STORE_SOFT_CAP_BYTES = 500 * 1024 * 1024;

/** A read refreshes a row's `lastUsed` only after this long: eviction works
 *  by the day, and a resumed 12k-file scan must not rewrite 12k rows. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

export type ScanSessionKind = 'github' | 'local' | 'files';
export type ScanSessionStatus = 'fetching' | 'analyzing' | 'done' | 'failed';

export interface ScanSessionRecord {
  /** `gh:owner/repo@<commit>` or `local:<recent id>@<signature>`. */
  id: string;
  kind: ScanSessionKind;
  /** What the Open dialog shows: `owner/repo@ref` or the folder name. */
  label: string;
  /** The immutable revision the session describes: a commit sha when known. */
  commit: string | null;
  /** Local folders without a commit: a hash over (path, size, mtime). */
  signature: string | null;
  status: ScanSessionStatus;
  /** Which analyzer wrote `result` (lib/scanCache.ts RESULT_PRODUCER): a
   *  result restores only for the same extractor version and app build. */
  producer: string;
  totals: { files: number; fetched: number; bytes: number };
  /** The extraction-cache keys the last run used, so the next run can
   *  preload exactly those entries before analyze (local scans have no
   *  texts before the walk). */
  extractionKeys: string[];
  /** The finished artifacts and their scan meta, for instant restore.
   *  Plain JSON. */
  result?: { agent: unknown; human: unknown; meta: ScanMeta };
  createdAt: number;
  updatedAt: number;
}

interface BlobRow {
  sha: string;
  text: string;
  bytes: number;
  lastUsed: number;
}
interface ExtractionRow {
  key: string;
  value: FileExtraction;
  bytes: number;
  lastUsed: number;
}

export interface StorageEstimate {
  /** Bytes this store tracks itself (sum of row sizes). */
  trackedBytes: number;
  /** The browser's own figures for the origin, when it offers them. */
  usageBytes: number | null;
  quotaBytes: number | null;
}

/** Rough byte size of a string as UTF-8 (good enough for quota accounting). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
    if (c >= 0xd800 && c <= 0xdbff) i++;
  }
  return n;
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

export class ScanStore {
  private open = true;

  constructor(
    private readonly db: IDBDatabase,
    private readonly clock: () => number = Date.now,
  ) {
    /* A newer build in another tab asks to upgrade the schema: let go of the
       connection so it can (otherwise its open blocks forever); callers
       reopen on their next scan. */
    db.onversionchange = () => this.close();
  }

  /** False once closed here or by a version change elsewhere. */
  get isOpen(): boolean {
    return this.open;
  }

  /* ── sessions ─────────────────────────────────────────────────────── */

  async getSession(id: string): Promise<ScanSessionRecord | undefined> {
    const tx = this.db.transaction('sessions', 'readonly');
    const row = await req(tx.objectStore('sessions').get(id));
    return (row as ScanSessionRecord | undefined) ?? undefined;
  }

  async putSession(rec: ScanSessionRecord): Promise<void> {
    const tx = this.db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put({ ...rec, updatedAt: this.clock() });
    await done(tx);
  }

  /** Newest first. */
  async listSessions(): Promise<ScanSessionRecord[]> {
    const tx = this.db.transaction('sessions', 'readonly');
    const rows = (await req(tx.objectStore('sessions').getAll())) as ScanSessionRecord[];
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteSession(id: string): Promise<void> {
    const tx = this.db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').delete(id);
    await done(tx);
  }

  /* ── blobs ────────────────────────────────────────────────────────── */

  /** Which of `shas` are already stored. One transaction, no texts moved. */
  async hasBlobs(shas: readonly string[]): Promise<Set<string>> {
    const tx = this.db.transaction('blobs', 'readonly');
    const store = tx.objectStore('blobs');
    const found = new Set<string>();
    await Promise.all(
      shas.map(async (sha) => {
        if ((await req(store.getKey(sha))) !== undefined) found.add(sha);
      }),
    );
    return found;
  }

  /** Blobs for `shas` (missing ones are absent from the map); touches lastUsed. */
  async getBlobs(shas: readonly string[]): Promise<Map<string, CachedBlob>> {
    const tx = this.db.transaction('blobs', 'readwrite');
    const store = tx.objectStore('blobs');
    const out = new Map<string, CachedBlob>();
    const now = this.clock();
    await Promise.all(
      shas.map(async (sha) => {
        const row = (await req(store.get(sha))) as BlobRow | undefined;
        if (!row) return;
        out.set(sha, { text: row.text, bytes: row.bytes });
        if (now - row.lastUsed > TOUCH_AFTER_MS) store.put({ ...row, lastUsed: now });
      }),
    );
    await done(tx);
    return out;
  }

  /** Store blobs. `bytes` is the size the source served (what the fetcher
   *  reports on resume); it defaults to the UTF-8 length of `text`. */
  async putBlobs(
    entries: ReadonlyArray<{ sha: string; text: string; bytes?: number }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const tx = this.db.transaction('blobs', 'readwrite');
    const store = tx.objectStore('blobs');
    const now = this.clock();
    for (const { sha, text, bytes } of entries)
      store.put({ sha, text, bytes: bytes ?? utf8Bytes(text), lastUsed: now } satisfies BlobRow);
    await done(tx);
  }

  /** The fetcher-facing view of the blob store (`fetchGitHubToMemory`'s
   *  `blobCache` option): resume a download, skip unchanged files. */
  blobCache(): BlobCache {
    return {
      has: (shas) => this.hasBlobs(shas),
      get: (shas) => this.getBlobs(shas),
      put: (entries) => this.putBlobs(entries),
    };
  }

  /* ── extractions ──────────────────────────────────────────────────── */

  async getExtractions(keys: readonly string[]): Promise<Map<string, FileExtraction>> {
    const tx = this.db.transaction('extractions', 'readwrite');
    const store = tx.objectStore('extractions');
    const out = new Map<string, FileExtraction>();
    const now = this.clock();
    await Promise.all(
      keys.map(async (key) => {
        const row = (await req(store.get(key))) as ExtractionRow | undefined;
        if (!row) return;
        out.set(key, row.value);
        if (now - row.lastUsed > TOUCH_AFTER_MS) store.put({ ...row, lastUsed: now });
      }),
    );
    await done(tx);
    return out;
  }

  async putExtractions(
    entries: ReadonlyArray<{ key: string; value: FileExtraction }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const tx = this.db.transaction('extractions', 'readwrite');
    const store = tx.objectStore('extractions');
    const now = this.clock();
    for (const { key, value } of entries)
      store.put({
        key,
        value,
        bytes: utf8Bytes(JSON.stringify(value)),
        lastUsed: now,
      } satisfies ExtractionRow);
    await done(tx);
  }

  /* ── space ────────────────────────────────────────────────────────── */

  async estimate(): Promise<StorageEstimate> {
    let trackedBytes = 0;
    const tx = this.db.transaction(['sessions', 'blobs', 'extractions'], 'readonly');
    for (const name of ['blobs', 'extractions'] as const)
      trackedBytes += await sumLruBytes(tx.objectStore(name).index('lruBytes'));
    const sessions = (await req(tx.objectStore('sessions').getAll())) as ScanSessionRecord[];
    for (const s of sessions) if (s.result) trackedBytes += utf8Bytes(JSON.stringify(s.result));
    let usageBytes: number | null = null;
    let quotaBytes: number | null = null;
    const nav = (
      globalThis as {
        navigator?: { storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } };
      }
    ).navigator;
    if (nav?.storage?.estimate) {
      try {
        const e = await nav.storage.estimate();
        usageBytes = e.usage ?? null;
        quotaBytes = e.quota ?? null;
      } catch {
        /* an estimate is a courtesy */
      }
    }
    return { trackedBytes, usageBytes, quotaBytes };
  }

  /** Delete least-recently-used blobs and extractions, then the oldest
   *  sessions, until the tracked bytes fit under `cap`. Returns bytes freed. */
  async evictToFit(cap: number = SCAN_STORE_SOFT_CAP_BYTES): Promise<number> {
    let { trackedBytes } = await this.estimate();
    if (trackedBytes <= cap) return 0;
    const start = trackedBytes;
    for (const name of ['blobs', 'extractions'] as const) {
      const tx = this.db.transaction(name, 'readwrite');
      const store = tx.objectStore(name);
      /* Key cursor over (lastUsed, bytes): least recently used first, the
         size read from the index key, the row never loaded. */
      await new Promise<void>((resolve, reject) => {
        const cur = store.index('lruBytes').openKeyCursor();
        cur.onerror = () => reject(cur.error);
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || trackedBytes <= cap) {
            resolve();
            return;
          }
          trackedBytes -= (c.key as [number, number])[1];
          store.delete(c.primaryKey);
          c.continue();
        };
      });
      await done(tx);
      if (trackedBytes <= cap) break;
    }
    if (trackedBytes > cap) {
      const sessions = (await this.listSessions()).reverse(); // oldest first
      for (const s of sessions) {
        if (trackedBytes <= cap) break;
        if (!s.result) continue;
        trackedBytes -= utf8Bytes(JSON.stringify(s.result));
        await this.deleteSession(s.id);
      }
    }
    return start - trackedBytes;
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction(['sessions', 'blobs', 'extractions'], 'readwrite');
    for (const name of ['sessions', 'blobs', 'extractions'] as const) tx.objectStore(name).clear();
    await done(tx);
  }

  close(): void {
    this.open = false;
    this.db.close();
  }
}

/** Total of the `bytes` half of a `['lastUsed', 'bytes']` index, from its
 *  keys alone. */
function sumLruBytes(idx: IDBIndex): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let total = 0;
    const cur = idx.openKeyCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) {
        resolve(total);
        return;
      }
      total += (c.key as [number, number])[1];
      c.continue();
    };
  });
}

/** Open (and create) the store, or `null` where IndexedDB is unusable:
 *  callers then keep everything in memory, as before this store existed. */
export async function openScanStore(
  clock: () => number = Date.now,
  /** `undefined` = the global factory; `null` = none available. */
  factory: IDBFactory | null | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
): Promise<ScanStore | null> {
  if (!factory) return null;
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(SCAN_DB_NAME, SCAN_DB_VERSION);
      r.onupgradeneeded = () => {
        const up = r.result;
        /* Convenience data, not user data: a schema bump drops and recreates. */
        for (const name of Array.from(up.objectStoreNames)) up.deleteObjectStore(name);
        up.createObjectStore('sessions', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        /* `lruBytes` serves both space questions from index keys alone — how
           much is tracked, and what to evict first — so a 200 MB blob store
           is never read just to be measured. */
        for (const [name, keyPath] of [
          ['blobs', 'sha'],
          ['extractions', 'key'],
        ] as const)
          up.createObjectStore(name, { keyPath }).createIndex('lruBytes', ['lastUsed', 'bytes']);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
      r.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    return new ScanStore(db, clock);
  } catch {
    return null;
  }
}

/** `gh:owner/repo@<commit>`: a GitHub session is its immutable commit. */
export function githubSessionId(owner: string, repo: string, commit: string): string {
  return `gh:${owner.toLowerCase()}/${repo.toLowerCase()}@${commit.toLowerCase()}`;
}

/** `local:<recent id>@<signature>`: a folder session is its content signature
 *  (a commit when the folder has one, else a hash over the tree). */
export function localSessionId(recentId: string, signature: string): string {
  return `local:${recentId}@${signature}`;
}

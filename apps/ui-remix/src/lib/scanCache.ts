/**
 * Scan-cache glue between the scanner worker and the IndexedDB scan store
 * (lib/scanSessions.ts, D-10):
 *
 *   - RecordingExtractionCache — the synchronous ExtractionCache analyze()
 *     consults (core/extraction-cache.ts). IndexedDB is async, so the cache is
 *     preloaded before the walk with the keys the previous run of the same
 *     project used, and records what this run touched for the next preload.
 *   - restorable() — whether a stored session can stand in for a scan.
 *   - saveSession() — persist the record and the fresh extractions, then
 *     evict to the soft cap. Best-effort: a failure costs the saving only.
 *
 * Everything here is pure over a ScanStore, so it unit-tests with
 * fake-indexeddb. INV2 holds by construction: a hit is the stored clone of
 * the very quad a fresh parse produced (extractFileCached stores and serves
 * clones), and the key carries the extractor version.
 */
import {
  EXTRACTION_CACHE_VERSION,
  type ExtractionCache,
  type FileExtraction,
} from '@factstack/core';
import {
  SCAN_STORE_SOFT_CAP_BYTES,
  type ScanSessionRecord,
  type ScanStore,
} from './scanSessions.ts';

/** Build id Vite defines at build time (vite.config.ts); absent under vitest. */
declare const __FACTS_BUILD__: string | undefined;

/** Which analyzer produced a stored result. A finished result restores only
 *  for the same extractor version and the same app build: after a deploy the
 *  first reopen re-analyzes once (fast, from the blob and extraction caches)
 *  instead of serving an older build's facts. */
export const RESULT_PRODUCER = `x${EXTRACTION_CACHE_VERSION}:${
  typeof __FACTS_BUILD__ === 'string' ? __FACTS_BUILD__ : 'dev'
}`;

export class RecordingExtractionCache implements ExtractionCache {
  /** Every key analyze() asked for, hit or miss: the next run preloads these. */
  readonly used = new Set<string>();
  /** Misses analyze() computed and handed back, to persist. */
  readonly fresh: Array<{ key: string; value: FileExtraction }> = [];
  hits = 0;

  constructor(private readonly preloaded: ReadonlyMap<string, FileExtraction>) {}

  get(key: string): FileExtraction | undefined {
    this.used.add(key);
    const hit = this.preloaded.get(key);
    if (hit) this.hits++;
    return hit;
  }

  set(key: string, value: FileExtraction): void {
    this.fresh.push({ key, value });
  }
}

/** Preload the extractions the newest earlier session whose id starts with
 *  `idPrefix` (e.g. `gh:owner/repo@`) used — an empty cache when there is
 *  none, or no store. */
export async function preloadExtractionCache(
  store: ScanStore | null,
  idPrefix: string,
): Promise<RecordingExtractionCache> {
  if (!store) return new RecordingExtractionCache(new Map());
  try {
    const prior = (await store.listSessions()).find(
      (s) => s.id.startsWith(idPrefix) && s.extractionKeys.length > 0,
    );
    const map = prior
      ? await store.getExtractions(prior.extractionKeys)
      : new Map<string, FileExtraction>();
    return new RecordingExtractionCache(map);
  } catch {
    return new RecordingExtractionCache(new Map());
  }
}

/** A stored session stands in for a scan when it finished, kept its result,
 *  and the same analyzer produced it. */
export function restorable(
  s: ScanSessionRecord | undefined,
): s is ScanSessionRecord & { result: NonNullable<ScanSessionRecord['result']> } {
  return !!s && s.status === 'done' && !!s.result && s.producer === RESULT_PRODUCER;
}

/** Persist a finished scan: the fresh extractions, the session record, then
 *  evict to the soft cap. With `supersededPrefix`, every other session of
 *  the same project (an earlier commit or folder state) is dropped: its
 *  result is dead weight and its parses already live in the shared
 *  extraction store. */
export async function saveSession(
  store: ScanStore | null,
  record: ScanSessionRecord,
  cache: RecordingExtractionCache,
  supersededPrefix?: string,
): Promise<void> {
  if (!store) return;
  try {
    await store.putExtractions(cache.fresh);
    await store.putSession(record);
    if (supersededPrefix) {
      for (const s of await store.listSessions()) {
        if (s.id !== record.id && s.id.startsWith(supersededPrefix))
          await store.deleteSession(s.id);
      }
    }
    await store.evictToFit(SCAN_STORE_SOFT_CAP_BYTES);
  } catch {
    /* the saving is lost, the scan is not */
  }
}

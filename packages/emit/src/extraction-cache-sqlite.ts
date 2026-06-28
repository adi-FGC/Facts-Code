/**
 * F8 — Node sqlite-backed extraction cache (`node:sqlite`, Node 22+ built-in,
 * zero native compile / no node-gyp).
 *
 * Implements core's synchronous `ExtractionCache` contract: a content-addressed
 * key → the parse-derived `FileExtraction` quad, stored as JSON in a single
 * `extraction(key, val)` table inside `<root>/.facts/cache.db`. A cache hit lets
 * analyze() skip the Babel parse for an unchanged file — the engine of F8's
 * "touching one file re-analyzes ~that file".
 *
 * Why this is SAFE w.r.t. INV2 (incremental == full): the key already encodes
 * the content hash + ext + refs-mode + extractor version (see core's
 * `extractionCacheKey`), so a hit can only return the exact value a fresh parse
 * would have produced. This store therefore never changes WHAT analyze emits,
 * only how fast. The on-disk schema is versioned separately and nuke-and-rebuilt
 * on mismatch, so a `cache.db` written by an older binary can never poison a run.
 *
 * Isomorphic boundary (INV1): this file imports `node:sqlite`, so it lives in
 * `@factstack/emit` (the one package allowed Node built-ins) — never in core.
 * The browser build simply never constructs one (analyze runs cache-less, INV7).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExtractionCache, FileExtraction } from '@factstack/core';
// node:sqlite has no @types/node@20 declarations — see ./node-sqlite.ts for the
// typed shim. `DatabaseSync` is a type here; the runtime ctor is loaded lazily
// via loadDatabaseSync() so importing this module never throws on Node < 22.5.
import { type DatabaseSync, loadDatabaseSync } from './node-sqlite.js';

/** On-disk schema version. Independent of the key's extractor version: bump
 *  this only when the TABLE shape changes. Mismatch ⇒ wipe + rebuild. */
const DB_SCHEMA_VERSION = 1;

interface ValRow {
  val: string;
}
interface MetaRow {
  v: string;
}

/**
 * A durable, content-addressed extraction cache backed by `node:sqlite`.
 * Construct one per analyze run pointed at `<root>/.facts/cache.db`, pass it as
 * `analyze(fs, { extractionCache })`, then `close()` it.
 */
export class SqliteExtractionCache implements ExtractionCache {
  #db: DatabaseSync;
  #get: ReturnType<DatabaseSync['prepare']>;
  #put: ReturnType<DatabaseSync['prepare']>;
  /** Hit/miss tallies for the CLI to report incremental savings. */
  hits = 0;
  misses = 0;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    // Lazily resolve the node:sqlite ctor (throws on Node < 22.5 — the caller
    // catches and falls back to a cache-less run).
    const DB = loadDatabaseSync();
    this.#db = new DB(dbPath);
    // WAL + NORMAL: durable enough for a rebuildable cache, fast on warm runs.
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.#db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
    this.#db.exec('CREATE TABLE IF NOT EXISTS extraction (key TEXT PRIMARY KEY, val TEXT NOT NULL);');

    // Version guard — nuke-and-rebuild on a table-shape mismatch so an old
    // binary's cache.db can never feed malformed rows to a newer one.
    const row = this.#db.prepare('SELECT v FROM meta WHERE k = ?').get('dbSchemaVersion') as
      | MetaRow
      | undefined;
    if (!row || row.v !== String(DB_SCHEMA_VERSION)) {
      this.#db.exec('DELETE FROM extraction;');
      this.#db
        .prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)')
        .run('dbSchemaVersion', String(DB_SCHEMA_VERSION));
    }

    this.#get = this.#db.prepare('SELECT val FROM extraction WHERE key = ?');
    this.#put = this.#db.prepare('INSERT OR REPLACE INTO extraction (key, val) VALUES (?, ?)');
  }

  get(key: string): FileExtraction | undefined {
    const row = this.#get.get(key) as ValRow | undefined;
    if (!row) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // A corrupt row should miss (force a fresh parse), never throw.
    try {
      return JSON.parse(row.val) as FileExtraction;
    } catch {
      this.hits--;
      this.misses++;
      return undefined;
    }
  }

  set(key: string, value: FileExtraction): void {
    this.#put.run(key, JSON.stringify(value));
  }

  /** Drop every cached entry (the `--no-cache`/`--force` rebuild path). */
  clear(): void {
    this.#db.exec('DELETE FROM extraction;');
  }

  close(): void {
    this.#db.close();
  }
}

/** Convenience: open the standard `<factsDir>/cache.db` store. */
export function openExtractionCache(factsDir: string): SqliteExtractionCache {
  return new SqliteExtractionCache(`${factsDir.replace(/[\\/]+$/, '')}/cache.db`);
}

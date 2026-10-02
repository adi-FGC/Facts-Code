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

import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EXTRACTION_CACHE_VERSION,
  type ExtractionCache,
  type FileExtraction,
} from '@factstack/core';
// node:sqlite has no @types/node@20 declarations — see ./node-sqlite.ts for the
// typed shim. `DatabaseSync` is a type here; the runtime ctor is loaded lazily
// via loadDatabaseSync() so importing this module never throws on Node < 22.5.
import { type DatabaseSync, type StatementSync, loadDatabaseSync } from './node-sqlite.js';

/** On-disk schema version. Independent of the key's extractor version: bump
 *  this when the TABLE shape changes, or when every stored row must go.
 *  Mismatch ⇒ wipe + rebuild.
 *  v2: one-time wipe of rows written before secret redaction reached the
 *  cache — their envReads[].defaultValue could hold a private-key body. */
const DB_SCHEMA_VERSION = 2;

/** How long a statement waits on another process's write lock. Overlapping
 *  analyze runs are normal (per-edit hook, watch, MCP session start, git
 *  hooks); without a timeout the loser failed at once with "database is
 *  locked" and took the whole analyze down with it. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** SQLite primary result codes that mean the FILE is bad (not merely busy):
 *  SQLITE_CORRUPT and SQLITE_NOTADB. Only these justify deleting cache.db. */
const DAMAGE_CODES = new Set([11, 26]);
const isDamage = (err: unknown): boolean => {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && DAMAGE_CODES.has(code & 0xff);
};

/** Remove cache.db and its WAL/SHM sidecars. Best-effort: another process may
 *  still hold them open (Windows refuses the unlink); the next run retries. */
function removeStore(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      /* in use elsewhere — leave it */
    }
  }
}

interface ValRow {
  val: string;
}
interface MetaRow {
  v: string;
}

interface Store {
  db: DatabaseSync;
  get: StatementSync;
  put: StatementSync;
}

function openStore(dbPath: string, busyTimeoutMs: number, keyVersion: number): Store {
  // Lazily resolve the node:sqlite ctor (throws on Node < 22.5 — the caller
  // catches and falls back to a cache-less run).
  const DB = loadDatabaseSync();
  const db = new DB(dbPath);
  try {
    // busy_timeout FIRST, so the WAL switch and every write below wait for a
    // concurrent run's lock instead of failing "database is locked".
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))};`);
    // A deleted row's bytes must not linger in free pages: purged rows can
    // hold what redaction later removed (see DB_SCHEMA_VERSION).
    db.exec('PRAGMA secure_delete = ON;');
    // WAL + NORMAL: durable enough for a rebuildable cache, fast on warm runs.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
    db.exec('CREATE TABLE IF NOT EXISTS extraction (key TEXT PRIMARY KEY, val TEXT NOT NULL);');

    const meta = (k: string): string | undefined =>
      (db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as MetaRow | undefined)?.v;
    const setMeta = (k: string, v: number): void => {
      db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, String(v));
    };
    let purged = false;

    // Version guard — nuke-and-rebuild on a table-shape mismatch so an old
    // binary's cache.db can never feed malformed rows to a newer one.
    if (meta('dbSchemaVersion') !== String(DB_SCHEMA_VERSION)) {
      db.exec('DELETE FROM extraction;');
      purged = true;
      // A pre-v2 binary never set secure_delete: rows its clear() and INSERT
      // OR REPLACE dropped still sit in FREE pages, which no DELETE reaches.
      // VACUUM rewrites the file from the live rows alone (the checkpoint
      // below lands it on disk). Busy past the timeout: leave the stamp, so
      // the next open wipes and retries.
      let rebuilt = true;
      try {
        db.exec('VACUUM;');
      } catch {
        rebuilt = false;
      }
      if (rebuilt) {
        setMeta('dbSchemaVersion', DB_SCHEMA_VERSION);
        setMeta('keyVersion', keyVersion);
      }
    }

    // Rows keyed by an OLDER extractor version (`v<N>:`, N below this run's)
    // are never served again, but would sit in cache.db forever: purge them
    // once, when a newer version first opens the file. Never a NEWER
    // version's rows — a CLI and an MCP server one release apart share this
    // file, and purging every foreign prefix made each open wipe the other's
    // cache. The stamp is the newest version seen, so the everyday open (and
    // an older binary's) takes no write lock. A key without a numeric `v<N>:`
    // prefix is never served either, so it goes too.
    const newestSeen = Number(meta('keyVersion'));
    if (!(newestSeen >= keyVersion)) {
      const stale = db
        .prepare(
          `DELETE FROM extraction WHERE NOT (
             substr(key, 1, 1) = 'v' AND instr(key, ':') > 2
             AND substr(key, 2, instr(key, ':') - 2) NOT GLOB '*[^0-9]*'
             AND CAST(substr(key, 2, instr(key, ':') - 2) AS INTEGER) >= ?)`,
        )
        .run(keyVersion);
      purged = purged || Number(stale.changes) > 0;
      setMeta('keyVersion', keyVersion);
    }

    // Push the zeroed pages into cache.db and empty the WAL, which still holds
    // the purged rows' old page images. Best-effort: a concurrent reader can
    // keep the WAL alive a little longer; the next checkpoint finishes it.
    if (purged) {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        /* busy — SQLite checkpoints again on its own */
      }
    }

    return {
      db,
      get: db.prepare('SELECT val FROM extraction WHERE key = ?'),
      put: db.prepare('INSERT OR REPLACE INTO extraction (key, val) VALUES (?, ?)'),
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      /* already unusable */
    }
    throw err;
  }
}

export interface SqliteExtractionCacheOptions {
  /** Wait on another process's lock for up to this long. Default 5000 ms. */
  busyTimeoutMs?: number;
  /** Extractor version whose `v<N>:` keys this run serves; rows under an
   *  OLDER prefix are purged on open, a newer binary's rows are kept.
   *  Default: core's EXTRACTION_CACHE_VERSION (tests override it). */
  keyVersion?: number;
}

/**
 * A durable, content-addressed extraction cache backed by `node:sqlite`.
 * Construct one per analyze run pointed at `<root>/.facts/cache.db`, pass it as
 * `analyze(fs, { extractionCache })`, then `close()` it.
 *
 * The cache can never fail an analyze: a lock held past the busy timeout, an
 * I/O error, or a damaged file turns every later get/set into a miss/no-op for
 * the rest of the run (output is unchanged — a miss just re-parses). A DAMAGED
 * file is also deleted on close() so the next run rebuilds it, and one that is
 * already unreadable at open is deleted and recreated on the spot.
 */
export class SqliteExtractionCache implements ExtractionCache {
  readonly #path: string;
  #db: DatabaseSync;
  #get: StatementSync;
  #put: StatementSync;
  /** Set after the first failed statement: stop touching the db this run. */
  #disabled = false;
  /** The failure was file damage (not busy): drop cache.db on close. */
  #damaged = false;
  /** Hit/miss tallies for the CLI to report incremental savings. */
  hits = 0;
  misses = 0;

  constructor(dbPath: string, opts: SqliteExtractionCacheOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#path = dbPath;
    const timeout = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    const keyVersion = opts.keyVersion ?? EXTRACTION_CACHE_VERSION;
    let store: Store;
    try {
      store = openStore(dbPath, timeout, keyVersion);
    } catch (err) {
      // "file is not a database" / "malformed" at open: it is only a cache,
      // so rebuild it once. Anything else (busy past the timeout, no
      // node:sqlite) propagates and the caller runs cache-less.
      if (!isDamage(err)) throw err;
      removeStore(dbPath);
      store = openStore(dbPath, timeout, keyVersion);
    }
    this.#db = store.db;
    this.#get = store.get;
    this.#put = store.put;
  }

  /** Record a failed statement: disable the store for the rest of the run. */
  #fail(err: unknown): void {
    this.#disabled = true;
    if (isDamage(err)) this.#damaged = true;
  }

  get(key: string): FileExtraction | undefined {
    let row: ValRow | undefined;
    try {
      row = this.#disabled ? undefined : (this.#get.get(key) as ValRow | undefined);
    } catch (err) {
      this.#fail(err);
      row = undefined;
    }
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
    if (this.#disabled) return;
    try {
      this.#put.run(key, JSON.stringify(value));
    } catch (err) {
      this.#fail(err); // skip the store; the parse result is already in hand
    }
  }

  /** Drop every cached entry (the `--no-cache`/`--force` rebuild path). */
  clear(): void {
    if (this.#disabled) return;
    try {
      this.#db.exec('DELETE FROM extraction;');
    } catch (err) {
      this.#fail(err);
    }
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      /* already closed / unusable */
    }
    if (this.#damaged) removeStore(this.#path);
  }
}

/** Convenience: open the standard `<factsDir>/cache.db` store. */
export function openExtractionCache(factsDir: string): SqliteExtractionCache {
  return new SqliteExtractionCache(`${factsDir.replace(/[\\/]+$/, '')}/cache.db`);
}

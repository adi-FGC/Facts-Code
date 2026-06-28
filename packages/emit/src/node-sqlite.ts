/**
 * LAZILY-loaded, typed access to the `node:sqlite` built-in (Node 22.5+).
 *
 * Two problems this solves:
 *   1. Types: the workspace pins `@types/node@^20`, whose declarations predate
 *      `node:sqlite`, so we hand-write the subset of types the F8 cache uses.
 *   2. Old-Node safety: `node:sqlite` does not exist before Node 22.5. A STATIC
 *      `import … from 'node:sqlite'` is evaluated when the module graph loads —
 *      i.e. the instant anything imports `@factstack/emit` — so on Node 20/21 it
 *      throws ERR_UNKNOWN_BUILTIN_MODULE and crashes the whole `factstack`
 *      binary before its cache-less fallback can run. So we `require()` it
 *      lazily, on first cache construction, where callers wrap it in try/catch.
 */

import { createRequire } from 'node:module';

/** A prepared statement — subset used by the F8 cache. */
export interface StatementSync {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
}

/** A synchronous SQLite database handle — subset used by the F8 cache. */
export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

interface DatabaseSyncCtor {
  new (path: string, options?: { readOnly?: boolean; open?: boolean }): DatabaseSync;
}

let cachedCtor: DatabaseSyncCtor | null = null;

/**
 * Load the `node:sqlite` `DatabaseSync` constructor on demand. Throws on
 * Node < 22.5 (no such built-in) — callers must catch and degrade to a
 * cache-less run. Memoized after the first successful load.
 */
export function loadDatabaseSync(): DatabaseSyncCtor {
  if (cachedCtor) return cachedCtor;
  const require = createRequire(import.meta.url);
  const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
  cachedCtor = mod.DatabaseSync;
  return cachedCtor;
}

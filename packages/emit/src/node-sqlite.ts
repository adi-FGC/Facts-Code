/**
 * Typed re-export of the `node:sqlite` built-in (Node 22+).
 *
 * Why this exists: the workspace pins `@types/node@^20`, whose declarations
 * predate `node:sqlite`, so a direct `import … from 'node:sqlite'` fails to
 * type-check even though the Node 22+/25 runtime ships the module (F8 requires
 * Node 22+). This re-exports the runtime value under a hand-written type that
 * covers ONLY the surface the F8 cache uses — it changes nothing at runtime.
 *
 * Self-expiring: when the workspace adopts `@types/node@^22` (which ships the
 * real types), the import below resolves and the `@ts-expect-error` becomes an
 * *unused* directive — TS then errors, forcing deletion of this whole file
 * (import directly from `node:sqlite` instead).
 */

// @ts-expect-error — node:sqlite is absent from @types/node@20; present at runtime (Node 22+).
import { DatabaseSync as DatabaseSyncRuntime } from 'node:sqlite';

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

/** The `node:sqlite` `DatabaseSync` constructor, typed to the subset above. */
export const DatabaseSync = DatabaseSyncRuntime as unknown as DatabaseSyncCtor;

/**
 * F8 — SqliteExtractionCache (node:sqlite store) tests. Covers the round-trip,
 * hit/miss tallies, corrupt-row resilience (must miss, never throw), the
 * version-guard nuke-on-mismatch, the stale-key-version purge (bytes really
 * erased), and persistence across reopen. Uses a temp db file. Needs the
 * node:sqlite built-in (Node >= 22.5; the CLI's Node floor is 24.3): without it the
 * suite fails at load rather than skipping, so the cache is never silently
 * left untested.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { SqliteExtractionCache, openExtractionCache } from '../src/extraction-cache-sqlite.js';
import { loadDatabaseSync } from '../src/node-sqlite.js';
import type { FileExtraction } from '@factstack/core';

// @types/node@20 has no `node:sqlite` declarations, so take the raw handle
// through the same typed loader the cache uses (same built-in, typed subset).
const DatabaseSync = loadDatabaseSync();

const QUAD: FileExtraction = {
  imports: [{ specifier: './x', kind: 'import', line: 1, names: [] } as never],
  symbols: [{ name: 'foo', kind: 'function', startLine: 2, endLine: 4, exported: true } as never],
  refs: [],
  envReads: [{ name: 'API_KEY', line: 3 } as never],
};

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'facts-cache-'));
  dirs.push(d);
  return join(d, 'cache.db');
}
/** Every byte of cache.db and its WAL, for "is this string still on disk?". */
const onDisk = (db: string): string =>
  ['', '-wal']
    .filter((s) => existsSync(db + s))
    .map((s) => readFileSync(db + s).toString('latin1'))
    .join('');
const storedKeys = (db: string): string[] => {
  const check = new DatabaseSync(db);
  const rows = check.prepare('SELECT key FROM extraction').all() as Array<{ key: string }>;
  check.close();
  return rows.map((r) => r.key).sort();
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SqliteExtractionCache', () => {
  it('round-trips a quad and counts a miss then a hit', () => {
    const c = new SqliteExtractionCache(tmpDb());
    expect(c.get('k1')).toBeUndefined();
    expect(c.misses).toBe(1);
    c.set('k1', QUAD);
    expect(c.get('k1')).toEqual(QUAD);
    expect(c.hits).toBe(1);
    c.close();
  });

  it('persists across reopen (durable cache.db)', () => {
    const db = tmpDb();
    const a = new SqliteExtractionCache(db);
    a.set('persist', QUAD);
    a.close();
    const b = new SqliteExtractionCache(db);
    expect(b.get('persist')).toEqual(QUAD);
    b.close();
  });

  it('creates the parent .facts dir if missing (openExtractionCache)', () => {
    const d = mkdtempSync(join(tmpdir(), 'facts-cache-'));
    dirs.push(d);
    const c = openExtractionCache(join(d, '.facts'));
    c.set('k', QUAD);
    expect(c.get('k')).toEqual(QUAD);
    c.close();
  });

  it('misses (never throws) on a corrupt stored row', () => {
    const db = tmpDb();
    const c = new SqliteExtractionCache(db);
    c.close();
    // Hand-corrupt the value via a raw connection.
    const raw = new DatabaseSync(db);
    raw
      .prepare('INSERT OR REPLACE INTO extraction (key, val) VALUES (?, ?)')
      .run('bad', '{not valid json');
    raw.close();
    const c2 = new SqliteExtractionCache(db);
    expect(() => c2.get('bad')).not.toThrow();
    expect(c2.get('bad')).toBeUndefined();
    c2.close();
  });

  it('clear() drops all entries', () => {
    const c = new SqliteExtractionCache(tmpDb());
    c.set('a', QUAD);
    c.set('b', QUAD);
    c.clear();
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeUndefined();
    c.close();
  });

  it('waits for a concurrent writer instead of throwing "database is locked"', async () => {
    const db = tmpDb();
    new SqliteExtractionCache(db).close(); // create the tables + WAL mode
    // Another process (a worker here) holds the write lock for ~300 ms —
    // what an overlapping analyze (hook, watch, MCP) does on every put.
    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite');
       const { parentPort, workerData } = require('node:worker_threads');
       const raw = new DatabaseSync(workerData);
       raw.exec('BEGIN IMMEDIATE');
       parentPort.postMessage('locked');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
       raw.exec('COMMIT');
       raw.close();`,
      { eval: true, workerData: db },
    );
    await new Promise((r) => holder.once('message', r));
    const c = new SqliteExtractionCache(db);
    expect(() => c.set('k', QUAD)).not.toThrow();
    expect(c.get('k')).toEqual(QUAD); // the write waited and landed
    c.close();
    await new Promise((r) => holder.once('exit', r));
  });

  it('degrades to cache-less (never throws) when the lock outlives the busy timeout', () => {
    const db = tmpDb();
    new SqliteExtractionCache(db).close();
    const raw = new DatabaseSync(db);
    raw.exec('BEGIN IMMEDIATE'); // never released while the cache runs
    const c = new SqliteExtractionCache(db, { busyTimeoutMs: 20 });
    expect(() => c.set('k', QUAD)).not.toThrow();
    expect(() => c.get('k')).not.toThrow();
    expect(c.get('k')).toBeUndefined();
    c.close();
    raw.exec('ROLLBACK');
    raw.close();
    expect(existsSync(db)).toBe(true); // busy is not damage: the file is kept
  });

  it('survives a damaged cache.db: misses, never throws, and the next run rebuilds it', () => {
    const db = tmpDb();
    const a = new SqliteExtractionCache(db);
    for (let i = 0; i < 300; i++) a.set(`k${i}`, QUAD);
    a.close();
    // Page-level damage past the schema/meta pages: the ctor still opens it,
    // but every read of the extraction b-tree hits "malformed".
    const bytes = readFileSync(db);
    bytes.fill(0xa5, 3 * 4096);
    writeFileSync(db, bytes);

    const b = new SqliteExtractionCache(db);
    expect(() => b.get('k1')).not.toThrow();
    expect(b.get('k1')).toBeUndefined();
    expect(() => b.set('fresh', QUAD)).not.toThrow();
    b.close(); // drops the damaged file so the next run starts clean

    const c = new SqliteExtractionCache(db);
    c.set('k', QUAD);
    expect(c.get('k')).toEqual(QUAD);
    c.close();
  });

  it('rebuilds a cache.db that is not a database at all', () => {
    const db = tmpDb();
    writeFileSync(db, 'this is not sqlite '.repeat(400));
    const c = new SqliteExtractionCache(db);
    c.set('k', QUAD);
    expect(c.get('k')).toEqual(QUAD);
    c.close();
  });

  it('nukes the table on a db-schema-version mismatch', () => {
    const db = tmpDb();
    const a = new SqliteExtractionCache(db);
    a.set('old', QUAD);
    a.close();
    // Simulate an older binary's version stamp.
    const raw = new DatabaseSync(db);
    raw.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('dbSchemaVersion', '0');
    raw.close();
    const b = new SqliteExtractionCache(db); // ctor sees mismatch -> wipes
    expect(b.get('old')).toBeUndefined();
    b.close();
  });

  it('purges rows keyed by an OLDER extractor version on open, keeps current and newer ones', () => {
    const db = tmpDb();
    const a = new SqliteExtractionCache(db, { keyVersion: 3 });
    a.set('v3:.ts:r0:cur', QUAD);
    a.close();
    // An older binary's rows (it never wrote a keyVersion stamp), plus the
    // prefix edge cases: v30 and v4 are NEWER versions (numeric, not text,
    // order), and a key without a `v<N>:` prefix is never served.
    const raw = new DatabaseSync(db);
    const put = raw.prepare('INSERT OR REPLACE INTO extraction (key, val) VALUES (?, ?)');
    for (const k of ['v2:.ts:r0:old', 'v1:x', 'v30:x', 'v4:x', 'bare', 'v:x', 'v2x:x']) {
      put.run(k, '{}');
    }
    raw.prepare('DELETE FROM meta WHERE k = ?').run('keyVersion');
    raw.close();

    const b = new SqliteExtractionCache(db, { keyVersion: 3 });
    expect(b.get('v3:.ts:r0:cur')).toEqual(QUAD);
    b.close();
    expect(storedKeys(db)).toEqual(['v30:x', 'v3:.ts:r0:cur', 'v4:x']);
  });

  it("never purges a NEWER version's rows: two binaries sharing cache.db keep their hits (EMIT-ADV-3)", () => {
    /* `npx factstack` (hook, CLI) and `npx -y factstack-mcp` can be one
       release apart and both use .facts/cache.db. Purging every foreign
       prefix made each open wipe the other's rows — a full re-parse per run. */
    const db = tmpDb();
    const v3 = new SqliteExtractionCache(db, { keyVersion: 3 });
    v3.set('v3:.ts:r0:a', QUAD);
    v3.close();
    const v4 = new SqliteExtractionCache(db, { keyVersion: 4 }); // newer: retires v3
    v4.set('v4:.ts:r0:a', QUAD);
    v4.close();
    expect(storedKeys(db)).toEqual(['v4:.ts:r0:a']);

    const older = new SqliteExtractionCache(db, { keyVersion: 3 });
    older.set('v3:.ts:r0:a', QUAD);
    older.close();
    const newer = new SqliteExtractionCache(db, { keyVersion: 4 });
    expect(newer.get('v4:.ts:r0:a')).toEqual(QUAD); // survived the older binary's open
    newer.close();
    const older2 = new SqliteExtractionCache(db, { keyVersion: 3 });
    expect(older2.get('v3:.ts:r0:a')).toEqual(QUAD); // ...and the older one keeps its hits too
    older2.close();

    new SqliteExtractionCache(db, { keyVersion: 5 }).close(); // a newer release retires both
    expect(storedKeys(db)).toEqual([]);
  });

  it('erases rows an OLDER binary already freed or replaced before the upgrade (EMIT-ADV-2)', () => {
    /* A pre-v2 binary never set secure_delete, so its clear() (--no-cache /
       --force) and INSERT OR REPLACE left old rows in free pages, where no
       DELETE reaches them — and with the table already empty the wipe had
       nothing to delete. The one-time v2 migration must rewrite the file. */
    const SECRET = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC-not-a-real-key-a2e9';
    const leaky = JSON.stringify({
      envReads: [{ name: 'KEY', defaultValue: SECRET }],
      pad: 'x'.repeat(300),
    });
    for (const mode of ['clear', 'replace'] as const) {
      const db = tmpDb();
      const raw = new DatabaseSync(db); // the old binary: WAL, no secure_delete
      raw.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = OFF;');
      raw.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
      raw.exec('CREATE TABLE extraction (key TEXT PRIMARY KEY, val TEXT NOT NULL);');
      raw.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('dbSchemaVersion', '1');
      const put = raw.prepare('INSERT OR REPLACE INTO extraction (key, val) VALUES (?, ?)');
      for (let i = 0; i < 40; i++) put.run(`v2:.env:r0:${i}`, leaky);
      if (mode === 'clear') raw.exec('DELETE FROM extraction;');
      else for (let i = 0; i < 40; i++) put.run(`v2:.env:r0:${i}`, '{"envReads":[]}');
      raw.close();
      expect(onDisk(db)).toContain(SECRET); // sanity: only free pages hold it now

      const c = new SqliteExtractionCache(db, { keyVersion: 3 });
      c.set('v3:.ts:r0:fresh', QUAD);
      expect(c.get('v3:.ts:r0:fresh')).toEqual(QUAD); // still a working cache
      c.close();
      expect(onDisk(db), mode).not.toContain(SECRET);
    }
  });

  it('leaves no trace of a purged row in cache.db or its WAL (security#6)', () => {
    /* Rows written before redaction reached the cache can hold a private-key
       body in envReads[].defaultValue. A plain DELETE leaves those bytes in
       free pages; the purge must actually erase them. Both purge paths: an
       older key version, and the pre-v2 db-schema wipe. */
    const SECRET = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC-not-a-real-key-7f3a';
    const stale: Array<[string, string]> = [
      ['keyVersion', 'DELETE'],
      ['dbSchemaVersion', '1'],
    ];
    for (const [k, v] of stale) {
      const db = tmpDb();
      new SqliteExtractionCache(db, { keyVersion: 3 }).close();
      const raw = new DatabaseSync(db);
      const val = JSON.stringify({ envReads: [{ name: 'KEY', defaultValue: SECRET }] });
      raw.prepare('INSERT INTO extraction (key, val) VALUES (?, ?)').run('v2:.env:r0:x', val);
      if (v === 'DELETE') raw.prepare('DELETE FROM meta WHERE k = ?').run(k);
      else raw.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, v);
      raw.close();
      expect(onDisk(db)).toContain(SECRET); // sanity: the stale row really is on disk

      const c = new SqliteExtractionCache(db, { keyVersion: 3 });
      expect(c.get('v2:.env:r0:x')).toBeUndefined();
      c.close();
      expect(onDisk(db)).not.toContain(SECRET);
    }
  });
});

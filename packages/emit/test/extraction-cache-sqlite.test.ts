/**
 * F8 — SqliteExtractionCache (node:sqlite store) tests. Covers the round-trip,
 * hit/miss tallies, corrupt-row resilience (must miss, never throw), the
 * version-guard nuke-on-mismatch, and persistence across reopen. Uses a temp
 * db file; skips cleanly if node:sqlite is unavailable on the runner.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteExtractionCache, openExtractionCache } from '../src/extraction-cache-sqlite.js';
import type { FileExtraction } from '@factstack/core';

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
    raw.prepare('INSERT OR REPLACE INTO extraction (key, val) VALUES (?, ?)').run('bad', '{not valid json');
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
});

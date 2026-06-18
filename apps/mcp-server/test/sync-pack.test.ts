/**
 * Tests for `resolveSyncPack` — the F8 consumer's current/diff/full decision.
 *
 * Builds real master + diff packs via the factspack primitives (same idiom as
 * factspack/test/chain.test.ts) and asserts the smallest-correct response for
 * each caller state, plus the round-trip that proves the returned diff actually
 * reconstructs the current master.
 */
import { describe, expect, it } from 'vitest';
import { applyChain, computeDiff, decode, encode, encodeIncremental, type PackHeader, type PackRow } from '@factstack/factspack';
import { resolveSyncPack } from '../src/sync-pack.js';

const HEADER: PackHeader = {
  producer: 'factstack/test',
  schema: 'agent-v4',
  snapshotId: 's',
  rowCount: null,
  seq: 1,
  parent: '-',
  kind: 'master',
  generated: 'g',
};

function master(rows: PackRow[]): string {
  return encode({ header: HEADER, tables: [{ name: 'files', columns: [{ name: 'path' }, { name: 'loc' }], rows }] });
}

const m1 = master([['a.ts', '1'], ['b.ts', '2']]);
const sha1 = decode(m1).trailer!.sha256;
const m2 = master([['a.ts', '1'], ['b.ts', '9'], ['c.ts', '3']]); // b changed, c added
const sha2 = decode(m2).trailer!.sha256;
const diff = encodeIncremental({
  header: { ...HEADER, snapshotId: 's2', rowCount: 0, seq: 2, parent: sha1, kind: 'diff' },
  tables: computeDiff(decode(m1), decode(m2)),
});

describe('resolveSyncPack — current / diff / full decision', () => {
  it('status=current when the caller already holds the current master', () => {
    const r = resolveSyncPack(m2, diff, sha2);
    expect(r.status).toBe('current');
    expect(r.sha).toBe(sha2);
    expect(r.pack).toBeUndefined();
  });

  it('status=diff when the caller holds the diff parent (one step behind)', () => {
    const r = resolveSyncPack(m2, diff, sha1);
    expect(r.status).toBe('diff');
    expect(r.sha).toBe(sha2);
    expect(r.pack).toBe(diff);
  });

  it('status=full on first fetch (no have)', () => {
    const r = resolveSyncPack(m2, diff, undefined);
    expect(r.status).toBe('full');
    expect(r.sha).toBe(sha2);
    expect(r.pack).toBe(m2);
  });

  it('status=full when have is an unknown / stale sha', () => {
    const r = resolveSyncPack(m2, diff, 'deadbeefcafe');
    expect(r.status).toBe('full');
    expect(r.pack).toBe(m2);
  });

  it('status=full when no diff sidecar exists (cold producer)', () => {
    const r = resolveSyncPack(m2, undefined, sha1);
    expect(r.status).toBe('full');
    expect(r.pack).toBe(m2);
  });

  it('falls through to full when the diff does not bridge the held master', () => {
    const otherParentDiff = encodeIncremental({
      header: { ...HEADER, snapshotId: 's2', rowCount: 0, seq: 2, parent: 'ffffffffffff', kind: 'diff' },
      tables: computeDiff(decode(m1), decode(m2)),
    });
    const r = resolveSyncPack(m2, otherParentDiff, sha1);
    expect(r.status).toBe('full');
  });

  it('falls through to full when the diff body is corrupt/unreadable', () => {
    // A bad diff sidecar must degrade gracefully to the full master, never error.
    const r = resolveSyncPack(m2, 'this is not a valid pack', sha1);
    expect(r.status).toBe('full');
    expect(r.pack).toBe(m2);
  });

  it('status=error on an unreadable master', () => {
    const r = resolveSyncPack('not a pack at all', diff, sha1);
    expect(r.status).toBe('error');
    expect(r.pack).toBeUndefined();
    expect(r.sha).toBeUndefined();
  });

  it('round-trip: applying the returned diff onto the held master reproduces the current master', () => {
    const r = resolveSyncPack(m2, diff, sha1);
    expect(r.status).toBe('diff');
    const rebuilt = applyChain(decode(m1), [decode(r.pack!)]);
    const fresh = decode(m2);
    const asSet = (rows: readonly PackRow[]) => rows.map((x) => JSON.stringify(x)).sort();
    expect(asSet(rebuilt.get('files')!.rows)).toEqual(asSet(fresh.tables.get('files')!.rows));
  });
});

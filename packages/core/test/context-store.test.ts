import { describe, expect, it } from 'vitest';
import {
  buildContextStore,
  recentSessionEntities,
  resolveCloseTarget,
  lastServedEntities,
  contextRecordEvent,
  sessionActionEvent,
} from '../src/learnings.js';

/**
 * F9 — durable context store + session-recency reader. Events are built via the
 * convention helpers with explicit timestamps (purity: no clock in tests).
 */

const ts = (n: number) => `2026-06-09T00:0${n}:00.000Z`; // n in 0..9

describe('buildContextStore (F9)', () => {
  it('buckets decisions/facts, open tasks, and open questions (most-recent-first)', () => {
    const events = [
      contextRecordEvent({ kind: 'decision', text: 'use zod for schemas', timestamp: ts(1) }),
      contextRecordEvent({ kind: 'fact', text: 'core is pure', timestamp: ts(2) }),
      contextRecordEvent({ kind: 'task', text: 'add F9 tests', timestamp: ts(3) }),
      contextRecordEvent({ kind: 'question', text: 'cap working ctx?', timestamp: ts(4) }),
    ];
    const s = buildContextStore(events);
    expect(s.decisions.map((d) => d.text)).toEqual(['core is pure', 'use zod for schemas']);
    expect(s.tasks.map((t) => t.text)).toEqual(['add F9 tests']);
    expect(s.openQuestions.map((q) => q.text)).toEqual(['cap working ctx?']);
  });

  it('most-recent-wins per key — a later event supersedes the earlier', () => {
    const events = [
      contextRecordEvent({ kind: 'decision', key: 'db', text: 'use sqlite', timestamp: ts(1) }),
      contextRecordEvent({ kind: 'decision', key: 'db', text: 'use postgres', timestamp: ts(5) }),
    ];
    const s = buildContextStore(events);
    expect(s.decisions).toHaveLength(1);
    expect(s.decisions[0]!.text).toBe('use postgres');
  });

  it('a task closed by a later event drops off the open list', () => {
    const events = [
      contextRecordEvent({ kind: 'task', key: 't1', text: 'ship F9', timestamp: ts(1) }),
      contextRecordEvent({ kind: 'task', key: 't1', text: 'ship F9', status: 'accepted', timestamp: ts(5) }),
    ];
    expect(buildContextStore(events).tasks).toHaveLength(0);
  });

  it('ignores non-context (session / proposal) events', () => {
    const events = [sessionActionEvent({ action: 'read', entities: ['a.ts'], timestamp: ts(1) })];
    expect(buildContextStore(events)).toEqual({ decisions: [], tasks: [], openQuestions: [] });
  });

  it('is deterministic', () => {
    const events = [
      contextRecordEvent({ kind: 'task', text: 'x', timestamp: ts(1) }),
      contextRecordEvent({ kind: 'decision', text: 'y', timestamp: ts(2) }),
    ];
    expect(JSON.stringify(buildContextStore(events))).toBe(JSON.stringify(buildContextStore(events)));
  });
});

describe('recentSessionEntities (F9)', () => {
  it('returns entities most-recent-first, deduped across events', () => {
    const events = [
      sessionActionEvent({ action: 'read', entities: ['a.ts', 'b.ts'], timestamp: ts(1) }),
      sessionActionEvent({ action: 'edited', entities: ['c.ts', 'a.ts'], timestamp: ts(3) }),
    ];
    // newest (ts3): c.ts, a.ts; then ts1 adds b.ts (a.ts already seen).
    expect(recentSessionEntities(events)).toEqual(['c.ts', 'a.ts', 'b.ts']);
  });

  it('respects the cap', () => {
    const events = [sessionActionEvent({ action: 'served', entities: ['a', 'b', 'c', 'd'], timestamp: ts(1) })];
    expect(recentSessionEntities(events, 2)).toEqual(['a', 'b']);
  });

  it('ignores non-session events', () => {
    const events = [contextRecordEvent({ kind: 'decision', text: 'd', entities: ['x.ts'], timestamp: ts(1) })];
    expect(recentSessionEntities(events)).toEqual([]);
  });
});

/**
 * resolveCloseTarget — the `remember --done` close-key resolution. Regression
 * guard for the review finding: closing a task created WITH a --key by re-typing
 * only its text must adopt that record's key (else the keyed task silently stays
 * open while the CLI claims "closed").
 */
describe('resolveCloseTarget (F9)', () => {
  const store = buildContextStore([
    contextRecordEvent({ kind: 'task', key: 'mykey', text: 'do the thing', timestamp: ts(1) }),
    contextRecordEvent({ kind: 'question', text: 'why pure?', timestamp: ts(2) }),
  ]);

  it('matches an open task by explicit key', () => {
    expect(resolveCloseTarget(store, 'task', 'mykey', 'whatever')).toEqual({ key: 'mykey', matched: true });
  });

  it('adopts the keyed record\'s key when only the text matches — close actually closes', () => {
    const target = resolveCloseTarget(store, 'task', undefined, 'do the thing');
    expect(target).toEqual({ key: 'mykey', matched: true });
    // End-to-end: a close event with the adopted key empties the open list.
    const after = buildContextStore([
      contextRecordEvent({ kind: 'task', key: 'mykey', text: 'do the thing', timestamp: ts(1) }),
      contextRecordEvent({ kind: 'task', key: target.key!, text: 'do the thing', status: 'accepted', timestamp: ts(5) }),
    ]);
    expect(after.tasks).toHaveLength(0);
  });

  it('matches an unkeyed question by its text-as-key', () => {
    expect(resolveCloseTarget(store, 'question', undefined, 'why pure?').matched).toBe(true);
  });

  it('reports matched:false when nothing open matches (caller warns, not lies)', () => {
    expect(resolveCloseTarget(store, 'task', undefined, 'unknown text').matched).toBe(false);
  });

  it('decision/fact have no open state to close', () => {
    expect(resolveCloseTarget(store, 'decision', undefined, 'do the thing').matched).toBe(false);
  });
});

/**
 * lastServedEntities — consecutive-dedup source for `served` logging (review
 * finding: identical repeated serves must not grow the log one line per call).
 */
describe('lastServedEntities (F9)', () => {
  it('returns the MOST RECENT served event\'s entities', () => {
    const events = [
      sessionActionEvent({ action: 'served', entities: ['a.ts'], timestamp: ts(1) }),
      sessionActionEvent({ action: 'served', entities: ['b.ts', 'c.ts'], timestamp: ts(3) }),
      sessionActionEvent({ action: 'read', entities: ['z.ts'], timestamp: ts(4) }), // not served
    ];
    expect(lastServedEntities(events)).toEqual(['b.ts', 'c.ts']);
  });

  it('is empty when no served event exists', () => {
    expect(lastServedEntities([sessionActionEvent({ action: 'read', entities: ['a.ts'], timestamp: ts(1) })])).toEqual([]);
  });
});

/**
 * Tests for v0.3.4 — postmortem learnings log.
 *
 * Coverage:
 *   - schema validation: required fields, max-length caps, enum values
 *   - JSONL round-trip: format → parse yields equal events
 *   - parseLearningsJsonl: tolerates blank lines, reports malformed lines
 *   - queryLearnings: every filter (since, until, agent, outcome, action,
 *     tag), descending sort, limit cap
 *   - selfCalibrateEvent / proposalEvent: shape matches schema
 */

import { describe, expect, it } from 'vitest';
import {
  formatLearningEvent,
  parseLearningsJsonl,
  queryLearnings,
  selfCalibrateEvent,
  proposalEvent,
  LEARNINGS_SCHEMA_VERSION,
  LearningEventSchema,
  type LearningEvent,
} from '../src/learnings.js';

const T = (iso: string): string => new Date(iso).toISOString();

describe('LearningEventSchema validation', () => {
  it('accepts a fully-formed event', () => {
    const e = {
      schemaVersion: LEARNINGS_SCHEMA_VERSION,
      timestamp: T('2026-05-02T10:00:00Z'),
      agent: 'claude-opus-4',
      action: 'fix-typo',
      outcome: 'accepted' as const,
      reasoning: 'Typo in README',
      confidence: 0.92,
      tags: ['docs'],
    };
    expect(() => LearningEventSchema.parse(e)).not.toThrow();
  });

  it('rejects an event missing required fields', () => {
    expect(() =>
      LearningEventSchema.parse({
        schemaVersion: LEARNINGS_SCHEMA_VERSION,
        timestamp: T('2026-05-02T10:00:00Z'),
        // agent missing
        action: 'fix',
        outcome: 'accepted',
      } as unknown),
    ).toThrow();
  });

  it('rejects an event with an unknown outcome', () => {
    expect(() =>
      LearningEventSchema.parse({
        schemaVersion: LEARNINGS_SCHEMA_VERSION,
        timestamp: T('2026-05-02T10:00:00Z'),
        agent: 'x',
        action: 'y',
        outcome: 'not-a-real-outcome',
      } as unknown),
    ).toThrow();
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(() =>
      LearningEventSchema.parse({
        schemaVersion: LEARNINGS_SCHEMA_VERSION,
        timestamp: T('2026-05-02T10:00:00Z'),
        agent: 'x',
        action: 'y',
        outcome: 'pending',
        confidence: 1.5,
      } as unknown),
    ).toThrow();
  });

  it('rejects an action longer than 64 chars', () => {
    expect(() =>
      LearningEventSchema.parse({
        schemaVersion: LEARNINGS_SCHEMA_VERSION,
        timestamp: T('2026-05-02T10:00:00Z'),
        agent: 'x',
        action: 'a'.repeat(65),
        outcome: 'pending',
      } as unknown),
    ).toThrow();
  });

  it('rejects reasoning longer than 500 chars', () => {
    expect(() =>
      LearningEventSchema.parse({
        schemaVersion: LEARNINGS_SCHEMA_VERSION,
        timestamp: T('2026-05-02T10:00:00Z'),
        agent: 'x',
        action: 'y',
        outcome: 'pending',
        reasoning: 'a'.repeat(501),
      } as unknown),
    ).toThrow();
  });
});

describe('formatLearningEvent / parseLearningsJsonl round-trip', () => {
  it('round-trips a simple event without loss', () => {
    const e = proposalEvent({
      agent: 'claude',
      action: 'add-test',
      outcome: 'accepted',
      timestamp: T('2026-05-02T10:00:00Z'),
    });
    const line = formatLearningEvent(e);
    expect(line.endsWith('\n')).toBe(true);
    const { events, errors } = parseLearningsJsonl(line);
    expect(errors).toEqual([]);
    expect(events).toEqual([e]);
  });

  it('round-trips three events as a JSONL batch', () => {
    const events = [
      proposalEvent({ agent: 'claude', action: 'a1', outcome: 'pending', timestamp: T('2026-05-01T10:00:00Z') }),
      proposalEvent({ agent: 'gpt', action: 'a2', outcome: 'rejected', timestamp: T('2026-05-01T11:00:00Z') }),
      selfCalibrateEvent({ fileCount: 168, totalLoc: 30000, totalTokens: 55000, riskCount: 2, durationMs: 1200, timestamp: T('2026-05-01T12:00:00Z') }),
    ];
    const text = events.map(formatLearningEvent).join('');
    const { events: parsed, errors } = parseLearningsJsonl(text);
    expect(errors).toEqual([]);
    expect(parsed).toEqual(events);
  });

  it('skips blank lines without erroring', () => {
    const e = proposalEvent({ agent: 'x', action: 'y', outcome: 'accepted', timestamp: T('2026-05-01T10:00:00Z') });
    const text = '\n\n' + formatLearningEvent(e) + '\n\n';
    const { events, errors } = parseLearningsJsonl(text);
    expect(errors).toEqual([]);
    expect(events).toEqual([e]);
  });

  it('reports invalid JSON lines via errors[]', () => {
    const e = proposalEvent({ agent: 'x', action: 'y', outcome: 'accepted', timestamp: T('2026-05-01T10:00:00Z') });
    const text = 'this is not json\n' + formatLearningEvent(e);
    const { events, errors } = parseLearningsJsonl(text);
    expect(errors.length).toBe(1);
    expect(errors[0]?.reason).toBe('invalid JSON');
    expect(events).toEqual([e]);
  });

  it('reports schema-mismatched lines via errors[]', () => {
    const e = proposalEvent({ agent: 'x', action: 'y', outcome: 'accepted', timestamp: T('2026-05-01T10:00:00Z') });
    const badLine = JSON.stringify({ schemaVersion: 'wrong-version', timestamp: T('2026-05-01T10:00:00Z'), agent: 'x', action: 'y', outcome: 'accepted' }) + '\n';
    const text = badLine + formatLearningEvent(e);
    const { events, errors } = parseLearningsJsonl(text);
    expect(errors.length).toBe(1);
    expect(events).toEqual([e]);
  });
});

describe('queryLearnings filters', () => {
  const events = [
    proposalEvent({ agent: 'claude', action: 'fix', outcome: 'accepted', timestamp: T('2026-05-01T10:00:00Z'), tags: ['security'] }),
    proposalEvent({ agent: 'gpt', action: 'fix', outcome: 'rejected', timestamp: T('2026-05-01T11:00:00Z'), tags: ['perf'] }),
    proposalEvent({ agent: 'claude', action: 'refactor', outcome: 'pending', timestamp: T('2026-05-02T10:00:00Z'), tags: ['security', 'cleanup'] }),
    selfCalibrateEvent({ fileCount: 100, totalLoc: 1000, totalTokens: 5000, riskCount: 0, durationMs: 500, timestamp: T('2026-05-02T11:00:00Z') }),
  ];

  it('returns all events when no filter is given', () => {
    const out = queryLearnings(events);
    expect(out.length).toBe(4);
  });

  it('filters by agent', () => {
    const out = queryLearnings(events, { agent: 'claude' });
    expect(out.map((e) => e.agent)).toEqual(['claude', 'claude']);
  });

  it('filters by outcome', () => {
    const out = queryLearnings(events, { outcome: 'rejected' });
    expect(out.length).toBe(1);
    expect(out[0]?.agent).toBe('gpt');
  });

  it('filters by action', () => {
    const out = queryLearnings(events, { action: 'fix' });
    expect(out.length).toBe(2);
  });

  it('filters by tag', () => {
    const out = queryLearnings(events, { tag: 'security' });
    expect(out.length).toBe(2);
  });

  it('filters by since (inclusive)', () => {
    const out = queryLearnings(events, { since: T('2026-05-02T00:00:00Z') });
    expect(out.length).toBe(2);
  });

  it('filters by until (inclusive)', () => {
    const out = queryLearnings(events, { until: T('2026-05-01T11:00:00Z') });
    expect(out.length).toBe(2);
  });

  it('combines filters (since + agent)', () => {
    const out = queryLearnings(events, { since: T('2026-05-02T00:00:00Z'), agent: 'claude' });
    expect(out.length).toBe(1);
    expect(out[0]?.action).toBe('refactor');
  });

  it('returns most-recent-first by default', () => {
    const out = queryLearnings(events);
    const ts = out.map((e) => e.timestamp);
    expect(ts).toEqual([...ts].sort((a, b) => b.localeCompare(a)));
  });

  it('caps results at limit', () => {
    expect(queryLearnings(events, { limit: 2 }).length).toBe(2);
  });

  it('caps limit at 5000 to prevent runaway payloads', () => {
    expect(queryLearnings(events, { limit: 99999 }).length).toBe(4);
  });
});

describe('selfCalibrateEvent + proposalEvent builders', () => {
  it('selfCalibrateEvent builds a valid event', () => {
    const e = selfCalibrateEvent({
      fileCount: 10,
      totalLoc: 500,
      totalTokens: 2000,
      riskCount: 1,
      durationMs: 250,
    });
    expect(e.agent).toBe('factstack-self');
    expect(e.outcome).toBe('self-calibrate');
    expect(e.action).toBe('analyze');
    expect(e.meta?.fileCount).toBe(10);
  });

  it('proposalEvent builds a valid event', () => {
    const e = proposalEvent({
      agent: 'claude',
      action: 'add-test',
      outcome: 'accepted',
      confidence: 0.75,
      reasoning: 'Edge case missing',
    });
    expect(e.agent).toBe('claude');
    expect(e.outcome).toBe('accepted');
    expect(e.confidence).toBe(0.75);
  });

  it('proposalEvent rejects invalid inputs at validate time', () => {
    expect(() =>
      proposalEvent({
        agent: 'x',
        action: 'a'.repeat(100),  // too long
        outcome: 'accepted',
      } as Parameters<typeof proposalEvent>[0]),
    ).toThrow();
  });
});

describe('determinism', () => {
  it('produces stable output for the same input', () => {
    const ts = T('2026-05-02T10:00:00Z');
    const a = formatLearningEvent(proposalEvent({ agent: 'claude', action: 'x', outcome: 'pending', timestamp: ts }));
    const b = formatLearningEvent(proposalEvent({ agent: 'claude', action: 'x', outcome: 'pending', timestamp: ts }));
    expect(a).toBe(b);
  });
});

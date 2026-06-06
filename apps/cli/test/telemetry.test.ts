/**
 * Tests for local-first telemetry (ft-9).
 *
 * The privacy contract is the load-bearing part, so the remote-gating
 * tests assert (a) nothing is sent without an explicit opt-in, and (b) the
 * payload's exact key set — locking out any accidental path/name leak. All
 * tests run against a temp dir with injected clock/uuid/fetch, so there are
 * no homedir writes and no network.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetry, shouldSendRemote, type TelemetryState } from '../src/telemetry.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'facts-tel-'));
}
const state = (over: Partial<TelemetryState> = {}): TelemetryState => ({
  installId: 'x',
  optedIn: true,
  optedInAt: null,
  firstRunSeen: true,
  ...over,
});

describe('shouldSendRemote', () => {
  it('requires both an opt-in AND a url', () => {
    expect(shouldSendRemote(state(), 'https://t')).toBe(true);
    expect(shouldSendRemote(state({ optedIn: false }), 'https://t')).toBe(false);
    expect(shouldSendRemote(state(), null)).toBe(false);
    expect(shouldSendRemote(state(), '')).toBe(false);
  });
});

describe('createTelemetry — local metrics', () => {
  it('records events, durations, file counts, and error categories', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null, now: () => '2026-06-05T00:00:00.000Z', uuid: () => 'fixed-id' });
      await t.recordEvent('analyze.complete', { durationMs: 1200, fileCount: 389 });
      await t.recordEvent('analyze.complete', { durationMs: 800, fileCount: 390 });
      await t.recordEvent('cli.error', { errorCategory: 'parse' });
      const m = await t.loadMetrics();
      expect(m.events['analyze.complete']).toBe(2);
      expect(m.events['cli.error']).toBe(1);
      expect(m.durationsMs).toEqual([1200, 800]);
      expect(m.fileCounts).toEqual([389, 390]);
      expect(m.errors.parse).toBe(1);
      expect(m.firstSeenAt).toBe('2026-06-05T00:00:00.000Z');
      expect((await t.loadState()).installId).toBe('fixed-id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps duration/file-count samples at 100 (count stays uncapped)', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null });
      for (let i = 0; i < 130; i++) await t.recordEvent('analyze.complete', { durationMs: i, fileCount: i });
      const m = await t.loadMetrics();
      expect(m.durationsMs).toHaveLength(100);
      expect(m.fileCounts).toHaveLength(100);
      expect(m.durationsMs[0]).toBe(30); // oldest 30 shifted out
      expect(m.events['analyze.complete']).toBe(130);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates a stable installId across calls', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null });
      await t.recordEvent('a');
      const id1 = (await t.loadState()).installId;
      await t.recordEvent('b');
      const id2 = (await t.loadState()).installId;
      expect(id1).toBeTruthy();
      expect(id2).toBe(id1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createTelemetry — remote gating', () => {
  it('does NOT send remote without opt-in, even with a url', async () => {
    const dir = tempDir();
    try {
      const calls: unknown[] = [];
      const t = createTelemetry({
        dir,
        remoteUrl: 'https://collector.test',
        fetch: async (u, i) => { calls.push({ u, i }); return undefined; },
      });
      await t.recordEvent('analyze.complete', { durationMs: 1, fileCount: 1 });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a numbers-only payload when opted in AND a url is set', async () => {
    const dir = tempDir();
    try {
      const bodies: string[] = [];
      const t = createTelemetry({
        dir,
        remoteUrl: 'https://collector.test',
        fetch: async (_u, i) => { bodies.push(i.body); return undefined; },
        uuid: () => 'id-1',
      });
      await t.setOptedIn(true);
      await t.recordEvent('analyze.complete', { durationMs: 1200, fileCount: 389, appVersion: '0.1.0' });
      expect(bodies).toHaveLength(1);
      const payload = JSON.parse(bodies[0]!);
      // Exact key set — any extra key would be a privacy leak.
      expect(Object.keys(payload).sort()).toEqual(
        ['appVersion', 'durationMs', 'event', 'fileCount', 'installId', 'ts'].sort(),
      );
      expect(payload).toMatchObject({ installId: 'id-1', event: 'analyze.complete', durationMs: 1200, fileCount: 389 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opt-out stops remote sends', async () => {
    const dir = tempDir();
    try {
      const calls: number[] = [];
      const t = createTelemetry({
        dir,
        remoteUrl: 'https://collector.test',
        fetch: async () => { calls.push(1); return undefined; },
      });
      await t.setOptedIn(true);
      await t.recordEvent('x', { durationMs: 1 });
      await t.setOptedIn(false);
      await t.recordEvent('y', { durationMs: 1 });
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createTelemetry — lifecycle', () => {
  it('reset deletes the local files', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null });
      await t.recordEvent('a', { durationMs: 1 });
      expect(existsSync(join(dir, 'metrics.json'))).toBe(true);
      await t.reset();
      expect(existsSync(join(dir, 'metrics.json'))).toBe(false);
      expect(existsSync(join(dir, 'state.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recordEvent never throws on an empty name', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null });
      await expect(t.recordEvent('')).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

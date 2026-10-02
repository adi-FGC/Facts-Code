/**
 * Tests for local-first telemetry (ft-9).
 *
 * The privacy contract is the load-bearing part, so the remote-gating
 * tests assert (a) nothing is sent without an explicit opt-in, and (b) the
 * payload's exact key set — locking out any accidental path/name leak. All
 * tests run against a temp dir with injected clock/uuid/fetch, so there are
 * no homedir writes and no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createTelemetry,
  isLockContention,
  rootIdOf,
  shouldSendRemote,
  type TelemetryState,
} from '../src/telemetry.js';

/* Lock fault injection (CLI-09): opening metrics.lock throws the queued
   error codes first, then behaves normally. Everything else is the real
   node:fs/promises, so every other test is unaffected. */
const lockFaults = vi.hoisted(() => ({ codes: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  type Open = typeof real.open;
  const open = async (
    file: Parameters<Open>[0],
    flags?: Parameters<Open>[1],
    mode?: Parameters<Open>[2],
  ): ReturnType<Open> => {
    const code = String(file).endsWith('metrics.lock') ? lockFaults.codes.shift() : undefined;
    if (code) throw Object.assign(new Error(`${code}: injected`), { code });
    return real.open(file, flags, mode);
  };
  return { ...real, open, default: { ...real, open } };
});
afterEach(() => {
  lockFaults.codes.length = 0;
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'facts-tel-'));
}
/* Dozens of sequential file-backed recordEvent calls. Well inside 5 s on a
   developer machine; not on a loaded Windows CI runner (real read-modify-
   write of metrics.json per event), so these get an explicit budget. */
const LOOP_TIMEOUT_MS = 30_000;
const state = (over: Partial<TelemetryState> = {}): TelemetryState => ({
  installId: 'x',
  optedIn: true,
  optedInAt: null,
  firstRunSeen: true,
  ...over,
});

/**
 * Attribution (2026-09-23). Added after an analyze against a frozen repo
 * could not be traced to a command or a project, because metrics held only
 * counters. The fix must buy diagnosability WITHOUT storing a path, so both
 * halves are pinned — the easy regression is someone "simplifying" rootIdOf
 * into storing the root itself.
 */
describe('rootIdOf', () => {
  it('is stable for the same directory however it is spelled', () => {
    expect(rootIdOf(process.cwd())).toBe(rootIdOf('.'));
    expect(rootIdOf('.')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('distinguishes different roots', () => {
    expect(rootIdOf(join(tmpdir(), 'alpha'))).not.toBe(rootIdOf(join(tmpdir(), 'beta')));
  });

  it('never returns anything path-shaped', () => {
    const secret = join(tmpdir(), 'very-private-client-project');
    const id = rootIdOf(secret)!;
    expect(id).not.toContain('very-private');
    expect(id).not.toContain('/');
    expect(secret).not.toContain(id);
  });

  it('treats Windows paths case-insensitively, POSIX paths case-sensitively', () => {
    const upper = join(tmpdir(), 'CaseProject');
    const lower = upper.toLowerCase();
    expect(rootIdOf(upper, 'win32')).toBe(rootIdOf(lower, 'win32'));
    expect(rootIdOf(upper, 'linux')).not.toBe(rootIdOf(lower, 'linux'));
  });

  it('is null for an empty or unusable root', () => {
    expect(rootIdOf('')).toBeNull();
    expect(rootIdOf('   ')).toBeNull();
  });
});

describe('the per-event ring', () => {
  it('records when, from which surface, and against which root id', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null, now: () => '2026-09-23T04:06:00.000Z' });
      await t.recordEvent('analyze.complete', {
        durationMs: 1200,
        fileCount: 42,
        surface: 'cli',
        root: '/projects/thing',
      });
      const r = (await t.loadMetrics()).recent[0]!;
      expect(r.at).toBe('2026-09-23T04:06:00.000Z');
      expect(r.event).toBe('analyze.complete');
      expect(r.surface).toBe('cli');
      expect(r.rootId).toBe(rootIdOf('/projects/thing'));
      expect(r.durationMs).toBe(1200);
      expect(r.fileCount).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores no raw path anywhere in the metrics file', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null });
      await t.recordEvent('analyze.complete', {
        surface: 'cli',
        root: '/clients/acme-secret-repo',
      });
      const raw = JSON.stringify(await t.loadMetrics());
      expect(raw).not.toContain('acme-secret-repo');
      expect(raw).not.toContain('/clients');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'stays bounded, keeping the NEWEST events rather than the oldest',
    async () => {
      const dir = tempDir();
      try {
        const t = createTelemetry({ dir, remoteUrl: null });
        for (let i = 0; i < 60; i++)
          await t.recordEvent('analyze.complete', { surface: 'cli', durationMs: i });
        const recent = (await t.loadMetrics()).recent;
        expect(recent).toHaveLength(50);
        expect(recent[0]!.durationMs).toBe(10); // the first 10 were evicted
        expect(recent.at(-1)!.durationMs).toBe(59); // the latest survives
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    LOOP_TIMEOUT_MS,
  );

  it('survives a metrics file written before the ring existed', async () => {
    const dir = tempDir();
    try {
      const t0 = createTelemetry({ dir, remoteUrl: null });
      await t0.recordEvent('analyze.complete', {});
      const p = join(dir, 'metrics.json');
      const old = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      delete old.recent; // simulate an upgrade from the pre-ring format
      writeFileSync(p, JSON.stringify(old));

      const t = createTelemetry({ dir, remoteUrl: null });
      // Readers get the promised array even before the first new event.
      expect((await t.loadMetrics()).recent).toEqual([]);
      await expect(t.recordEvent('analyze.complete', { surface: 'cli' })).resolves.toBeUndefined();
      expect((await t.loadMetrics()).recent).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
      const t = createTelemetry({
        dir,
        remoteUrl: null,
        now: () => '2026-06-05T00:00:00.000Z',
        uuid: () => 'fixed-id',
      });
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

  it(
    'caps duration/file-count samples at 100 (count stays uncapped)',
    async () => {
      const dir = tempDir();
      try {
        const t = createTelemetry({ dir, remoteUrl: null });
        for (let i = 0; i < 130; i++)
          await t.recordEvent('analyze.complete', { durationMs: i, fileCount: i });
        const m = await t.loadMetrics();
        expect(m.durationsMs).toHaveLength(100);
        expect(m.fileCounts).toHaveLength(100);
        expect(m.durationsMs[0]).toBe(30); // oldest 30 shifted out
        expect(m.events['analyze.complete']).toBe(130);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    LOOP_TIMEOUT_MS,
  );

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
        fetch: async (u, i) => {
          calls.push({ u, i });
          return undefined;
        },
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
        fetch: async (_u, i) => {
          bodies.push(i.body);
          return undefined;
        },
        uuid: () => 'id-1',
      });
      await t.setOptedIn(true);
      await t.recordEvent('analyze.complete', {
        durationMs: 1200,
        fileCount: 389,
        appVersion: '0.1.0',
        surface: 'cli',
        root: '/clients/acme-secret-repo', // supplied on purpose: must NOT go out
      });
      expect(bodies).toHaveLength(1);
      const payload = JSON.parse(bodies[0]!);
      // Exact key set — any extra key would be a privacy leak. `surface` is
      // allowed (it names a code path); `root`/`rootId` are not, because a
      // per-project id sent off-machine becomes a record of how many projects
      // someone has and when they touch each one.
      expect(Object.keys(payload).sort()).toEqual(
        ['appVersion', 'durationMs', 'event', 'fileCount', 'installId', 'surface', 'ts'].sort(),
      );
      expect(payload).toMatchObject({
        installId: 'id-1',
        event: 'analyze.complete',
        durationMs: 1200,
        fileCount: 389,
        surface: 'cli',
      });
      // Neither the path nor its hash may reach the wire.
      expect(bodies[0]).not.toContain('acme-secret-repo');
      expect(bodies[0]).not.toContain(rootIdOf('/clients/acme-secret-repo')!);
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
        fetch: async () => {
          calls.push(1);
          return undefined;
        },
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

/**
 * CLI-09: the freshness hook runs analyzes concurrently. Unlocked
 * read-modify-write lost most events, and a torn read "recovered" the file
 * to empty defaults — wiping the counters and the attribution ring.
 */
describe('createTelemetry — concurrent writers (CLI-09)', () => {
  /* Three rounds against one file: every round re-creates and deletes the
     lock 60 times under contention, so a Windows delete-pending EPERM that
     drops an event shows up as a short count (58/60 under full-suite load
     before withLock waited those out). */
  it(
    'keeps every event when many writers interleave',
    async () => {
      const dir = tempDir();
      try {
        const writers = Array.from({ length: 6 }, () => createTelemetry({ dir, remoteUrl: null }));
        for (let round = 1; round <= 3; round++) {
          await Promise.all(
            writers.map(async (t) => {
              for (let i = 0; i < 10; i++)
                await t.recordEvent('analyze.complete', { fileCount: i });
            }),
          );
          const m = await writers[0]!.loadMetrics();
          expect(m.events['analyze.complete'], `round ${round}`).toBe(60 * round);
          expect(m.recent).toHaveLength(50); // the ring is full, not wiped
          expect(existsSync(join(dir, 'metrics.lock'))).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    LOOP_TIMEOUT_MS * 2,
  );

  it('treats a delete-pending lock as contention on Windows only', () => {
    expect(isLockContention('EEXIST', 'linux')).toBe(true);
    expect(isLockContention('EEXIST', 'win32')).toBe(true);
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(isLockContention(code, 'win32'), code).toBe(true);
      expect(isLockContention(code, 'linux'), code).toBe(false);
      expect(isLockContention(code, 'darwin'), code).toBe(false);
    }
    expect(isLockContention('EROFS', 'win32')).toBe(false);
    expect(isLockContention('ENOSPC', 'win32')).toBe(false);
    expect(isLockContention(undefined, 'win32')).toBe(false);
  });

  it('waits out EPERM / EACCES / EBUSY on the lock (Windows) instead of dropping the event', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null, platform: 'win32' });
      lockFaults.codes.push('EPERM', 'EPERM', 'EACCES', 'EBUSY', 'EPERM');
      await t.recordEvent('analyze.complete', { durationMs: 7 });
      expect(lockFaults.codes).toEqual([]); // every injected failure was retried
      const m = await t.loadMetrics();
      expect(m.events['analyze.complete']).toBe(1);
      expect(m.durationsMs).toEqual([7]);
      expect(existsSync(join(dir, 'metrics.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the event at once on a POSIX permission error (no stall)', async () => {
    const dir = tempDir();
    try {
      const t = createTelemetry({ dir, remoteUrl: null, platform: 'linux' });
      lockFaults.codes.push('EACCES');
      const t0 = Date.now();
      await t.recordEvent('analyze.complete');
      expect(Date.now() - t0).toBeLessThan(1_000); // not the 2 s lock wait
      expect(existsSync(join(dir, 'metrics.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps every event across separate processes', () => {
    const dir = tempDir();
    try {
      const cliRoot = join(import.meta.dirname, '..');
      const tsx = join(cliRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const script = join(dir, 'writer.mts');
      const src = pathToFileURL(join(cliRoot, 'src', 'telemetry.ts')).href;
      writeFileSync(
        script,
        `import { createTelemetry } from ${JSON.stringify(src)};\n` +
          `const t = createTelemetry({ dir: ${JSON.stringify(dir)}, remoteUrl: null });\n` +
          `for (let i = 0; i < 15; i++) await t.recordEvent('hook', { durationMs: i });\n`,
      );
      const PROCS = 4;
      const code = [
        `const { spawn } = require('node:child_process');`,
        `let left = ${PROCS}, bad = 0;`,
        `for (let i = 0; i < ${PROCS}; i++) {`,
        `  const c = spawn(process.execPath, [${JSON.stringify(tsx)}, ${JSON.stringify(script)}], { stdio: 'inherit' });`,
        `  c.on('exit', (s) => { if (s !== 0) bad++; if (--left === 0) process.exit(bad); });`,
        `}`,
      ].join('\n');
      const r = spawnSync(process.execPath, ['-e', code], { stdio: 'inherit', timeout: 60_000 });
      expect(r.status).toBe(0);
      const m = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8'));
      expect(m.events.hook).toBe(PROCS * 15);
      expect(m.durationsMs).toHaveLength(PROCS * 15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('leaves an unreadable metrics file alone instead of resetting it', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'metrics.json'), '{"events": {"analyze": 241}, "recent": [');
      const t = createTelemetry({ dir, remoteUrl: null });
      await t.recordEvent('analyze', { durationMs: 1 });
      expect(readFileSync(join(dir, 'metrics.json'), 'utf8')).toBe(
        '{"events": {"analyze": 241}, "recent": [',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('breaks a stale lock left by a crashed process', async () => {
    const dir = tempDir();
    try {
      const lock = join(dir, 'metrics.lock');
      writeFileSync(lock, '');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const t = createTelemetry({ dir, remoteUrl: null });
      await t.recordEvent('a');
      expect((await t.loadMetrics()).events.a).toBe(1);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

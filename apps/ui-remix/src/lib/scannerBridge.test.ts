/**
 * scannerBridge — a dead scanner worker must settle every in-flight scan
 * (FSB-5).
 *
 * A worker that fails to load (a stale chunk after a redeploy is served
 * index.html), throws at top level, or runs out of memory fires `error` on
 * the Worker object and never posts an `error` message. The bridge used to
 * null its singleton and stop there, so the scan promise stayed pending and
 * the Open modal sat on "scanning" with no way out.
 *
 * `Worker` is faked; nothing is analyzed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GH_LOCKFILE_NAMES } from '@factstack/fs-browser';
import { LOCKFILE_NAMES } from '@factstack/scanners';

class FakeWorker extends EventTarget {
  static all: FakeWorker[] = [];
  terminated = false;
  posted: unknown[] = [];
  constructor() {
    super();
    FakeWorker.all.push(this);
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** Settles to 'pending' if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms = 200): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

type Bridge = typeof import('./scannerBridge.ts');
let bridge: Bridge;

beforeEach(async () => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.resetModules(); // fresh worker singleton per test
  bridge = await import('./scannerBridge.ts');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scannerBridge worker death (FSB-5)', () => {
  it('rejects the in-flight scan when the worker fires `error`', async () => {
    const scan = bridge.runGitHubScan({ owner: 'o', repo: 'r' });
    const worker = FakeWorker.all[0]!;
    expect(worker.posted).toHaveLength(1);
    worker.dispatchEvent(new Event('error'));
    await expect(within(scan)).rejects.toThrow(/scanner stopped unexpectedly/);
    expect(worker.terminated).toBe(true);
  });

  it('rejects every pending scan, and the next scan gets a fresh worker', async () => {
    const a = bridge.runGitHubScan({ owner: 'o', repo: 'a' });
    const b = bridge.runGitHubScan({ owner: 'o', repo: 'b' });
    FakeWorker.all[0]!.dispatchEvent(new Event('messageerror'));
    await expect(within(a)).rejects.toThrow(/reload the page/);
    await expect(within(b)).rejects.toThrow(/reload the page/);

    const c = bridge.runGitHubScan({ owner: 'o', repo: 'c' });
    expect(FakeWorker.all).toHaveLength(2);
    const fresh = FakeWorker.all[1]!;
    const req = fresh.posted[0] as { id: string };
    fresh.dispatchEvent(
      new MessageEvent('message', { data: { id: req.id, type: 'error', message: 'boom' } }),
    );
    await expect(within(c)).rejects.toThrow('boom');
  });

  it('does not reject a scan that already finished when the worker dies later', async () => {
    const scan = bridge.runGitHubScan({ owner: 'o', repo: 'r' });
    const worker = FakeWorker.all[0]!;
    const req = worker.posted[0] as { id: string };
    worker.dispatchEvent(
      new MessageEvent('message', { data: { id: req.id, type: 'error', message: 'first' } }),
    );
    await expect(scan).rejects.toThrow('first');
    worker.dispatchEvent(new Event('error')); // no pending scans: nothing to settle, no throw
    expect(worker.terminated).toBe(true);
  });
});

/* The worker's GitHub fetch (fs-browser) must download every lockfile core
   parses (@factstack/scanners), or a browser scan grades declared ranges
   where the CLI grades installed versions (INV7). Both now take spec's
   LOCKFILE_NAMES (BFS3-R1); this app is where the two packages meet, so the
   end-to-end guard stays here in case either one forks its list (BFS2-4). */
describe('GitHub scan lockfile list', () => {
  it('is exactly the lockfiles @factstack/scanners parses', () => {
    expect(new Set(GH_LOCKFILE_NAMES)).toEqual(new Set(LOCKFILE_NAMES));
  });
});

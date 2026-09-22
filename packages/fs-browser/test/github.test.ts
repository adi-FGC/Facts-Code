/**
 * fetchGitHubToMemory — request shape and ordering.
 *
 * The scan's wall time on a real connection is dominated by GitHub round
 * trips, not by the analyzer, so the ORDER of those requests is a
 * user-visible property and is pinned here: the recursive tree listing must
 * not wait for the default-branch lookup. A future refactor that awaits the
 * metadata first would pass every other test in the repo while making every
 * scan a round trip slower for everyone.
 *
 * `fetch` is faked — no network, no rate limit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubToMemory } from '../src/github.js';

interface Call {
  url: string;
  started: number;
  settle: (body: unknown) => void;
}

/** A fetch whose responses are resolved by the test, so overlap is observable. */
function deferredFetch(): { calls: Call[]; fetch: typeof globalThis.fetch } {
  const calls: Call[] = [];
  const fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    return new Promise((resolve) => {
      calls.push({
        url,
        started: calls.length,
        settle: (value) =>
          resolve(
            new Response(JSON.stringify(value), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
      });
    });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const tree = (paths: string[]) => ({
  sha: 'deadbeef',
  truncated: false,
  tree: paths.map((p) => ({ path: p, type: 'blob', size: 10, sha: 'x' })),
});
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchGitHubToMemory request ordering', () => {
  it('lists the tree without waiting for the default-branch lookup', async () => {
    const { calls, fetch } = deferredFetch();
    vi.stubGlobal('fetch', fetch);
    const scan = fetchGitHubToMemory({ owner: 'acme', repo: 'widgets' });
    await flush();

    // Both API calls are in flight before either has answered.
    expect(calls).toHaveLength(2);
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.endsWith('/repos/acme/widgets'))).toBe(true);
    expect(urls.some((u) => u.includes('/git/trees/HEAD?recursive=1'))).toBe(true);

    // Answer the tree FIRST: the metadata call is still outstanding, which is
    // exactly the overlap the ordering exists to buy.
    calls.find((c) => c.url.includes('/git/trees/'))!.settle(tree(['src/a.ts']));
    await flush();
    calls.find((c) => c.url.endsWith('/repos/acme/widgets'))!.settle({ default_branch: 'trunk' });
    await flush();

    // The raw blob must be fetched from the resolved branch, not from HEAD.
    const raw = calls.find((c) => c.url.includes('raw.githubusercontent.com'));
    expect(raw?.url).toBe('https://raw.githubusercontent.com/acme/widgets/trunk/src/a.ts');
    raw!.settle('export const a = 1;');
    const fs = await scan;
    expect(await fs.readText('src/a.ts')).toContain('export const a');
  });

  it('skips the metadata request entirely when a ref is pinned', async () => {
    const { calls, fetch } = deferredFetch();
    vi.stubGlobal('fetch', fetch);
    const scan = fetchGitHubToMemory({ owner: 'acme', repo: 'widgets', ref: 'v2' });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/git/trees/v2?recursive=1');
    calls[0]!.settle(tree(['index.ts']));
    await flush();
    const raw = calls.find((c) => c.url.includes('raw.githubusercontent.com'));
    expect(raw?.url).toBe('https://raw.githubusercontent.com/acme/widgets/v2/index.ts');
    raw!.settle('export {};');
    await expect(scan).resolves.toBeDefined();
  });

  it('reports the tree failure, not an unhandled metadata rejection', async () => {
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal('fetch', ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push({ url });
      // Both API calls fail, as they would for a repo that does not exist.
      return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
    }) as typeof globalThis.fetch);

    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent | unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(fetchGitHubToMemory({ owner: 'acme', repo: 'nope' })).rejects.toThrow(
        /not found/i,
      );
      await flush();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

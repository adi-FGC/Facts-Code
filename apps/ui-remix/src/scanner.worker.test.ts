/**
 * scanner.worker — a GitHub scan's whole-scan caveat reaches the artifacts
 * (UI-02).
 *
 * A truncated tree listing leaves no per-file marker, so unless the worker
 * hands it to analyze() as `scanWarnings`, a saved or shared agent.json
 * passes for a complete scan. The worker runs for real (GitHub fetch +
 * analyzer); only `self` and `fetch` are faked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GH_TRUNCATED_WARNING } from '@factstack/fs-browser';
import type { ScanResponse } from './scanner.worker.ts';

type Done = Extract<ScanResponse, { type: 'done' }>;

const SHA = 'c'.repeat(40);
/** Six files, so one failed download stays under the refusal share. */
const FILES: Record<string, string> = {
  'package.json': '{"name":"demo","version":"1.0.0"}\n',
  'src/index.ts': 'export const answer = 42;\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 2;\n',
  'src/c.ts': 'export const c = 3;\n',
  'src/unreachable.ts': 'export const u = 4;\n',
};

/** api.github.com + the raw host, just enough for one scan of o/r. */
function fakeGitHub(opts: { truncated: boolean; failPath?: string }): void {
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const u = new URL(typeof input === 'string' ? input : String(input));
    if (u.hostname === 'raw.githubusercontent.com') {
      // /o/r/<sha>/<path…>
      const path = u.pathname.split('/').slice(4).map(decodeURIComponent).join('/');
      if (path === opts.failPath) return new Response('nope', { status: 500 });
      const body = FILES[path];
      return body === undefined ? new Response('404', { status: 404 }) : new Response(body);
    }
    if (u.pathname.startsWith('/repos/o/r/commits/')) return new Response(SHA);
    if (u.pathname.startsWith('/repos/o/r/git/trees/')) {
      return Response.json({
        truncated: opts.truncated,
        tree: Object.entries(FILES).map(([path, body], i) => ({
          path,
          type: 'blob',
          mode: '100644',
          size: new TextEncoder().encode(body).byteLength,
          sha: `blob${i}`,
        })),
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof globalThis.fetch);
}

class FakeWorkerScope extends EventTarget {
  posted: ScanResponse[] = [];
  postMessage(msg: ScanResponse): void {
    this.posted.push(msg);
  }
}

let scope: FakeWorkerScope;

beforeAll(async () => {
  scope = new FakeWorkerScope();
  vi.stubGlobal('self', scope);
  await import('./scanner.worker.ts'); // registers its message listener on `self`
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('self', scope);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function scanGitHub(id: string): Promise<Done> {
  scope.dispatchEvent(
    new MessageEvent('message', {
      data: { id, kind: 'scan:github', spec: { owner: 'o', repo: 'r' } },
    }),
  );
  const settled = (): ScanResponse | undefined =>
    scope.posted.find((m) => m.id === id && m.type !== 'progress');
  await vi.waitFor(() => expect(settled()).toBeDefined(), { timeout: 30_000, interval: 20 });
  const end = settled()!;
  if (end.type === 'error') throw new Error(`scan failed: ${end.message}`);
  return end as Done;
}

describe('scanner.worker GitHub scan → agent.project.scanWarnings (UI-02)', () => {
  it('records a truncated tree in the artifacts, path-free', async () => {
    fakeGitHub({ truncated: true });
    const done = await scanGitHub('truncated');
    expect(done.agent.project.scanWarnings).toEqual([GH_TRUNCATED_WARNING]);
    for (const path of Object.keys(FILES)) {
      expect(done.agent.project.scanWarnings!.join('\n')).not.toContain(path);
    }
    // The UI's own list is unchanged.
    expect(done.meta.warnings).toEqual([GH_TRUNCATED_WARNING]);
  }, 60_000);

  it('omits the field for a complete listing, even with a failed download', async () => {
    /* The failed file is a per-file read-error risk; its UI line names the
       file, so it never goes into project.scanWarnings. */
    fakeGitHub({ truncated: false, failPath: 'src/unreachable.ts' });
    const done = await scanGitHub('complete');
    expect(done.agent.project).not.toHaveProperty('scanWarnings');
    expect(done.meta.warnings).toHaveLength(1);
    expect(done.meta.warnings![0]).toMatch(/1 of 6 files could not be downloaded/);
  }, 60_000);
});

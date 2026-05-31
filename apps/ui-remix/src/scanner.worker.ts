/**
 * Scanner Web Worker — runs the analyzer off the main thread.
 *
 * Why a worker:
 *   `@factstack/core`'s analyze() can take a few seconds on a 10k-file
 *   monorepo. Doing that on the main thread would lock scrolling, button
 *   clicks, and the View Transition that animates the "scanning…" UI.
 *   Workers cost a few MB of memory and one extra Vite chunk, but the
 *   UX win on every interaction during a scan is worth it.
 *
 * Bundle hygiene:
 *   The main bundle imports nothing from this file's transitive closure
 *   (analyzer, parsers, scanners, extractors). Vite produces a separate
 *   chunk per worker — the only thing the main bundle pays for is the
 *   Worker constructor. CI's bundle-size assertion (PR8) protects this.
 *
 * Wire shape:
 *   Request:  { id, kind: 'scan:local',  root: FileSystemDirectoryHandle, projectName? }
 *             { id, kind: 'scan:github', spec: GitHubFetchSpec }
 *   Response: { id, type: 'progress', phase, current, total, label }
 *             { id, type: 'done', agent, human, meta }
 *             { id, type: 'error', message }
 *
 *   `FileSystemDirectoryHandle` is structured-cloneable so it transfers
 *   to the worker without serialization. Same for the resulting agent +
 *   human artifacts on the way back (POJOs all the way down).
 *
 * Constraint C1 reminder:
 *   This worker imports browser-only packages (fs-browser, emit-browser)
 *   plus the isomorphic core. Never import `node:*`. Vite would happily
 *   bundle a polyfill but it'd inflate the chunk by ~200 KB and silently
 *   ship dead code.
 */

import { analyze } from '@factstack/core';
import { FsaBrowserFS, fetchGitHubToMemory, type GitHubFetchSpec } from '@factstack/fs-browser';
import { MemoryFS } from '@factstack/fs-memory';
import { browserGzippedBytes } from '@factstack/emit-browser';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

export type ScanRequest =
  | { id: string; kind: 'scan:local'; root: FileSystemDirectoryHandle; projectName?: string }
  | { id: string; kind: 'scan:files'; files: Array<{ path: string; file: File }>; projectName?: string }
  | { id: string; kind: 'scan:github'; spec: GitHubFetchSpec };

export type ScanResponse =
  | { id: string; type: 'progress'; phase: string; current: number; total: number; label: string }
  | {
      id: string;
      type: 'done';
      agent: AgentArtifact;
      human: HumanArtifact;
      meta: { filesScanned: number; filesSkipped: number; elapsedMs: number };
    }
  | { id: string; type: 'error'; message: string };

const post = (msg: ScanResponse): void => {
  (self as unknown as { postMessage: (m: ScanResponse) => void }).postMessage(msg);
};

/* Throttle progress events to ~10/sec — the analyzer can fire onProgress
 * thousands of times on large repos, which floods postMessage and slows
 * the main thread's render loop. The UI renders a percentage; sub-100ms
 * granularity isn't perceptible.
 *
 * analyze() emits `(pct, file)` where pct ∈ [0, 1]. We map that to the
 * worker's three-part {current, total, label} message shape so the
 * progress UI doesn't have to know which phase it's in. Pct gets
 * scaled to 0–100 so the UI can use one renderer for both walk and
 * analyze phases. */
function throttledProgress(id: string, phase: string): (pct: number, file: string) => void {
  let last = 0;
  return (pct, file) => {
    const now = performance.now();
    /* Always send the final message (pct === 1) so the UI hits 100% even
       if the previous tick was <100ms ago. */
    if (now - last < 100 && pct < 1) return;
    last = now;
    const current = Math.round(pct * 100);
    post({ id, type: 'progress', phase, current, total: 100, label: file || phase });
  };
}

/* Browser-side gzip is async; analyze()'s `gzip` callback is sync. The
 * cheapest sync gzip in the browser would be pako (80 KB) or
 * @cloudflare/zlib (120 KB) — both inflate the worker chunk for a
 * column the user perceives as "small/medium/large." We omit the gzip
 * callback entirely; analyze() degrades to `bundleSize: null` per file,
 * and the file row falls back to byte-count.
 *
 * Real gzipped sizes appear when the user hits "Save artifacts" —
 * writeBrowserArtifacts uses CompressionStream there, where the cost
 * matters and the UI's already showing a save-progress bar. */
function buildAnalyzeOpts(projectName: string, onProgress: (pct: number, file: string) => void) {
  /* Build the options object literally so we can omit `gzip` (the
     `exactOptionalPropertyTypes: true` rule rejects `gzip: undefined`).
     `gitStats` is similarly omitted — git mining requires a real .git
     directory which the FSA path doesn't expose and the GitHub path
     hasn't fetched. */
  return { projectName, onProgress };
}

self.addEventListener('message', async (ev: MessageEvent<ScanRequest>) => {
  const req = ev.data;
  try {
    if (req.kind === 'scan:local') {
      const fs = new FsaBrowserFS(req.root);
      const onProgress = throttledProgress(req.id, 'analyzing');
      post({ id: req.id, type: 'progress', phase: 'analyzing', current: 0, total: 0, label: 'Walking…' });
      const result = await analyze(fs, buildAnalyzeOpts(req.projectName ?? req.root.name, onProgress));
      post({ id: req.id, type: 'done', ...result });
      return;
    }

    if (req.kind === 'scan:files') {
      const files: Record<string, string> = {};
      const total = req.files.length;
      for (let i = 0; i < req.files.length; i++) {
        const entry = req.files[i]!;
        post({
          id: req.id,
          type: 'progress',
          phase: 'reading',
          current: i,
          total,
          label: entry.path,
        });
        files[entry.path] = await entry.file.text();
      }
      post({
        id: req.id,
        type: 'progress',
        phase: 'reading',
        current: total,
        total,
        label: 'Analyzing…',
      });
      const fs = new MemoryFS(files);
      const onProgress = throttledProgress(req.id, 'analyzing');
      const result = await analyze(fs, buildAnalyzeOpts(req.projectName ?? 'local files', onProgress));
      post({ id: req.id, type: 'done', ...result });
      return;
    }

    if (req.kind === 'scan:github') {
      /* Two-phase: fetch the repo into a MemoryFS (network-bound),
       * then run the analyzer (CPU-bound). Both phases share the same
       * id so the UI can show one continuous progress bar. */
      const fs = await fetchGitHubToMemory(req.spec, (p) => {
        post({
          id: req.id,
          type: 'progress',
          phase: p.phase,
          current: p.current,
          total: p.total,
          label: p.label,
        });
      });
      const onProgress = throttledProgress(req.id, 'analyzing');
      post({ id: req.id, type: 'progress', phase: 'analyzing', current: 0, total: 0, label: 'Analyzing…' });
      const projectName = `${req.spec.owner}/${req.spec.repo}${req.spec.ref ? '@' + req.spec.ref : ''}`;
      const result = await analyze(fs, buildAnalyzeOpts(projectName, onProgress));
      post({ id: req.id, type: 'done', ...result });
      return;
    }

    /* Exhaustiveness check — TS infers `never` if the discriminated
     * union is exhausted; runtime fallback for malformed messages. */
    post({
      id: (req as { id?: string }).id ?? '?',
      type: 'error',
      message: `Unknown scan kind: ${(req as { kind?: string }).kind ?? 'undefined'}`,
    });
  } catch (err) {
    post({
      id: req.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/* Re-export so TypeScript doesn't drop the message types. The bundler
 * tree-shakes them out of the worker chunk; they survive only in .d.ts
 * so the bridge module can import them by type. */
export type { GitHubFetchSpec };

/* `browserGzippedBytes` is intentionally unused by the worker today —
 * see the NO_GZIP comment above. Re-exported so the writer module
 * (PR5/6) has a single import surface and so tree-shaking visibly
 * keeps it out of the worker chunk. */
export { browserGzippedBytes };

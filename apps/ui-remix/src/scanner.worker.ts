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
 *             { id, kind: 'scan:files',  files: {path, file}[], projectName? }
 *             { id, kind: 'scan:github', spec: GitHubFetchSpec }
 *   Response: { id, type: 'progress', phase, current, total, label }
 *             { id, type: 'done', agent, human, meta }   (meta.warnings: an
 *               incomplete GitHub download — failed files, truncated tree;
 *               a truncated tree is also in agent.project.scanWarnings)
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
import {
  FileListFS,
  FsaBrowserFS,
  browserRepoName,
  fetchGitHubToMemory,
  type GitHubFetchSpec,
} from '@factstack/fs-browser';
import { browserGzippedBytes } from '@factstack/emit-browser';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

export type ScanRequest =
  | { id: string; kind: 'scan:local'; root: FileSystemDirectoryHandle; projectName?: string }
  | {
      id: string;
      kind: 'scan:files';
      files: Array<{ path: string; file: File }>;
      projectName?: string;
    }
  | { id: string; kind: 'scan:github'; spec: GitHubFetchSpec };

export type ScanResponse =
  | { id: string; type: 'progress'; phase: string; current: number; total: number; label: string }
  | {
      id: string;
      type: 'done';
      agent: AgentArtifact;
      human: HumanArtifact;
      meta: ScanMeta;
    }
  | { id: string; type: 'error'; message: string };

export interface ScanMeta {
  filesScanned: number;
  /** Walker-skipped files (a failed GitHub download counts: read_error). */
  filesSkipped: number;
  elapsedMs: number;
  /** Present only when the scan is known to be incomplete (a GitHub
   *  download with failed files or a truncated tree) — show them, never
   *  present the result as a complete scan. */
  warnings?: string[];
}

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
      post({
        id: req.id,
        type: 'progress',
        phase: 'analyzing',
        current: 0,
        total: 0,
        label: 'Walking…',
      });
      /* Same project name the CLI gives this checkout: a linked worktree
         is named after its main repo, so a browser Save lands on the same
         .claude/skills/factstack-<name>/ the CLI writes (FSB-11). */
      const projectName = await browserRepoName(fs, req.projectName ?? req.root.name);
      const result = await analyze(fs, buildAnalyzeOpts(projectName, onProgress));
      post({ id: req.id, type: 'done', ...result });
      return;
    }

    if (req.kind === 'scan:files') {
      /* Lazy, like the FSA path: stat() is each File's real byte size and
         bytes are read only when the walker asks. Decoding every file up
         front inflated binaries ~1.8x (false file-size-cap risks) and read
         node_modules/.git the walker would skip anyway. */
      const fs = new FileListFS(req.files);
      post({
        id: req.id,
        type: 'progress',
        phase: 'analyzing',
        current: 0,
        total: 0,
        label: 'Walking…',
      });
      const onProgress = throttledProgress(req.id, 'analyzing');
      const projectName = await browserRepoName(fs, req.projectName ?? 'local files');
      const result = await analyze(fs, buildAnalyzeOpts(projectName, onProgress));
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
      post({
        id: req.id,
        type: 'progress',
        phase: 'analyzing',
        current: 0,
        total: 0,
        label: 'Analyzing…',
      });
      /* `owner/repo[@ref]` is the recents id OpenModal parses back out of
         project.name, so it stays; the Claude skill renderer slugs only
         the repo part, matching the CLI's folder-named skill. The ref is
         the one that resolved (a slash branch may have had candidates). */
      const { report } = fs;
      const projectName = `${req.spec.owner}/${req.spec.repo}${report.ref ? '@' + report.ref : ''}`;
      /* A truncated tree leaves no per-file marker, so its path-free caveat
         goes into the artifacts themselves (agent.project.scanWarnings, which
         core omits when the list is empty) — a saved or shared agent.json
         must not pass for a complete scan (UI-02). */
      const result = await analyze(fs, {
        ...buildAnalyzeOpts(projectName, onProgress),
        scanWarnings: report.scanWarnings,
      });
      /* Failed downloads are already in filesSkipped (and in agent.risks as
         read-error): they stay in the tree unreadable, so the walker marks
         them read_error. meta.warnings keeps the UI's full list, the
         failed-file example included. */
      post({
        id: req.id,
        type: 'done',
        ...result,
        meta: {
          ...result.meta,
          ...(report.warnings.length ? { warnings: report.warnings } : {}),
        },
      });
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

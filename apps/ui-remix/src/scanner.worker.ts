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
  localSnapshot,
  type GitHubFetchSpec,
  type LocalSnapshot,
} from '@factstack/fs-browser';
import { browserGzippedBytes } from '@factstack/emit-browser';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import {
  RESULT_PRODUCER,
  preloadExtractionCache,
  restorable,
  saveSession,
} from './lib/scanCache.ts';
import {
  githubSessionId,
  localSessionId,
  openScanStore,
  type ScanSessionRecord,
  type ScanStore,
} from './lib/scanSessions.ts';

/** Save this local scan in the browser's scan store (D-10, opt-in). `key`
 *  names the folder across scans — the recents id's folder name — so the
 *  next scan of it can resume, restore, or report what changed. */
export interface LocalSessionOpt {
  key: string;
}

export type ScanRequest =
  | {
      id: string;
      kind: 'scan:local';
      root: FileSystemDirectoryHandle;
      projectName?: string;
      session?: LocalSessionOpt;
    }
  | {
      id: string;
      kind: 'scan:files';
      files: Array<{ path: string; file: File }>;
      projectName?: string;
      session?: LocalSessionOpt;
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
  /** Files served from this browser's scan store instead of GitHub (a
   *  resumed download, or files unchanged since an earlier scan). */
  resumed?: number;
  /** Per-file parses served from the scan store instead of re-parsed. */
  extractionHits?: number;
  /** The result is a finished scan of the same commit (GitHub) or of the
   *  unchanged folder (local), restored without re-analyzing. */
  restored?: boolean;
  /** A local folder differed from its saved scan, so this was a full scan:
   *  `commit` when HEAD moved, `files` when files changed at the same (or
   *  an unknown) commit. Shas are full; the UI shortens them. */
  changed?: { kind: 'commit' | 'files'; fromCommit: string | null; toCommit: string | null };
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
  /* INV1 — the adapter owns the clock: stamped here, once per scan (F-38). */
  return { projectName, onProgress, generatedAt: new Date().toISOString() };
}

/* One store connection for the worker's lifetime, reopened when a version
   change in another tab closed it. "No store" is not cached: a transient
   refusal (an upgrade blocked by an old tab) is retried on the next scan. */
let storeConn: ScanStore | null = null;
async function getStore(): Promise<ScanStore | null> {
  if (storeConn?.isOpen) return storeConn;
  storeConn = await openScanStore();
  return storeConn;
}

/**
 * A local scan (a picked folder or a file list). Saved in this browser only
 * when the request carries `session` (the Open dialog's opt-in checkbox,
 * D-10): the folder's identity is a tree signature plus the commit when
 * `.git` is readable. An unchanged folder restores its finished result; a
 * changed one is scanned in full and reports what changed, reusing the
 * per-file parses of files that did not (D-11).
 */
async function scanLocalLike(
  req: Extract<ScanRequest, { kind: 'scan:local' | 'scan:files' }>,
  fs: FsaBrowserFS | FileListFS,
  fallbackName: string,
): Promise<void> {
  const t0 = Date.now();
  const tick = (label: string): void =>
    post({ id: req.id, type: 'progress', phase: 'analyzing', current: 0, total: 0, label });
  tick('Walking…');
  const projectName = await browserRepoName(fs, fallbackName);

  const key = req.session?.key;
  const store = key ? await getStore() : null;
  const prefix = key ? localSessionId(key, '') : null;
  let snap: LocalSnapshot | null = null;
  let prior: ScanSessionRecord | undefined;
  let sessionId: string | null = null;
  if (store && key && prefix) {
    tick('Checking for changes since the saved scan…');
    snap = await localSnapshot(fs, (n) => tick(`Checking files… ${n}`));
    sessionId = localSessionId(key, snap.signature);
    prior = (await store.listSessions()).find((s) => s.id.startsWith(prefix));
    if (prior && prior.id === sessionId && restorable(prior)) {
      post({
        id: req.id,
        type: 'done',
        agent: prior.result.agent as AgentArtifact,
        human: prior.result.human as HumanArtifact,
        meta: { ...prior.result.meta, elapsedMs: Date.now() - t0, restored: true },
      });
      return;
    }
  }

  const extractionCache = await preloadExtractionCache(store, prefix ?? '');
  const onProgress = throttledProgress(req.id, 'analyzing');
  const result = await analyze(fs, {
    ...buildAnalyzeOpts(projectName, onProgress),
    extractionCache,
  });
  /* A record with this very signature that could not be restored (another
     build wrote it) is not a change in the folder: no change is reported. */
  const changed =
    prior && snap && prior.id !== sessionId
      ? {
          kind: prior.commit && snap.commit && prior.commit !== snap.commit ? 'commit' : 'files',
          fromCommit: prior.commit,
          toCommit: snap.commit,
        }
      : null;
  const meta: ScanMeta = {
    ...result.meta,
    elapsedMs: Date.now() - t0, // the whole wait: change check + analysis
    extractionHits: extractionCache.hits,
    ...(changed ? { changed: changed as NonNullable<ScanMeta['changed']> } : {}),
  };
  if (store && sessionId && snap && prefix) {
    tick('Saving this scan in your browser…');
    const now = Date.now();
    await saveSession(
      store,
      {
        id: sessionId,
        kind: req.kind === 'scan:local' ? 'local' : 'files',
        label: projectName,
        commit: snap.commit,
        signature: snap.signature,
        status: 'done',
        producer: RESULT_PRODUCER,
        totals: { files: snap.files, fetched: snap.files, bytes: snap.bytes },
        extractionKeys: [...extractionCache.used],
        result: { agent: result.agent, human: result.human, meta },
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      },
      extractionCache,
      prefix,
    );
  }
  post({ id: req.id, type: 'done', ...result, meta });
}

self.addEventListener('message', async (ev: MessageEvent<ScanRequest>) => {
  const req = ev.data;
  try {
    if (req.kind === 'scan:local') {
      /* Same project name the CLI gives this checkout: a linked worktree
         is named after its main repo, so a browser Save lands on the same
         .claude/skills/factstack-<name>/ the CLI writes (FSB-11). */
      await scanLocalLike(req, new FsaBrowserFS(req.root), req.projectName ?? req.root.name);
      return;
    }

    if (req.kind === 'scan:files') {
      /* Lazy, like the FSA path: stat() is each File's real byte size and
         bytes are read only when the walker asks. Decoding every file up
         front inflated binaries ~1.8x (false file-size-cap risks) and read
         node_modules/.git the walker would skip anyway. */
      await scanLocalLike(req, new FileListFS(req.files), req.projectName ?? 'local files');
      return;
    }

    if (req.kind === 'scan:github') {
      /* Two-phase: fetch the repo into a MemoryFS (network-bound),
       * then run the analyzer (CPU-bound). Both phases share the same
       * id so the UI can show one continuous progress bar.
       *
       * Both phases persist in this browser's scan store (D-10): blobs by
       * sha, so a stopped download resumes and an unchanged file is never
       * fetched twice; per-file parses by content hash, so it is never
       * parsed twice; and the finished result by commit, so reopening the
       * same commit restores it without a scan. No store (private mode,
       * blocked storage) means a plain scan. */
      const t0 = Date.now();
      const store = await getStore();
      const fs = await fetchGitHubToMemory(
        req.spec,
        (p) => {
          post({
            id: req.id,
            type: 'progress',
            phase: p.phase,
            current: p.current,
            total: p.total,
            label: p.label,
          });
        },
        store ? { blobCache: store.blobCache() } : {},
      );
      /* `owner/repo[@ref]` is the recents id OpenModal parses back out of
         project.name, so it stays; the Claude skill renderer slugs only
         the repo part, matching the CLI's folder-named skill. The ref is
         the one that resolved (a slash branch may have had candidates). */
      const { report } = fs;
      const { owner, repo } = req.spec;
      const projectName = `${owner}/${repo}${report.ref ? '@' + report.ref : ''}`;
      const sessionId = report.commit ? githubSessionId(owner, repo, report.commit) : null;
      const prior = store && sessionId ? await store.getSession(sessionId) : undefined;
      if (restorable(prior)) {
        post({
          id: req.id,
          type: 'done',
          agent: prior.result.agent as AgentArtifact,
          human: prior.result.human as HumanArtifact,
          meta: {
            ...prior.result.meta,
            elapsedMs: Date.now() - t0,
            resumed: report.resumed,
            restored: true,
          },
        });
        return;
      }
      const onProgress = throttledProgress(req.id, 'analyzing');
      post({
        id: req.id,
        type: 'progress',
        phase: 'analyzing',
        current: 0,
        total: 0,
        label: 'Analyzing…',
      });
      const extractionCache = await preloadExtractionCache(store, githubSessionId(owner, repo, ''));
      /* A truncated tree leaves no per-file marker, so its path-free caveat
         goes into the artifacts themselves (agent.project.scanWarnings, which
         core omits when the list is empty) — a saved or shared agent.json
         must not pass for a complete scan (UI-02). */
      const result = await analyze(fs, {
        ...buildAnalyzeOpts(projectName, onProgress),
        scanWarnings: report.scanWarnings,
        extractionCache,
      });
      /* Failed downloads are already in filesSkipped (and in agent.risks as
         read-error): they stay in the tree unreadable, so the walker marks
         them read_error. meta.warnings keeps the UI's full list, the
         failed-file example included. */
      /* Elapsed covers the whole scan the user waited for (download +
         analysis), not analyze() alone: on a 12k-file repo the download is
         97% of it (F-125). */
      const meta: ScanMeta = {
        ...result.meta,
        elapsedMs: Date.now() - t0,
        ...(report.warnings.length ? { warnings: report.warnings } : {}),
        resumed: report.resumed,
        extractionHits: extractionCache.hits,
      };
      /* Save before announcing, so a tab closed right after "Scan complete"
         still has its session. A partial download is not saved as a session
         (its blobs are, so the retry resumes); the next complete scan of
         this commit will be. */
      if (store && sessionId && report.failed.length === 0 && !report.truncated) {
        post({
          id: req.id,
          type: 'progress',
          phase: 'analyzing',
          current: 100,
          total: 100,
          label: 'Saving this scan in your browser…',
        });
        const now = Date.now();
        await saveSession(
          store,
          {
            id: sessionId,
            kind: 'github',
            label: projectName,
            commit: report.commit,
            signature: null,
            status: 'done',
            producer: RESULT_PRODUCER,
            totals: { files: report.totalFiles, fetched: report.fetched, bytes: report.bytes },
            extractionKeys: [...extractionCache.used],
            result: { agent: result.agent, human: result.human, meta },
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
          },
          extractionCache,
          githubSessionId(owner, repo, ''),
        );
      }
      post({ id: req.id, type: 'done', ...result, meta });
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

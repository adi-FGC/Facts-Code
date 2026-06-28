/**
 * Analyze Web Worker — runs @factstack/core's analyze() off the panel's main
 * thread so the UI stays responsive during a scan.
 *
 * This mirrors apps/ui-remix/src/scanner.worker.ts but is intentionally leaner
 * (no save-back / skills / gzip imports). It imports only the isomorphic core +
 * the browser FS adapters — never `node:*` (Constraint C1).
 *
 * Wire shape:
 *   Request:  { id, kind:'github', spec }
 *             { id, kind:'local',  root, projectName? }
 *             { id, kind:'files',  files, projectName? }
 *   Response: { id, type:'progress', phase, current, total, label }
 *             { id, type:'done', agent, human, meta }
 *             { id, type:'error', message }
 */
import { analyze } from '@factstack/core';
import { FsaBrowserFS, fetchGitHubToMemory, type GitHubFetchSpec } from '@factstack/fs-browser';
import { MemoryFS } from '@factstack/fs-memory';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';

export interface AnalyzeMeta {
  filesScanned: number;
  filesSkipped: number;
  elapsedMs: number;
}

export type AnalyzeRequest =
  | { id: string; kind: 'github'; spec: GitHubFetchSpec }
  | { id: string; kind: 'local'; root: FileSystemDirectoryHandle; projectName?: string }
  | { id: string; kind: 'files'; files: Array<{ path: string; file: File }>; projectName?: string };

export type AnalyzeResponse =
  | { id: string; type: 'progress'; phase: string; current: number; total: number; label: string }
  | { id: string; type: 'done'; agent: AgentArtifact; human: HumanArtifact; meta: AnalyzeMeta }
  | { id: string; type: 'error'; message: string };

const post = (msg: AnalyzeResponse): void => {
  (self as unknown as { postMessage: (m: AnalyzeResponse) => void }).postMessage(msg);
};

/* Throttle analyze()'s (pct, file) callback to ~10/sec so postMessage doesn't
 * flood the main thread on large repos. Always emit the final tick (pct === 1).
 * Mirrors the dashboard worker so progress feels identical across surfaces. */
function throttledProgress(id: string, phase: string): (pct: number, file: string) => void {
  let last = 0;
  return (pct, file) => {
    const now = performance.now();
    if (now - last < 100 && pct < 1) return;
    last = now;
    post({ id, type: 'progress', phase, current: Math.round(pct * 100), total: 100, label: file || phase });
  };
}

self.addEventListener('message', async (ev: MessageEvent<AnalyzeRequest>) => {
  const req = ev.data;
  try {
    if (req.kind === 'github') {
      const fs = await fetchGitHubToMemory(req.spec, (p) => {
        post({ id: req.id, type: 'progress', phase: p.phase, current: p.current, total: p.total, label: p.label });
      });
      post({ id: req.id, type: 'progress', phase: 'analyzing', current: 0, total: 0, label: 'Analyzing…' });
      const projectName = `${req.spec.owner}/${req.spec.repo}${req.spec.ref ? '@' + req.spec.ref : ''}`;
      const result = await analyze(fs, { projectName, onProgress: throttledProgress(req.id, 'analyzing') });
      post({ id: req.id, type: 'done', ...result });
      return;
    }

    if (req.kind === 'local') {
      const fs = new FsaBrowserFS(req.root);
      post({ id: req.id, type: 'progress', phase: 'analyzing', current: 0, total: 0, label: 'Walking…' });
      const result = await analyze(fs, {
        projectName: req.projectName ?? req.root.name,
        onProgress: throttledProgress(req.id, 'analyzing'),
      });
      post({ id: req.id, type: 'done', ...result });
      return;
    }

    if (req.kind === 'files') {
      const files: Record<string, string> = {};
      const total = req.files.length;
      for (let i = 0; i < req.files.length; i++) {
        const entry = req.files[i]!;
        post({ id: req.id, type: 'progress', phase: 'reading', current: i, total, label: entry.path });
        files[entry.path] = await entry.file.text();
      }
      const fs = new MemoryFS(files);
      post({ id: req.id, type: 'progress', phase: 'analyzing', current: 0, total: 0, label: 'Analyzing…' });
      const result = await analyze(fs, {
        projectName: req.projectName ?? 'local files',
        onProgress: throttledProgress(req.id, 'analyzing'),
      });
      post({ id: req.id, type: 'done', ...result });
      return;
    }

    post({ id: (req as { id?: string }).id ?? '?', type: 'error', message: `Unknown analyze kind` });
  } catch (err) {
    post({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});

/* Keep the message types alive for the bridge's type-only import. */
export type { GitHubFetchSpec };

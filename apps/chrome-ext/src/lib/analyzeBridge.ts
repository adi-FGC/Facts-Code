/**
 * Main-thread bridge to the analyze Web Worker.
 *
 * Dynamic-imported (see acquire.ts) so the worker, the analyzer's transitive
 * closure, and humanToViz only download when the user actually analyzes — the
 * cold-start panel (demo view + shell) stays tiny.
 *
 * Returns the canonical `Dataset` (= VizArtifact) the routes render, produced
 * by humanToViz() on the main thread (cheap, pure) from the worker's
 * {agent, human} payload — same split the dashboard uses.
 */
import { humanToViz } from '@factstack/emit/pure';
import type { GitHubFetchSpec } from '@factstack/fs-browser';
import type { Dataset } from './types.ts';
import type { AnalyzeRequest, AnalyzeResponse, AnalyzeMeta } from '../worker/analyze.worker.ts';

export interface AnalyzeProgress {
  phase: string;
  current: number;
  total: number;
  label: string;
  fraction: number;
}

export interface AnalyzeResult {
  dataset: Dataset;
  meta: AnalyzeMeta;
}

let worker: Worker | null = null;
let nextId = 1;

/* In-flight runs keyed by request id. A worker crash / message error must
 * reject every pending run — otherwise the caller hangs on "Analyzing…"
 * forever waiting for a message that will never arrive. */
const pending = new Map<string, { reject: (e: Error) => void; off: () => void; timer: ReturnType<typeof setTimeout> }>();

/** Per-run safety timeout: a worker that silently wedges (pathological input)
 *  would otherwise hang the caller forever. 10 min is generous for any real
 *  repo; on fire it rejects + cleans up so the UI can recover. */
const ANALYZE_TIMEOUT_MS = 10 * 60 * 1000;

/** Reject + fully clean every in-flight run. Snapshot first so the per-entry
 *  cleanup (which deletes from the Map) can't invalidate the iterator. */
function discardPending(message: string): void {
  const entries = [...pending.values()];
  pending.clear();
  for (const p of entries) {
    p.off();
    clearTimeout(p.timer);
    p.reject(new Error(message));
  }
}

/** Cancel in-flight runs but keep the worker warm for reuse (the panel's "New"
 *  / reset calls this). Rejects with the cancel sentinel so callers treat it as
 *  a no-op rather than a surfaced error. */
export function cancelPending(): void {
  discardPending('__factstack_cancelled__');
}

function killWorker(message: string): void {
  discardPending(message);
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('../worker/analyze.worker.ts', import.meta.url), {
    type: 'module',
    name: 'factstack-analyze',
  });
  w.addEventListener('error', () => killWorker('The analyzer crashed. Please try again.'));
  w.addEventListener('messageerror', () => killWorker('The analyzer sent a malformed message. Please try again.'));
  worker = w;
  return worker;
}

function run(req: AnalyzeRequest, onProgress?: (p: AnalyzeProgress) => void): Promise<AnalyzeResult> {
  const w = getWorker();
  return new Promise<AnalyzeResult>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<AnalyzeResponse>): void => {
      const m = ev.data;
      if (m.id !== req.id) return; // ignore stale scans
      if (m.type === 'progress') {
        onProgress?.({
          phase: m.phase,
          current: m.current,
          total: m.total,
          label: m.label,
          fraction: m.total > 0 ? Math.max(0, Math.min(1, m.current / m.total)) : 0,
        });
        return;
      }
      finish();
      if (m.type === 'error') {
        reject(new Error(m.message));
        return;
      }
      try {
        resolve({ dataset: humanToViz(m.agent, m.human), meta: m.meta });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const off = (): void => w.removeEventListener('message', onMessage);
    const timer = setTimeout(() => {
      finish();
      reject(new Error('Analysis timed out — try a smaller repo or check your connection.'));
    }, ANALYZE_TIMEOUT_MS);
    const finish = (): void => {
      off();
      clearTimeout(timer);
      pending.delete(req.id);
    };
    pending.set(req.id, { reject, off, timer });
    w.addEventListener('message', onMessage);
    w.postMessage(req);
  });
}

export function analyzeGitHub(spec: GitHubFetchSpec, onProgress?: (p: AnalyzeProgress) => void): Promise<AnalyzeResult> {
  return run({ id: String(nextId++), kind: 'github', spec }, onProgress);
}

export function analyzeLocal(
  root: FileSystemDirectoryHandle,
  onProgress?: (p: AnalyzeProgress) => void,
  projectName?: string,
): Promise<AnalyzeResult> {
  return run({ id: String(nextId++), kind: 'local', root, ...(projectName ? { projectName } : {}) }, onProgress);
}

export function analyzeFiles(
  files: Array<{ path: string; file: File }>,
  onProgress?: (p: AnalyzeProgress) => void,
  projectName?: string,
): Promise<AnalyzeResult> {
  return run({ id: String(nextId++), kind: 'files', files, ...(projectName ? { projectName } : {}) }, onProgress);
}

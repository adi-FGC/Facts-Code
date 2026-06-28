/**
 * Data-acquisition orchestrator — the one surface the UI calls to get a
 * Dataset. Hides the worker/dynamic-import plumbing and the per-source
 * provenance bookkeeping.
 *
 *   acquireGitHub   — analyze a repo (the active-tab headline path)
 *   acquireLocalFolder — best-effort File System Access (Chrome/Edge)
 *   acquireDemo     — bundled zero-setup dataset
 *
 * Everything heavy (analyzer worker + humanToViz) is behind a dynamic import,
 * so importing this module from the cold-start shell stays cheap.
 */
import type { LoadedDataset } from './types.ts';
import { repoLabel, type RepoRef } from './githubUrl.ts';
import type { AnalyzeProgress } from './analyzeBridge.ts';
import { loadDemo } from './demo.ts';

export type Progress = AnalyzeProgress;

/** Sentinel error message used when the user dismisses the folder picker. */
export const CANCELLED = '__factstack_cancelled__';

export function canPickLocalFolder(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function acquireGitHub(
  repo: RepoRef,
  onProgress?: (p: Progress) => void,
  token?: string,
): Promise<LoadedDataset> {
  const { analyzeGitHub } = await import('./analyzeBridge.ts');
  const spec = {
    owner: repo.owner,
    repo: repo.repo,
    ...(repo.ref ? { ref: repo.ref } : {}),
    ...(token ? { token } : {}),
  };
  const { dataset } = await analyzeGitHub(spec, onProgress);
  return { dataset, source: { kind: 'github', label: repoLabel(repo), at: Date.now() } };
}

export async function acquireLocalFolder(onProgress?: (p: Progress) => void): Promise<LoadedDataset> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: 'read' }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (typeof picker !== 'function') {
    throw new Error('Folder analysis needs the File System Access API (Chrome/Edge 114+). Use the GitHub path instead.');
  }
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({ mode: 'read' });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(CANCELLED);
    throw err;
  }
  const { analyzeLocal } = await import('./analyzeBridge.ts');
  const { dataset } = await analyzeLocal(handle, onProgress, handle.name);
  return { dataset, source: { kind: 'local', label: handle.name, at: Date.now() } };
}

export async function acquireDemo(): Promise<LoadedDataset> {
  return loadDemo();
}

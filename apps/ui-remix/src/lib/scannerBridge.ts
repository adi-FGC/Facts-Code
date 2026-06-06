/**
 * Main-thread bridge to the scanner Web Worker.
 *
 * Two responsibilities:
 *   1. Wrap the worker's message protocol in a Promise + progress
 *      callback shape that React-style UI code can await.
 *   2. Convert the worker's {agent, human} payload into the legacy
 *      Dataset shape the existing routes consume, then hot-swap it
 *      via the same `factstack:dataset` CustomEvent the re-analyze
 *      button uses. Routes don't have to know whether their data
 *      came from the CLI or from a browser scan.
 *
 * Lazy worker:
 *   The worker chunk is ~hundreds of KB once Vite splits it (analyzer
 *   + tree-sitter wasm-loader stubs + extractors). We don't want that
 *   in the cold-start path — most users land on the static dashboard
 *   and never scan. The worker is constructed on first use and reused
 *   for the lifetime of the page; the module-level singleton lets us
 *   keep the per-scan API stateless from the caller's POV.
 *
 * Cancel semantics:
 *   We don't terminate + recreate the worker on cancel — recreation
 *   costs a fresh chunk parse. Instead, the in-flight scan is "abandoned"
 *   by ignoring its messages (we filter by `id`). The worker keeps
 *   running for a bit, then GCs naturally. Cheap for the user, kind to
 *   the bundle.
 */

import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { humanToViz } from '@factstack/emit/pure';
import {
  writeBrowserArtifacts,
  writeBrowserSkills,
  type BrowserWriteResult,
  type BrowserSkillsResult,
  type EmitProfile,
  type SkillFormatId,
} from '@factstack/emit-browser';
import type { GitHubFetchSpec } from '@factstack/fs-browser';
import type { ScanRequest, ScanResponse } from '../scanner.worker.ts';
import type { Dataset } from './loadArtifacts.ts';

export interface ScanProgress {
  phase: string;
  current: number;
  total: number;
  label: string;
  /** 0–1 — convenience for progress bars. */
  fraction: number;
}

export interface ScanResult {
  agent: AgentArtifact;
  human: HumanArtifact;
  dataset: Dataset;
  meta: { filesScanned: number; filesSkipped: number; elapsedMs: number };
}

export interface BrowserFileEntry {
  path: string;
  file: File;
}

let workerSingleton: Worker | null = null;
let nextRequestId = 1;

/* The worker is type:'module' so Vite emits one chunk per imported
 * module + a small worker bootstrap. import.meta.url + new URL is the
 * documented pattern Vite recognizes for worker discovery — string
 * concat would defeat the bundler's static analysis and leave the
 * worker chunk un-built. */
function getWorker(): Worker {
  if (workerSingleton) return workerSingleton;
  workerSingleton = new Worker(new URL('../scanner.worker.ts', import.meta.url), {
    type: 'module',
    name: 'factstack-scanner',
  });
  /* If the worker dies (uncaught throw, OOM), null the singleton so
     the next scan request gets a fresh worker instead of posting into
     a dead one. We don't surface the error — the per-scan promise
     will reject via the `error` message below if there's an in-flight
     request, or the user retries and gets a fresh worker if not. */
  workerSingleton.addEventListener('error', () => {
    if (workerSingleton) {
      workerSingleton.terminate();
      workerSingleton = null;
    }
  });
  return workerSingleton;
}

interface RunOptions {
  onProgress?: (p: ScanProgress) => void;
}

/**
 * Run a scan on a user-picked local directory (FSA handle). The handle
 * MUST be opened with at least 'read' permission before being passed
 * here — the picker enforces this when the user clicks "Open" in the
 * native dialog.
 */
export async function runLocalScan(
  handle: FileSystemDirectoryHandle,
  opts: RunOptions & { projectName?: string } = {},
): Promise<ScanResult> {
  return runScan(
    {
      id: String(nextRequestId++),
      kind: 'scan:local',
      root: handle,
      ...(opts.projectName ? { projectName: opts.projectName } : {}),
    },
    opts,
  );
}

/**
 * Run a scan from a standard <input type="file" webkitdirectory> pick.
 * This is the fallback/primary path for embedded browsers where
 * showDirectoryPicker() advertises support but never opens a visible
 * native picker. Files are cloned into the worker as File blobs and
 * materialized into MemoryFS there.
 */
export async function runFileListScan(
  files: BrowserFileEntry[],
  opts: RunOptions & { projectName?: string } = {},
): Promise<ScanResult> {
  return runScan(
    {
      id: String(nextRequestId++),
      kind: 'scan:files',
      files,
      ...(opts.projectName ? { projectName: opts.projectName } : {}),
    },
    opts,
  );
}

/** Run a scan against a public GitHub repo URL. */
export async function runGitHubScan(
  spec: GitHubFetchSpec,
  opts: RunOptions = {},
): Promise<ScanResult> {
  return runScan(
    {
      id: String(nextRequestId++),
      kind: 'scan:github',
      spec,
    },
    opts,
  );
}

/** Hot-swap the route tree to a freshly scanned dataset. Same event
 *  shape the Re-analyze button uses, so App.tsx's existing listener
 *  picks it up without modification. */
export function publishDataset(dataset: Dataset): void {
  window.dispatchEvent(new CustomEvent('factstack:dataset', { detail: dataset }));
}

/**
 * Persist scanned artifacts to disk via the File System Access API.
 *
 * Two ways the destination handle can arrive:
 *   1. The local-scan path already has a directory handle — pass it
 *      through. We need to re-request `mode: 'readwrite'` permission
 *      because the original scan-time pick was `mode: 'read'`.
 *   2. The GitHub path has no source directory. Caller opens a fresh
 *      `showDirectoryPicker({ mode: 'readwrite' })` and passes the
 *      result here.
 *
 * Returns the byte-count + per-file paths (relative to .facts/) so the
 * UI can show a confirmation toast like "Wrote 5 files (582 KB) to .facts/".
 *
 * Permission upgrade flow:
 *   Chrome's FSA grants permission with a granularity of (handle, mode).
 *   A handle that was opened read-only needs `requestPermission({mode:'readwrite'})`
 *   before any write succeeds. On grant the prompt is one-tap; on
 *   prior-session grant it returns `granted` synchronously.
 */
export async function saveArtifacts(
  destination: FileSystemDirectoryHandle,
  agent: AgentArtifact,
  human: HumanArtifact,
  opts: { profile?: EmitProfile; memoryBody?: string } = {},
): Promise<BrowserWriteResult> {
  const granted = await ensureWritePermission(destination);
  if (!granted) {
    throw new Error('Write permission denied for ' + destination.name);
  }
  return writeBrowserArtifacts({
    root: destination,
    agent,
    human,
    ...(opts.profile !== undefined && { profile: opts.profile }),
    ...(opts.memoryBody !== undefined && { memoryBody: opts.memoryBody }),
  });
}

/**
 * Write the agent-instruction / skill files (.cursorrules, AGENTS.md,
 * .github/copilot-instructions.md, .claude/skills/<name>/SKILL.md …) to
 * the PROJECT ROOT of the picked directory, so any AI coding agent that
 * opens this folder is told to prefer `.facts/agent.pack` + the FACTS
 * MCP over re-scanning. Pairs with `saveArtifacts` (which writes the pack
 * itself). Same permission upgrade as `saveArtifacts`.
 *
 * Kept here (not the main bundle) because scannerBridge is dynamically
 * imported — `@factstack/skills` rides the lazy scan chunk, not cold
 * start.
 */
export async function saveSkills(
  destination: FileSystemDirectoryHandle,
  agent: AgentArtifact,
  human: HumanArtifact,
  opts: { formats?: SkillFormatId[] } = {},
): Promise<BrowserSkillsResult> {
  const granted = await ensureWritePermission(destination);
  if (!granted) {
    throw new Error('Write permission denied for ' + destination.name);
  }
  return writeBrowserSkills({
    root: destination,
    agent,
    human,
    ...(opts.formats !== undefined && { formats: opts.formats }),
  });
}

/**
 * Idempotent permission upgrade. Returns true when the handle has
 * readwrite permission (already granted or freshly granted), false
 * when the user denied. Shouldn't throw — denial is a normal path.
 */
async function ensureWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  /* `queryPermission` + `requestPermission` aren't in the standard FSA
     types yet (they're in the wicg-file-system-access shim). Cast to
     a permissive shape rather than pulling in the shim package. */
  const perm = handle as unknown as {
    queryPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  };
  if (typeof perm.queryPermission !== 'function') {
    /* Safari / older Chrome — assume the original picker grant covers
       writes too. If it doesn't, the underlying writeBrowserArtifacts
       call will surface a NotAllowedError that the caller already shows
       in the error banner. */
    return true;
  }
  const current = await perm.queryPermission({ mode: 'readwrite' });
  if (current === 'granted') return true;
  /* current is 'denied' | 'prompt'. requestPermission can flip 'prompt'
     to 'granted' (user clicks Allow); 'denied' typically also re-prompts
     if the underlying permission state allows it. If the API isn't
     present we can't ask, so we return false rather than guessing. */
  if (typeof perm.requestPermission !== 'function') return false;
  const next = await perm.requestPermission({ mode: 'readwrite' });
  return next === 'granted';
}

/**
 * Show the directory picker in readwrite mode. Used by the GitHub save
 * path which has no on-disk source directory to upgrade. Returns null
 * when the user cancels (caller treats this as "go back to idle").
 */
export async function pickWriteDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) {
    throw new Error('File System Access API not supported in this browser. Try Chrome or Edge.');
  }
  try {
    return await picker({ mode: 'readwrite' });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return null;
    throw err;
  }
}

/* ─────────── private ─────────── */

function runScan(req: ScanRequest, opts: RunOptions): Promise<ScanResult> {
  const worker = getWorker();
  return new Promise<ScanResult>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<ScanResponse>) => {
      const msg = ev.data;
      /* Multiplex on `id` so a stale scan's late progress messages don't
         drive a newer scan's UI. The worker doesn't know which scans
         the UI still cares about — that's our job. */
      if (msg.id !== req.id) return;
      if (msg.type === 'progress') {
        opts.onProgress?.({
          phase: msg.phase,
          current: msg.current,
          total: msg.total,
          label: msg.label,
          fraction: msg.total > 0 ? Math.max(0, Math.min(1, msg.current / msg.total)) : 0,
        });
        return;
      }
      worker.removeEventListener('message', onMessage);
      if (msg.type === 'error') {
        reject(new Error(msg.message));
        return;
      }
      // type === 'done'
      try {
        const dataset = humanToViz(msg.agent, msg.human) as Dataset;
        resolve({ agent: msg.agent, human: msg.human, dataset, meta: msg.meta });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage(req);
  });
}

/**
 * Browser-tier artifact-write shim.
 *
 * Thin wrapper around `writeArtifactsTo` (the isomorphic orchestrator
 * in `@factstack/emit/pure`) + the FSA-backed `FsaFileWriter`.
 *
 * This file used to be 269 lines of orchestration that duplicated the
 * Node side. The orchestration moved upstream; this file is now the
 * browser-specific outer ring — primarily a constructor for the
 * adapter + the option-shape translator. See CONTEXT.md for the
 * deepening story.
 *
 * The `readBrowserSnapshots` function stays here. It's the FSA-side
 * mirror of `readSnapshots` (in `@factstack/emit/src/write.ts`). Both
 * readers are CURRENTLY duplicated across tiers — a future `FileReader`
 * interface deepening could collapse them the same way `FileWriter`
 * collapsed the writers, but that's tracked in CONTEXT.md as separate
 * work.
 */

import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { writeArtifactsTo } from '@factstack/emit/pure';
import { FsaFileWriter } from './fsa-writer.js';

export interface BrowserWriteOptions {
  /** User-picked destination directory. Must be opened with mode: 'readwrite'. */
  root: FileSystemDirectoryHandle;
  agent: AgentArtifact;
  human: HumanArtifact;
  /** Also emit the streamable `agent.jsonl` companion. Default true. */
  streamable?: boolean;
  /** Write a snapshot row to `.facts/snapshots/<ISO>.json`. Default
   *  true (browser callers always want trend data — they don't have
   *  a separate `analyze` vs `ui` flow like the CLI). */
  writeSnapshot?: boolean;
  /** Cap snapshot retention (lexi-oldest pruned). Default 50; 0 disables. */
  snapshotRetention?: number;
  /** Optional pre-built MEMORY.md body (caller generates via core.buildMemory). */
  memoryBody?: string;
}

export interface BrowserWriteResult {
  /** Names relative to `<root>/.facts/`. */
  agentName: string;
  humanName: string;
  jsonlName: string | null;
  packName: string;
  snapshotName: string | null;
  memoryName: string | null;
  bytesWritten: number;
}

export async function writeBrowserArtifacts(
  opts: BrowserWriteOptions,
): Promise<BrowserWriteResult> {
  const writer = new FsaFileWriter(opts.root);
  /* Browser default for writeSnapshot is `true` (the in-browser
     scanner always wants trend data). The Node side defaults to
     `false` (the CLI's `ui` and `export` commands suppress
     snapshots; `analyze` opts in explicitly). The orchestrator's
     default is `false` — so the browser shim flips it when not
     specified, preserving the pre-deepening behavior. */
  const writeSnapshot = opts.writeSnapshot ?? true;

  const result = await writeArtifactsTo(writer, opts.agent, opts.human, {
    /* Conditional-spread because exactOptionalPropertyTypes rejects
       `{ key: undefined }`. */
    ...(opts.streamable !== undefined && { streamable: opts.streamable }),
    writeSnapshot,
    ...(opts.snapshotRetention !== undefined && { snapshotRetention: opts.snapshotRetention }),
    ...(opts.memoryBody !== undefined && { memoryBody: opts.memoryBody }),
  });

  return {
    agentName: result.agentName,
    humanName: result.humanName,
    packName: result.packName,
    jsonlName: result.jsonlName,
    memoryName: result.memoryName,
    snapshotName: result.snapshotName,
    bytesWritten: result.bytesWritten,
  };
}

/**
 * Symmetric reader for the History tab. Mirrors @factstack/emit's
 * `readSnapshots` shape so the same UI code can consume both.
 *
 * Future deepening: a `FileReader` interface (mirror of `FileWriter`)
 * would let one `readSnapshotsFrom(reader)` orchestrator replace both
 * implementations. Tracked in CONTEXT.md.
 */
export async function readBrowserSnapshots(
  root: FileSystemDirectoryHandle,
): Promise<
  Array<{
    at: string;
    loc: number;
    tokens: number;
    files: number;
    risks: number;
    todos: number;
  }>
> {
  let factsDir: FileSystemDirectoryHandle;
  try {
    factsDir = await root.getDirectoryHandle('.facts');
  } catch {
    return [];
  }
  let snapDir: FileSystemDirectoryHandle;
  try {
    snapDir = await factsDir.getDirectoryHandle('snapshots');
  } catch {
    return [];
  }
  const out: Array<{
    at: string;
    loc: number;
    tokens: number;
    files: number;
    risks: number;
    todos: number;
  }> = [];
  const names: string[] = [];
  for await (const name of (snapDir as unknown as { keys: () => AsyncIterableIterator<string> }).keys()) {
    if (name.endsWith('.json')) names.push(name);
  }
  names.sort();
  for (const name of names) {
    try {
      const handle = await snapDir.getFileHandle(name);
      const file = await handle.getFile();
      const text = await file.text();
      const j = JSON.parse(text) as {
        at: string;
        stats?: { loc?: number; totalTokenCost?: number; fileCount?: number };
        risks?: number;
        todos?: number;
      };
      out.push({
        at: j.at,
        loc: j.stats?.loc ?? 0,
        tokens: j.stats?.totalTokenCost ?? 0,
        files: j.stats?.fileCount ?? 0,
        risks: j.risks ?? 0,
        todos: j.todos ?? 0,
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

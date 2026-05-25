/**
 * Node-tier artifact-write shim.
 *
 * Thin wrapper around `writeArtifactsTo` (the isomorphic
 * orchestrator) + Node-specific extras:
 *
 *   - Construct a `NodeFileWriter` for the project's `.facts/` dir
 *   - Invoke `writeArtifactsTo` with the runtime + options
 *   - Optionally append `.facts/` to the project's `.gitignore`
 *     (Node-only — browser callers manage their own gitignore policy)
 *   - Re-expand the returned names into absolute paths so existing
 *     CLI summary code that prints `agentPath` etc. keeps working
 *
 * This file used to be 213 lines of orchestration. The orchestration
 * moved to `orchestrator.ts`; this file is now the Node-specific
 * outer ring. See `CONTEXT.md` for the deepening story.
 *
 * The `readSnapshots` function stays here (Node-only, reads the
 * snapshot sidecar back). That reader is its own thing — a separate
 * deepening opportunity (mirror `FileWriter` with a `FileReader`)
 * that's tracked but not in this commit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { writeArtifactsTo } from './orchestrator.js';
import { NodeFileWriter } from './node-writer.js';

export interface WriteOptions {
  /** Project root — the directory that contains `.facts/`. */
  root: string;
  agent: AgentArtifact;
  human: HumanArtifact;
  /** Also emit the streamable `agent.jsonl` companion. Default true. */
  streamable?: boolean;
  /** Auto-add `.facts/` to root .gitignore if missing. Default true.
   *  Node-only — browser shim doesn't touch any gitignore. */
  addGitignoreEntry?: boolean;
  /**
   * Write a small snapshot (`.facts/snapshots/<ISO>.json`) that
   * stores the 6 headline metrics + timestamp. Used by the History
   * tab to draw trend lines. Off by default so `ui`/`export` don't
   * accrete noise; the `analyze` command turns it on.
   */
  writeSnapshot?: boolean;
  /** Cap snapshot retention; oldest pruned. Default 50; 0 disables. */
  snapshotRetention?: number;
  /**
   * Optional MEMORY.md body. When provided, written to `.facts/MEMORY.md`
   * for AI agents to read FIRST. Caller is responsible for generating
   * via `@factstack/core`'s `buildMemory(agent, human)`.
   */
  memoryBody?: string;
}

/**
 * Node-tier writer entry point. Preserved surface from pre-deepening
 * — every CLI call site is unchanged.
 */
export async function writeArtifacts(opts: WriteOptions): Promise<{
  agentPath: string;
  humanPath: string;
  jsonlPath: string | null;
  packPath: string;
  snapshotPath: string | null;
  memoryPath: string | null;
  bytesWritten: number;
}> {
  const writer = new NodeFileWriter(opts.root);
  /* Conditional-spread because exactOptionalPropertyTypes rejects
     `{ key: undefined }` — the orchestrator's options must either
     have the key set to a real value or not have the key at all. */
  const result = await writeArtifactsTo(writer, opts.agent, opts.human, {
    ...(opts.streamable !== undefined && { streamable: opts.streamable }),
    ...(opts.writeSnapshot !== undefined && { writeSnapshot: opts.writeSnapshot }),
    ...(opts.snapshotRetention !== undefined && { snapshotRetention: opts.snapshotRetention }),
    ...(opts.memoryBody !== undefined && { memoryBody: opts.memoryBody }),
  });

  /* Node-only extra: auto-add `.facts/` to .gitignore so artifacts
     don't leak into commits. Lives here (not in the orchestrator)
     because the browser side never touches any gitignore — the user
     picks the destination directory themselves and owns its content. */
  if (opts.addGitignoreEntry ?? true) {
    await ensureGitignoreEntry(opts.root);
  }

  /* Re-expand names to absolute paths for backward compat with
     existing CLI summary output (`✓ .facts/agent.json` etc.). The
     orchestrator returns just names; the shim resolves them through
     the writer's known root. */
  const root = writer.artifactRoot;
  return {
    agentPath: path.join(root, result.agentName),
    humanPath: path.join(root, result.humanName),
    jsonlPath: result.jsonlName ? path.join(root, result.jsonlName) : null,
    packPath: path.join(root, result.packName),
    memoryPath: result.memoryName ? path.join(root, result.memoryName) : null,
    snapshotPath: result.snapshotName
      ? path.join(root, 'snapshots', result.snapshotName)
      : null,
    bytesWritten: result.bytesWritten,
  };
}

/**
 * Read the snapshot sidecar (`.facts/snapshots/*.json`) into memory
 * so the History tab can plot a sparkline. Returns empty array if
 * absent or on read errors (History shows its empty state).
 *
 * Note: Node-only. The browser-side equivalent is `readBrowserSnapshots`
 * in `@factstack/emit-browser`. Both reads are CURRENTLY duplicated
 * (different filesystem layers, same loop shape). A future `FileReader`
 * interface would let us deepen this the same way `FileWriter` did
 * for the write path — tracked in CONTEXT.md.
 */
export async function readSnapshots(root: string): Promise<Array<{
  at: string;
  loc: number;
  tokens: number;
  files: number;
  risks: number;
  todos: number;
}>> {
  const snapDir = path.join(root, '.facts', 'snapshots');
  let entries: string[];
  try { entries = await fs.readdir(snapDir); }
  catch { return []; }
  const out: Array<{ at: string; loc: number; tokens: number; files: number; risks: number; todos: number }> = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const text = await fs.readFile(path.join(snapDir, name), 'utf8');
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
    } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Idempotent .gitignore append for `.facts/`. The regex anchor on
 * `^\.facts\/?\s*$` matches both `.facts/` and `.facts` so we don't
 * duplicate when either form is already present.
 *
 * Node-only — kept here (not in the orchestrator) per CONTEXT.md's
 * "adapter-specific extras stay on the adapter side" principle.
 */
async function ensureGitignoreEntry(root: string): Promise<void> {
  const giPath = path.join(root, '.gitignore');
  let existing = '';
  try { existing = await fs.readFile(giPath, 'utf8'); }
  catch { /* file will be created */ }
  if (/^\.facts\/?\s*$/m.test(existing)) return;
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const appended = existing + (needsNewline ? '\n' : '') + '\n# FACTS analysis artifacts\n.facts/\n';
  await fs.writeFile(giPath, appended);
}

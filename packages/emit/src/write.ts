import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { AgentArtifactSchema, HumanArtifactSchema } from '@factstack/spec';

/**
 * Write analysis artifacts to `.facts/` in the target project directory.
 *
 * Both artifacts are validated against their Zod schemas before write so
 * we never ship a malformed agent.json to an LLM downstream.
 *
 * Ensures `.facts/` is added to `.gitignore` on first run so artifacts
 * don't leak into commits.
 */

export interface WriteOptions {
  /** Project root — the directory that contains `.facts/`. */
  root: string;
  agent: AgentArtifact;
  human: HumanArtifact;
  /** Also emit the streamable `agent.jsonl` companion. Default true. */
  streamable?: boolean;
  /** Auto-add `.facts/` to root .gitignore if missing. Default true. */
  addGitignoreEntry?: boolean;
  /**
   * Write a small snapshot (`.facts/snapshots/<ISO>/summary.json`) that
   * stores the 6 headline metrics + timestamp. Used by the History tab
   * to draw trend lines. Off by default so `ui`/`export` don't accrete
   * noise; the `analyze` command turns it on.
   */
  writeSnapshot?: boolean;
  /**
   * Maximum number of snapshots to retain in `.facts/snapshots/`. Older
   * ones are deleted oldest-first. Default 50; pass 0 to disable retention
   * (keep every snapshot — safe but unbounded growth in watch mode).
   */
  snapshotRetention?: number;
  /**
   * Optional MEMORY.md body. When provided, written to `.facts/MEMORY.md`
   * for AI agents to read FIRST. Caller is responsible for generating
   * via `@factstack/core`'s `buildMemory(agent, human)`. We accept a
   * pre-built string so this serializer stays source-agnostic.
   */
  memoryBody?: string;
}

export async function writeArtifacts(opts: WriteOptions): Promise<{
  agentPath: string;
  humanPath: string;
  jsonlPath: string | null;
  snapshotPath: string | null;
  memoryPath: string | null;
  bytesWritten: number;
}> {
  // Validate up front; throws a useful error if the shape drifted.
  AgentArtifactSchema.parse(opts.agent);
  HumanArtifactSchema.parse(opts.human);

  const dir = path.join(opts.root, '.facts');
  await fs.mkdir(dir, { recursive: true });

  const agentPath = path.join(dir, 'agent.json');
  const humanPath = path.join(dir, 'human.json');
  const jsonlPath = (opts.streamable ?? true) ? path.join(dir, 'agent.jsonl') : null;

  const agentBody = JSON.stringify(opts.agent, null, 2);
  const humanBody = JSON.stringify(opts.human, null, 2);

  let bytes = 0;
  await fs.writeFile(agentPath, agentBody);
  bytes += Buffer.byteLength(agentBody);
  await fs.writeFile(humanPath, humanBody);
  bytes += Buffer.byteLength(humanBody);

  if (jsonlPath) {
    // One file per line for streamable consumption by LLMs on tight windows.
    const lines = opts.agent.files.map((f) => JSON.stringify(f)).join('\n') + '\n';
    await fs.writeFile(jsonlPath, lines);
    bytes += Buffer.byteLength(lines);
  }

  // MEMORY.md — the v0.3.1 brief that agents read FIRST. Written when
  // caller provides `memoryBody` (CLI does this every analyze).
  let memoryPath: string | null = null;
  if (typeof opts.memoryBody === 'string' && opts.memoryBody.length > 0) {
    memoryPath = path.join(dir, 'MEMORY.md');
    await fs.writeFile(memoryPath, opts.memoryBody);
    bytes += Buffer.byteLength(opts.memoryBody);
  }

  let snapshotPath: string | null = null;
  if (opts.writeSnapshot ?? false) {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    // Millisecond-resolution ISO + exclusive-create retry: two analyses
    // triggered in the same millisecond (rare, but `/api/reanalyze` on a
    // fast loopback can do it) get unique filenames instead of a silent
    // overwrite. Format: 2026-04-22T14-23-07-123Z.json — lexi-sort = chrono.
    const body = JSON.stringify({
      at: opts.human.generatedAt,
      stats: opts.agent.stats,
      risks: opts.agent.risks.length,
      broken: opts.human.summary.health.broken,
      stale: opts.human.summary.health.stale,
      todos: opts.human.summary.health.todos,
      secrets: opts.human.summary.health.secrets,
    }, null, 2);
    const baseStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    for (let suffix = 0; suffix < 1000; suffix++) {
      const name = suffix === 0 ? `${baseStamp}Z.json` : `${baseStamp}Z-${suffix}.json`;
      const candidate = path.join(snapDir, name);
      try {
        await fs.writeFile(candidate, body, { flag: 'wx' });
        snapshotPath = candidate;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;
        // else: collision — bump suffix and retry.
      }
    }
    if (snapshotPath) bytes += Buffer.byteLength(body);

    // Retention: keep the N most recent snapshots so `factstack watch`
    // doesn't accumulate hundreds of files in `.facts/snapshots/`.
    // Default 50; configurable via `WriteOptions.snapshotRetention`.
    // Lexical sort = chrono sort because filenames are ISO timestamps.
    // 0 disables retention (keep everything).
    const keep = opts.snapshotRetention ?? 50;
    if (keep > 0) {
      try {
        const all = (await fs.readdir(snapDir))
          .filter((n) => n.endsWith('.json'))
          .sort();
        if (all.length > keep) {
          const drop = all.slice(0, all.length - keep);
          await Promise.all(drop.map((n) => fs.unlink(path.join(snapDir, n)).catch(() => undefined)));
        }
      } catch { /* readdir failures are non-fatal — snapshots still written */ }
    }
  }

  if (opts.addGitignoreEntry ?? true) {
    await ensureGitignoreEntry(opts.root);
  }

  return { agentPath, humanPath, jsonlPath, snapshotPath, memoryPath, bytesWritten: bytes };
}

/**
 * Read the snapshot sidecar (`.facts/snapshots/*.json`) into memory so
 * the History tab can plot a sparkline. Returns empty array if absent
 * or on read errors (History shows its empty state).
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

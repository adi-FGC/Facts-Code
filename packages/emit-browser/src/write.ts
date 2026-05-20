/**
 * Browser-side artifact writer — twin of @factstack/emit's writeArtifacts().
 *
 * The user picks a destination via showDirectoryPicker({ mode: 'readwrite' }),
 * we materialize a `.facts/` subdirectory inside it, and stream the same
 * five files (agent.json, human.json, agent.pack, agent.jsonl, snapshots/)
 * through `FileSystemWritableFileStream`.
 *
 * Validation parity:
 *   We run the SAME Zod schemas as the Node writer (AgentArtifactSchema /
 *   HumanArtifactSchema) before any byte hits disk. A malformed agent
 *   shape that reaches an LLM downstream is the bug class this prevents.
 *
 * Why no .gitignore manipulation:
 *   The Node writer auto-appends `.facts/` to the project's .gitignore
 *   so artifacts don't leak into commits. Browser-side, the user already
 *   chose the destination explicitly — they may have picked a non-git
 *   directory (Documents, Downloads, an external drive). Touching
 *   .gitignore at a directory we don't know is git-tracked would be
 *   surprising. If callers want it, they can do it themselves with the
 *   same handle.
 *
 * Why no MEMORY.md path:
 *   `writeBrowserArtifacts` accepts `memoryBody` and writes it identically
 *   to the Node writer when present. The optional-string contract matches.
 *
 * Snapshots:
 *   Same lexically-sortable ISO timestamp + suffix-on-collision pattern,
 *   though FSA doesn't expose an exclusive-create flag. We mitigate by
 *   listing the snapshots dir first and picking the next free name.
 *   Race-window is theoretical (browser tab can't double-fire writes
 *   from a single click), so we don't loop on EEXIST the way Node does.
 */

import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { AgentArtifactSchema, HumanArtifactSchema } from '@factstack/spec';
import { encodeAgentPack } from '@factstack/emit/pure';

export interface BrowserWriteOptions {
  /** User-picked destination directory. Must be opened with mode: 'readwrite'. */
  root: FileSystemDirectoryHandle;
  agent: AgentArtifact;
  human: HumanArtifact;
  /** Also emit the streamable `agent.jsonl` companion. Default true. */
  streamable?: boolean;
  /** Write a snapshot row to `.facts/snapshots/<ISO>.json`. Default true
   *  (browser callers always want trend data — they don't have a separate
   *  `analyze` vs `ui` flow like the CLI). */
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
  // Validate up front. Same schemas as the Node writer — the contract
  // doesn't move just because the I/O surface did.
  AgentArtifactSchema.parse(opts.agent);
  HumanArtifactSchema.parse(opts.human);

  const factsDir = await opts.root.getDirectoryHandle('.facts', { create: true });

  const agentBody = JSON.stringify(opts.agent, null, 2);
  const humanBody = JSON.stringify(opts.human, null, 2);
  const packBody = encodeAgentPack(opts.agent);

  let bytes = 0;
  bytes += await writeText(factsDir, 'agent.json', agentBody);
  bytes += await writeText(factsDir, 'human.json', humanBody);
  bytes += await writeText(factsDir, 'agent.pack', packBody);

  let jsonlName: string | null = null;
  if (opts.streamable ?? true) {
    const lines = opts.agent.files.map((f) => JSON.stringify(f)).join('\n') + '\n';
    bytes += await writeText(factsDir, 'agent.jsonl', lines);
    jsonlName = 'agent.jsonl';
  }

  let memoryName: string | null = null;
  if (typeof opts.memoryBody === 'string' && opts.memoryBody.length > 0) {
    bytes += await writeText(factsDir, 'MEMORY.md', opts.memoryBody);
    memoryName = 'MEMORY.md';
  }

  let snapshotName: string | null = null;
  if (opts.writeSnapshot ?? true) {
    const snapDir = await factsDir.getDirectoryHandle('snapshots', { create: true });
    const body = JSON.stringify(
      {
        at: opts.human.generatedAt,
        stats: opts.agent.stats,
        risks: opts.agent.risks.length,
        broken: opts.human.summary.health.broken,
        stale: opts.human.summary.health.stale,
        todos: opts.human.summary.health.todos,
        secrets: opts.human.summary.health.secrets,
      },
      null,
      2,
    );
    snapshotName = await writeSnapshot(snapDir, body);
    bytes += new TextEncoder().encode(body).byteLength;

    const keep = opts.snapshotRetention ?? 50;
    if (keep > 0) {
      await pruneSnapshots(snapDir, keep);
    }
  }

  return {
    agentName: 'agent.json',
    humanName: 'human.json',
    jsonlName,
    packName: 'agent.pack',
    snapshotName,
    memoryName,
    bytesWritten: bytes,
  };
}

/* ─────────── helpers ─────────── */

/** Create-or-open + truncate-write + close. Returns byte count for the
 *  caller's running total. */
async function writeText(
  dir: FileSystemDirectoryHandle,
  name: string,
  body: string,
): Promise<number> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(body);
  } finally {
    /* Always close — leaving a writable open holds the file lock and the
       next write attempt will throw NoModificationAllowedError. The Node
       writer doesn't have to think about this because fs.writeFile closes
       its own descriptor; FSA makes the lifecycle explicit. */
    await writable.close();
  }
  return new TextEncoder().encode(body).byteLength;
}

/**
 * Pick a free filename in the snapshots dir. Uses ms-resolution ISO
 * + numeric suffix on collision. We list the dir up-front instead of
 * looping on FSA's `getFileHandle` because there's no exclusive-create
 * flag — `{create: true}` always succeeds and overwrites.
 */
async function writeSnapshot(
  snapDir: FileSystemDirectoryHandle,
  body: string,
): Promise<string> {
  const baseStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const existing = new Set<string>();
  for await (const name of (snapDir as unknown as { keys: () => AsyncIterableIterator<string> }).keys()) {
    existing.add(name);
  }
  for (let suffix = 0; suffix < 1000; suffix++) {
    const name = suffix === 0 ? `${baseStamp}Z.json` : `${baseStamp}Z-${suffix}.json`;
    if (existing.has(name)) continue;
    await writeText(snapDir, name, body);
    return name;
  }
  // 1000 collisions in one ms → user is doing something unusual; fall back.
  const fallback = `${baseStamp}Z-${Date.now()}.json`;
  await writeText(snapDir, fallback, body);
  return fallback;
}

/** Keep the N lexically-newest `.json` snapshots, delete the rest. */
async function pruneSnapshots(
  snapDir: FileSystemDirectoryHandle,
  keep: number,
): Promise<void> {
  const names: string[] = [];
  for await (const name of (snapDir as unknown as { keys: () => AsyncIterableIterator<string> }).keys()) {
    if (name.endsWith('.json')) names.push(name);
  }
  names.sort();
  if (names.length <= keep) return;
  const drop = names.slice(0, names.length - keep);
  await Promise.all(
    drop.map((n) =>
      snapDir.removeEntry(n).catch(() => undefined),
    ),
  );
}

/**
 * Symmetric reader for the History tab. Mirrors @factstack/emit's
 * readSnapshots() shape so the same UI code can consume both.
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

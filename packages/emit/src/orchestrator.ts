/**
 * `writeArtifactsTo` — the pure, isomorphic artifact-write orchestrator.
 *
 * Takes a `FileWriter` (Node FS / FSA / in-memory) and writes the full
 * FACTS artifact set: `agent.json`, `human.json`, `agent.pack`, and
 * optionally `agent.jsonl`, `MEMORY.md`, and a snapshot row.
 *
 * Replaces the two near-identical implementations that previously
 * lived in `packages/emit/src/write.ts` and
 * `packages/emit-browser/src/write.ts`. Both still exist as thin
 * shims that construct the right adapter and call this function.
 *
 * Constraint C1 (isomorphic): no `node:*` imports, no DOM types. The
 * orchestrator only knows about the `FileWriter` interface; adapters
 * supply the I/O.
 *
 * Paths used here are pure RELATIVE — the adapter scopes itself to
 * the project's `.facts/` root internally. So `agent.json` and
 * `snapshots/X.json` are all the orchestrator ever names. Adapters
 * auto-mkdirp parent directories on write.
 */

import type { AgentArtifact, FileWriter, HumanArtifact } from '@factstack/spec';
import { AgentArtifactSchema, HumanArtifactSchema } from '@factstack/spec';
import { encodeAgentPack } from './pack.js';

export interface WriteArtifactsToOptions {
  /** Also emit the streamable `agent.jsonl` companion. Default true. */
  streamable?: boolean;
  /**
   * Write a snapshot row to `snapshots/<ISO>.json`. Off by default
   * for `factstack ui` and `factstack export`; the `analyze` command
   * + browser scanner both turn it on.
   */
  writeSnapshot?: boolean;
  /**
   * Maximum number of snapshot rows to retain. Older ones are
   * pruned oldest-first (lexical sort = chronological since names
   * are ISO timestamps). Default 50; pass 0 to keep everything.
   */
  snapshotRetention?: number;
  /**
   * Optional pre-built MEMORY.md body. Caller is responsible for
   * generating via `@factstack/core`'s `buildMemory(agent, human)`.
   * We accept a pre-built string so this orchestrator stays
   * source-agnostic. When omitted or empty, no MEMORY.md is written.
   */
  memoryBody?: string;
}

export interface WriteArtifactsResult {
  /** Always written: `agent.json`. */
  agentName: 'agent.json';
  /** Always written: `human.json`. */
  humanName: 'human.json';
  /** Always written: `agent.pack`. */
  packName: 'agent.pack';
  /** `agent.jsonl`, or null when streamable: false. */
  jsonlName: string | null;
  /** `MEMORY.md`, or null when memoryBody is omitted/empty. */
  memoryName: string | null;
  /** Name of the snapshot file under `snapshots/`, or null when
   *  writeSnapshot: false. The Node shim resolves this to a full
   *  path; in-browser callers use it as-is. */
  snapshotName: string | null;
  /** Sum of bytes written across every file in this call. */
  bytesWritten: number;
}

/**
 * Orchestrator entry point. Pure delegation to the `FileWriter`.
 *
 * 1. Validate `agent` + `human` against their Zod schemas. Throws
 *    if either is malformed — we never ship a broken artifact.
 * 2. Write the three always-on files (agent.json, human.json, pack).
 * 3. Conditionally write jsonl, MEMORY.md, snapshot.
 * 4. If snapshots are on AND retention is positive, prune oldest.
 *
 * Returns a flat `WriteArtifactsResult` with the names (not paths)
 * of every written file plus a `bytesWritten` total.
 */
export async function writeArtifactsTo(
  writer: FileWriter,
  agent: AgentArtifact,
  human: HumanArtifact,
  options: WriteArtifactsToOptions = {},
): Promise<WriteArtifactsResult> {
  // Validate up front — same Zod schemas for every tier. Throws a
  // useful error if the shape drifted.
  AgentArtifactSchema.parse(agent);
  HumanArtifactSchema.parse(human);

  const agentBody = JSON.stringify(agent, null, 2);
  const humanBody = JSON.stringify(human, null, 2);
  /* v0.3.10 — FactsPack encoding for the AI surface. agent.json
     continues to ship for one deprecation cycle so existing readers
     don't break. The two files derive from the SAME in-memory
     artifact — no two-source-of-truth drift. */
  const packBody = encodeAgentPack(agent);

  let bytes = 0;
  bytes += await writer.writeText('agent.json', agentBody);
  bytes += await writer.writeText('human.json', humanBody);
  bytes += await writer.writeText('agent.pack', packBody);

  let jsonlName: string | null = null;
  if (options.streamable ?? true) {
    // One file per line for streamable consumption by LLMs on tight
    // context windows.
    const lines = agent.files.map((f) => JSON.stringify(f)).join('\n') + '\n';
    bytes += await writer.writeText('agent.jsonl', lines);
    jsonlName = 'agent.jsonl';
  }

  let memoryName: string | null = null;
  if (typeof options.memoryBody === 'string' && options.memoryBody.length > 0) {
    bytes += await writer.writeText('MEMORY.md', options.memoryBody);
    memoryName = 'MEMORY.md';
  }

  let snapshotName: string | null = null;
  if (options.writeSnapshot ?? false) {
    snapshotName = await writeSnapshotFile(writer, agent, human);
    if (snapshotName) {
      // Account for the snapshot bytes — writeText returns them but
      // writeSnapshotFile is the one that knows the body. Recompute
      // via TextEncoder for the byte count parity (UTF-8). The cost
      // is one encode of a small JSON blob (< 1 KB typical).
      const body = buildSnapshotBody(agent, human);
      bytes += new TextEncoder().encode(body).byteLength;
    }

    const keep = options.snapshotRetention ?? 50;
    if (keep > 0) {
      await pruneSnapshots(writer, keep);
    }
  }

  return {
    agentName: 'agent.json',
    humanName: 'human.json',
    packName: 'agent.pack',
    jsonlName,
    memoryName,
    snapshotName,
    bytesWritten: bytes,
  };
}

/* ─────────── snapshot helpers ─────────── */

/**
 * Single shared snapshot-body builder — was previously duplicated
 * between Node and browser writers verbatim. The 7 fields are the
 * History tab's sparkline data source; do NOT add fields here
 * without updating `readSnapshots` (in the Node shim) +
 * `readBrowserSnapshots` (in the browser shim) to read them back.
 */
function buildSnapshotBody(agent: AgentArtifact, human: HumanArtifact): string {
  return JSON.stringify(
    {
      at: human.generatedAt,
      stats: agent.stats,
      risks: agent.risks.length,
      broken: human.summary.health.broken,
      stale: human.summary.health.stale,
      todos: human.summary.health.todos,
      secrets: human.summary.health.secrets,
    },
    null,
    2,
  );
}

/**
 * Pick a free filename in `snapshots/` and write the body. Returns
 * the chosen name (relative to the snapshots dir; the caller
 * resolves to a full path if needed).
 *
 * Algorithm: list-first-pick-free-name.
 *   - Build the ms-resolution ISO timestamp basename.
 *   - List `snapshots/` keys.
 *   - Pick the first name not already taken: `<stamp>Z.json`,
 *     then `<stamp>Z-1.json`, `<stamp>Z-2.json`, ...
 *
 * We deliberately don't use Node's `flag: 'wx'` exclusive-create —
 * the FileWriter interface is symmetric and the previous
 * Node-specific atomic retry loop existed to handle a race
 * ("two analyses in the same millisecond") that is vanishingly
 * rare on a single-tenant CLI. List-first works on both tiers.
 */
async function writeSnapshotFile(
  writer: FileWriter,
  agent: AgentArtifact,
  human: HumanArtifact,
): Promise<string | null> {
  const body = buildSnapshotBody(agent, human);
  const baseStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  /* listKeys returns empty array if snapshots/ doesn't exist yet — the
     adapter auto-creates the directory on first writeText. So we don't
     need to mkdir explicitly. */
  const existing = new Set(await writer.listKeys('snapshots').catch(() => []));

  for (let suffix = 0; suffix < 1000; suffix++) {
    const name = suffix === 0 ? `${baseStamp}Z.json` : `${baseStamp}Z-${suffix}.json`;
    if (existing.has(name)) continue;
    await writer.writeText(`snapshots/${name}`, body);
    return name;
  }
  /* 1000 collisions in one millisecond — user is doing something
     unusual. Fall back to a Date.now() suffix that's guaranteed
     unique modulo a microsecond. */
  const fallback = `${baseStamp}Z-${Date.now()}.json`;
  await writer.writeText(`snapshots/${fallback}`, body);
  return fallback;
}

/**
 * Keep the `keep` lexically-newest `.json` snapshot files; delete
 * the rest. Pure logic over the listKeys output — no I/O of its
 * own beyond the adapter calls.
 *
 * readKeys failures are swallowed: the snapshot dir might not
 * exist yet on a fresh project, and retention isn't load-bearing.
 */
async function pruneSnapshots(writer: FileWriter, keep: number): Promise<void> {
  let names: string[];
  try {
    names = (await writer.listKeys('snapshots')).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  if (names.length <= keep) return;
  names.sort(); // lexi sort = chrono sort since names are ISO timestamps
  const drop = names.slice(0, names.length - keep);
  /* removeEntry is contractually a no-op on missing entries, so we
     don't need to wrap in try/catch. Parallel because the adapter's
     deletes are independent. */
  await Promise.all(drop.map((n) => writer.removeEntry('snapshots', n)));
}

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
import { computeDiff, decode, encodeIncremental, type PackHeader } from '@factstack/factspack';
import { encodeAgentPack } from './pack.js';

/**
 * Emit profile — controls which artifacts land on disk.
 *
 *   - `legacy` (default): the full historical set. `agent.json` (raw
 *     JSON for tooling/scripts that can't read the pack), `agent.jsonl`
 *     (streamable per-file), the snapshot row, plus the always-on
 *     `agent.pack` + `human.json` + optional `MEMORY.md`.
 *
 *   - `minimal`: the AI-first core only. `agent.pack` (the canonical,
 *     token-efficient AI surface), `human.json` (dashboard), and
 *     `MEMORY.md` (cold-start brief) when a body is supplied. Drops the
 *     three redundant encodings: `agent.json` (pack supersedes it),
 *     `agent.jsonl` (derivable), and the snapshot (History-tab only).
 *
 * Explicit `streamable` / `writeSnapshot` options still WIN over the
 * profile when set — the profile only changes their *defaults*. This
 * keeps the CLI's existing per-command snapshot control intact.
 */
export type EmitProfile = 'minimal' | 'legacy';

export interface WriteArtifactsToOptions {
  /**
   * Which artifact set to write. Default `legacy` (the full set) so no
   * existing caller's output changes unless it opts in. See
   * {@link EmitProfile}. `minimal` drops `agent.json` + `agent.jsonl` +
   * snapshot; `agent.pack` + `human.json` (+ `MEMORY.md`) always ship.
   */
  profile?: EmitProfile;
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
  /**
   * F8 — the PREVIOUS `agent.pack` body, pre-read by the caller (the
   * shims read it before this overwrites the file). When present and
   * decodable, we additionally emit `agent.diff.pack`: the row-level
   * delta from that master to this one, so a consumer holding the prior
   * master applies a small diff instead of re-reading the whole pack.
   * Omit it (or pass a body we can't use) and only the full master is
   * written — the sidecar is purely additive and best-effort.
   */
  prevPackBody?: string;
}

export interface WriteArtifactsResult {
  /** `agent.json`, or null in the `minimal` profile (pack supersedes it). */
  agentName: 'agent.json' | null;
  /** Always written: `human.json`. */
  humanName: 'human.json';
  /** Always written: `agent.pack`. */
  packName: 'agent.pack';
  /** F8 — `agent.diff.pack` when a usable `prevPackBody` was supplied and
   *  the diff emitted; null otherwise (cold run, or an unusable prev). */
  diffName: 'agent.diff.pack' | null;
  /** `agent.jsonl`, or null when streamable: false / minimal profile. */
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

  const profile: EmitProfile = options.profile ?? 'legacy';
  const isMinimal = profile === 'minimal';

  const humanBody = JSON.stringify(human, null, 2);
  /* FactsPack is the canonical AI surface (~80% fewer tokens than the
     raw JSON). It ships in EVERY profile — minimal and legacy alike. */
  const packBody = encodeAgentPack(agent);

  let bytes = 0;

  /* agent.json: the raw-JSON encoding. Redundant with agent.pack for
     AI consumption, but several CLI commands (scan-vulns, diff,
     export-skills/diagram, ci-report) read it back as their source of
     truth, and external tooling may parse it. So it stays in `legacy`
     and is dropped in `minimal`. */
  let agentName: 'agent.json' | null = null;
  if (!isMinimal) {
    bytes += await writer.writeText('agent.json', JSON.stringify(agent, null, 2));
    agentName = 'agent.json';
  }

  bytes += await writer.writeText('human.json', humanBody);
  bytes += await writer.writeText('agent.pack', packBody);

  /* F8 — incremental diff sidecar. When the caller supplies the previous
     master, emit `agent.diff.pack`: the row-level delta from it to this
     pack (encodeIncremental(computeDiff(prev, next))). It's a depth-1
     accelerator — always the diff vs the immediately preceding master, not
     a growing chain — so a consumer holding the prior master applies one
     small diff instead of re-reading the whole pack. The full `agent.pack`
     master above is untouched; the sidecar is purely additive.

     Best-effort by design: any failure (a corrupt / pre-v0.2 / truncated
     prev, a schema drift, a duplicate PK) skips the diff and leaves the
     master as the source of truth. The emit step must never fail because
     the accelerator couldn't build. The diff header's producer/schema/
     snapshotId come from re-decoding the master we just wrote, so the
     sidecar's identity can never drift from the pack it describes. */
  let diffName: 'agent.diff.pack' | null = null;
  if (options.prevPackBody) {
    try {
      const prev = decode(options.prevPackBody); // strict: throws on corrupt/legacy/truncated
      const next = decode(packBody);
      // Only diff a verifiable, same-schema master: the trailer sha anchors
      // the chain (the consumer verifies it before applying), and a schema
      // mismatch (e.g. an agent-v3 pack on disk) makes the rows incomparable.
      // PACK-3: the prev MUST be a master — diffing against a diff (kind:'diff')
      // would compute a delta-of-a-delta the consumer could never apply. decode
      // treats an absent kind as a legacy master, so reject only explicit diffs.
      if (prev.trailer && prev.header.kind !== 'diff' && prev.header.schema === next.header.schema) {
        const header: PackHeader = {
          producer: next.header.producer,
          schema: next.header.schema,
          snapshotId: next.header.snapshotId,
          rowCount: 0, // spec §7 diff sentinel — encodeIncremental enforces 0 here (not a placeholder)
          seq: (prev.header.seq ?? 1) + 1,
          parent: prev.trailer.sha256, // 12-hex of the master this diff applies onto
          kind: 'diff',
          ...(next.header.generated !== undefined && { generated: next.header.generated }),
        };
        const diffBody = encodeIncremental({ header, tables: computeDiff(prev, next) });
        bytes += await writer.writeText('agent.diff.pack', diffBody);
        diffName = 'agent.diff.pack';
      }
    } catch {
      /* accelerator failed — master is still authoritative, carry on */
    }
  }

  /* agent.jsonl: streamable per-file. Profile sets the default
     (legacy on, minimal off); an explicit `streamable` still wins. */
  let jsonlName: string | null = null;
  if (options.streamable ?? !isMinimal) {
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

  /* Snapshot: History-tab trend data, off unless the caller opts in.
     Callers that want it on own that default explicitly — the browser
     shim passes `writeSnapshot: !isMinimal` and the CLI's `analyze`
     opts in — so the orchestrator needs no profile-based fallback. */
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
    agentName,
    humanName: 'human.json',
    packName: 'agent.pack',
    diffName,
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

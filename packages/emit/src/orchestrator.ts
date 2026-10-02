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
import { AgentArtifactSchema, BASELINE_AGENT_FILE, HumanArtifactSchema } from '@factstack/spec';
import { computeDiff, decode, encodeIncremental, type PackHeader } from '@factstack/factspack';
import { encodeAgentPack } from './pack.js';
import {
  RAW_JSON_ARTIFACTS,
  StaleResaveError,
  buildStaleMark,
  packGeneratedAt,
  staleMarkName,
  type RawJsonArtifact,
} from './stale-mark.js';

const BASELINE_DIR = BASELINE_AGENT_FILE.slice(0, BASELINE_AGENT_FILE.lastIndexOf('/'));
/** Left next to the baseline by earlier builds, whose --minimal rewrote
 *  agent.json: "agent.json is a --minimal head, do not park it". Only read
 *  (then removed) by a full write; minimal no longer touches agent.json. */
const LEGACY_MINIMAL_HEAD_MARK = 'minimal-head';

/** An error as one short line for `diffSkipped` (messages can be multi-line
 *  or quote a whole pack row). */
function oneLine(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > 200 ? `${msg.slice(0, 199)}…` : msg || 'unknown error';
}

/** Top-level `generatedAt` of a serialized agent.json; null when the body is
 *  not a parseable artifact. */
function generatedAtOf(body: string): string | null {
  try {
    const at = (JSON.parse(body) as { generatedAt?: unknown } | null)?.generatedAt;
    return typeof at === 'string' ? at : null;
  } catch {
    return null;
  }
}

/** Is a refused write a re-save of the analysis agent.json holds (same
 *  `generatedAt`), rather than a new analysis? Only asked on the refusal
 *  path, so reading the multi-MB agent.json costs nothing on a normal run.
 *  Unknown (no reader, a read error) keeps the guard's original re-save
 *  wording; no agent.json at all means a new analysis. */
async function isResaveOfDiskAgent(
  writer: FileWriter,
  generatedAt: string,
  prevAgentBody: string | undefined,
): Promise<boolean> {
  let body: string | null | undefined = prevAgentBody;
  if (body === undefined && writer.readText) {
    body = await writer.readText('agent.json').catch(() => undefined);
  }
  if (body === undefined) return true;
  return body !== null && generatedAtOf(body) === generatedAt;
}

/** Is the agent.pack on disk (still) the one this run wrote? Unknown (no
 *  reader, a read error, no header stamp) counts as yes: the caller then
 *  writes a stale mark, and a needless mark is the safe side. */
async function packIsStill(writer: FileWriter, generatedAt: string): Promise<boolean> {
  if (!writer.readText) return true;
  const body = await writer.readText('agent.pack').catch(() => undefined);
  if (body === undefined || body === null) return true;
  const at = packGeneratedAt(body);
  return at === null || Date.parse(at) === Date.parse(generatedAt);
}

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
 *     "Drops" means never WRITES: an `agent.json` / `agent.jsonl` an
 *     earlier full run left stays as it is (rewriting ~8 MB on every
 *     per-edit hook run was performance#1), and is marked stale with a
 *     tiny `<file>.stale` BEFORE the newer pack lands, so no reader serves
 *     it as current (see `stale-mark.ts`). Since minimal never replaces
 *     agent.json, it also never touches the review baseline: agent.json
 *     stays the last full analysis, parked by the next full run.
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
  /**
   * The PREVIOUS `agent.json` body, pre-read by the caller (like
   * `prevPackBody`). When this run writes a new `agent.json`, the old one
   * is kept first at `BASELINE_AGENT_FILE` (keep-1), so `review` /
   * `review_change` / `since` compare two full artifacts. Omit it on a
   * first run — nothing to keep. Not parked when it is the same analysis
   * (same `generatedAt`) or unparseable. Unused by `minimal`, which never
   * replaces agent.json.
   */
  prevAgentBody?: string;
  /**
   * Treat this write as a new analysis for the review baseline. Default
   * true. Pass false for a write that must not move the baseline — a re-save
   * of an analysis already on disk (scan-vulns, the MCP CVE refresh), or a
   * refresh during a hold: the baseline is then left exactly as it is,
   * whatever `generatedAt` the rewritten artifact carries. Only about the
   * baseline; see `refuseUnderNewerPack` for the stale-write guard.
   */
  rotateBaseline?: boolean;
  /**
   * Refuse the write with a `StaleResaveError` (nothing written) when
   * `prevPackBody` shows a NEWER analysis in agent.pack than `agent`: a
   * --minimal hook run landed after this analysis was loaded or made, and
   * writing it would revert agent.pack, human.json and MEMORY.md. Default:
   * on exactly when `rotateBaseline` is false (the historical coupling,
   * which the CLI refresh and MCP warm-up rely on). Set it explicitly to
   * decouple the two: `true` guards a rotating write too, `false` lets a
   * non-rotating one overwrite (last writer wins).
   */
  refuseUnderNewerPack?: boolean;
}

export interface WriteArtifactsResult {
  /** `agent.json`, or null in the `minimal` profile (pack supersedes it;
   *  one an earlier run left is marked stale instead — see `staleLeft`). */
  agentName: 'agent.json' | null;
  /** Always written: `human.json`. */
  humanName: 'human.json';
  /** Always written: `agent.pack`. */
  packName: 'agent.pack';
  /** F8 — `agent.diff.pack` when a usable `prevPackBody` was supplied and
   *  the diff emitted; null otherwise (cold run, or an unusable prev). */
  diffName: 'agent.diff.pack' | null;
  /** Why no diff was written although a previous pack was supplied (an
   *  unreadable or pre-v0.2 prev, a schema change, a computeDiff failure
   *  such as a duplicate primary key). Absent when the diff was written or
   *  there was no previous pack. One line, for the caller to print dimmed:
   *  the write itself still succeeded. */
  diffSkipped?: string;
  /** `agent.jsonl`, or null when streamable: false / minimal profile. */
  jsonlName: string | null;
  /** Raw-JSON artifacts an earlier run left that this run did NOT refresh,
   *  so they now carry a `<file>.stale` mark (older than the pack). Absent
   *  when there are none. For the caller to mention, dimmed. */
  staleLeft?: RawJsonArtifact[];
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
 *    if either is malformed — we never ship a broken artifact. Refuse a
 *    write under a newer pack (`StaleResaveError`, see
 *    `refuseUnderNewerPack`).
 * 2. Mark a leftover agent.json / agent.jsonl this run won't refresh
 *    stale, then write agent.json + agent.jsonl (legacy; clearing their
 *    marks), human.json, the pack; re-check the marks a concurrent run
 *    may have cleared meanwhile.
 * 3. Conditionally write the diff sidecar, MEMORY.md, snapshot.
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
  const rotate = options.rotateBaseline ?? true;
  const refuseUnderNewer = options.refuseUnderNewerPack ?? !rotate;

  /* Never revert a NEWER analysis (see `refuseUnderNewerPack`). When
     agent.pack is ahead of this one, refuse before anything is touched —
     and say whether this was a re-save of a stale agent.json or a new
     analysis that was overtaken (EMIT-REV-2: the old wording blamed
     agent.json for both). */
  if (refuseUnderNewer && options.prevPackBody !== undefined) {
    const onDisk = packGeneratedAt(options.prevPackBody);
    if (onDisk !== null && Date.parse(onDisk) > Date.parse(agent.generatedAt)) {
      throw new StaleResaveError(
        agent.generatedAt,
        onDisk,
        await isResaveOfDiskAgent(writer, agent.generatedAt, options.prevAgentBody),
      );
    }
  }

  const humanBody = JSON.stringify(human, null, 2);
  /* FactsPack is the canonical AI surface (~80% fewer tokens than the
     raw JSON). It ships in EVERY profile — minimal and legacy alike. */
  const packBody = encodeAgentPack(agent);

  let bytes = 0;

  /* What an earlier run left at the artifact root (listKeys returns [] for
     a missing dir). null = the listing failed: then assume anything may
     exist — a needless stale mark is harmless, a missing one would let an
     old agent.json pass as current. */
  const listed = await writer.listKeys('').then(
    (keys) => new Set(keys),
    () => null,
  );
  const mayExist = (name: string): boolean => listed === null || listed.has(name);

  /* An agent.diff.pack from an earlier run describes an OLDER master. Drop
     it before any artifact lands: a run that builds no diff (cold, unusable
     prev, schema change, computeDiff failure) must not leave a sidecar that
     sync_pack would pair with this master, and a reader landing mid-write
     sees "no diff" rather than new master + old diff. Best-effort, like the
     FSA adapter: a Windows EBUSY/EPERM (indexer, antivirus) must not abort
     the write — sync_pack refuses a diff whose snapshotId doesn't match. */
  await writer.removeEntry('', 'agent.diff.pack').catch(() => undefined);

  /* The raw-JSON encodings this run refreshes. agent.json is redundant with
     agent.pack for AI consumption, but several CLI commands (scan-vulns,
     diff, review, export-skills/diagram, ci-report) read it back as their
     source of truth, and external tooling may parse it — so `legacy` writes
     it. `minimal` never writes either: rewriting them on every per-edit hook
     run cost ~5x the bytes (performance#1). An explicit `streamable` still
     wins for agent.jsonl. */
  const refreshes: Record<RawJsonArtifact, boolean> = {
    'agent.json': !isMinimal,
    'agent.jsonl': options.streamable ?? !isMinimal,
  };

  /* One an earlier run left and this run does not refresh is now older than
     the pack: mark it stale BEFORE any newer artifact lands, so no reader
     ever sees a newer pack beside an unmarked older agent.json (a crash in
     between leaves a conservative mark). Only the first run of a streak
     writes it — `staleSince` stays the first newer analysis — so later hook
     runs add no bytes. A mark whose file is gone is dropped. */
  const staleLeft: RawJsonArtifact[] = [];
  for (const file of RAW_JSON_ARTIFACTS) {
    if (refreshes[file]) continue; // its mark is cleared once the file lands
    const mark = staleMarkName(file);
    if (mayExist(file)) {
      if (listed !== null) staleLeft.push(file);
      if (!(listed?.has(mark) ?? false)) {
        bytes += await writer.writeText(mark, buildStaleMark(file, agent.generatedAt));
      }
    } else if (mayExist(mark)) {
      await writer.removeEntry('', mark).catch(() => undefined);
    }
  }
  /* After `file` itself landed. Best-effort: a mark that survives a locked
     delete only makes readers say "stale" of a fresh file (the safe side),
     and the next full run retries. */
  const clearStaleMark = async (file: RawJsonArtifact): Promise<void> => {
    const mark = staleMarkName(file);
    if (mayExist(mark)) await writer.removeEntry('', mark).catch(() => undefined);
  };

  let agentName: 'agent.json' | null = null;
  if (refreshes['agent.json']) {
    /* Keep-1 review baseline: the previous agent.json, parked just before
       it is replaced. It is always a FULL analysis — minimal never writes
       agent.json, so after a hook streak it still holds the last full run.
       A rewrite of the SAME analysis (scan-vulns, CVE refresh) parks nothing
       — the MCP reader drops a baseline equal to the head — and neither does
       an unparseable body. rotateBaseline:false skips all of it (a re-save,
       or a refresh during a hold). An earlier build's --minimal DID rewrite
       agent.json and left LEGACY_MINIMAL_HEAD_MARK: that head is not parked,
       once. */
    const held =
      rotate &&
      (await writer.listKeys(BASELINE_DIR).catch((): string[] => [])).includes(
        LEGACY_MINIMAL_HEAD_MARK,
      );
    const prev = rotate ? options.prevAgentBody : undefined;
    const prevAt = prev !== undefined ? generatedAtOf(prev) : null;
    const sameAnalysis = prevAt === agent.generatedAt;
    if (prev !== undefined && !held && prevAt !== null && !sameAnalysis) {
      bytes += await writer.writeText(BASELINE_AGENT_FILE, prev);
    }
    bytes += await writer.writeText('agent.json', JSON.stringify(agent, null, 2));
    agentName = 'agent.json';
    await clearStaleMark('agent.json');
    if (held && !sameAnalysis) {
      await writer.removeEntry(BASELINE_DIR, LEGACY_MINIMAL_HEAD_MARK).catch(() => undefined);
    }
  }

  /* agent.jsonl: streamable per-file. Profile sets the default (legacy on,
     minimal off — one an earlier run left is marked stale above); an
     explicit `streamable` still wins. Written — and its mark cleared —
     BEFORE the pack, like agent.json (EMIT-REV-6): a run clears marks only
     while its own pack has not landed yet, so a concurrent --minimal run
     whose pack lands later always sees the cleared mark in its post-pack
     check below. Cleared after the pack, a mark could vanish beside an
     older agent.jsonl and a newer pack. */
  let jsonlName: string | null = null;
  if (refreshes['agent.jsonl']) {
    // One file per line for streamable consumption by LLMs on tight
    // context windows.
    const lines = agent.files.map((f) => JSON.stringify(f)).join('\n') + '\n';
    bytes += await writer.writeText('agent.jsonl', lines);
    jsonlName = 'agent.jsonl';
    await clearStaleMark('agent.jsonl');
  }

  bytes += await writer.writeText('human.json', humanBody);
  bytes += await writer.writeText('agent.pack', packBody);

  /* EMIT-REV-6 — the pre-write marks above are check-then-act: this run
     listed the root, found a mark and skipped writing it, and a concurrent
     full run may have cleared it since (after writing its OLDER agent.json,
     before this pack landed). Re-list now that the pack is down: a raw file
     this run did not refresh that sits unmarked beside our pack gets its
     mark back. Skipped when a later run already replaced our pack (that run
     owns the marks), which only a reader can tell: see packIsStill. One
     directory listing per run; a failed listing keeps what the pre-write
     pass did (it marked conservatively when ITS listing failed). */
  const unrefreshed = RAW_JSON_ARTIFACTS.filter((file) => !refreshes[file]);
  if (unrefreshed.length > 0) {
    const now = await writer.listKeys('').then(
      (keys) => new Set(keys),
      () => null,
    );
    const cleared = unrefreshed.filter((f) => now?.has(f) && !now.has(staleMarkName(f)));
    if (cleared.length > 0 && (await packIsStill(writer, agent.generatedAt))) {
      for (const file of cleared) {
        bytes += await writer.writeText(
          staleMarkName(file),
          buildStaleMark(file, agent.generatedAt),
        );
        if (!staleLeft.includes(file)) staleLeft.push(file);
      }
    }
  }

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
     the accelerator couldn't build — but it says why (`diffSkipped`), so a
     producer bug such as a duplicate primary key is visible instead of
     silently costing every consumer the small diff. The diff header's
     producer/schema/snapshotId come from re-decoding the master we just
     wrote, so the sidecar's identity can never drift from the pack it
     describes. */
  let diffName: 'agent.diff.pack' | null = null;
  let diffSkipped: string | undefined;
  if (options.prevPackBody) {
    let stage = 'previous agent.pack is unreadable';
    try {
      const prev = decode(options.prevPackBody); // strict: throws on corrupt/legacy/truncated
      stage = 'the new agent.pack does not decode';
      const next = decode(packBody);
      // Only diff a verifiable, same-schema master: the trailer sha anchors
      // the chain (the consumer verifies it before applying), and a schema
      // mismatch (e.g. an agent-v3 pack on disk) makes the rows incomparable.
      // PACK-3: the prev MUST be a master — diffing against a diff (kind:'diff')
      // would compute a delta-of-a-delta the consumer could never apply. decode
      // treats an absent kind as a legacy master, so reject only explicit diffs.
      if (!prev.trailer) {
        diffSkipped = 'previous agent.pack has no integrity trailer (pre-v0.2)';
      } else if (prev.header.kind === 'diff') {
        diffSkipped = 'previous agent.pack is a diff, not a master';
      } else if (prev.header.schema !== next.header.schema) {
        diffSkipped = `pack schema changed (${prev.header.schema} → ${next.header.schema})`;
      } else {
        stage = 'computing the diff failed';
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
        stage = 'writing agent.diff.pack failed';
        bytes += await writer.writeText('agent.diff.pack', diffBody);
        diffName = 'agent.diff.pack';
      }
    } catch (err) {
      /* accelerator failed — master is still authoritative, carry on */
      diffSkipped = `${stage}: ${oneLine(err)}`;
    }
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
    ...(diffSkipped !== undefined && { diffSkipped }),
    jsonlName,
    ...(staleLeft.length > 0 && { staleLeft }),
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

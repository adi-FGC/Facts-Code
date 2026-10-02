/**
 * F8 consumer — the pure decision behind the `sync_pack` MCP tool.
 *
 * Given the on-disk master (`agent.pack`), the optional diff sidecar
 * (`agent.diff.pack`), and the sha256 the caller currently holds, decide the
 * smallest correct response:
 *
 *   - `current` — the caller already holds the current master. Send nothing.
 *   - `diff`    — the caller holds the diff's parent (one step behind). Send the
 *                 small delta; the caller reads the + added / x removed rows.
 *   - `full`    — first fetch, stale, or unknown master. Send the whole master.
 *
 * Extracted from the server handler so the branch logic is unit-testable
 * without the stdio transport. Pure: it only decodes the bytes it's handed.
 */
import { decode } from '@factstack/factspack';

export interface SyncPackResult {
  status: 'current' | 'diff' | 'full' | 'error';
  /** The current master's 12-hex sha256 — the caller passes this back as
   *  `have` next time. Absent only on `error`. */
  sha?: string;
  /** The pack text to read: the diff (status `diff`) or the master (`full`).
   *  Absent on `current` (nothing to send) and `error`. */
  pack?: string;
  /** Present only on `error`. */
  error?: string;
}

export function resolveSyncPack(
  masterBody: string,
  diffBody: string | undefined,
  have: string | undefined,
): SyncPackResult {
  // The master's trailer sha is the chain anchor. Strict decode (the default)
  // REQUIRES + verifies the integrity trailer, so a trailerless / truncated /
  // corrupt master throws here and is caught below; on success the trailer is
  // guaranteed present.
  let master: ReturnType<typeof decode>;
  try {
    master = decode(masterBody);
  } catch {
    return { status: 'error', error: 'unreadable or trailerless master pack' };
  }
  const currentSha = master.trailer!.sha256;

  // Already current — nothing to send but the confirmation + the sha held.
  if (have && have === currentSha) {
    return { status: 'current', sha: currentSha };
  }

  // One step behind — return the diff only when it bridges the caller's held
  // master to the CURRENT one: its parent is what they hold AND it was built
  // for this master (the producer stamps a diff with its target's identity).
  // A sidecar left by an earlier run, or read between the pack write and the
  // diff write, targets an older master; applying it would leave the caller
  // on that master while recording the current sha. Best-effort: an
  // unreadable or non-bridging diff falls through to the full master.
  if (have && diffBody) {
    try {
      const d = decode(diffBody);
      const h = d.header;
      const m = master.header;
      if (
        h.kind === 'diff' &&
        h.parent === have &&
        h.snapshotId === m.snapshotId &&
        h.schema === m.schema &&
        (h.generated === undefined || m.generated === undefined || h.generated === m.generated)
      ) {
        return { status: 'diff', sha: currentSha, pack: diffBody };
      }
    } catch {
      /* unreadable diff → fall through to the full master */
    }
  }

  // First fetch, stale, or unknown master — send the full master.
  return { status: 'full', sha: currentSha, pack: masterBody };
}

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
  let currentSha: string;
  try {
    currentSha = decode(masterBody).trailer!.sha256;
  } catch {
    return { status: 'error', error: 'unreadable or trailerless master pack' };
  }

  // Already current — nothing to send but the confirmation + the sha held.
  if (have && have === currentSha) {
    return { status: 'current', sha: currentSha };
  }

  // One step behind — return the diff only when it bridges the caller's held
  // master to the current one (its parent == what they hold). Best-effort: an
  // unreadable or non-bridging diff falls through to the full master.
  if (have && diffBody) {
    try {
      const d = decode(diffBody);
      if (d.header.kind === 'diff' && d.header.parent === have) {
        return { status: 'diff', sha: currentSha, pack: diffBody };
      }
    } catch {
      /* unreadable diff → fall through to the full master */
    }
  }

  // First fetch, stale, or unknown master — send the full master.
  return { status: 'full', sha: currentSha, pack: masterBody };
}

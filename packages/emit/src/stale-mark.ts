/**
 * Stale marks for the raw-JSON artifacts (`agent.json`, `agent.jsonl`).
 *
 * The per-edit `analyze --minimal` hook refreshes only the AI-first core
 * (agent.pack, human.json, MEMORY.md). Rewriting a multi-MB agent.json +
 * agent.jsonl on every edit made each hook run write ~5x the bytes
 * (performance#1), so minimal leaves them in place — and, so that nothing
 * ever reads them as current by accident, drops a tiny `<file>.stale` mark
 * next to each one BEFORE the newer pack lands. The next run that writes
 * the file itself (a full analyze) removes its mark after the file lands.
 *
 * Rule for readers: `.facts/<file>.stale` exists ⇒ `<file>` describes an
 * OLDER analysis than agent.pack / human.json. Tell the user (or refresh
 * with a full analyze) instead of serving it as current. The file itself
 * is still the last FULL analysis, so it stays a valid review baseline.
 *
 * Isomorphic (C1): no `node:*` imports. The Node reader lives in
 * `stale-mark-node.ts`.
 */

/** The raw-JSON artifacts a run can leave behind the pack. */
export const RAW_JSON_ARTIFACTS = ['agent.json', 'agent.jsonl'] as const;
export type RawJsonArtifact = (typeof RAW_JSON_ARTIFACTS)[number];

/** `.facts/`-relative name of the mark for `file`. */
export function staleMarkName(file: RawJsonArtifact): `${RawJsonArtifact}.stale` {
  return `${file}.stale`;
}

/** What a mark says. `staleSince` is the `generatedAt` of the first newer
 *  analysis (the run that left `file` behind); null when unreadable. */
export interface StaleMark {
  file: RawJsonArtifact;
  staleSince: string | null;
}

/** The mark's body: one small JSON object, readable by a human too. */
export function buildStaleMark(file: RawJsonArtifact, staleSince: string): string {
  return (
    JSON.stringify(
      {
        file,
        staleSince,
        reason: `a newer analysis (agent.pack, human.json, MEMORY.md) was written without refreshing ${file}`,
        fix: 'run `factstack analyze` (without --minimal) to refresh it',
      },
      null,
      2,
    ) + '\n'
  );
}

/** Read a mark's body. Any mark that exists means stale, so an unreadable
 *  body still yields a mark, just without `staleSince`. */
export function parseStaleMark(file: RawJsonArtifact, body: string | null): StaleMark {
  try {
    const at = (JSON.parse(body ?? '') as { staleSince?: unknown } | null)?.staleSince;
    return { file, staleSince: typeof at === 'string' ? at : null };
  } catch {
    return { file, staleSince: null };
  }
}

/** One line for a reader to print when it finds a mark. */
export function staleHint(mark: StaleMark): string {
  const since = mark.staleSince ? ` (a newer analysis exists since ${mark.staleSince})` : '';
  return (
    `.facts/${mark.file} is older than the newest analysis${since}: ` +
    'the per-edit `analyze --minimal` refreshes agent.pack, human.json and MEMORY.md only. ' +
    'Run `factstack analyze` to refresh it.'
  );
}

/** `generated` (header field 8) of a serialized pack; null when absent.
 *  Reads the first line only — no decode of the whole master. */
export function packGeneratedAt(packBody: string): string | null {
  const nl = packBody.indexOf('\n');
  const header = nl === -1 ? packBody : packBody.slice(0, nl);
  if (!header.startsWith('#')) return null;
  const at = header.replace(/\r$/, '').split('\t')[7];
  return at && at !== '-' ? at : null;
}

/**
 * Thrown by a write that refuses to land under a NEWER agent.pack
 * (`refuseUnderNewerPack`, on by default for `rotateBaseline: false`).
 * Writing it would revert agent.pack, human.json and MEMORY.md to an older
 * analysis. Nothing is written.
 *
 * Two cases, told apart by `resave` so the message never misleads:
 *   - a RE-SAVE (scan-vulns, the MCP CVE refresh) of the analysis agent.json
 *     holds: agent.json is stale (a --minimal run landed since it was loaded);
 *   - a NEW analysis (a `ui` / `watch` refresh, an MCP warm-up) that a newer
 *     one overtook while it ran: nothing is stale, it just lost the race.
 */
export class StaleResaveError extends Error {
  readonly code = 'FACTS_STALE_RESAVE';
  constructor(
    /** `generatedAt` of the analysis the caller tried to write. */
    readonly resaveAt: string,
    /** `generated` of the newer agent.pack on disk. */
    readonly packAt: string,
    /** true = a re-save of the analysis in agent.json (the default: the
     *  guard's original case); false = a new analysis that was overtaken. */
    readonly resave: boolean = true,
  ) {
    super(
      resave
        ? `not re-saving the analysis from ${resaveAt}: .facts/agent.pack already holds a newer one ` +
            `(${packAt}), so .facts/agent.json is stale. Run \`factstack analyze\`, then retry.`
        : `not writing the analysis from ${resaveAt}: .facts/agent.pack already holds a newer one ` +
            `(${packAt}), written while it ran (the per-edit \`analyze --minimal\` hook?). ` +
            'Writing it would revert agent.pack, human.json and MEMORY.md, so nothing was written. ' +
            'Run the analysis again.',
    );
    this.name = 'StaleResaveError';
  }
}

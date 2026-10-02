/**
 * Argument checks for the tools whose inputs have no Zod schema in
 * @factstack/spec (`since`, `query_learnings`). A malformed timestamp used to
 * pass straight through: `since{timestamp:'yesterday'}` answered "nothing
 * changed", `query_learnings{since:'garbage'}` ignored the filter, and
 * `limit:-1` silently dropped the oldest event (MCP-13). Also the length cap
 * on graph-tool globs. Pure.
 */
import { MAX_GLOB_LENGTH } from '@factstack/spec';

export interface ArgIssue {
  field: string;
  message: string;
}

/** ISO 8601 date or date-time (optional seconds, fraction and offset). */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

export function isIsoTimestamp(v: unknown): v is string {
  return typeof v === 'string' && ISO_8601.test(v) && Number.isFinite(Date.parse(v));
}

const EXAMPLE = 'an ISO 8601 timestamp, e.g. "2026-04-30T00:00:00Z"';

export function sinceArgIssues(args: Record<string, unknown>): ArgIssue[] {
  const ts = args.timestamp;
  if (ts === undefined || ts === '')
    return [{ field: 'timestamp', message: `required: ${EXAMPLE}` }];
  if (!isIsoTimestamp(ts)) return [{ field: 'timestamp', message: `must be ${EXAMPLE}` }];
  return [];
}

/** Longest glob a graph tool accepts. The matcher is linear now (MCP-11);
 *  the cap is defense in depth against a pathological pattern. It IS spec's
 *  MAX_GLOB_LENGTH, which the schemas the CLI `query` parses with also carry
 *  (INV7: one cap, never a local copy that can drift). */
export const GLOB_MAX_CHARS: number = MAX_GLOB_LENGTH;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** query_graph `filter` and query `query.start.glob` / `query.where.pathGlob`:
 *  at most GLOB_MAX_CHARS. Checked before the Zod parse so the answer names
 *  the field in the same `{ field, message }` shape as the other arg checks. */
export function globArgIssues(args: Record<string, unknown>): ArgIssue[] {
  const q = isObj(args.query) ? args.query : {};
  const globs: Array<[string, unknown]> = [
    ['filter', args.filter],
    ['query.start.glob', isObj(q.start) ? q.start.glob : undefined],
    ['query.where.pathGlob', isObj(q.where) ? q.where.pathGlob : undefined],
  ];
  return globs
    .filter(([, v]) => typeof v === 'string' && v.length > GLOB_MAX_CHARS)
    .map(([field]) => ({ field, message: `at most ${GLOB_MAX_CHARS} characters` }));
}

export const LEARNINGS_LIMIT_MAX = 5000;

export function queryLearningsArgIssues(args: Record<string, unknown>): ArgIssue[] {
  const issues: ArgIssue[] = [];
  for (const field of ['since', 'until'] as const) {
    if (args[field] !== undefined && !isIsoTimestamp(args[field])) {
      issues.push({ field, message: `must be ${EXAMPLE}` });
    }
  }
  const limit = args.limit;
  if (
    limit !== undefined &&
    !(
      typeof limit === 'number' &&
      Number.isInteger(limit) &&
      limit >= 1 &&
      limit <= LEARNINGS_LIMIT_MAX
    )
  ) {
    issues.push({ field: 'limit', message: `must be an integer from 1 to ${LEARNINGS_LIMIT_MAX}` });
  }
  return issues;
}

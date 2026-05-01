/**
 * Postmortem learning log — v0.3.4.
 *
 * Append-only JSONL of every AI proposal and its eventual outcome.
 * Three jobs:
 *
 *   1. Calibration substrate for the v0.6 trust framework. Every
 *      proposal stores `{agent, action, outcome, confidence}`; over
 *      time we can answer "this agent has been right 84% of the time
 *      on refactor proposals" without trusting anyone's word for it.
 *
 *   2. Audit trail. Humans can grep `learnings.jsonl` and see who
 *      proposed what, when, and what happened next. Diff-able under
 *      git.
 *
 *   3. Self-calibration even before any external agent connects.
 *      FACTS itself emits `self-calibrate` events on every analyze
 *      run with file/token/risk counts so the analyzer's own behavior
 *      becomes a tracked time series.
 *
 * Module split:
 *   - This file: pure / isomorphic functions (validate, format, parse,
 *     query). No Node imports, no fs.
 *   - The CLI / MCP server: provide the actual write-to-disk via
 *     `node:fs.appendFileSync(.facts/learnings.jsonl, line)`.
 *
 * The JSONL format (one event per line, no surrounding array) is
 * chosen so:
 *   - Appends are O(1) — no rewrite of prior lines.
 *   - Each line is self-contained and JSON.parse-able alone.
 *   - Corruption of one line never breaks the rest of the file.
 *   - `tail -f .facts/learnings.jsonl | jq` works as a live console.
 */

import { z } from 'zod';

export const LEARNINGS_SCHEMA_VERSION = 'factstack-learnings.v1' as const;

/* `outcome` is the lifecycle state of the proposal at the time of
 * logging. `pending` lets us log a proposal without knowing the
 * outcome yet — a follow-up event with the same ticketId + a final
 * outcome closes the loop. `self-calibrate` is reserved for events
 * FACTS emits about its own runs (not about external proposals). */
export const LearningOutcomeSchema = z.enum([
  'accepted',
  'rejected',
  'pending',
  'self-calibrate',
]);
export type LearningOutcome = z.infer<typeof LearningOutcomeSchema>;

export const LearningEventSchema = z.object({
  /** Always set; lets older readers detect format drift early. */
  schemaVersion: z.literal(LEARNINGS_SCHEMA_VERSION),
  /** ISO 8601 timestamp at the moment the event was logged. */
  timestamp: z.string().datetime(),
  /** Agent identifier. Stable across sessions for an external agent;
   *  always `'factstack-self'` for self-calibrate events. */
  agent: z.string().min(1),
  /** Optional model id when the agent uses a specific one (e.g.
   *  `claude-opus-4`, `gpt-5.4`). Self-events leave this empty. */
  model: z.string().optional(),
  /** Optional ticket id linking to .facts/tickets/<id>.json. The
   *  same ticketId can appear on multiple events as the lifecycle
   *  progresses (pending → accepted/rejected). */
  ticketId: z.string().optional(),
  /** Short verb-form proposal: `fix-typo`, `add-test`, `refactor-X`,
   *  `analyze`, `reanalyze`, etc. Bound to 64 chars to keep the log
   *  readable; longer descriptions go into `reasoning`. */
  action: z.string().min(1).max(64),
  /** What happened to the proposal. */
  outcome: LearningOutcomeSchema,
  /** Optional 1-2 sentence rationale. Hard cap at 500 chars so
   *  malformed callers don't bloat the log. */
  reasoning: z.string().max(500).optional(),
  /** Files this proposal would have touched, in order. */
  filesAffected: z.array(z.string()).optional(),
  /** Self-reported confidence at proposal time, 0..1. Used by the
   *  v0.6 trust framework for per-agent calibration curves. */
  confidence: z.number().min(0).max(1).optional(),
  /** Free-form tags for slicing later (`security`, `perf`, `lint`). */
  tags: z.array(z.string()).optional(),
  /** Arbitrary structured payload — strict shape per `action` is up
   *  to callers. Reserved for future structured fields without a
   *  schema bump. */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type LearningEvent = z.infer<typeof LearningEventSchema>;

/* ─────────────────────────────────────────────────────────────────
 * PURE serializers — encode + decode the JSONL wire format.
 * ─────────────────────────────────────────────────────────────── */

/** Serialize a validated event to a single JSONL line (terminated by \n).
 *  Throws if the event doesn't validate against the schema. */
export function formatLearningEvent(event: unknown): string {
  const parsed = LearningEventSchema.parse(event);
  return JSON.stringify(parsed) + '\n';
}

/** Parse a JSONL document into events. Tolerates blank lines and
 *  malformed lines (skipped, returned in `errors[]`). The strict
 *  validation here keeps quirky data from poisoning the consumer. */
export function parseLearningsJsonl(text: string): { events: LearningEvent[]; errors: Array<{ line: number; reason: string }> } {
  const events: LearningEvent[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push({ line: i + 1, reason: 'invalid JSON' });
      continue;
    }
    const result = LearningEventSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({ line: i + 1, reason: result.error.issues.map((iss) => iss.message).join('; ') });
      continue;
    }
    events.push(result.data);
  }
  return { events, errors };
}

/* ─────────────────────────────────────────────────────────────────
 * PURE in-memory filter — used by both the MCP `query_learnings` tool
 * and any local script that wants to slice the log without parsing
 * outside this module.
 * ─────────────────────────────────────────────────────────────── */

export interface LearningQuery {
  /** Inclusive lower bound; ISO timestamp. */
  since?: string;
  /** Inclusive upper bound; ISO timestamp. */
  until?: string;
  /** Only events from this agent. */
  agent?: string;
  /** Only events with this outcome. */
  outcome?: LearningOutcome;
  /** Only events whose `action` field equals this string (exact). */
  action?: string;
  /** Only events whose `tags` array contains this tag. */
  tag?: string;
  /** Cap on returned events. Default 200; max 5000 to keep payloads sane. */
  limit?: number;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

/** Filter an event list by the query. Returns most-recent-first
 *  (descending timestamp), capped at `limit`. */
export function queryLearnings(events: LearningEvent[], q: LearningQuery = {}): LearningEvent[] {
  const limit = Math.min(MAX_LIMIT, q.limit ?? DEFAULT_LIMIT);
  const sinceMs = q.since ? Date.parse(q.since) : -Infinity;
  const untilMs = q.until ? Date.parse(q.until) : Infinity;
  const out: LearningEvent[] = [];
  for (const e of events) {
    const ts = Date.parse(e.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts < sinceMs || ts > untilMs) continue;
    if (q.agent && e.agent !== q.agent) continue;
    if (q.outcome && e.outcome !== q.outcome) continue;
    if (q.action && e.action !== q.action) continue;
    if (q.tag && !(e.tags ?? []).includes(q.tag)) continue;
    out.push(e);
  }
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return out.slice(0, limit);
}

/* ─────────────────────────────────────────────────────────────────
 * Convenience builders for the two callers we ship with v0.3.4:
 *   - `selfCalibrateEvent` — emitted by FACTS itself on every analyze
 *   - `proposalEvent` — emitted by external agents via MCP
 * ─────────────────────────────────────────────────────────────── */

export interface SelfCalibrateInput {
  fileCount: number;
  totalLoc: number;
  totalTokens: number;
  riskCount: number;
  /** Wall-clock duration of the analyze run, in milliseconds. */
  durationMs: number;
  timestamp?: string;
}

/** Build a `self-calibrate` event for a FACTS analyze run. Used by
 *  the CLI right after analysis completes. */
export function selfCalibrateEvent(input: SelfCalibrateInput): LearningEvent {
  return {
    schemaVersion: LEARNINGS_SCHEMA_VERSION,
    timestamp: input.timestamp ?? new Date().toISOString(),
    agent: 'factstack-self',
    action: 'analyze',
    outcome: 'self-calibrate',
    meta: {
      fileCount: input.fileCount,
      totalLoc: input.totalLoc,
      totalTokens: input.totalTokens,
      riskCount: input.riskCount,
      durationMs: input.durationMs,
    },
  };
}

export interface ProposalInput {
  agent: string;
  action: string;
  outcome: LearningOutcome;
  model?: string;
  ticketId?: string;
  reasoning?: string;
  filesAffected?: string[];
  confidence?: number;
  tags?: string[];
  meta?: Record<string, unknown>;
  timestamp?: string;
}

/** Build a learning event for an external agent proposal. Strict
 *  validation in the schema catches bad inputs early. */
export function proposalEvent(input: ProposalInput): LearningEvent {
  const event: LearningEvent = {
    schemaVersion: LEARNINGS_SCHEMA_VERSION,
    timestamp: input.timestamp ?? new Date().toISOString(),
    agent: input.agent,
    action: input.action,
    outcome: input.outcome,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.ticketId !== undefined ? { ticketId: input.ticketId } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(input.filesAffected !== undefined ? { filesAffected: input.filesAffected } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };
  return LearningEventSchema.parse(event);
}

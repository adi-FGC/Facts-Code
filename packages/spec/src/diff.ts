/**
 * diff.v1.json — structured delta between two analyses.
 *
 * Consumed by `factstack diff` (CLI TTY + --json), the upcoming
 * MCP server's `list_diff` tool (v0.3), and the History tab's
 * "changes since" expansion.
 *
 * The schema is deliberately additive-only within a major version
 * (same contract as agent.json + human.json).
 */

import { z } from 'zod';
import { FACTS_SCHEMA_VERSION } from './agent.js';

export const DiffEndpointSchema = z.object({
  /** ISO timestamp of the snapshot the comparison used. */
  at: z.string(),
  /** Path to the snapshot file on disk (present only when loaded from
   *  `.facts/snapshots/*.json`; absent when loaded from live state). */
  snapshotFile: z.string().optional(),
});

export const DiffDeltaSchema = z.object({
  before: z.number(),
  after: z.number(),
  delta: z.number(),
});

/* v0.7 — vulnerability delta surface.
 *
 *   - `new`    — vuln IDs present in `to` but not `from` (regressions).
 *   - `fixed`  — vuln IDs present in `from` but not `to` (improvements).
 *   - `severityShift` — signed integer summarizing direction + magnitude
 *     of the change. Computed via weighted scoring
 *     (critical:4, high:3, medium:2, low:1, unknown:0). Positive = worse
 *     security posture; negative = better; zero = neutral.
 *
 * The shift score captures the asymmetry a count delta misses: one new
 * critical + one fixed low = +3 (clearly worse), whereas a naive count
 * delta of 0 would suggest no change. PR-comment renderers use this as
 * their headline number.
 */
export const VulnDiffSchema = z.object({
  new: z.array(z.string()).default([]),
  fixed: z.array(z.string()).default([]),
  severityShift: z.number().int().default(0),
});

export const DiffStatsSchema = z.object({
  loc: DiffDeltaSchema,
  tokens: DiffDeltaSchema,
  files: DiffDeltaSchema,
  risks: DiffDeltaSchema,
  todos: DiffDeltaSchema,
  secrets: DiffDeltaSchema,
  /* v0.7 — vulns count delta. Defaults to {0,0,0} so pre-v0.7 diff
   *  JSON validates unchanged. Same backward-compat pattern as
   *  AgentArtifact's dependencyManifests[]/vulnerabilities[] defaults. */
  vulns: DiffDeltaSchema.default({ before: 0, after: 0, delta: 0 }),
});

export const DiffFileChangeSchema = z.object({
  path: z.string(),
  locDelta: z.number(),
  tokenDelta: z.number(),
});

export const DiffArtifactSchema = z.object({
  $schema: z
    .literal('https://factstack.dev/schema/diff.v1.json')
    .default('https://factstack.dev/schema/diff.v1.json'),
  factsVersion: z.literal(FACTS_SCHEMA_VERSION).default(FACTS_SCHEMA_VERSION),
  generatedAt: z.string(),
  from: DiffEndpointSchema,
  to: DiffEndpointSchema,
  stats: DiffStatsSchema,
  /** File-path diff — membership-only (no content diff).
   *  `changed` is present when the same path appears in both endpoints
   *  AND any stat differs (token/LOC).
   *  `incomplete: true` signals one endpoint had no `files[]` (snapshot
   *  rollup); added/removed/changed are empty in that case and the
   *  TTY/JSON consumers should surface a "(per-file diff unavailable)"
   *  hint instead of misleading "everything added" numbers. */
  files: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(DiffFileChangeSchema),
    incomplete: z.literal(true).optional(),
  }),
  /* v0.7 — vulnerability ID-level diff. Defaults to empty arrays +
   *  zero shift so pre-v0.7 diff JSON validates unchanged. Consumers
   *  that don't care about vulns simply ignore this field. */
  vulns: VulnDiffSchema.default({ new: [], fixed: [], severityShift: 0 }),
});

export type DiffArtifact = z.infer<typeof DiffArtifactSchema>;
export type VulnDiff = z.infer<typeof VulnDiffSchema>;

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

export const DiffStatsSchema = z.object({
  loc: DiffDeltaSchema,
  tokens: DiffDeltaSchema,
  files: DiffDeltaSchema,
  risks: DiffDeltaSchema,
  todos: DiffDeltaSchema,
  secrets: DiffDeltaSchema,
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
});

export type DiffArtifact = z.infer<typeof DiffArtifactSchema>;

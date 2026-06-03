/**
 * verdict.v1.json — the "Change Verdict": one opinionated, grounded answer
 * to "what does this change do to the system, and how risky is it?"
 *
 * Composed by `buildChangeVerdict` in @factstack/core from a DiffArtifact
 * plus the head artifact's dependency graph. Consumed by `factstack review`
 * (CLI markdown + JSON) and the MCP `review_change` tool.
 *
 * Unlike a raw diff, a verdict fuses the deltas (secrets, vulnerabilities,
 * structural cycles, risk count) with BLAST RADIUS (how many modules
 * transitively depend on the changed files) into a single severity headline.
 * The whole point: structural truth a reviewer (human or agent) can act on,
 * not a count dump.
 *
 * Additive-only within a major version, same contract as agent/human/diff.
 */

import { z } from 'zod';
import { FACTS_SCHEMA_VERSION } from './agent.js';
import { DiffEndpointSchema } from './diff.js';

/** Rolled-up verdict severity. `none` = the change moved nothing risk-relevant. */
export const ReviewSeveritySchema = z.enum(['none', 'low', 'medium', 'high', 'critical']);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

/** Per-finding severity. No `none` — a finding that exists is at least `low`. */
export const FindingSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** What kind of thing the change did. */
export const FindingKindSchema = z.enum(['secret', 'vulnerability', 'cycle', 'hotspot', 'risk']);
export type FindingKind = z.infer<typeof FindingKindSchema>;

/**
 * One concrete thing the change did, with the evidence to verify it.
 * `evidence` is open by kind: file paths for hotspots/cycles, advisory ids
 * for vulnerabilities, a raw count for risk-count moves.
 */
export const ChangeFindingSchema = z.object({
  kind: FindingKindSchema,
  severity: FindingSeveritySchema,
  /** Short, human-readable claim, e.g. "Introduces 1 new dependency cycle". */
  title: z.string(),
  /** One sentence of grounded detail naming the actual evidence. */
  detail: z.string(),
  evidence: z
    .object({
      files: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
      count: z.number().optional(),
    })
    .optional(),
});
export type ChangeFinding = z.infer<typeof ChangeFindingSchema>;

/**
 * How far the change can reach. `maxReach` = the largest transitive-caller
 * count among the changed files; `topFile` = which file that was. This is
 * the "if I break this, what else breaks" number, computed from the head
 * graph's reverse edges.
 */
export const BlastRadiusSchema = z.object({
  /** Count of added + content-changed files considered. */
  changedFiles: z.number(),
  /** Max transitive dependents of any single changed file. */
  maxReach: z.number(),
  /** The changed file with the largest blast radius (absent when none). */
  topFile: z.string().optional(),
});
export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

/** The raw scoreboard the headline is built from. */
export const ChangeVerdictSummarySchema = z.object({
  filesAdded: z.number(),
  filesChanged: z.number(),
  filesRemoved: z.number(),
  secretsAdded: z.number(),
  risksDelta: z.number(),
  vulnsNew: z.number(),
  vulnsFixed: z.number(),
  /** Weighted security-posture shift carried over from the DiffArtifact. */
  severityShift: z.number(),
  cyclesNew: z.number(),
});
export type ChangeVerdictSummary = z.infer<typeof ChangeVerdictSummarySchema>;

export const ChangeVerdictSchema = z.object({
  $schema: z
    .literal('https://factstack.dev/schema/verdict.v1.json')
    .default('https://factstack.dev/schema/verdict.v1.json'),
  factsVersion: z.literal(FACTS_SCHEMA_VERSION).default(FACTS_SCHEMA_VERSION),
  generatedAt: z.string(),
  from: DiffEndpointSchema,
  to: DiffEndpointSchema,
  /** Rolled-up severity = the max finding severity, or `none`. */
  severity: ReviewSeveritySchema,
  /** One-line, severity-prefixed summary suitable for a PR-comment title. */
  headline: z.string(),
  findings: z.array(ChangeFindingSchema),
  blastRadius: BlastRadiusSchema,
  summary: ChangeVerdictSummarySchema,
});
export type ChangeVerdict = z.infer<typeof ChangeVerdictSchema>;

// ───────────────────────── SEVERITY MODEL (the verdict contract) ──────────────
//
// Lives in @factstack/spec, next to the schema, so EVERY surface scores findings
// identically: the core engine (`buildChangeVerdict`), the CLI (`factstack
// review`), the MCP tool (`review_change`), and the web /review panel all import
// these. Putting them here (a tiny, zod-only package) also keeps the browser
// bundle from pulling the whole analyzer just to reuse a handful of constants.
//
//   - A leaked secret is the worst thing a change can add → `high`.
//   - A new vulnerability inherits the advisory's own severity.
//   - A new dependency cycle is a structural regression → `medium`.
//   - A widely-depended-on file (big blast radius) is a `medium` caution at
//     HOTSPOT_MEDIUM transitive dependents, a `low` note at HOTSPOT_LOW.
//   - Any other net-new risk finding → `low`.
//   - The rolled-up verdict severity is the MAX finding severity.

export const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const SECRET_SEVERITY: FindingSeverity = 'high';
export const CYCLE_SEVERITY: FindingSeverity = 'medium';
export const RISK_DELTA_SEVERITY: FindingSeverity = 'low';
export const HOTSPOT_LOW = 5; // ≥ this many transitive dependents → low hotspot note
export const HOTSPOT_MEDIUM = 20; // ≥ this many → medium hotspot caution

/** Map a vulnerability/advisory severity string onto a finding severity. */
export function vulnFindingSeverity(sev: string): FindingSeverity {
  switch (sev) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    default:
      return 'low'; // low / unknown / anything unexpected
  }
}

/** Rolled-up verdict severity = the worst finding, or `none`. */
export function rollupSeverity(findings: ChangeFinding[]): ReviewSeverity {
  let worst: ReviewSeverity = 'none';
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}

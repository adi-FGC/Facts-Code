/**
 * Severity constants + helpers for the Change Verdict — the part of
 * `review.ts` that has NO zod in it.
 *
 * Split out (v0.3.11) because the dashboard imports these at runtime and
 * used to reach them through the package barrel, which also re-exports every
 * zod schema in the package. A bundler update stopped tree-shaking those
 * schemas out of the entry chunk (+55 KB raw / +12.5 KB gz on first paint).
 * Importing `@factstack/spec/review-severity` cannot pull zod in, whatever
 * the bundler decides. `review.ts` re-exports everything here, so existing
 * importers are unaffected.
 */

import type { ChangeFinding, FindingSeverity, ReviewSeverity } from './review.js';

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

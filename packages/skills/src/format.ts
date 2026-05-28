/**
 * Tiny formatting helpers shared across renderers.
 *
 * Lives in its own file rather than inlined per renderer because the
 * three renderers (claude/cursor/copilot) had three byte-identical
 * copies of this function, which is exactly the "duplication is a
 * fact" signal that justifies promotion.
 *
 * Kept dependency-free + isomorphic — same constraint as the rest of
 * @factstack/skills.
 */

/**
 * Format an integer for display: 1.2M / 3.4K / 567.
 *
 * Tokens and LOC use the same scale (both are large integers humans
 * want to skim at-a-glance), so one formatter serves both. The unit
 * label travels with the call site, not the formatter.
 */
export function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

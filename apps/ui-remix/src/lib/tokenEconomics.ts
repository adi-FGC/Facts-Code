/**
 * tokenEconomics — the math behind the Overview "cost to give an agent
 * this project" panel.
 *
 * The pitch FACTS makes, quantified: putting a whole codebase in an AI
 * agent's context window costs `stats.tokens` tokens every time. Loading
 * the FACTS artifact instead — the structural map of the same project —
 * costs a fraction, and the agent then opens only the handful of files a
 * task actually touches.
 *
 * This module is the pure arithmetic. No DOM, no model SDK. The caller
 * measures the artifact's serialized size (see measureArtifactChars in
 * ui/TokenRoiPanel.tsx) and passes it in; everything here is testable in
 * isolation.
 *
 * Honesty notes (surfaced in the panel caption, not hidden):
 *   - NEITHER side is an exact token count. `fullTokens` comes from the
 *     analyzer's `approximateTokens` (packages/scanners/src/tokencost.ts),
 *     which is `Math.round(text.length / 3.5)` — a char-based estimate that
 *     the scanner documents as tracking cl100k "within ~8%". It is NOT
 *     cl100k tokenization, and the panel must not claim it is.
 *   - `artifactTokens` is the same kind of estimate over the artifact's
 *     serialized length.
 *   - Both sides therefore use the SAME divisor. They used to differ (3.5
 *     for the codebase, 4 for the artifact), which made the artifact look
 *     ~14% smaller than the same rule would make the codebase and inflated
 *     both `ratio` and `savedFraction` by that much. The old comment here
 *     claimed dividing by 4 was "the conservative direction (it makes FACTS
 *     look worse, not better)" — that was backwards: a smaller artifact is
 *     a BIGGER saving. A ratio is only meaningful when its two sides are
 *     measured the same way, so if the analyzer ever adopts real tiktoken,
 *     this must follow it rather than keep a rule-of-thumb.
 *   - The artifact we measure is the dashboard's own data block, a
 *     superset of the lean agent.json. Real agent-facing artifacts are
 *     smaller still — that one IS conservative.
 */

/**
 * Chars per token. Must stay equal to the divisor in the analyzer's
 * `approximateTokens` (packages/scanners/src/tokencost.ts), or the two
 * halves of every ratio on this panel stop being comparable.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Anything carrying an input rate can price a run. Structural on purpose, so
 * `CatalogModel` (lib/modelCatalog.ts) satisfies it without a conversion —
 * and so a live-refreshed rate can be substituted for a baked one with no
 * change here.
 *
 * The three hardcoded Haiku/Sonnet/Opus presets that used to live in this
 * file were replaced on 2026-09-23 by the researched, per-model-dated
 * catalog in lib/modelCatalog.ts. They were a single vendor's ballpark; the
 * catalog carries a source URL and a verification date per row.
 */
export interface ModelRate {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
}

export interface TokenRoi {
  /** Whole-codebase tokens (exact, from the analyzer). */
  fullTokens: number;
  /** Estimated tokens of the FACTS artifact. */
  artifactTokens: number;
  /** fullTokens − artifactTokens, floored at 0. */
  savedTokens: number;
  /** Fraction saved, 0..1 (0 when there's nothing to compare). */
  savedFraction: number;
  /** How many times bigger the full context is than the artifact.
   *  E.g. 26 means "the repo is 26× the artifact". 0 when undefined. */
  ratio: number;
}

/**
 * Compute the token ROI from the exact codebase token count and the
 * artifact's serialized character length.
 *
 * @param fullTokens   exact codebase tokens (data.stats.tokens)
 * @param artifactChars serialized length of the shipped artifact, in chars
 */
export function computeTokenRoi(fullTokens: number, artifactChars: number): TokenRoi {
  const full = Math.max(0, Math.round(fullTokens));
  const artifactTokens = Math.max(0, Math.round(artifactChars / CHARS_PER_TOKEN));
  const savedTokens = Math.max(0, full - artifactTokens);
  const savedFraction = full > 0 ? savedTokens / full : 0;
  const ratio = artifactTokens > 0 ? full / artifactTokens : 0;
  return { fullTokens: full, artifactTokens, savedTokens, savedFraction, ratio };
}

/** USD cost of `tokens` input tokens at the given rate. */
export function dollars(tokens: number, rate: ModelRate): number {
  return (tokens / 1_000_000) * rate.inputPerMTok;
}

/* ─────────── formatting ─────────── */

/** Compact token count: 1_240_000 → "1.24M", 57_300 → "57.3K". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(2).replace(/\.?0+$/, '') + 'K';
  return n.toLocaleString('en-US');
}

/**
 * USD formatting tuned for per-task agent costs, which span $0.001 →
 * $50+. Sub-cent values keep enough precision to be meaningful rather
 * than collapsing to "$0.00".
 */
export function fmtUsd(n: number): string {
  if (n <= 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 1) return '$' + n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString('en-US');
}

/**
 * Price of ONE token, which is the unit people are actually billed in and
 * the one vendors never print.
 *
 * At $0.75/M a token costs $0.00000075, and every general-purpose formatter
 * renders that as "$0.00". So: significant figures, not fixed decimals, and
 * an explicit `$0` only for a genuine zero. The trailing unit is the
 * caller's job — this returns the number alone so it can sit in a table
 * column without repeating "/token" on every row.
 */
export function fmtPerToken(perMTok: number): string {
  if (!Number.isFinite(perMTok) || perMTok <= 0) return '$0';
  const perToken = perMTok / 1_000_000;
  /* Two significant figures at any magnitude. toPrecision returns the
     exponential spelling down here ("7.5e-7"), which is correct but unreadable
     in a price column, so expand it with toFixed and trim the padding. */
  const sig = Number(perToken.toPrecision(2));
  const decimals = Math.max(0, Math.min(12, -Math.floor(Math.log10(sig)) + 1));
  return '$' + sig.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
}

/** "26×" — the multiplier framing. Rounds to a clean integer above 10. */
export function fmtRatio(ratio: number): string {
  if (ratio <= 0) return '—';
  if (ratio >= 10) return Math.round(ratio) + '×';
  return ratio.toFixed(1).replace(/\.0$/, '') + '×';
}

/** "96%" — the savings framing. */
export function fmtPct(fraction: number): string {
  return Math.round(fraction * 100) + '%';
}

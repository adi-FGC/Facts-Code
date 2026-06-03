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
 *   - `fullTokens` is exact — the analyzer tokenizes every source file
 *     with the cl100k encoding.
 *   - `artifactTokens` is an estimate: serialized-bytes ÷ CHARS_PER_TOKEN.
 *     JSON tokenizes a little denser than prose, so this slightly
 *     under-counts artifact tokens, which is the conservative direction
 *     (it makes FACTS look worse, not better).
 *   - The artifact we measure is the dashboard's own data block, a
 *     superset of the lean agent.json. Real agent-facing artifacts are
 *     smaller still, so again: conservative.
 */

/** cl100k rule-of-thumb: ~4 characters per token for code + JSON. */
export const CHARS_PER_TOKEN = 4;

export interface ModelRate {
  id: string;
  /** Short display label (model class). */
  label: string;
  /** USD per 1,000,000 input tokens. Approximate public list price — an
   *  editable assumption, not a live quote. */
  inputPerMTok: number;
}

/**
 * Rate presets for the "what does this cost" column. Labelled by model
 * class with ballpark list prices so the dollar figure is concrete;
 * the panel states plainly that these are approximate and adjustable.
 */
export const MODEL_RATES: readonly ModelRate[] = [
  { id: 'haiku', label: 'Haiku', inputPerMTok: 0.8 },
  { id: 'sonnet', label: 'Sonnet', inputPerMTok: 3 },
  { id: 'opus', label: 'Opus', inputPerMTok: 15 },
] as const;

export const DEFAULT_RATE_ID = 'sonnet';

export function rateById(id: string): ModelRate {
  return MODEL_RATES.find((r) => r.id === id) ?? MODEL_RATES[1]!;
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

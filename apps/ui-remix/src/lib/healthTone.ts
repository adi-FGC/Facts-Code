/**
 * Canonical Overview health tone — one source of truth for "is this
 * green/amber/red?" shared by the lede banner and the margin HealthGrade
 * marque so the two surfaces never disagree.
 *
 * Prefers the v0.3 composite grade; falls back to the flat counts for
 * pre-v0.3 baked datasets that carry no letter.
 *
 * Secrets and broken imports force `danger` regardless of the letter.
 * A leaked secret is always act-now even if a single occurrence only
 * nicks the score to a C — the grade is a summary, the tone is an alarm.
 */
import type { Dataset } from './loadArtifacts.ts';

export type HealthTone = 'ok' | 'warn' | 'danger';

/** Tone → design-token color. Co-located with the tone logic so the
 *  marque's grade letter + deduction bars tint from the same source the
 *  tone decision uses. (FootnoteChip keeps its own 5-tone map for chrome;
 *  this is the 3-tone health subset the marque needs as a raw value.) */
export const HEALTH_TONE_COLOR: Record<HealthTone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
};

type Health = Dataset['summary']['health'];

export function healthTone(h: Health): HealthTone {
  if (h.secrets > 0 || h.broken > 0) return 'danger';
  if (h.grade) {
    if (h.grade === 'F') return 'danger';
    if (h.grade === 'C' || h.grade === 'D') return 'warn';
    return 'ok'; // A, B
  }
  // pre-grade dataset: secrets/broken already handled above.
  return h.stale > 0 || h.todos > 0 ? 'warn' : 'ok';
}

/**
 * HealthGrade — the composite project-health marque for the margin column.
 *
 * The editorial signature of the Overview: a large serif letter grade
 * (A–F) tinted by severity, the 0–100 score beside it, and a compact
 * "ledger" of the top deductions (factor · count · −penalty, with a thin
 * proportional bar). It answers not just "how healthy?" but "what's
 * costing points?" — the evidence sitting in the margin beside the claim.
 *
 * Composes FootnoteChip for its chrome (left rule, kicker, hairline,
 * padding) so the margin column's chips stay structurally identical; the
 * grade/score/ledger render in the chip's body. Falls back to a plain
 * count summary when the dataset predates the grade (pre-v0.3 baked
 * artifacts carry only flat broken/stale/todos/secrets).
 */
import type { Handle, RemixNode } from 'remix/ui';
import { css } from 'remix/ui';
import { FootnoteChip } from './FootnoteChip.tsx';
import { healthTone, HEALTH_TONE_COLOR } from '../lib/healthTone.ts';
import type { Dataset } from '../lib/loadArtifacts.ts';

interface HealthGradeProps {
  health: Dataset['summary']['health'];
}

/* Grade + score on one baseline: serif letter as the focal marque, the
   /100 score as a mono footing. Baseline-aligned so the big letter and
   the small figure read as one unit, not two stacked stats. */
const marque = css({
  display: 'flex',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  marginBottom: 'var(--space-3)',
});

const gradeLetter = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'clamp(2.6rem, 7vw, 3.4rem)',
  fontWeight: '600',
  lineHeight: '0.9',
  letterSpacing: '-0.02em',
  color: 'var(--tone)',
});

const scoreFigure = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-13)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-muted)',
  whiteSpace: 'nowrap',
});

const scoreUnit = css({
  color: 'var(--fg-faint)',
});

const ledger = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
});

const ledgerRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'baseline',
  columnGap: 'var(--space-3)',
  rowGap: 'var(--space-2)',
});

const ledgerLabel = css({
  fontSize: 'var(--fs-12)',
  color: 'var(--fg)',
  minWidth: '0',
});

const ledgerValue = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
});

const ledgerPenalty = css({
  color: 'var(--tone)',
});

/* Thin deduction bar — width proportional to this factor's penalty
   against the heaviest one. Editorial weight, not a chart: a 2px rule
   tinted toward the tone. */
const barTrack = css({
  gridColumn: '1 / -1',
  height: '2px',
  background: 'var(--hairline)',
  position: 'relative',
  overflow: 'hidden',
});

const barFill = css({
  position: 'absolute',
  insetBlock: '0',
  insetInlineStart: '0',
  width: 'var(--w)',
  background: 'color-mix(in oklab, var(--tone) 70%, transparent)',
});

const cleanNote = css({
  color: 'var(--fg-muted)',
});

export function HealthGrade(handle: Handle<HealthGradeProps>): () => RemixNode {
  return () => {
    const h = handle.props.health;
    const tone = healthTone(h);

    // Pre-v0.3 dataset: no letter grade. Show the flat-count summary so
    // older baked artifacts still render something honest.
    if (!h.grade || typeof h.score !== 'number') {
      return (
        <FootnoteChip label="Health" tone={tone}>
          {h.broken === 0 && h.secrets === 0
            ? 'Clean. No broken imports, no secrets in source.'
            : `${h.broken} broken · ${h.secrets} secrets · ${h.todos} todos`}
        </FootnoteChip>
      );
    }

    const factors = h.factors ?? [];
    const maxPenalty = factors.reduce((m, f) => Math.max(m, f.penalty), 0) || 1;

    return (
      <FootnoteChip label="Health" tone={tone}>
        {/* --tone scopes the grade letter + deduction bars to the severity
            color without re-deriving it. */}
        <div style={`--tone:${HEALTH_TONE_COLOR[tone]}`}>
          <div
            mix={marque}
            role="img"
            aria-label={`Health grade ${h.grade}, score ${h.score} out of 100`}
          >
            <span mix={gradeLetter}>{h.grade}</span>
            <span mix={scoreFigure}>
              {h.score}
              <span mix={scoreUnit}>/100</span>
            </span>
          </div>
          {factors.length > 0 ? (
            <ul mix={ledger}>
              {factors.map((f) => (
                <li key={f.label} mix={ledgerRow}>
                  <span mix={ledgerLabel}>{f.label}</span>
                  <span mix={ledgerValue}>
                    {f.count} <span mix={ledgerPenalty}>−{f.penalty}</span>
                  </span>
                  <span mix={barTrack}>
                    <span
                      aria-hidden="true"
                      mix={barFill}
                      style={`--w:${Math.round((f.penalty / maxPenalty) * 100)}%`}
                    />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span mix={cleanNote}>No blockers detected. Nothing dragging the score down.</span>
          )}
        </div>
      </FootnoteChip>
    );
  };
}

/**
 * FootnoteChip — annotation block for the margin column.
 *
 * Each chip looks like a printed footnote: a tracked-uppercase label,
 * a single-line value (can be a count + unit), and a thin connecting
 * rule that visually anchors it to the body. Replaces "card with icon"
 * stat patterns; reads as editorial annotation.
 *
 *   ┌────────────────────────
 *   │ DETECTED
 *   │ React, Vite, Tailwind   ← value (multi-line ok)
 *   │ +9 more                 ← optional aside
 *   ────────────────────────  ← bottom hairline
 */
import type { Handle, RemixNode } from 'remix/ui';
import { css } from 'remix/ui';

interface FootnoteChipProps {
  label: string;
  children: RemixNode;
  /** Optional muted aside under the value. */
  aside?: string | undefined;
  /** Tone — picks the color for the leading rule. Default neutral. */
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'ok' | undefined;
}

const TONE_COLOR: Record<NonNullable<FootnoteChipProps['tone']>, string> = {
  neutral: 'var(--hairline)',
  accent:  'var(--accent)',
  warn:    'var(--warn)',
  danger:  'var(--danger)',
  ok:      'var(--ok)',
};

export function FootnoteChip(handle: Handle<FootnoteChipProps>) {
  return () => {
    const { label, children, aside, tone = 'neutral' } = handle.props;
    return (
      <div
        mix={css({
          position: 'relative',
          paddingTop: 'var(--space-3)',
          paddingBottom: 'var(--space-4)',
          paddingLeft: 'var(--space-3)',
          borderLeft: `2px solid ${TONE_COLOR[tone]}`,
          borderBottom: '1px solid var(--hairline)',
        })}
      >
        <div
          mix={css({
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-10)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: tone === 'neutral' ? 'var(--fg-subtle)' : `var(--${tone === 'accent' ? 'accent' : tone})`,
            marginBottom: 'var(--space-2)',
          })}
        >
          {label}
        </div>
        <div
          mix={css({
            fontSize: 'var(--fs-13)',
            color: 'var(--fg)',
            lineHeight: '1.4',
          })}
        >
          {children}
        </div>
        {aside && (
          <div
            mix={css({
              marginTop: 'var(--space-2)',
              fontSize: 'var(--fs-11)',
              color: 'var(--fg-muted)',
            })}
          >
            {aside}
          </div>
        )}
      </div>
    );
  };
}

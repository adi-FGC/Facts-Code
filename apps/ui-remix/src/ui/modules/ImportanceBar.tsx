/**
 * ImportanceBar — the F5 visual encoding for graph importance (normalized
 * PageRank). A thin proportional bar + the exact value in mono. Importance gets
 * its own channel on purpose: the design language already spends *size* on
 * token cost, *saturation* on status, *opacity* on churn and *hue* on language,
 * so a separate bar keeps the encodings legible instead of overloading one.
 *
 * Evidence-first: the bar is the glance, the number is the proof.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';

interface ImportanceBarProps {
  /** 0..1 normalized importance. */
  value: number;
}

const wrap = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  justifyContent: 'flex-end',
});

const track = css({
  position: 'relative',
  width: 'clamp(40px, 7vw, 88px)',
  height: '4px',
  borderRadius: '2px',
  background: 'var(--hairline)',
  overflow: 'hidden',
  flex: '0 0 auto',
});

const fill = css({
  position: 'absolute',
  insetBlock: '0',
  insetInlineStart: '0',
  background: 'var(--accent-soft)',
  borderRadius: '2px',
});

const num = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  fontVariantNumeric: 'tabular-nums lining-nums',
  color: 'var(--fg-muted)',
  minWidth: '3ch',
  textAlign: 'right',
});

export function ImportanceBar(handle: Handle<ImportanceBarProps>) {
  return () => {
    const { value } = handle.props;
    const clamped = Math.max(0, Math.min(1, value));
    const pct = (clamped * 100).toFixed(1);
    return (
      <div mix={wrap} title={`importance ${clamped.toFixed(3)}`}>
        <div mix={track}>
          <div mix={[fill, css({ width: `${pct}%` })]} />
        </div>
        <span mix={num}>{clamped.toFixed(2)}</span>
      </div>
    );
  };
}

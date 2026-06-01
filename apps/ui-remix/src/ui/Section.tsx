/**
 * Section — the structural unit of every editorial page.
 *
 * Anatomy:
 *   ┌─ TOP HAIRLINE ──────────────────────────────────────────────
 *   │  LABEL · MONO · UPPERCASE · TRACKED            (optional)
 *   │  Display title                                  (optional)
 *   │  …children…
 *
 * Replaces the "card with header bar" pattern. Hairline > border-box.
 * No drop shadow. No background color (content surfaces are paper).
 */
import type { Handle, RemixNode } from 'remix/ui';
import { css } from 'remix/ui';

interface SectionProps {
  /** Tracked uppercase mono label above the title. */
  label?: string | undefined;
  /** Display-serif title. Pass empty/omit when the label is enough. */
  title?: string | undefined;
  /** Override the title size — e.g. for the Overview hero. */
  titleSize?: 'lg' | 'xl' | 'display' | undefined;
  children?: RemixNode | undefined;
}

const SIZE_MAP = {
  lg: 'var(--fs-24)',
  xl: 'var(--fs-32)',
  display: 'var(--fs-display-sm)',
} as const;

const wrap = css({
  borderTop: '1px solid var(--hairline)',
  paddingTop: 'var(--space-6)',
  marginBottom: 'var(--space-12)',
});

const labelStyle = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
  marginBottom: 'var(--space-3)',
});

const titleBase = css({
  fontFamily: 'var(--font-display)',
  fontWeight: '600',
  letterSpacing: '-0.02em',
  lineHeight: '1.05',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
  /* Optical-size axis kicks in around the larger sizes. */
  fontVariationSettings: '"opsz" 64',
});

export function Section(handle: Handle<SectionProps>) {
  return () => {
    const { label, title, titleSize = 'lg', children } = handle.props;
    return (
      <section mix={wrap}>
        {label && <div mix={labelStyle}>{label}</div>}
        {title && (
          <h2 mix={[titleBase, css({ fontSize: SIZE_MAP[titleSize] })]}>{title}</h2>
        )}
        {children}
      </section>
    );
  };
}

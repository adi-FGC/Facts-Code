/**
 * LabelNumber — the editorial label/number pair primitive.
 *
 *   FILES                  LOC                  TOKENS
 *   168                    43,890               530K
 *   ─── hairline ─────────────────────────────────────
 *
 * Bloomberg/FT pattern. Number is mono (tabular), label is small-caps
 * tracked mono. NO icon. NO box. NO gradient on the number.
 *
 * Use a row of these for stats. Each one ends in a hairline rule on
 * the right (except the last) so they read as columns.
 */
import type { Handle, RemixNode } from 'remix/ui';
import { css } from 'remix/ui';

interface LabelNumberProps {
  label: string;
  /** Pre-formatted string. Use a fmt helper before passing. */
  value: string | number;
  /** Optional unit, rendered smaller next to the value. */
  unit?: string | undefined;
  /** Optional one-line annotation under the number. */
  hint?: string | undefined;
  /** When true, this is the last in a row — drop the right hairline. */
  last?: boolean | undefined;
  /** Promote one number per row as the "lede" — bigger size. */
  lede?: boolean | undefined;
  /** Optional href — turns the whole pair into a link. */
  href?: string | undefined;
  /** Slot for an inline trailing element (e.g., StatusChip, Sparkline). */
  trailing?: RemixNode | undefined;
}

const cell = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  paddingInline: 'var(--space-5)',
  paddingBlock: 'var(--space-3)',
  minWidth: '0',
  borderRight: '1px solid var(--hairline)',
});

const cellLast = css({ borderRight: 'none' });

const labelStyle = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
});

/** numberStyle MUST stay aligned with `<MonoNum>`'s base style. We fold
 *  the same ss01/cv03 axis settings here so raw values render with the
 *  identical optical treatment whether they're wrapped in MonoNum or
 *  passed through LabelNumber's `value` prop. The reviewer flagged the
 *  prior mismatch — keep these identical going forward. */
const numberStyle = css({
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums lining-nums',
  fontFeatureSettings: '"ss01", "cv03"',
  fontWeight: '500',
  letterSpacing: '-0.01em',
  lineHeight: '1',
  color: 'var(--fg)',
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 'var(--space-2)',
});

const hintStyle = css({
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-muted)',
  lineHeight: '1.3',
});

const unitStyle = css({
  fontSize: '0.55em',
  color: 'var(--fg-muted)',
  fontWeight: '400',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
});

export function LabelNumber(handle: Handle<LabelNumberProps>) {
  return () => {
    const { label, value, unit, hint, last, lede, href, trailing } = handle.props;
    const numSize = lede
      ? css({ fontSize: 'var(--fs-display-sm)' })
      : css({ fontSize: 'var(--fs-32)' });
    const body = (
      <>
        <span mix={labelStyle}>{label}</span>
        <span mix={[numberStyle, numSize]}>
          {value}
          {unit && <span mix={unitStyle}>{unit}</span>}
          {trailing}
        </span>
        {hint && <span mix={hintStyle}>{hint}</span>}
      </>
    );
    const baseMix = last ? [cell, cellLast] : [cell];
    if (href) {
      return (
        <a href={href} mix={[...baseMix, css({ color: 'inherit', textDecoration: 'none' })]}>
          {body}
        </a>
      );
    }
    return <div mix={baseMix}>{body}</div>;
  };
}

/**
 * LabelNumberRow — convenience wrapper that lays out N LabelNumbers
 * with a top + bottom hairline. Drops the right hairline on the last
 * cell automatically when its `last` prop isn't pre-set.
 */
export function LabelNumberRow(handle: Handle<{ children: RemixNode }>) {
  return () => {
    const { children } = handle.props;
    return (
      <div
        mix={css({
          display: 'flex',
          alignItems: 'stretch',
          flexWrap: 'wrap',
          borderTop: '1px solid var(--hairline)',
          borderBottom: '1px solid var(--hairline)',
          marginInline: 'calc(var(--space-5) * -1)',
        })}
      >
        {children}
      </div>
    );
  };
}

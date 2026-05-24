/**
 * MarginColumn — broadsheet marginalia lane.
 *
 * Pairs with `<ContentWithMargin>` to build a two-column layout where
 * the right column holds annotations / footnotes / chips that hang off
 * the body without crowding it. Below `lg` (< 1280px), the margin
 * collapses and any chips inside fall into the body flow.
 *
 * The connecting hairline rules are drawn from `<FootnoteChip>`, not
 * here — this primitive just defines the lane.
 */
import type { Handle, RemixNode } from 'remix/ui';
import { css } from 'remix/ui';

interface ContentWithMarginProps {
  children: RemixNode;
}

export function ContentWithMargin(_h: Handle<ContentWithMarginProps>) {
  return ({ children }: ContentWithMarginProps) => (
    <div
      mix={css({
        display: 'grid',
        gridTemplateColumns: '1fr var(--margin-col-w)',
        columnGap: 'var(--gutter)',
        rowGap: 'var(--space-8)',
        maxWidth: 'var(--content-max)',
        marginInline: 'auto',
        paddingInline: 'var(--gutter)',
        paddingBlock: 'var(--space-12)',

        /* Below xl: margin column collapses. The grid flips to single
           column and any `<MarginColumn>` block stacks underneath the
           body chunk it was annotating. */
        '@media (max-width: 1279px)': {
          gridTemplateColumns: '1fr',
        },
      })}
    >
      {children}
    </div>
  );
}

interface MarginColumnProps {
  children: RemixNode;
  /** Make the lane align with a specific body element by lifting it
   *  with negative margin. Default = align with the row top. */
  align?: 'top' | 'baseline';
}

export function MarginColumn(_h: Handle<MarginColumnProps>) {
  return ({ children, align = 'top' }: MarginColumnProps) => (
    <aside
      role="complementary"
      mix={css({
        gridColumn: '2',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        ...(align === 'baseline' ? { marginTop: 'var(--space-3)' } : {}),
        '@media (max-width: 1279px)': {
          gridColumn: '1',
          flexDirection: 'row',
          flexWrap: 'wrap',
          marginTop: 'calc(var(--space-4) * -1)',
        },
      })}
    >
      {children}
    </aside>
  );
}

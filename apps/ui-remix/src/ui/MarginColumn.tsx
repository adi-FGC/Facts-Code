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

export function ContentWithMargin(handle: Handle<ContentWithMarginProps>) {
  return () => {
    const { children } = handle.props;
    return (
    <div
      mix={css({
        display: 'grid',
        /* minmax(0, 1fr) not 1fr: a bare 1fr track's min is min-content,
           which lets a wide child (e.g. a min-width table on the Files
           tab) blow the column past the viewport instead of letting an
           inner scroll container scroll. Identical to 1fr for normal
           text content; only prevents the blowout. */
        gridTemplateColumns: 'minmax(0, 1fr) var(--margin-col-w)',
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
          gridTemplateColumns: 'minmax(0, 1fr)',
        },
      })}
    >
      {children}
    </div>
    );
  };
}

interface MarginColumnProps {
  children: RemixNode;
  /** Make the lane align with a specific body element by lifting it
   *  with negative margin. Default = align with the row top. */
  align?: 'top' | 'baseline';
}

export function MarginColumn(handle: Handle<MarginColumnProps>) {
  return () => {
    const { children, align = 'top' } = handle.props;
    return (
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
  };
}

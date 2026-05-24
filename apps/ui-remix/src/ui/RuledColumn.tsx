/**
 * RuledColumn — hairline-divided "column" wrappers for tabular data.
 *
 * Most "card" lists in dashboards should be tables. We render them as
 * grids with hairline rules between cells (no boxed rows). Same density
 * as a newspaper agate column.
 *
 *   <RuledTable cols="auto 1fr auto auto">
 *     <RuledRow>
 *       <RuledCell>GET</RuledCell>
 *       <RuledCell mono>/api/health</RuledCell>
 *       <RuledCell muted>app/routes/health.ts</RuledCell>
 *       <RuledCell><StatusChip kind="ok" /></RuledCell>
 *     </RuledRow>
 *   </RuledTable>
 */
import type { Handle, RemixNode } from 'remix/ui';
import { css } from 'remix/ui';

interface TableProps {
  /** CSS grid-template-columns value, e.g. "120px 1fr auto". */
  cols: string;
  children: RemixNode;
}

export function RuledTable(_h: Handle<TableProps>) {
  return ({ cols, children }: TableProps) => (
    <div
      role="table"
      mix={css({
        display: 'grid',
        gridTemplateColumns: cols,
        borderTop: '1px solid var(--hairline)',
      })}
    >
      {children}
    </div>
  );
}

interface RowProps {
  children: RemixNode;
  /** Subdued row — use for headers or muted entries. */
  header?: boolean;
}

export function RuledRow(_h: Handle<RowProps>) {
  return ({ children, header }: RowProps) => (
    <div
      role="row"
      mix={css({ display: 'contents' })}
      data-row-header={header ? 'true' : undefined}
    >
      {children}
    </div>
  );
}

interface CellProps {
  children: RemixNode;
  /** Switch to mono font (paths, identifiers, numbers). */
  mono?: boolean;
  /** Subdued color (file paths, secondary metadata). */
  muted?: boolean;
  /** Right-align (numbers, statuses). */
  align?: 'left' | 'right' | 'center';
  /** Header cell — uppercase tracked label. */
  header?: boolean;
}

export function RuledCell(_h: Handle<CellProps>) {
  return ({ children, mono, muted, align = 'left', header }: CellProps) => (
    <div
      role={header ? 'columnheader' : 'cell'}
      mix={css({
        paddingInline: 'var(--space-4)',
        paddingBlock: 'var(--space-3)',
        borderBottom: '1px solid var(--hairline)',
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        fontVariantNumeric: mono ? 'tabular-nums lining-nums' : 'normal',
        color: muted ? 'var(--fg-muted)' : 'var(--fg)',
        fontSize: header ? 'var(--fs-10)' : mono ? 'var(--fs-12)' : 'var(--fs-13)',
        letterSpacing: header ? '0.14em' : 'normal',
        textTransform: header ? 'uppercase' : 'none',
        fontWeight: header ? '500' : '400',
        textAlign: align,
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: align === 'left' ? 'normal' : 'nowrap',
      })}
    >
      {children}
    </div>
  );
}

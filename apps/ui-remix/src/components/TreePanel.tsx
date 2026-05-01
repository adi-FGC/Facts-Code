/**
 * Project tree — agate-column listing of top-level folders + files.
 *
 * Stays a flat one-level listing for v1. Recursive collapsible tree
 * is in TASKS.md as a follow-up. The single-level view is enough to
 * orient at a glance and pairs naturally with the editorial body.
 *
 * Each row is a hairline-divided line, not a card. Bytes hang in the
 * right column like a price column in an FT table.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset, DatasetTreeNode } from '../lib/loadArtifacts.ts';

interface TreePanelProps {
  data: Dataset;
}

type Row = {
  kind: 'dir' | 'file';
  name: string;
  size: number;
  loc: number;
};

function flattenTopLevel(node: DatasetTreeNode): Row[] {
  const rows: Row[] = [];
  for (const c of node.children) {
    rows.push({
      kind: 'dir',
      name: c.name,
      size: c.rollup?.size ?? 0,
      loc: c.rollup?.loc ?? 0,
    });
  }
  for (const f of node.files) {
    rows.push({
      kind: 'file',
      name: f.name,
      size: f.size,
      loc: f.loc,
    });
  }
  return rows;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'M';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'K';
  return n + 'B';
}

const wrap = css({
  overflowY: 'auto',
  paddingTop: 'var(--space-4)',
  paddingBottom: 'var(--space-4)',
  borderRight: '1px solid var(--hairline)',
  background: 'var(--bg)',
});

const head = css({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  paddingInline: 'var(--space-5)',
  paddingBottom: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  marginBottom: 'var(--space-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
});

const list = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
});

const row = css({
  display: 'grid',
  gridTemplateColumns: '12px 1fr auto',
  alignItems: 'baseline',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-5)',
  paddingBlock: '6px',
  borderBottom: '1px solid var(--hairline)',
  cursor: 'default',
});

const rowDir = css({
  fontWeight: '500',
});

const rowFile = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
});

const marker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
});

const sizeCell = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-faint)',
  whiteSpace: 'nowrap',
});

const nameCell = css({
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontSize: 'var(--fs-13)',
  color: 'var(--fg)',
});

export function TreePanel(_handle: Handle<TreePanelProps>) {
  return ({ data }: TreePanelProps) => {
    const rows = flattenTopLevel(data.tree);
    return (
      <aside aria-label="Project tree" mix={wrap}>
        <div mix={head}>
          <span>{data.project.name}</span>
          <span>
            {data.stats.files} <span mix={css({ color: 'var(--fg-faint)', marginLeft: '4px' })}>files</span>
          </span>
        </div>
        <ul mix={list}>
          {rows.map((r, i) => (
            <li key={i} mix={[row, r.kind === 'dir' ? rowDir : rowFile]}>
              <span aria-hidden="true" mix={marker}>
                {r.kind === 'dir' ? '▸' : '·'}
              </span>
              <span mix={nameCell}>{r.name}</span>
              <span mix={sizeCell}>{fmtBytes(r.size)}</span>
            </li>
          ))}
        </ul>
      </aside>
    );
  };
}

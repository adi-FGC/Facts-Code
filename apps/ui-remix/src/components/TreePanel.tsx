/**
 * Project file tree panel — flat list of top-level folders + files
 * with rollup stats. Simpler than the legacy `react-arborist` tree
 * (which we dropped along with React); the v1 here is a single-level
 * directory listing with click-to-expand handled inline.
 *
 * Refinement plan (TASKS.md): port the recursive collapsible tree as
 * a self-rendering component using the Remix runtime's `handle.update()`
 * pattern for each branch's open/closed state. For now, a one-level
 * flatten gets the panel populated and useful.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset, DatasetTreeNode } from '../lib/loadArtifacts.ts';

interface TreePanelProps {
  data: Dataset;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function flattenTopLevel(node: DatasetTreeNode): Array<{
  kind: 'dir' | 'file';
  name: string;
  size: number;
  loc: number;
  status?: string;
}> {
  const rows: Array<{ kind: 'dir' | 'file'; name: string; size: number; loc: number; status?: string }> = [];
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
      status: f.status,
    });
  }
  return rows;
}

export function TreePanel(_handle: Handle<TreePanelProps>) {
  return ({ data }: TreePanelProps) => {
    const rows = flattenTopLevel(data.tree);
    return (
      <aside
        class="glass"
        aria-label="Project tree"
        mix={css({
          gridArea: 'tree',
          overflowY: 'auto',
          padding: '12px 8px',
          borderRight: '1px solid var(--border)',
          fontSize: '12px',
        })}
      >
        <div class="mono" mix={css({
          padding: '0 8px 8px',
          color: 'var(--fg-subtle)',
          fontSize: '11px',
          display: 'flex',
          justifyContent: 'space-between',
        })}>
          <span>{data.project.name}</span>
          <span>{data.stats.files} files</span>
        </div>
        <ul mix={css({ listStyle: 'none', padding: '0', margin: '0', display: 'grid', gap: '2px' })}>
          {rows.map((r, i) => (
            <li
              key={i}
              mix={css({
                padding: '6px 8px',
                borderRadius: '6px',
                display: 'grid',
                gridTemplateColumns: '14px 1fr auto',
                gap: '8px',
                alignItems: 'center',
                color: r.kind === 'dir' ? 'var(--fg)' : 'var(--fg-muted)',
              })}
            >
              <span aria-hidden="true" mix={css({ fontSize: '10px', color: 'var(--fg-subtle)' })}>
                {r.kind === 'dir' ? '▸' : '·'}
              </span>
              <span mix={css({
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                fontFamily: r.kind === 'file' ? 'var(--font-mono)' : 'inherit',
              })}>{r.name}</span>
              <span class="mono" mix={css({ fontSize: '10px', color: 'var(--fg-subtle)' })}>
                {fmtBytes(r.size)}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    );
  };
}

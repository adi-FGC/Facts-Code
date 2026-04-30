import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Dataset, DatasetTreeNode } from '../lib/loadArtifacts.ts';

/**
 * LHS project tree — minimal v0.1.
 *
 * Recursive folder expansion, language chip per file, aria-tree semantics.
 * Click a folder to toggle; click a file to emit an event consumed by the
 * (not yet ported) Files route. Roving tabindex added in a follow-up.
 */
export function TreePanel({ data }: { data: Dataset }) {
  return (
    <aside aria-label="Project tree" className="glass" style={{ padding: '12px 8px', borderRadius: 0 }}>
      <div style={{ padding: '4px 8px 12px', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-subtle)', display: 'flex', justifyContent: 'space-between' }}>
        <span>{data.project.name}</span>
        <span>{data.stats.files} files</span>
      </div>
      <div role="tree" aria-label="Project file tree" style={{ display: 'grid', gap: 1 }}>
        <TreeNode node={data.tree} depth={0} defaultOpen />
      </div>
    </aside>
  );
}

function TreeNode({ node, depth, defaultOpen = false }: { node: DatasetTreeNode; depth: number; defaultOpen?: boolean }) {
  const [open, setOpen] = useState<boolean>(defaultOpen || depth < 1);
  const hasChildren = (node.children?.length ?? 0) + (node.files?.length ?? 0) > 0;
  const navigate = useNavigate();

  return (
    <div role="treeitem" aria-expanded={open} aria-level={depth + 1}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          width: '100%',
          padding: '4px 8px', paddingLeft: 8 + depth * 10,
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'var(--font-display)',
          color: 'var(--fg)',
          textAlign: 'left',
        }}
      >
        <span aria-hidden="true" style={{ width: 10, color: 'var(--fg-subtle)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 150ms' }}>
          {hasChildren ? '▸' : '·'}
        </span>
        <span style={{ fontWeight: 500 }}>{node.name || '.'}</span>
        <span style={{ flex: 1 }} />
        {node.rollup && (
          <span className="mono" style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>
            {node.rollup.files} · {fmtTok(node.rollup.tokens)}t
          </span>
        )}
      </button>
      {open && hasChildren && (
        <div role="group" style={{ borderLeft: '1px dashed var(--border)', marginLeft: 12 + depth * 10, paddingLeft: 4 }}>
          {node.children.map((c) => (
            <TreeNode key={c.path || c.name} node={c} depth={depth + 1} />
          ))}
          {node.files.map((f) => (
            <button
              key={f.path}
              type="button"
              role="treeitem"
              aria-level={depth + 2}
              tabIndex={-1}
              onClick={() => navigate('/files?path=' + encodeURIComponent(f.path))}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '3px 8px', paddingLeft: 8 + (depth + 1) * 10,
                fontSize: 12,
                color: 'var(--fg-muted)',
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              {f.language && (
                <span
                  aria-hidden="true"
                  style={{
                    width: 10, height: 10, borderRadius: 2, background: f.language.iconColor, flexShrink: 0,
                  }}
                />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>
                {fmtTok(f.tokens)}t
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtTok(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

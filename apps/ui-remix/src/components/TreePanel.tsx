/**
 * Project tree — recursive, collapsible, click-to-navigate.
 *
 * v1 rendered a flat one-level listing. This is the v2 — a real tree
 * with the same agate-column rhythm, but every row is now interactive:
 *
 *   - **File rows** are `<a href="/files?p=...">`. The document-level
 *     `linkClick` listener intercepts and pushState-navigates, so the
 *     URL deep-links cleanly when shared.
 *   - **Directory rows** are `<button>` toggles. Open/closed state is
 *     held in a closure-level `Set<string>` of paths; mutation calls
 *     `handle.update()` to re-render.
 *   - **Active file** (matches `?p=` in the current URL) gets the
 *     yellow `--highlight` wash + bold weight so the reader can scan
 *     "where am I" at a glance.
 *
 * Initial expansion: top-level directories are open by default; deeper
 * directories collapsed. Keeps the first paint scannable on a 168-file
 * project without burying the file list.
 */
import type { Handle } from '@remix-run/ui';
import { css, on } from '@remix-run/ui';
import type { Dataset, DatasetFile, DatasetTreeNode } from '../lib/loadArtifacts.ts';

interface TreePanelProps {
  data: Dataset;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'M';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'K';
  return n + 'B';
}

/** Read the active file path from the current URL — same key Files.tsx uses. */
function activeFilePath(): string | null {
  if (typeof location === 'undefined') return null;
  if (location.pathname !== '/files') return null;
  const qs = new URLSearchParams(location.search);
  const p = qs.get('p');
  return p && p.length > 0 ? p : null;
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

const tree = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
});

/* Each row: chevron / dot · name · size. We render direct children of
   the same flex-row inline so the chevron sits at a consistent left
   edge across depth levels (depth controls the leading padding). */
const rowBase = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  width: '100%',
  paddingBlock: '4px',
  paddingInline: 'var(--space-5)',
  borderBottom: '1px solid var(--hairline)',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  borderBottomWidth: '1px',
  borderBottomStyle: 'solid',
  borderBottomColor: 'var(--hairline)',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  textDecoration: 'none',
  transition: 'background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    background: 'var(--highlight-faint)',
  },
  '&:focus-visible': {
    outline: '2px solid var(--accent)',
    outlineOffset: '-2px',
  },
});

const rowDir = css({
  fontFamily: 'var(--font-display)',
  fontWeight: '500',
  fontSize: 'var(--fs-13)',
  color: 'var(--fg)',
});

const rowFile = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
});

/* Active row: a SOFT wash + a 2px accent leading bar so the eye locks
   onto "you are here" without the row screaming. Using the full
   --highlight (terminal-yellow in dark / safety-orange in light) was
   too loud for a passive locator; the -soft variants are exactly what
   they exist for. The leading bar is the editorial flag — same shape
   StatusChip uses, so the visual grammar carries. */
const rowActive = css({
  background: 'var(--highlight-soft)',
  color: 'var(--fg)',
  fontWeight: '600',
  boxShadow: 'inset 2px 0 0 0 var(--accent)',
});

const marker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-faint)',
  width: '10px',
  flexShrink: '0',
  textAlign: 'center',
});

const nameCell = css({
  flex: '1',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const sizeCell = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-faint)',
  whiteSpace: 'nowrap',
  marginLeft: '6px',
});

export function TreePanel(handle: Handle<TreePanelProps>) {
  // Closure state: which directory paths are expanded.
  // Initial seed = every top-level dir under root.
  const open = new Set<string>();

  // Re-render when the URL changes so the active file highlight follows
  // the page. We listen to popstate + the in-app `factstack:nav` event.
  const rerender = () => { void handle.update(); };
  window.addEventListener('popstate', rerender);
  window.addEventListener('factstack:nav', rerender);
  handle.signal.addEventListener('abort', () => {
    window.removeEventListener('popstate', rerender);
    window.removeEventListener('factstack:nav', rerender);
  });

  function toggle(path: string) {
    if (open.has(path)) open.delete(path);
    else open.add(path);
    void handle.update();
  }

  /* Recursive renderer. Returns an array of <li> nodes, one per row,
     pre-flattened so the parent <ul> can list them top-down without
     wrapping each subtree in nested ul/li (which would multiply the
     hairline borders into a busy ladder). */
  function renderNode(node: DatasetTreeNode, depth: number, activePath: string | null): JSX.Element[] {
    const out: JSX.Element[] = [];
    // Directories first, alphabetically — gives the tree its FS-like
    // ordering instead of "everything jumbled by token weight".
    const dirs = node.children.slice().sort((a, b) => a.name.localeCompare(b.name));
    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      const isOpen = open.has(d.path);
      const indent = `calc(var(--space-5) + ${depth * 12}px)`;
      out.push(
        <li key={`d:${d.path}`}>
          <button
            type="button"
            aria-expanded={isOpen ? 'true' : 'false'}
            mix={[
              rowBase,
              rowDir,
              css({ paddingInlineStart: indent }),
              on('click', () => toggle(d.path)),
            ]}
          >
            <span aria-hidden="true" mix={marker}>{isOpen ? '▾' : '▸'}</span>
            <span mix={nameCell}>{d.name}</span>
            <span mix={sizeCell}>{fmtBytes(d.rollup?.size ?? 0)}</span>
          </button>
          {isOpen && renderNode(d, depth + 1, activePath)}
        </li>,
      );
    }

    for (const f of files) {
      const indent = `calc(var(--space-5) + ${depth * 12}px)`;
      const isActive = activePath === f.path;
      /* v0.3.8 — native tooltip with reading-time + top-1 contributor.
         Native `title` is intentionally simple here (richer custom
         tooltips would fight the overflow-y:auto wrap). The Files
         detail page renders the full Owners table in its margin. */
      const mins = f.readingMinutes;
      const topAuthor = f.topContributors?.[0];
      const titleParts: string[] = [];
      if (typeof mins === 'number' && mins > 0) titleParts.push(`~${mins} min read`);
      titleParts.push(`${f.loc} LOC`);
      if (topAuthor) {
        const days = Math.round((Date.now() - topAuthor.lastTouchedMs) / 86_400_000);
        titleParts.push(`${topAuthor.name || topAuthor.email.split('@')[0]} · ${days}d ago`);
      }
      out.push(
        <li key={`f:${f.path}`}>
          <a
            href={`/files?p=${encodeURIComponent(f.path)}`}
            title={titleParts.join(' · ')}
            mix={[
              rowBase,
              rowFile,
              isActive ? rowActive : null,
              css({ paddingInlineStart: indent }),
            ]}
          >
            <span aria-hidden="true" mix={marker}>·</span>
            <span mix={nameCell}>{f.name}</span>
            <span mix={sizeCell}>{fmtBytes(f.size)}</span>
          </a>
        </li>,
      );
    }
    return out;
  }

  // Seed: open every top-level dir on first render so the panel feels
  // populated without a click. Done once in setup.
  for (const c of handle.props.data.tree.children) open.add(c.path);

  return ({ data }: TreePanelProps) => {
    const activePath = activeFilePath();
    /* Auto-open every ancestor of the active file so the highlight is
       actually visible without manual expansion. We add to `open`
       without triggering re-render (we're already inside one). */
    if (activePath) {
      const parts = activePath.split('/');
      // path "a/b/c.ts" → ancestors ["a", "a/b"]
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
        open.add(acc);
      }
    }
    const allRows = renderNode(data.tree, 0, activePath);

    return (
      <aside aria-label="Project tree" mix={wrap}>
        <div mix={head}>
          <span>{data.project.name}</span>
          <span>
            {data.stats.files} <span mix={css({ color: 'var(--fg-faint)', marginLeft: '4px' })}>files</span>
          </span>
        </div>
        <ul mix={tree}>{allRows}</ul>
      </aside>
    );
  };
}

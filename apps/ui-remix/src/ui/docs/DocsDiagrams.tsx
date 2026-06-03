/**
 * DocsDiagrams — every diagram embedded in the docs, in one place: mermaid
 * (flowcharts, sequence, ER, class, state, gantt), plantuml, graphviz. Each
 * is shown as labelled, copyable source with its doc origin. Filter by type
 * to isolate e.g. the entity-relationship diagrams.
 *
 * (We render the source, not a live SVG: bundling mermaid would blow the
 *  bundle budget. "Copy" drops the fence body onto the clipboard for any
 *  mermaid editor or PR.)
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset } from '../../lib/loadArtifacts.ts';
import { getDocs, collectDiagrams, diagramTypeLabel, type DiagramRow } from '../../lib/docsModel.ts';

const page = css({ maxWidth: 'var(--content-max)', marginInline: 'auto', paddingInline: 'var(--gutter)', paddingBlock: 'var(--space-6)' });
const h = css({ fontFamily: 'var(--font-display, var(--font-body))', fontSize: 'var(--fs-24)', fontWeight: '600', letterSpacing: '-0.02em', margin: '0 0 var(--space-4)' });
const filters = css({ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-5)' });
const fChip = (active: boolean) => css({
  fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', padding: '4px var(--space-3)', borderRadius: '999px', cursor: 'pointer',
  border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'), background: active ? 'var(--accent-soft)' : 'transparent',
  color: active ? 'var(--accent)' : 'var(--fg-muted)',
});
const card = css({ border: '1px solid var(--hairline)', borderRadius: '12px', background: 'var(--surface-1)', marginBottom: 'var(--space-4)', overflow: 'hidden' });
const cardHead = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--hairline)' });
const typeBadge = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' });
const src = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--fg-subtle)' });
const copyBtn = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: '6px', padding: '2px var(--space-3)', cursor: 'pointer', background: 'transparent', '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent)' } });
const code = css({ margin: '0', padding: 'var(--space-4)', overflowX: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', lineHeight: '1.55', color: 'var(--fg-muted)' });
const empty = css({ color: 'var(--fg-subtle)', fontSize: 'var(--fs-13)', paddingBlock: 'var(--space-6)' });

function copy(text: string): void {
  try {
    const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } };
    void nav.clipboard?.writeText(text);
  } catch { /* clipboard blocked — non-fatal */ }
}

export function DocsDiagrams(handle: Handle<{ data: Dataset }>) {
  let filter = 'all';
  const setFilter = (f: string) => { filter = f; void handle.update(); };

  return () => {
    const all = collectDiagrams(getDocs(handle.props.data));
    if (all.length === 0) {
      return <div mix={page}><p mix={empty}>No diagrams found. Fenced <code>mermaid</code> / <code>plantuml</code> / <code>dot</code> blocks in any doc show up here — including entity-relationship diagrams.</p></div>;
    }
    const types = ['all', ...Array.from(new Set(all.map((d) => diagramTypeLabel(d)))).sort()];
    const shown: DiagramRow[] = filter === 'all' ? all : all.filter((d) => diagramTypeLabel(d) === filter);

    return (
      <div mix={page}>
        <h1 mix={h}>Diagrams &amp; charts</h1>
        <div mix={filters}>
          {types.map((t) => (
            <button key={t} type="button" mix={[fChip(filter === t), on('click', () => setFilter(t))]}>
              {t}{t !== 'all' ? ` (${all.filter((d) => diagramTypeLabel(d) === t).length})` : ` (${all.length})`}
            </button>
          ))}
        </div>
        {shown.map((d, i) => (
          <div key={i} mix={card}>
            <div mix={cardHead}>
              <span mix={typeBadge}>{diagramTypeLabel(d)}</span>
              <span mix={src}>{d.docPath}:{d.line}</span>
              <button type="button" mix={[copyBtn, on('click', () => copy(d.code))]}>copy</button>
            </div>
            <pre mix={code}><code>{d.code}</code></pre>
          </div>
        ))}
      </div>
    );
  };
}

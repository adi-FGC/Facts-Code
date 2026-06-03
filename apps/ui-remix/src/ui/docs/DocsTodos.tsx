/**
 * DocsTodos — every actionable item parsed from the project's prose, in one
 * place. Checkbox tasks (with done/total progress) + bare TODO/FIXME markers,
 * grouped by source doc. "Verifiable": each item shows its doc path + line.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset } from '../../lib/loadArtifacts.ts';
import { getDocs, summarizeTodos } from '../../lib/docsModel.ts';

const page = css({ maxWidth: 'var(--content-max)', marginInline: 'auto', paddingInline: 'var(--gutter)', paddingBlock: 'var(--space-6)' });
const h = css({ fontFamily: 'var(--font-display, var(--font-body))', fontSize: 'var(--fs-24)', fontWeight: '600', letterSpacing: '-0.02em', margin: '0 0 var(--space-3)' });
const statRow = css({ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'baseline', marginBottom: 'var(--space-3)' });
const big = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-20)', color: 'var(--fg)' });
const lbl = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', color: 'var(--fg-subtle)', letterSpacing: '0.08em', textTransform: 'uppercase' });
const bar = css({ height: '8px', borderRadius: '999px', background: 'var(--surface-2)', overflow: 'hidden', marginBottom: 'var(--space-6)', maxWidth: '520px' });
const fill = (pct: number) => css({ height: '100%', width: `${pct}%`, background: 'var(--ok)', transition: 'width var(--dur-quick) var(--ease-out-quart)' });
const toggle = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: '6px', padding: '4px var(--space-3)', cursor: 'pointer', background: 'transparent' });
const card = css({ border: '1px solid var(--hairline)', borderRadius: '12px', background: 'var(--surface-1)', padding: 'var(--space-4) var(--space-5)', marginBottom: 'var(--space-4)' });
const cardHead = css({ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'baseline', marginBottom: 'var(--space-3)' });
const cardTitle = css({ fontSize: 'var(--fs-14)', fontWeight: '600', color: 'var(--fg)' });
const cardPath = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--fg-subtle)' });
const item = css({ display: 'grid', gridTemplateColumns: '18px 1fr auto', gap: 'var(--space-2)', alignItems: 'baseline', fontSize: 'var(--fs-13)', padding: '3px 0' });
const boxOk = css({ fontFamily: 'var(--font-mono)', color: 'var(--ok)' });
const boxOpen = css({ fontFamily: 'var(--font-mono)', color: 'var(--fg-subtle)' });
const markerTag = css({ fontFamily: 'var(--font-mono)', color: 'var(--warn)', fontSize: 'var(--fs-11)' });
const doneText = css({ color: 'var(--fg-subtle)', textDecoration: 'line-through' });
const openText = css({ color: 'var(--fg-muted)' });
const lineRef = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--fg-subtle)' });
const empty = css({ color: 'var(--fg-subtle)', fontSize: 'var(--fs-13)', paddingBlock: 'var(--space-6)' });

export function DocsTodos(handle: Handle<{ data: Dataset }>) {
  let showDone = true;
  const flip = () => { showDone = !showDone; void handle.update(); };

  return () => {
    const sum = summarizeTodos(getDocs(handle.props.data));
    if (sum.buckets.length === 0) {
      return <div mix={page}><p mix={empty}>No todos or checklists found in the project's docs.</p></div>;
    }
    const pct = sum.totalCheckboxes ? Math.round((sum.totalDone / sum.totalCheckboxes) * 100) : 0;
    return (
      <div mix={page}>
        <h1 mix={h}>Todos across the docs</h1>
        <div mix={statRow}>
          <span><span mix={big}>{sum.totalDone}/{sum.totalCheckboxes}</span> <span mix={lbl}>tasks done</span></span>
          <span><span mix={big}>{pct}%</span> <span mix={lbl}>complete</span></span>
          <span><span mix={big}>{sum.totalMarkers}</span> <span mix={lbl}>TODO/FIXME markers</span></span>
          <button type="button" mix={[toggle, on('click', flip)]}>{showDone ? 'Hide done' : 'Show done'}</button>
        </div>
        <div mix={bar}><div mix={fill(pct)} /></div>

        {sum.buckets.map((b) => {
          const items = showDone ? b.items : b.items.filter((t) => t.done !== true);
          if (items.length === 0) return null;
          return (
            <div key={b.docPath} mix={card}>
              <div mix={cardHead}>
                <span mix={cardTitle}>{b.docTitle}</span>
                <span mix={cardPath}>{b.done}/{b.checkboxes} done{b.markers ? ` · ${b.markers} markers` : ''}</span>
              </div>
              {items.map((t, i) => (
                <div key={i} mix={item}>
                  <span aria-hidden="true" mix={t.done === null ? markerTag : t.done ? boxOk : boxOpen}>
                    {t.done === null ? '⚑' : t.done ? '☑' : '☐'}
                  </span>
                  <span mix={t.done === true ? doneText : openText}>
                    {t.done === null && t.tag ? <span mix={markerTag}>{t.tag} </span> : null}
                    {t.text}
                  </span>
                  <span mix={lineRef}>:{t.line}</span>
                </div>
              ))}
              <div mix={cardPath} style="margin-top:var(--space-2)">{b.docPath}</div>
            </div>
          );
        })}
      </div>
    );
  };
}

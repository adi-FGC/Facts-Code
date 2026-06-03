/**
 * DocsRoadmap — collapsible, verifiable roadmaps inferred from any doc that
 * carries checklists. Each doc becomes a roadmap; each heading-group becomes a
 * collapsible section with a real done/total progress bar, so a reader can
 * verify what's actually shipped vs. planned straight from the prose.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset } from '../../lib/loadArtifacts.ts';
import { getDocs, detectRoadmaps } from '../../lib/docsModel.ts';

const page = css({ maxWidth: 'var(--content-max)', marginInline: 'auto', paddingInline: 'var(--gutter)', paddingBlock: 'var(--space-6)' });
const h = css({ fontFamily: 'var(--font-display, var(--font-body))', fontSize: 'var(--fs-24)', fontWeight: '600', letterSpacing: '-0.02em', margin: '0 0 var(--space-2)' });
const lede = css({ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', marginBottom: 'var(--space-6)', maxWidth: '70ch' });
const rm = css({ border: '1px solid var(--hairline)', borderRadius: '12px', background: 'var(--surface-1)', marginBottom: 'var(--space-5)', overflow: 'hidden' });
const rmHead = css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-3)', padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--hairline)' });
const rmTitle = css({ fontSize: 'var(--fs-16)', fontWeight: '600', color: 'var(--fg)' });
const rmPct = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' });
const secBtn = css({ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: 'var(--space-3) var(--space-5)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)', color: 'var(--fg)', '&:hover': { background: 'var(--accent-soft)' } });
const caret = (open: boolean) => css({ fontFamily: 'var(--font-mono)', color: 'var(--fg-subtle)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur-quick) var(--ease-out-quart)', flex: '0 0 auto' });
const secTitle = css({ fontSize: 'var(--fs-13)', fontWeight: '600', flex: '1 1 auto' });
const miniBar = css({ height: '6px', width: '120px', borderRadius: '999px', background: 'var(--surface-2)', overflow: 'hidden', flex: '0 0 auto' });
const miniFill = (pct: number) => css({ height: '100%', width: `${pct}%`, background: pct === 100 ? 'var(--ok)' : 'var(--accent)' });
const secCount = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', color: 'var(--fg-subtle)', flex: '0 0 auto', minWidth: '44px', textAlign: 'right' });
const items = css({ padding: '0 var(--space-5) var(--space-4) calc(var(--space-5) + var(--space-4))' });
const item = css({ display: 'grid', gridTemplateColumns: '18px 1fr auto', gap: 'var(--space-2)', alignItems: 'baseline', fontSize: 'var(--fs-13)', padding: '3px 0' });
const boxOk = css({ fontFamily: 'var(--font-mono)', color: 'var(--ok)' });
const boxOpen = css({ fontFamily: 'var(--font-mono)', color: 'var(--fg-subtle)' });
const doneText = css({ color: 'var(--fg-subtle)', textDecoration: 'line-through' });
const openText = css({ color: 'var(--fg-muted)' });
const lineRef = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--fg-subtle)' });
const empty = css({ color: 'var(--fg-subtle)', fontSize: 'var(--fs-13)', paddingBlock: 'var(--space-6)' });

export function DocsRoadmap(handle: Handle<{ data: Dataset }>) {
  const collapsed = new Set<string>();
  const toggle = (k: string) => { if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k); void handle.update(); };

  return () => {
    const roadmaps = detectRoadmaps(getDocs(handle.props.data));
    if (roadmaps.length === 0) {
      return <div mix={page}><p mix={empty}>No checklists or roadmaps found in the docs. Add <code>- [ ] task</code> items to a doc and they'll appear here as a verifiable roadmap.</p></div>;
    }
    return (
      <div mix={page}>
        <h1 mix={h}>Roadmaps</h1>
        <p mix={lede}>Inferred from every checklist in the docs. Progress bars are computed from the actual <code>- [x]</code> state — so this is a verifiable view, not a hand-maintained one.</p>
        {roadmaps.map((r) => {
          const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
          return (
            <div key={r.docPath} mix={rm}>
              <div mix={rmHead}>
                <span mix={rmTitle}>{r.docTitle}</span>
                <span mix={rmPct}>{r.done}/{r.total} · {pct}% · {r.docPath}</span>
              </div>
              {r.sections.map((s, si) => {
                const key = r.docPath + '::' + si;
                const open = !collapsed.has(key);
                const spct = s.total ? Math.round((s.done / s.total) * 100) : 0;
                return (
                  <div key={key}>
                    <button type="button" mix={[secBtn, on('click', () => toggle(key))]} aria-expanded={open ? 'true' : 'false'}>
                      <span aria-hidden="true" mix={caret(open)}>▸</span>
                      <span mix={secTitle}>{s.title}</span>
                      <span mix={miniBar}><span mix={miniFill(spct)} /></span>
                      <span mix={secCount}>{s.done}/{s.total}</span>
                    </button>
                    {open ? (
                      <div mix={items}>
                        {s.items.map((it, i) => (
                          <div key={i} mix={item}>
                            <span aria-hidden="true" mix={it.done ? boxOk : boxOpen}>{it.done ? '☑' : '☐'}</span>
                            <span mix={it.done ? doneText : openText}>{it.text}</span>
                            <span mix={lineRef}>:{it.line}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };
}

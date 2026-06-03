/**
 * DocsFeatures — a "what does this project do" view built from two sources:
 * the capabilities the analyzer inferred from the code, and the feature names
 * lifted from doc sections titled "Features" / "Capabilities". The two
 * together cross-check intent (docs) against reality (code).
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../../lib/loadArtifacts.ts';
import { extractFeatures } from '../../lib/docsModel.ts';

const page = css({ maxWidth: 'var(--content-max)', marginInline: 'auto', paddingInline: 'var(--gutter)', paddingBlock: 'var(--space-6)' });
const h = css({ fontFamily: 'var(--font-display, var(--font-body))', fontSize: 'var(--fs-24)', fontWeight: '600', letterSpacing: '-0.02em', margin: '0 0 var(--space-2)' });
const lede = css({ color: 'var(--fg-muted)', fontSize: 'var(--fs-13)', marginBottom: 'var(--space-6)', maxWidth: '70ch' });
const section = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--accent)', margin: 'var(--space-6) 0 var(--space-3)' });
const grid = css({ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' });
const fcard = css({ border: '1px solid var(--hairline)', borderRadius: '12px', background: 'var(--surface-1)', padding: 'var(--space-4) var(--space-5)' });
const fhead = css({ fontSize: 'var(--fs-14)', fontWeight: '600', color: 'var(--fg)', display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' });
const fsub = css({ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', marginTop: '4px' });
const tick = css({ color: 'var(--ok)', flex: '0 0 auto' });
const docGroup = css({ marginBottom: 'var(--space-4)' });
const docName = css({ fontSize: 'var(--fs-13)', fontWeight: '600', color: 'var(--fg)', marginBottom: 'var(--space-2)' });
const featRow = css({ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', padding: '2px 0' });
const dot = css({ color: 'var(--accent)', flex: '0 0 auto' });
const lineRef = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--fg-subtle)', marginLeft: 'auto' });
const empty = css({ color: 'var(--fg-subtle)', fontSize: 'var(--fs-13)', paddingBlock: 'var(--space-6)' });

export function DocsFeatures(handle: Handle<{ data: Dataset }>) {
  return () => {
    const { fromAnalyzer, fromDocs } = extractFeatures(handle.props.data);
    if (fromAnalyzer.length === 0 && fromDocs.length === 0) {
      return <div mix={page}><p mix={empty}>No features detected. The analyzer found no capabilities, and no doc has a "Features" / "Capabilities" section.</p></div>;
    }

    // Group doc-derived features by source doc.
    const byDoc = new Map<string, typeof fromDocs>();
    for (const f of fromDocs) {
      const arr = byDoc.get(f.docTitle) ?? [];
      arr.push(f);
      byDoc.set(f.docTitle, arr);
    }

    return (
      <div mix={page}>
        <h1 mix={h}>Features</h1>
        <p mix={lede}>Capabilities the analyzer inferred from the code, alongside the features the docs claim. Mismatches are worth a look.</p>

        {fromAnalyzer.length ? (
          <>
            <p mix={section}>From the code · analyzer</p>
            <div mix={grid}>
              {fromAnalyzer.map((c, i) => (
                <div key={i} mix={fcard}>
                  <div mix={fhead}><span mix={tick}>✓</span><span>{c.head}</span></div>
                  {c.sub ? <div mix={fsub}>{c.sub}</div> : null}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {byDoc.size ? (
          <>
            <p mix={section}>From the docs · stated features</p>
            {[...byDoc.entries()].map(([title, feats]) => (
              <div key={title} mix={docGroup}>
                <div mix={docName}>{title}</div>
                {feats.map((f, i) => (
                  <div key={i} mix={featRow}>
                    <span aria-hidden="true" mix={dot}>›</span>
                    <span>{f.text}</span>
                    <span mix={lineRef}>{f.docPath}:{f.line}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        ) : null}
      </div>
    );
  };
}

import type { Dataset } from '../lib/loadArtifacts.ts';

/**
 * Overview — editorial landing page. Prose with inline numbers, stack
 * cards, language badges. No hero-metric template; the design principle
 * is evidence-first, not dashboard-generator.
 */
export function Overview({ data }: { data: Dataset }) {
  const langs = data.project.languages.slice(0, 6);
  const fmt = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
    : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K' : String(n);

  return (
    <article style={{ padding: '24px 32px', maxWidth: 960, margin: '0 auto' }}>
      <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 14 }}>
        Overview · analysis
      </div>

      <h1 className="serif" style={{ fontSize: 'clamp(2rem, 4vw, 3.25rem)', lineHeight: 1.1, letterSpacing: '-0.02em', marginBottom: 16 }}>
        {data.summary.oneLiner}
      </h1>

      <p style={{ fontSize: 17, maxWidth: '62ch', color: 'var(--fg-muted)', marginBottom: 24 }}>
        {data.project.name} spans <strong style={{ color: 'var(--fg)' }}>{fmt(data.stats.files)} files</strong> and
        {' '}<strong style={{ color: 'var(--fg)' }}>{fmt(data.stats.loc)} LOC</strong>, costing
        {' '}<strong style={{ color: 'var(--fg)' }}>~{fmt(data.stats.tokens)} tokens</strong> to fit into an AI
        context. The editorial dashboard surfaces routes, risks, and snapshots as evidence — every claim links
        back to its source.
      </p>

      <hr style={{ border: 0, borderTop: '1px solid var(--hairline)', margin: '28px 0' }} />

      <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 12 }}>Stack</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 24 }}>
        {langs.map((l) => (
          <div
            key={l.id}
            className="surface"
            style={{ borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, minWidth: 160 }}
          >
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: l.iconColor }} />
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>{l.label}</span>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-subtle)' }}>
              {fmt(l.loc)} · {l.files}f
            </span>
          </div>
        ))}
      </div>

      {data.project.frameworks.length > 0 && (
        <>
          <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 12 }}>Frameworks detected</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 24 }}>
            {data.project.frameworks.map((f) => (
              <span key={f} className="mono" style={{ fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 999, color: 'var(--fg-muted)' }}>
                {f}
              </span>
            ))}
          </div>
        </>
      )}

      {data.summary.capabilities.length > 0 && (
        <>
          <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 12 }}>Capabilities</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8, marginBottom: 24 }}>
            {data.summary.capabilities.map((c, i) => (
              <li key={i} style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: 'var(--accent)' }}>{c.icon}</span>
                <div>
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>{c.head}</span>
                  {c.sub && <span style={{ color: 'var(--fg-subtle)', fontSize: 13 }}> — {c.sub}</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

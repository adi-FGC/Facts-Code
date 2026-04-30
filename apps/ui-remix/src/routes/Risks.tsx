import type { Dataset } from '../lib/loadArtifacts.ts';

export function Risks({ data }: { data: Dataset }) {
  if (data.risks.length === 0) {
    return (
      <article style={{ padding: '40px 32px', maxWidth: 720, margin: '0 auto' }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 14 }}>Risks · audit</div>
        <h1 className="serif" style={{ fontSize: 32, lineHeight: 1.1, letterSpacing: '-0.02em', marginBottom: 16 }}>Nothing to flag today.</h1>
        <p style={{ fontSize: 15, color: 'var(--fg-muted)', maxWidth: '62ch' }}>
          No secrets, broken imports, cycles, license conflicts, or missing-license findings.
          This page populates the moment the next analysis finds something worth attention.
        </p>
      </article>
    );
  }

  const bySeverity = new Map<string, typeof data.risks>();
  for (const r of data.risks) {
    const arr = bySeverity.get(r.severity) ?? [];
    arr.push(r);
    bySeverity.set(r.severity, arr);
  }
  const order = ['critical', 'high', 'medium', 'low', 'info'];

  return (
    <article style={{ padding: '32px', maxWidth: 960, margin: '0 auto' }}>
      <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 14 }}>
        Risks · {data.risks.length} findings
      </div>
      <h1 className="serif" style={{ fontSize: 32, marginBottom: 24 }}>What to look at first.</h1>
      {order.filter((s) => bySeverity.has(s)).map((sev) => (
        <section key={sev} style={{ marginBottom: 24 }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: color(sev), marginBottom: 8 }}>{sev}</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
            {bySeverity.get(sev)!.map((r, i) => (
              <li key={i} className="surface" style={{ borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{r.message}</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  {r.category} · {r.rule}{r.file ? ` · ${r.file}` : ''}{r.line ? `:${r.line}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

function color(sev: string): string {
  if (sev === 'critical' || sev === 'high') return 'var(--danger)';
  if (sev === 'medium') return 'var(--warn)';
  if (sev === 'low') return 'var(--fg-muted)';
  return 'var(--fg-subtle)';
}

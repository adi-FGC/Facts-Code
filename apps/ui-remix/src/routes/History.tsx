import type { Dataset } from '../lib/loadArtifacts.ts';

/** History — sparklines over the snapshot sidecar. Mirrors the prototype. */
export function History({ data }: { data: Dataset }) {
  const history = Array.isArray(data.history) ? data.history : [];
  if (history.length < 2) {
    return (
      <article style={{ padding: '40px 32px', maxWidth: 720, margin: '0 auto' }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 14 }}>History · trend data</div>
        <h1 className="serif" style={{ fontSize: 32, lineHeight: 1.1, marginBottom: 16 }}>
          {history.length === 0 ? 'No snapshots yet.' : 'Just one snapshot so far.'}
        </h1>
        <p style={{ fontSize: 15, color: 'var(--fg-muted)', maxWidth: '62ch' }}>
          Run <span className="mono">factstack analyze</span> across multiple commits or days and this page plots
          how token cost, risks, TODOs, and file count move over time.
        </p>
      </article>
    );
  }

  const firstAt = new Date(history[0]!.at).toLocaleString();
  const lastAt = new Date(history[history.length - 1]!.at).toLocaleString();

  const row = (label: string, vals: number[], color: string) => {
    const last = vals[vals.length - 1] ?? 0;
    const first = vals[0] ?? 0;
    const delta = last - first;
    const pct = first ? (delta / first) * 100 : 0;
    const arrow = delta === 0 ? '→' : delta > 0 ? '↑' : '↓';
    return (
      <tr key={label} style={{ borderBottom: '1px solid var(--border)' }}>
        <td style={{ padding: '14px 0', fontFamily: 'var(--font-display)', fontWeight: 600 }}>{label}</td>
        <td className="mono" style={{ padding: '14px 16px' }}>{fmt(last)}</td>
        <td className="mono" style={{ padding: '14px 16px', color: delta > 0 ? 'var(--warn)' : delta < 0 ? 'var(--ok)' : 'var(--fg-muted)' }}>
          {arrow} {(delta >= 0 ? '+' : '') + fmt(delta)} ({pct.toFixed(1)}%)
        </td>
        <td style={{ padding: '10px 0', textAlign: 'right' }}>{spark(vals, color)}</td>
      </tr>
    );
  };

  return (
    <article style={{ padding: '32px', maxWidth: 1024, margin: '0 auto' }}>
      <div className="mono" style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 14 }}>
        History · {history.length} snapshots
      </div>
      <h1 className="serif" style={{ fontSize: 32, lineHeight: 1.1, marginBottom: 12 }}>How the codebase moved.</h1>
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', maxWidth: '62ch', marginBottom: 24 }}>
        {firstAt} — {lastAt}. Each analysis writes a snapshot into <span className="mono">.facts/snapshots/</span>; the
        sparklines plot every one.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--hairline)' }}>
            <th style={th}>Metric</th>
            <th style={th}>Latest</th>
            <th style={th}>Since first</th>
            <th style={{ ...th, textAlign: 'right' }}>Trend</th>
          </tr>
        </thead>
        <tbody>
          {row('Files',  history.map((h) => h.files),  'var(--info)')}
          {row('LOC',    history.map((h) => h.loc),    'var(--accent)')}
          {row('Tokens', history.map((h) => h.tokens), 'var(--accent)')}
          {row('Risks',  history.map((h) => h.risks),  'var(--danger)')}
          {row('TODOs',  history.map((h) => h.todos),  'var(--warn)')}
        </tbody>
      </table>
    </article>
  );
}

const th: React.CSSProperties = { padding: '8px 0', textAlign: 'left', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' };

function spark(values: number[], color: string) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const span = Math.max(max - min, 1);
  const w = 220, h = 40, step = w / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - ((v - min) / span) * (h - 4) - 2).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const lastX = ((values.length - 1) * step).toFixed(1);
  const lastY = (h - (((values[values.length - 1] ?? 0) - min) / span) * (h - 4) - 2).toFixed(1);
  return (
    <svg width={w} height={h} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2.5} fill={color} />
    </svg>
  );
}

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (a >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

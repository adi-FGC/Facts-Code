import type { Dataset } from '../lib/loadArtifacts.ts';

export function StatusBar({ data }: { data: Dataset }) {
  const h = data.summary.health;
  return (
    <footer
      role="contentinfo"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface-1)',
        fontSize: 11,
        color: 'var(--fg-subtle)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span>{data.stats.files} files</span>
      <span>{Math.round(data.stats.loc).toLocaleString()} LOC</span>
      <span>{fmtTok(data.stats.tokens)} tok</span>
      <span style={{ flex: 1 }} />
      <span style={{ color: h.broken ? 'var(--danger)' : 'var(--fg-subtle)' }}>
        {h.broken} broken
      </span>
      <span style={{ color: h.todos ? 'var(--warn)' : 'var(--fg-subtle)' }}>
        {h.todos} TODOs
      </span>
      <span style={{ color: h.secrets ? 'var(--danger)' : 'var(--ok)' }}>
        {h.secrets} secrets
      </span>
      <span>v0.1</span>
    </footer>
  );
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

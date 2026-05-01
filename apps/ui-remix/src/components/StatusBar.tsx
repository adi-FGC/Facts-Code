import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';

interface StatusBarProps {
  data: Dataset;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function StatusBar(_handle: Handle<StatusBarProps>) {
  return ({ data }: StatusBarProps) => {
    const s = data.stats;
    const h = data.summary.health;
    return (
      <footer
        class="glass"
        role="contentinfo"
        mix={css({
          display: 'flex', alignItems: 'center', gap: '14px',
          padding: '0 16px', height: '28px', fontSize: '11px',
          color: 'var(--fg-muted)', borderRadius: '0',
          borderTop: '1px solid var(--border)',
        })}
      >
        <span class="mono">{fmt(s.files)} files</span>
        <span class="mono">{fmt(s.loc)} LOC</span>
        <span class="mono">{fmt(s.tokens)} tok</span>
        <span mix={css({ flex: '1' })} />
        <span class="mono">{h.broken} broken</span>
        <span class="mono">{h.todos} TODOs</span>
        <span class="mono">{h.secrets} secrets</span>
      </footer>
    );
  };
}

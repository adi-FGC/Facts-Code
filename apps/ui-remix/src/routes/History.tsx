import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';

interface HistoryProps {
  data: Dataset;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function History(_h: Handle<HistoryProps>) {
  return ({ data }: HistoryProps) => {
    const history = data.history ?? [];
    if (history.length === 0) {
      return (
        <article mix={css({ padding: '40px 32px', maxWidth: '720px', margin: '0 auto' })}>
          <div class="mono" mix={css({
            fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
            color: 'var(--fg-subtle)', marginBottom: '14px',
          })}>History · trends</div>
          <h1 class="serif" mix={css({
            fontSize: '32px', lineHeight: '1.1', letterSpacing: '-0.02em',
            marginBottom: '16px',
          })}>One snapshot so far.</h1>
          <p mix={css({ fontSize: '15px', color: 'var(--fg-muted)', maxWidth: '62ch' })}>
            Trend lines populate after multiple analyses. Re-run{' '}
            <span class="mono">factstack analyze</span> on a recurring schedule to
            see LOC, risk, and token-cost evolution over time.
          </p>
        </article>
      );
    }
    return (
      <article mix={css({ padding: '32px', maxWidth: '960px', margin: '0 auto' })}>
        <div class="mono" mix={css({
          fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
          color: 'var(--fg-subtle)', marginBottom: '14px',
        })}>History · {history.length} snapshots</div>
        <h1 class="serif" mix={css({ fontSize: '32px', marginBottom: '24px' })}>
          Trends over time.
        </h1>
        <table mix={css({
          width: '100%', borderCollapse: 'collapse',
          fontSize: '13px',
        })}>
          <thead>
            <tr mix={css({ borderBottom: '1px solid var(--border)', textAlign: 'left' })}>
              <th mix={css({ padding: '8px 12px', color: 'var(--fg-subtle)', fontWeight: '500' })}>When</th>
              <th mix={css({ padding: '8px 12px', color: 'var(--fg-subtle)', fontWeight: '500' })}>Files</th>
              <th mix={css({ padding: '8px 12px', color: 'var(--fg-subtle)', fontWeight: '500' })}>LOC</th>
              <th mix={css({ padding: '8px 12px', color: 'var(--fg-subtle)', fontWeight: '500' })}>Tokens</th>
              <th mix={css({ padding: '8px 12px', color: 'var(--fg-subtle)', fontWeight: '500' })}>Risks</th>
              <th mix={css({ padding: '8px 12px', color: 'var(--fg-subtle)', fontWeight: '500' })}>TODOs</th>
            </tr>
          </thead>
          <tbody>
            {history.slice().reverse().map((h, i) => (
              <tr key={i} mix={css({ borderBottom: '1px solid var(--border)' })}>
                <td class="mono" mix={css({ padding: '8px 12px', fontSize: '12px' })}>
                  {new Date(h.at).toISOString().slice(0, 19).replace('T', ' ')}
                </td>
                <td class="mono" mix={css({ padding: '8px 12px' })}>{fmt(h.files)}</td>
                <td class="mono" mix={css({ padding: '8px 12px' })}>{fmt(h.loc)}</td>
                <td class="mono" mix={css({ padding: '8px 12px' })}>{fmt(h.tokens)}</td>
                <td class="mono" mix={css({ padding: '8px 12px' })}>{h.risks}</td>
                <td class="mono" mix={css({ padding: '8px 12px' })}>{h.todos}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    );
  };
}

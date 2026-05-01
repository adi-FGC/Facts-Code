import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';

interface OverviewProps {
  data: Dataset;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function Overview(_h: Handle<OverviewProps>) {
  return ({ data }: OverviewProps) => {
    const { project, summary, stats } = data;
    return (
      <article mix={css({ padding: '40px 32px', maxWidth: '880px', margin: '0 auto' })}>
        <div class="mono" mix={css({
          fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
          color: 'var(--fg-subtle)', marginBottom: '14px',
        })}>Overview · analysis</div>

        <h1 class="serif" mix={css({
          fontSize: '36px', lineHeight: '1.1',
          letterSpacing: '-0.02em', marginBottom: '20px',
        })}>{summary.oneLiner}</h1>

        <p mix={css({
          fontSize: '15px', color: 'var(--fg-muted)',
          maxWidth: '62ch', lineHeight: '1.6', marginBottom: '32px',
        })}>
          {project.name} spans <strong>{fmt(stats.files)} files</strong>{' '}
          and <strong>{fmt(stats.loc)} LOC</strong>, costing{' '}
          <strong>~{fmt(stats.tokens)} tokens</strong> to fit into an AI context.
          The editorial dashboard surfaces routes, risks, and snapshots as evidence —
          every claim links back to its source.
        </p>

        {/* Stack chips */}
        {project.languages.length > 0 && (
          <section mix={css({ marginBottom: '32px' })}>
            <div class="mono" mix={css({
              fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
              color: 'var(--fg-subtle)', marginBottom: '12px',
            })}>Stack</div>
            <div mix={css({
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: '10px',
            })}>
              {project.languages.slice(0, 8).map((l) => (
                <div
                  key={l.id}
                  class="surface"
                  mix={css({
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 12px', borderRadius: '8px',
                    fontSize: '13px',
                  })}
                >
                  <span mix={css({
                    width: '10px', height: '10px', borderRadius: '2px',
                    background: l.iconColor, flex: 'none',
                  })} />
                  <span mix={css({ flex: '1', fontWeight: '500' })}>{l.label}</span>
                  <span class="mono" mix={css({ fontSize: '11px', color: 'var(--fg-subtle)' })}>
                    {fmt(l.tokens)} · {l.files}f
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Frameworks */}
        {project.frameworks.length > 0 && (
          <section mix={css({ marginBottom: '32px' })}>
            <div class="mono" mix={css({
              fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
              color: 'var(--fg-subtle)', marginBottom: '12px',
            })}>Frameworks detected</div>
            <div mix={css({ display: 'flex', flexWrap: 'wrap', gap: '6px' })}>
              {project.frameworks.map((f) => (
                <span
                  key={f}
                  mix={css({
                    padding: '4px 10px', borderRadius: '999px',
                    fontSize: '12px', border: '1px solid var(--border)',
                    color: 'var(--fg-muted)',
                  })}
                >{f}</span>
              ))}
            </div>
          </section>
        )}

        {/* Capabilities */}
        {summary.capabilities.length > 0 && (
          <section>
            <div class="mono" mix={css({
              fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
              color: 'var(--fg-subtle)', marginBottom: '12px',
            })}>Capabilities</div>
            <ul mix={css({ listStyle: 'none', padding: '0', margin: '0', display: 'grid', gap: '6px' })}>
              {summary.capabilities.map((c, i) => (
                <li
                  key={i}
                  mix={css({ display: 'flex', gap: '10px', alignItems: 'baseline', fontSize: '14px' })}
                >
                  <span mix={css({ color: 'var(--ok)' })}>{c.icon || '✓'}</span>
                  <span>
                    <strong>{c.head}</strong>
                    {c.sub && <span mix={css({ color: 'var(--fg-muted)' })}> — {c.sub}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    );
  };
}

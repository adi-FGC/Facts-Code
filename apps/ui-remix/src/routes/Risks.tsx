import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';

interface RisksProps {
  data: Dataset;
}

function color(sev: string): string {
  if (sev === 'critical' || sev === 'high') return 'var(--danger)';
  if (sev === 'medium') return 'var(--warn)';
  if (sev === 'low') return 'var(--fg-muted)';
  return 'var(--fg-subtle)';
}

export function Risks(_h: Handle<RisksProps>) {
  return ({ data }: RisksProps) => {
    if (data.risks.length === 0) {
      return (
        <article mix={css({ padding: '40px 32px', maxWidth: '720px', margin: '0 auto' })}>
          <div class="mono" mix={css({
            fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
            color: 'var(--fg-subtle)', marginBottom: '14px',
          })}>Risks · audit</div>
          <h1 class="serif" mix={css({
            fontSize: '32px', lineHeight: '1.1', letterSpacing: '-0.02em',
            marginBottom: '16px',
          })}>Nothing to flag today.</h1>
          <p mix={css({ fontSize: '15px', color: 'var(--fg-muted)', maxWidth: '62ch' })}>
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
      <article mix={css({ padding: '32px', maxWidth: '960px', margin: '0 auto' })}>
        <div class="mono" mix={css({
          fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
          color: 'var(--fg-subtle)', marginBottom: '14px',
        })}>Risks · {data.risks.length} findings</div>
        <h1 class="serif" mix={css({ fontSize: '32px', marginBottom: '24px' })}>
          What to look at first.
        </h1>
        {order.filter((s) => bySeverity.has(s)).map((sev) => (
          <section key={sev} mix={css({ marginBottom: '24px' })}>
            <div class="mono" mix={css({
              fontSize: '11px', letterSpacing: '2px', textTransform: 'uppercase',
              color: color(sev), marginBottom: '8px',
            })}>{sev}</div>
            <ul mix={css({ listStyle: 'none', padding: '0', margin: '0', display: 'grid', gap: '10px' })}>
              {bySeverity.get(sev)!.map((r, i) => (
                <li
                  key={i}
                  class="surface"
                  mix={css({ borderRadius: '10px', padding: '12px 14px' })}
                >
                  <div mix={css({ fontSize: '14px', fontWeight: '500' })}>{r.message}</div>
                  <div class="mono" mix={css({ fontSize: '11px', color: 'var(--fg-subtle)', marginTop: '4px' })}>
                    {r.category} · {r.rule}
                    {r.file && ` · ${r.file}`}
                    {r.line && `:${r.line}`}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </article>
    );
  };
}

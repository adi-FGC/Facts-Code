/**
 * Placeholder shown for tabs that haven't been ported from the legacy
 * single-file prototype to this Remix v3 app yet. Tracked in
 * `apps/ui-remix/TASKS.md`.
 *
 * Critically: links the user back to the legacy demo at the same tab
 * via the legacy prototype's URL hash routing (shipped in `17f83f6`)
 * so they can SEE the feature instead of being stranded on a placeholder.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import { LEGACY_DEMO_URL } from '../lib/routes.ts';

export interface PortFromLegacyProps {
  tab: string;
  legacyHash: string;
  summary: string;
  features: string[];
}

export function PortFromLegacy(_handle: Handle<PortFromLegacyProps>) {
  return ({ tab, legacyHash, summary, features }: PortFromLegacyProps) => {
    const legacyHref = `${LEGACY_DEMO_URL}/${legacyHash}`;
    return (
      <article mix={css({ padding: '40px 32px', maxWidth: '720px', margin: '0 auto' })}>
        <div class="mono" mix={css({
          fontSize: '10px', letterSpacing: '2px', textTransform: 'uppercase',
          color: 'var(--fg-subtle)', marginBottom: '14px',
        })}>{tab} · porting</div>

        <h1 class="serif" mix={css({
          fontSize: '32px', lineHeight: '1.1', letterSpacing: '-0.02em',
          marginBottom: '16px',
        })}>Coming over from the legacy prototype.</h1>

        <p mix={css({
          fontSize: '15px', color: 'var(--fg-muted)',
          maxWidth: '62ch', lineHeight: '1.6',
        })}>{summary}</p>

        {features.length > 0 && (
          <>
            <h2 class="serif" mix={css({
              fontSize: '18px', marginTop: '28px',
              marginBottom: '10px', color: 'var(--fg)',
            })}>What this page will surface</h2>
            <ul mix={css({
              listStyle: 'none', padding: '0', margin: '0',
              display: 'grid', gap: '8px',
              fontSize: '14px', color: 'var(--fg-muted)',
            })}>
              {features.map((f, i) => (
                <li key={i} mix={css({ display: 'flex', gap: '10px', alignItems: 'baseline' })}>
                  <span mix={css({ color: 'var(--accent)', fontSize: '12px' })}>▸</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div class="surface" mix={css({
          marginTop: '32px', padding: '14px 18px', borderRadius: '10px',
          fontSize: '13px', color: 'var(--fg-muted)',
        })}>
          Want to see it working today?{' '}
          <a href={legacyHref} target="_blank" rel="noopener noreferrer"
            mix={css({ color: 'var(--accent)', textDecoration: 'underline' })}>
            Open the legacy prototype on this tab ↗
          </a>
          . Tracked in{' '}
          <code class="mono" mix={css({ fontSize: '12px' })}>apps/ui-remix/TASKS.md</code>.
        </div>
      </article>
    );
  };
}

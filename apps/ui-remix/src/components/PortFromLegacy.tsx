import { LEGACY_DEMO_URL } from '../lib/routes.ts';

/**
 * Placeholder shown for tabs that haven't been ported from the legacy
 * prototype to Remix v3 yet. Tracked in `apps/ui-remix/TASKS.md`.
 *
 * Critically: links the user to the legacy demo at the same tab name
 * via the URL hash routing we shipped in `17f83f6`, so they can SEE
 * the feature instead of being stranded on a placeholder.
 */
export interface PortFromLegacyProps {
  /** Title of the tab being ported. */
  tab: string;
  /** Hash that the legacy prototype uses for this tab (e.g. `#tab=routes`). */
  legacyHash: string;
  /** One-paragraph summary of what this tab does, in the user's words. */
  summary: string;
  /** Bullet list of the specific signals/features this page will surface. */
  features: string[];
}

export function PortFromLegacy({ tab, legacyHash, summary, features }: PortFromLegacyProps) {
  const legacyHref = `${LEGACY_DEMO_URL}/${legacyHash}`;
  return (
    <article style={{ padding: '40px 32px', maxWidth: 720, margin: '0 auto' }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 2,
          textTransform: 'uppercase',
          color: 'var(--fg-subtle)',
          marginBottom: 14,
        }}
      >
        {tab} · porting
      </div>

      <h1
        className="serif"
        style={{ fontSize: 32, lineHeight: 1.1, letterSpacing: '-0.02em', marginBottom: 16 }}
      >
        Coming over from the legacy prototype.
      </h1>

      <p style={{ fontSize: 15, color: 'var(--fg-muted)', maxWidth: '62ch', lineHeight: 1.6 }}>
        {summary}
      </p>

      {features.length > 0 && (
        <>
          <h2
            className="serif"
            style={{ fontSize: 18, marginTop: 28, marginBottom: 10, color: 'var(--fg)' }}
          >
            What this page will surface
          </h2>
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 8,
              fontSize: 14,
              color: 'var(--fg-muted)',
            }}
          >
            {features.map((f, i) => (
              <li
                key={i}
                style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}
              >
                <span style={{ color: 'var(--accent)', fontSize: 12 }}>▸</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div
        className="surface"
        style={{
          marginTop: 32,
          padding: '14px 18px',
          borderRadius: 10,
          fontSize: 13,
          color: 'var(--fg-muted)',
        }}
      >
        Want to see it working today?{' '}
        <a
          href={legacyHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--accent)', textDecoration: 'underline' }}
        >
          Open the legacy prototype on this tab ↗
        </a>
        . Tracked in{' '}
        <code className="mono" style={{ fontSize: 12 }}>
          apps/ui-remix/TASKS.md
        </code>
        .
      </div>
    </article>
  );
}

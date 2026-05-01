/**
 * PortFromLegacy — placeholder for tabs not yet ported from the legacy
 * single-file prototype (`legacy/prototype/index.html`).
 *
 * Editorial treatment: kicker → headline → lede → "what this surfaces"
 * list → footnote-style margin chip linking back to the live legacy
 * demo at the same `#tab=name` so the user can see the feature today.
 *
 * NOT a card. NOT a "coming soon" badge. Reads as a press release
 * announcing what's next.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import { LEGACY_DEMO_URL } from '../lib/routes.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

export interface PortFromLegacyProps {
  tab: string;
  legacyHash: string;
  summary: string;
  features: string[];
  /** Optional one-word state, e.g. "deferred", "in-progress". */
  status?: string;
}

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

const headline = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-display-sm)',
  fontWeight: '600',
  letterSpacing: '-0.025em',
  lineHeight: '1.04',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
  fontVariationSettings: '"opsz" 64',
});

const lede = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-20)',
  fontWeight: '400',
  letterSpacing: '-0.005em',
  lineHeight: '1.45',
  color: 'var(--fg-muted)',
  fontVariationSettings: '"opsz" 24',
  maxWidth: '56ch',
  marginBottom: 'var(--space-12)',
});

const featureList = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
});

const featureItem = css({
  display: 'grid',
  gridTemplateColumns: '24px 1fr',
  gap: 'var(--space-3)',
  alignItems: 'baseline',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
});

const featureMark = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--accent)',
  fontWeight: '500',
  letterSpacing: '0.04em',
});

const featureText = css({
  fontSize: 'var(--fs-14)',
  color: 'var(--fg)',
  lineHeight: '1.5',
});

export function PortFromLegacy(_handle: Handle<PortFromLegacyProps>) {
  return ({ tab, legacyHash, summary, features, status = 'porting' }: PortFromLegacyProps) => {
    const legacyHref = `${LEGACY_DEMO_URL}/${legacyHash}`;
    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>{tab} · {status}</div>
          <h1 mix={headline}>Coming over from the legacy prototype.</h1>
          <p mix={lede}>{summary}</p>

          {features.length > 0 && (
            <Section label="What this page will surface">
              <ul mix={featureList}>
                {features.map((f, i) => (
                  <li key={i} mix={featureItem}>
                    <span mix={featureMark}>{String(i + 1).padStart(2, '0')}</span>
                    <span mix={featureText}>{f}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
        <MarginColumn>
          <FootnoteChip label="See it today" tone="accent">
            <a
              href={legacyHref}
              target="_blank"
              rel="noopener noreferrer"
              mix={css({ color: 'var(--accent)', textDecoration: 'underline', textDecorationThickness: '1px' })}
            >
              Legacy prototype, this tab ↗
            </a>
          </FootnoteChip>
          <FootnoteChip label="Tracked in">
            <code class="mono" style="font-size:var(--fs-11)">apps/ui-remix/TASKS.md</code>
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}

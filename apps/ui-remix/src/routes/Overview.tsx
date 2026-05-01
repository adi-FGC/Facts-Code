/**
 * Overview — the editorial landing.
 *
 * Composition:
 *   ┌──────────────────────────────────────┬──────────────────┐
 *   │ KICKER                                                  │
 *   │ DISPLAY HEADLINE (oneLiner — Fraunces, 4-6 lines max)   │
 *   │ Lede paragraph                                          │
 *   │ ─────────────── hairline ─────────────                  │
 *   │ FILES   LOC   TOKENS   RISKS    ←  LabelNumberRow       │
 *   │ ─────────────── hairline ─────────────                  │
 *   │                                                         │
 *   │ ## Stack                              FRAMEWORKS         │
 *   │ Stack rows                            ⌐                  │
 *   │                                       │ React, Vite, …   │
 *   │ ## Capabilities                       ⌐                  │
 *   │ Capabilities                          │ MARGIN CHIPS     │
 *   │                                       │                  │
 *   └──────────────────────────────────────┴──────────────────┘
 *
 * < 1280px: margin column collapses, chips stack into the body flow.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface OverviewProps {
  data: Dataset;
}

function fmt(n: number): string {
  // Numbers > 999 get K/M shortened so the display column stays compact;
  // smaller values render as-is (43,890 stays 43.9K to keep visual weight
  // proportional in the row).
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
  display: 'flex',
  gap: 'var(--space-3)',
  alignItems: 'baseline',
});

const kickerDot = css({
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  background: 'var(--accent)',
  display: 'inline-block',
});

const headline = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-display)',
  fontWeight: '600',
  letterSpacing: '-0.025em',
  lineHeight: '1.04',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
  fontVariationSettings: '"opsz" 144',
  /* Hanging punctuation for a quote-like opening when the oneLiner
     starts with a quotation mark. */
  hangingPunctuation: 'first',
});

const stackRow = css({
  /* Audit fix #3: 3 cols (name · tokens · file count chip), not 4.
     "X tokens / Y files" → "Y · X" mono cell. Less noise. */
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'baseline',
  columnGap: 'var(--space-4)',
  paddingInline: 'var(--space-3)',
  marginInline: 'calc(var(--space-3) * -1)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  transition: 'background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    background: 'var(--highlight-faint)',
  },
});

const langSwatch = (color: string) => css({
  display: 'inline-block',
  width: '10px',
  height: '10px',
  background: color,
  marginRight: 'var(--space-3)',
  verticalAlign: 'baseline',
  transform: 'translateY(1px)',
});

const stackName = css({
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-16)',
  fontWeight: '500',
});

const stackMeta = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--fg-subtle)',
  whiteSpace: 'nowrap',
});

const capList = css({
  listStyle: 'none',
  margin: '0',
  padding: '0',
});

const capItem = css({
  display: 'grid',
  gridTemplateColumns: '24px 1fr',
  gap: 'var(--space-3)',
  alignItems: 'baseline',
  paddingInline: 'var(--space-3)',
  marginInline: 'calc(var(--space-3) * -1)',
  paddingBlock: 'var(--space-3)',
  borderBottom: '1px solid var(--hairline)',
  transition: 'background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    background: 'var(--highlight-faint)',
  },
});

const capMark = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--accent)',
  fontWeight: '500',
  letterSpacing: '0.04em',
});

/* Audit fix #5: head + sub were rendered same weight — hard to scan
   the list. Head now sits at fs-14 weight 600; sub drops to fs-12
   roman + muted color so the two reads are unambiguous. */
const capText = css({
  fontSize: 'var(--fs-14)',
  color: 'var(--fg)',
  lineHeight: '1.5',
  fontWeight: '600',
});

const capSub = css({
  display: 'block',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
  marginTop: 'var(--space-1)',
  fontWeight: '400',
});

const ledeText = css({
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

export function Overview(_h: Handle<OverviewProps>) {
  return ({ data }: OverviewProps) => {
    const { project, summary, stats } = data;
    const topLanguages = project.languages.slice(0, 6);
    const remainingFrameworks = Math.max(0, project.frameworks.length - 6);
    const showFrameworks = project.frameworks.slice(0, 6);
    return (
      <ContentWithMargin>
        {/* Kicker · headline · lede ────────────────────────────── */}
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>
            <span aria-hidden="true" mix={kickerDot} />
            Overview
            <span mix={css({ color: 'var(--fg-faint)' })}>·</span>
            <span mix={css({ color: 'var(--fg-subtle)' })}>analysis</span>
          </div>
          <h1 mix={headline}>{summary.oneLiner}</h1>
          <p mix={ledeText}>
            {project.name} spans <strong style="font-weight:600;color:var(--fg)">{fmt(stats.files)} files</strong>
            {' '}and{' '}
            <strong style="font-weight:600;color:var(--fg)">{fmt(stats.loc)} lines</strong>
            , a roughly{' '}
            <strong style="font-weight:600;color:var(--fg)">{fmt(stats.tokens)}-token</strong>
            {' '}context window. Every metric below links to its source.
          </p>

          {/* Headline figures — LabelNumberRow */}
          <LabelNumberRow>
            <LabelNumber label="Files"  value={fmt(stats.files)} />
            <LabelNumber label="Lines"  value={fmt(stats.loc)} />
            <LabelNumber label="Tokens" value={fmt(stats.tokens)} unit="cl100k" />
            <LabelNumber
              label="Risks"
              value={data.risks.length}
              hint={data.risks.length === 0 ? 'clean' : 'review'}
              last
            />
          </LabelNumberRow>

          {/* Stack — language list as agate column */}
          <Section label="Stack" title="What it's made of">
            <ul mix={css({ listStyle: 'none', margin: '0', padding: '0' })}>
              {topLanguages.map((l) => (
                <li key={l.id} mix={stackRow}>
                  <span mix={stackName}>
                    <span aria-hidden="true" mix={langSwatch(l.iconColor)} />
                    {l.label}
                  </span>
                  <span mix={stackMeta}>
                    {l.files}{l.files === 1 ? ' file' : ' files'}
                    <span mix={css({ color: 'var(--fg-faint)', marginInline: '6px' })}>·</span>
                    {fmt(l.tokens)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          {/* Capabilities — bullet list, no boxes */}
          {summary.capabilities.length > 0 && (
            <Section label="Capabilities" title="What it does">
              <ul mix={capList}>
                {summary.capabilities.map((c, i) => (
                  <li key={i} mix={capItem}>
                    <span mix={capMark}>{String(i + 1).padStart(2, '0')}</span>
                    <span mix={capText}>
                      {c.head}
                      {c.sub && <span mix={capSub}>{c.sub}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {/* Margin column — frameworks, health, intent ───────── */}
        <MarginColumn>
          {project.frameworks.length > 0 && (
            <FootnoteChip
              label="Frameworks"
              aside={remainingFrameworks > 0 ? `+${remainingFrameworks} more` : undefined}
            >
              {/* Audit fix #6: vertical list, one framework per line.
                  Comma-separated wraps awkwardly + "+N more" hangs
                  detached in tight margin widths. */}
              <ul mix={css({ listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: '2px' })}>
                {showFrameworks.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </FootnoteChip>
          )}
          <FootnoteChip
            label="Health"
            tone={
              summary.health.broken > 0 || summary.health.secrets > 0
                ? 'danger'
                : summary.health.todos > 0
                ? 'warn'
                : 'ok'
            }
          >
            {summary.health.broken === 0 && summary.health.secrets === 0
              ? 'Clean. No broken imports, no secrets in source.'
              : `${summary.health.broken} broken · ${summary.health.secrets} secrets · ${summary.health.todos} todos`}
          </FootnoteChip>
          {summary.description && (
            <FootnoteChip label="Intent">{summary.description}</FootnoteChip>
          )}
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}

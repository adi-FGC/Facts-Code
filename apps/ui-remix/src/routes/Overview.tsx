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
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { HealthGrade } from '../ui/HealthGrade.tsx';
import { healthTone } from '../lib/healthTone.ts';
import { TokenRoiPanel } from '../ui/TokenRoiPanel.tsx';

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

/* v0.3.10 — Overview health badge. A single hairline-bordered row
   above the LabelNumberRow that answers "is anything broken?" before
   the user reads anything else. Clicks through to /risks so the most-
   common Overview-visit reason resolves in one click.
   Three states: ok / warn / danger. Each carries a colored leading
   bar (matches StatusChip's grammar) + mono label + arrow tail. */
const healthBadge = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-3)',
  paddingBlock: 'var(--space-3)',
  paddingInline: 'var(--space-4)',
  marginBottom: 'var(--space-6)',
  border: '1px solid var(--hairline)',
  background: 'var(--bg)',
  textDecoration: 'none',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  letterSpacing: '0.04em',
  color: 'var(--fg-muted)',
  transition: 'border-color var(--dur-quick) var(--ease-out-quart), background var(--dur-quick) var(--ease-out-quart)',
  '&:hover': {
    borderColor: 'var(--border)',
    background: 'var(--highlight-faint)',
  },
});

const healthBadgeOk = css({ '--badge-color': 'var(--ok)' });
const healthBadgeWarn = css({ '--badge-color': 'var(--warn)' });
const healthBadgeDanger = css({ '--badge-color': 'var(--danger)' });

const healthBadgeBar = css({
  display: 'inline-block',
  width: '4px',
  alignSelf: 'stretch',
  background: 'var(--badge-color, var(--fg-muted))',
  marginBlock: '-2px',
});

const healthBadgeText = css({
  flex: '1',
  color: 'var(--fg)',
});

const healthBadgeStrong = css({
  color: 'var(--badge-color, var(--fg))',
  fontWeight: '500',
});

const healthBadgeArrow = css({
  color: 'var(--badge-color, var(--fg-faint))',
  fontFamily: 'var(--font-display)',
  fontSize: 'var(--fs-13)',
});

const headline = css({
  /* Switched from --font-display (Fraunces serif) to --font-body
     (Mona Sans) per direct user feedback — the serif at display size
     was reading as old-broadsheet headline rather than dashboard hero
     when the oneLiner was a long compound sentence. Sans gives the
     same op-typography feel at the wider tracking we use here without
     the "newspaper" register. */
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-display)',
  fontWeight: '600',
  /* Tightened tracking compensates for sans's wider intrinsic spacing
     at display size — same optical density as the old serif setting. */
  letterSpacing: '-0.03em',
  lineHeight: '1.08',
  color: 'var(--fg)',
  marginBottom: 'var(--space-6)',
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

/* Emphasized figures inside the lede — same weight/color the inline
   style="font-weight:600;color:var(--fg)" used to set, hoisted to a
   class so the CSP can drop style-src 'unsafe-inline'. */
const ledeStrong = css({
  fontWeight: '600',
  color: 'var(--fg)',
});

export function Overview(handle: Handle<OverviewProps>) {
  return () => {
    const { data } = handle.props;
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
            <span mix={css({ color: 'var(--fg-subtle)' })}>{fmt(stats.files)} files</span>
            {/* v0.3.11 H6: project + tool attribution. A first-time
                visitor landing on a shared dashboard URL needs to know
                "what am I looking at?" — the project name + "FACTS"
                tool name in the kicker answers it without another
                click. Pushed to the right with margin-left: auto so
                the visit-count text stays where the eye expects. */}
            <span mix={css({ flex: '1' })} />
            <span mix={css({ color: 'var(--fg-faint)' })}>·</span>
            <span mix={css({ color: 'var(--fg-subtle)' })}>
              FACTS analyzing <span mix={css({ color: 'var(--fg-muted)', fontWeight: '500' })}>{project.name}</span>
            </span>
          </div>
          <h1 mix={headline}>{summary.oneLiner}</h1>
          <p mix={ledeText}>
            {project.name} spans <strong mix={ledeStrong}>{fmt(stats.files)} files</strong>
            {' '}and{' '}
            <strong mix={ledeStrong}>{fmt(stats.loc)} lines</strong>
            , a roughly{' '}
            <strong mix={ledeStrong}>{fmt(stats.tokens)}-token</strong>
            {' '}context window. Every metric below links to its source.
          </p>

          {/* v0.3 — health badge. Click → /risks. Leads with the composite
              grade (A–F · 0–100) when present, then the top deductions. Tone
              comes from the shared healthTone() helper so it never disagrees
              with the margin HealthGrade marque. Pre-v0.3 datasets (no letter)
              fall back to the original severity-count summary below. */}
          {(() => {
            const h = summary.health;
            const tone = healthTone(h);
            const toneStyle =
              tone === 'danger' ? healthBadgeDanger : tone === 'warn' ? healthBadgeWarn : healthBadgeOk;
            const verb = tone === 'danger' ? 'Act on Risks' : tone === 'warn' ? 'Open Risks' : 'View Risks';

            if (h.grade && typeof h.score === 'number') {
              // Reuse core's headline prose (single grammar source — memory
              // pins it verbatim) by stripping the "{grade} · {score} — " head.
              // Grade/score render strong from the structured fields; the factor
              // tail renders muted. Take everything after the FIRST " — " so the
              // clean tail ("clean — no blockers detected") survives intact.
              const sep = h.headline.indexOf(' — ');
              const tail = sep >= 0 ? h.headline.slice(sep + 3) : h.headline;
              return (
                <a
                  href="/risks"
                  mix={[healthBadge, toneStyle]}
                  aria-label={`Health grade ${h.grade}, score ${h.score} of 100. ${tail}.`}
                >
                  <span aria-hidden="true" mix={healthBadgeBar} />
                  <span mix={healthBadgeText}>
                    <span mix={healthBadgeStrong}>{h.grade} · {h.score}</span>
                    <span mix={css({ color: 'var(--fg-faint)' })}> — {tail}</span>
                  </span>
                  <span mix={healthBadgeArrow}>{verb} →</span>
                </a>
              );
            }

            // Fallback: pre-grade dataset. Original severity-count summary.
            const risks = data.risks;
            const counts = risks.reduce<Record<string, number>>((acc, r) => {
              acc[r.severity] = (acc[r.severity] ?? 0) + 1;
              return acc;
            }, {});
            const critical = counts.critical ?? 0;
            const label =
              tone === 'danger'
                ? `${critical + h.secrets + h.broken} critical · review now`
                : tone === 'warn'
                ? `${risks.length} ${risks.length === 1 ? 'finding' : 'findings'} · ${h.stale} stale · ${h.todos} TODOs · review when convenient`
                : `0 findings · scanned clean`;
            return (
              <a href="/risks" mix={[healthBadge, toneStyle]} aria-label={`Health: ${label}`}>
                <span aria-hidden="true" mix={healthBadgeBar} />
                <span mix={healthBadgeText}>
                  <span mix={healthBadgeStrong}>{label.split('·')[0]?.trim()}</span>
                  <span mix={css({ color: 'var(--fg-faint)' })}> · {label.split('·').slice(1).join('·').trim()}</span>
                </span>
                <span mix={healthBadgeArrow}>{verb} →</span>
              </a>
            );
          })()}

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

          {/* Token economics — the quantified FACTS pitch. Sits right
              under the headline figures so the Tokens number above flows
              straight into "here's what that costs an agent, and what
              FACTS saves." */}
          <TokenRoiPanel data={data} />

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
          <HealthGrade health={summary.health} />
          {summary.description && (
            <FootnoteChip label="Intent">{summary.description}</FootnoteChip>
          )}
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}

/**
 * History — snapshot trends.
 *
 * Headline figures up top with sparklines wrapped into the
 * LabelNumber `trailing` slot, then a hairline-divided table of
 * snapshots in reverse-chronological order.
 *
 * No chart library — the sparkline component is ~30 lines of inline
 * SVG. Justified because the trend line is real meaning, not
 * decoration (per the design spec's anti-slop rule).
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { Sparkline } from '../ui/Sparkline.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface HistoryProps {
  data: Dataset;
}

function fmt(n: number): string {
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

export function History(_h: Handle<HistoryProps>) {
  return ({ data }: HistoryProps) => {
    const history = data.history ?? [];
    if (history.length === 0) {
      return (
        <ContentWithMargin>
          <div mix={css({ gridColumn: '1' })}>
            <div mix={kicker}>History · 1 snapshot</div>
            <h1 mix={headline}>One snapshot so far.</h1>
            <p mix={lede}>
              Trend lines populate after multiple analyses. Re-run{' '}
              <code style="font-family:var(--font-mono);font-size:0.92em;color:var(--fg)">factstack analyze</code>{' '}
              on a recurring schedule (a CI step, a watch loop, or a cron)
              to populate LOC, risk count, and token-cost evolution here.
            </p>
          </div>
          <MarginColumn>
            <FootnoteChip label="Generated">
              {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
            </FootnoteChip>
          </MarginColumn>
        </ContentWithMargin>
      );
    }
    const series = {
      loc:    history.map((h) => h.loc),
      tokens: history.map((h) => h.tokens),
      files:  history.map((h) => h.files),
      risks:  history.map((h) => h.risks),
    };
    const last = history[history.length - 1]!;
    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>History · {history.length} {history.length === 1 ? 'snapshot' : 'snapshots'}</div>
          <h1 mix={headline}>Trends over time.</h1>
          <p mix={lede}>
            Each row below is a single analysis pass. The figures above
            track the latest value with a sparkline of the full series.
          </p>

          <LabelNumberRow>
            <LabelNumber
              label="Lines"
              value={fmt(last.loc)}
              trailing={<Sparkline values={series.loc}    label="lines over time" />}
            />
            <LabelNumber
              label="Tokens"
              value={fmt(last.tokens)}
              trailing={<Sparkline values={series.tokens} label="tokens over time" />}
            />
            <LabelNumber
              label="Files"
              value={fmt(last.files)}
              trailing={<Sparkline values={series.files}  label="files over time" />}
            />
            <LabelNumber
              label="Risks"
              value={last.risks}
              trailing={<Sparkline values={series.risks}  label="risks over time" color="var(--danger)" />}
              last
            />
          </LabelNumberRow>

          <Section label="Snapshots" title="Every analysis pass">
            <RuledTable cols="auto auto auto auto auto auto">
              <RuledRow header>
                <RuledCell header>When</RuledCell>
                <RuledCell header align="right">Files</RuledCell>
                <RuledCell header align="right">Lines</RuledCell>
                <RuledCell header align="right">Tokens</RuledCell>
                <RuledCell header align="right">Risks</RuledCell>
                <RuledCell header align="right">TODOs</RuledCell>
              </RuledRow>
              {history.slice().reverse().map((h, i) => (
                <RuledRow key={i}>
                  <RuledCell mono>
                    {new Date(h.at).toISOString().slice(0, 19).replace('T', ' ')}
                  </RuledCell>
                  <RuledCell mono align="right">{fmt(h.files)}</RuledCell>
                  <RuledCell mono align="right">{fmt(h.loc)}</RuledCell>
                  <RuledCell mono align="right">{fmt(h.tokens)}</RuledCell>
                  <RuledCell mono align="right">{h.risks}</RuledCell>
                  <RuledCell mono align="right">{h.todos}</RuledCell>
                </RuledRow>
              ))}
            </RuledTable>
          </Section>
        </div>
        <MarginColumn>
          <FootnoteChip label="Generated">
            {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
          </FootnoteChip>
          <FootnoteChip label="Window">
            {history.length === 1
              ? '1 snapshot'
              : `${history.length} snapshots · ${new Date(history[0]!.at).toLocaleDateString()} → today`}
          </FootnoteChip>
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}

/**
 * Risks — severity-grouped findings.
 *
 * Groups in canonical severity order with a tracked uppercase header
 * for each. Empty state is itself editorial: an "all clear" headline
 * + a one-paragraph dispatch. No empty-state illustration cliché.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { RiskRow } from '../ui/RiskRow.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';
import { LabelNumberRow, LabelNumber } from '../ui/LabelNumber.tsx';

interface RisksProps {
  data: Dataset;
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

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

export function Risks(handle: Handle<RisksProps>) {
  return () => {
    const { data } = handle.props;
    if (data.risks.length === 0) {
      return (
        <ContentWithMargin>
          <div mix={css({ gridColumn: '1' })}>
            <div mix={kicker}>Risks · 0 findings</div>
            <h1 mix={headline}>Nothing to flag today.</h1>
            <p mix={lede}>
              No exposed secrets, no unresolved imports, no dependency cycles,
              no license conflicts. The next analysis will repopulate this
              page the moment something is worth your attention.
            </p>
          </div>
          <MarginColumn>
            <FootnoteChip label="Last scanned" tone="ok">
              {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
            </FootnoteChip>
            <FootnoteChip label="Coverage" aside="see Tests tab">
              Secrets, licenses, broken imports, cycles, supply chain
            </FootnoteChip>
          </MarginColumn>
        </ContentWithMargin>
      );
    }
    const counts: Record<string, number> = {};
    for (const r of data.risks) counts[r.severity] = (counts[r.severity] ?? 0) + 1;
    const bySeverity = new Map<string, typeof data.risks>();
    for (const r of data.risks) {
      const arr = bySeverity.get(r.severity) ?? [];
      arr.push(r);
      bySeverity.set(r.severity, arr);
    }
    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1' })}>
          <div mix={kicker}>Risks · {data.risks.length} {data.risks.length === 1 ? 'finding' : 'findings'}</div>
          <h1 mix={headline}>What to look at first.</h1>
          <p mix={lede}>
            Highest-severity items lead. Each finding ties back to a file
            and line; click through to read the exact source.
          </p>
          <LabelNumberRow>
            <LabelNumber label="Critical" value={counts.critical ?? 0} />
            <LabelNumber label="High"     value={counts.high     ?? 0} />
            <LabelNumber label="Medium"   value={counts.medium   ?? 0} />
            <LabelNumber label="Low"      value={counts.low      ?? 0} last />
          </LabelNumberRow>

          {SEV_ORDER.filter((s) => bySeverity.has(s)).map((sev) => (
            <Section key={sev} label={sev}>
              {bySeverity.get(sev)!.map((r, i) => (
                <RiskRow
                  key={i}
                  severity={r.severity as 'critical' | 'high' | 'medium' | 'low' | 'info'}
                  rule={r.rule}
                  category={r.category}
                  message={r.message}
                  source={r.file ? `${r.file}${r.line != null ? ':' + r.line : ''}` : undefined}
                  preview={r.preview}
                  messageTechnical={r.messageTechnical}
                />
              ))}
            </Section>
          ))}
        </div>
        <MarginColumn>
          <FootnoteChip label="Last scanned">
            {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}
          </FootnoteChip>
          {(counts.critical ?? 0) + (counts.high ?? 0) > 0 && (
            <FootnoteChip
              label="Action"
              tone="danger"
              aside="see legacy Risks tab for redacted previews"
            >
              {(counts.critical ?? 0) + (counts.high ?? 0)} item{(counts.critical ?? 0) + (counts.high ?? 0) === 1 ? '' : 's'} need rotation or removal before next deploy.
            </FootnoteChip>
          )}
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}

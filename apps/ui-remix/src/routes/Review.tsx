/**
 * Review — the Change Verdict panel.
 *
 * The human-reviewer surface for FACTS's structural-depth code intelligence
 * (the validated wedge: Greptile/CodeRabbit-style review, grounded in the
 * real dependency graph rather than an LLM's read of a diff).
 *
 * Two honest halves (see lib/reviewVerdict.ts for why):
 *   - POSTURE: current structural risk from the live graph (secrets, CVEs,
 *     cycles, blast radius). Always available.
 *   - TREND: count deltas vs a chosen baseline snapshot. Lights up when
 *     history exists; a picker chooses the baseline.
 *
 * Severity is scored by @factstack/core, so this verdict matches the CLI
 * (`factstack review`) and MCP (`review_change`) byte-for-byte in meaning.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { Dataset } from '../lib/loadArtifacts.ts';
import type { ReviewSeverity } from '@factstack/spec';
import { buildReviewVerdict, type ReviewBaseline, type Delta } from '../lib/reviewVerdict.ts';
import { ContentWithMargin, MarginColumn } from '../ui/MarginColumn.tsx';
import { Section } from '../ui/Section.tsx';
import { LabelNumber, LabelNumberRow } from '../ui/LabelNumber.tsx';
import { RuledTable, RuledRow, RuledCell } from '../ui/RuledColumn.tsx';
import { FootnoteChip } from '../ui/FootnoteChip.tsx';

interface ReviewProps {
  data: Dataset;
}

const SEVERITY_TOKEN: Record<ReviewSeverity, string> = {
  none: 'var(--ok)',
  low: 'var(--accent)',
  medium: 'var(--warn)',
  high: 'color-mix(in oklab, var(--danger) 62%, var(--warn))',
  critical: 'var(--danger)',
};
const SEVERITY_WORD: Record<ReviewSeverity, string> = {
  none: 'No risk',
  low: 'Low',
  medium: 'Elevated',
  high: 'High',
  critical: 'Critical',
};
const FINDING_DOT: Record<string, string> = {
  low: 'var(--accent)',
  medium: 'var(--warn)',
  high: 'color-mix(in oklab, var(--danger) 62%, var(--warn))',
  critical: 'var(--danger)',
};

const kicker = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 'var(--space-5)',
});

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
function shortAt(at: string): string {
  try {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return at;
  }
}
function resolveBaseline(key: string, data: Dataset): ReviewBaseline | null {
  const history = data.history ?? [];
  const priors = history.filter((h) => h.at !== data.generatedAt);
  if (key === '@none') return null;
  if (key === '@auto') return priors.length ? priors[priors.length - 1]! : null;
  return history.find((h) => h.at === key) ?? null;
}

export function Review(handle: Handle<ReviewProps>) {
  // '@auto' = newest prior snapshot · '@none' = posture only · else an ISO ts.
  let baselineKey = '@auto';
  function setBaseline(next: string) {
    baselineKey = next;
    void handle.update();
  }

  return () => {
    const { data } = handle.props;
    const history = data.history ?? [];
    const priors = history.filter((h) => h.at !== data.generatedAt);
    const baseline = resolveBaseline(baselineKey, data);
    const v = buildReviewVerdict(data, baseline);
    const tone = SEVERITY_TOKEN[v.severity];

    return (
      <ContentWithMargin>
        <div mix={css({ gridColumn: '1', minWidth: '0' })}>
          <div mix={kicker}>Review · change verdict</div>

          {/* ── severity hero ── */}
          <div
            mix={css({
              position: 'relative',
              border: '1px solid var(--border)',
              borderRadius: '16px',
              background: 'var(--surface-1)',
              padding: 'var(--space-6)',
              paddingLeft: 'var(--space-7)',
              overflow: 'hidden',
              marginBottom: 'var(--space-6)',
            })}
          >
            <div
              mix={css({
                position: 'absolute',
                insetBlock: '0',
                insetInlineStart: '0',
                width: '4px',
                background: tone,
              })}
            />
            <div
              mix={css({
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-10)',
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: tone,
                marginBottom: 'var(--space-3)',
              })}
            >
              {SEVERITY_WORD[v.severity]} risk{v.findings.length ? ` · ${v.findings.length} finding${v.findings.length === 1 ? '' : 's'}` : ''}
            </div>
            <h1
              mix={css({
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(var(--fs-24), 3vw, var(--fs-32))',
                fontWeight: '600',
                letterSpacing: '-0.02em',
                lineHeight: '1.18',
                color: 'var(--fg)',
                margin: '0',
                maxWidth: '54ch',
              })}
            >
              {v.headline}
            </h1>

            {/* posture chips */}
            <div
              mix={css({
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--space-2)',
                marginTop: 'var(--space-5)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-11)',
              })}
            >
              <PostureChip label="secrets" value={v.posture.secrets} danger={v.posture.secrets > 0} />
              <PostureChip label="CVEs" value={v.posture.vulnerabilities} danger={v.posture.vulnerabilities > 0} />
              <PostureChip label="cycles" value={v.posture.cycles} danger={v.posture.cycles > 0} />
              <PostureChip
                label="max blast"
                value={v.posture.topHub ? v.posture.topHub.reach : 0}
                danger={false}
              />
            </div>
          </div>

          {/* ── baseline picker ── */}
          <label
            mix={css({
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-6)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-11)',
              color: 'var(--fg-muted)',
              flexWrap: 'wrap',
            })}
          >
            <span mix={css({ letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--fg-faint)' })}>
              Baseline
            </span>
            <select
              value={baselineKey}
              mix={[
                css({
                  background: 'var(--surface-2)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '6px 10px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--fs-11)',
                  cursor: 'pointer',
                }),
                on<HTMLSelectElement>('change', (e) => setBaseline((e.target as HTMLSelectElement).value)),
              ]}
            >
              <option value="@auto">Auto · newest prior snapshot</option>
              <option value="@none">None · current posture only</option>
              {priors
                .slice()
                .reverse()
                .map((h) => (
                  <option key={h.at} value={h.at}>
                    {shortAt(h.at)}
                  </option>
                ))}
            </select>
            {baseline ? (
              <span mix={css({ color: 'var(--fg-faint)' })}>
                comparing current → {shortAt(baseline.at)}
              </span>
            ) : (
              <span mix={css({ color: 'var(--fg-faint)' })}>
                no baseline — showing current posture only
              </span>
            )}
          </label>

          {/* ── findings ── */}
          {v.findings.length > 0 ? (
            <Section label="Findings" title="What the verdict flags">
              <div mix={css({ display: 'flex', flexDirection: 'column' })}>
                {v.findings.map((f, i) => (
                  <div
                    key={i}
                    mix={css({
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-4) 0',
                      borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
                    })}
                  >
                    <div
                      mix={css({
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        marginTop: '6px',
                        background: FINDING_DOT[f.severity] ?? 'var(--fg-faint)',
                      })}
                    />
                    <div mix={css({ minWidth: '0' })}>
                      <div
                        mix={css({
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 'var(--space-3)',
                          flexWrap: 'wrap',
                        })}
                      >
                        <span mix={css({ fontWeight: '600', color: 'var(--fg)', fontSize: 'var(--fs-14)' })}>
                          {f.title}
                        </span>
                        <span
                          mix={css({
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--fs-10)',
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            color: FINDING_DOT[f.severity] ?? 'var(--fg-faint)',
                          })}
                        >
                          {f.severity}
                        </span>
                      </div>
                      <p
                        mix={css({
                          margin: 'var(--space-1) 0 0',
                          color: 'var(--fg-muted)',
                          fontSize: 'var(--fs-13)',
                          lineHeight: '1.5',
                        })}
                      >
                        {f.detail}
                      </p>
                      {f.evidence?.files && f.evidence.files.length > 0 ? (
                        <div
                          mix={css({
                            marginTop: 'var(--space-2)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--fs-11)',
                            color: 'var(--fg-faint)',
                            wordBreak: 'break-all',
                          })}
                        >
                          {f.evidence.files.join(' · ')}
                        </div>
                      ) : null}
                      {f.evidence?.ids && f.evidence.ids.length > 0 ? (
                        <div
                          mix={css({
                            marginTop: 'var(--space-2)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--fs-11)',
                            color: 'var(--fg-faint)',
                          })}
                        >
                          {f.evidence.ids.join(' · ')}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          ) : (
            <Section label="Findings" title="Clean">
              <p mix={css({ color: 'var(--fg-muted)', fontSize: 'var(--fs-14)', maxWidth: '60ch' })}>
                No secrets, known vulnerabilities, dependency cycles, or oversized
                hubs in the current analysis. The structural posture is clean.
              </p>
            </Section>
          )}

          {/* ── trend vs baseline ── */}
          {v.trend ? (
            <Section label="Trend" title={`Change since ${shortAt(baseline!.at)}`}>
              <RuledTable cols="1fr auto auto auto">
                <RuledRow header>
                  <RuledCell header>Metric</RuledCell>
                  <RuledCell header align="right">Baseline</RuledCell>
                  <RuledCell header align="right">Current</RuledCell>
                  <RuledCell header align="right">Δ</RuledCell>
                </RuledRow>
                <TrendRow label="Risk findings" d={v.trend.risks} worseWhenUp />
                <TrendRow label="TODOs" d={v.trend.todos} worseWhenUp />
                <TrendRow label="Files" d={v.trend.files} />
                <TrendRow label="Lines" d={v.trend.loc} />
                <TrendRow label="Tokens" d={v.trend.tokens} />
              </RuledTable>
            </Section>
          ) : (
            <Section label="Trend" title="No baseline selected">
              <p mix={css({ color: 'var(--fg-muted)', fontSize: 'var(--fs-14)', maxWidth: '60ch' })}>
                {priors.length === 0
                  ? 'Only one analysis so far. Re-run factstack analyze over time (a CI step or watch loop) to populate snapshot history, then a trend appears here.'
                  : 'Pick a baseline snapshot above to see how risks, TODOs, and size changed since then.'}
              </p>
            </Section>
          )}

          {/* posture as numbers, for the data-minded */}
          <LabelNumberRow>
            <LabelNumber label="Secrets" value={v.posture.secrets} />
            <LabelNumber label="CVEs" value={v.posture.vulnerabilities} />
            <LabelNumber label="Cycles" value={v.posture.cycles} />
            <LabelNumber label="Max blast" value={v.posture.topHub ? v.posture.topHub.reach : 0} last />
          </LabelNumberRow>
        </div>

        <MarginColumn>
          <FootnoteChip label="Severity">{SEVERITY_WORD[v.severity]}</FootnoteChip>
          <FootnoteChip label="Scored by">@factstack/spec model · same as CLI + MCP</FootnoteChip>
          <FootnoteChip label="Generated">{shortAt(v.generatedAt)}</FootnoteChip>
          {baseline ? <FootnoteChip label="Baseline">{shortAt(baseline.at)}</FootnoteChip> : null}
        </MarginColumn>
      </ContentWithMargin>
    );
  };
}

function PostureChip(handle: Handle<{ label: string; value: number; danger: boolean }>) {
  return () => {
    const { label, value, danger } = handle.props;
    return (
      <span
        mix={css({
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 'var(--space-2)',
          padding: '4px 10px',
          borderRadius: '999px',
          border: '1px solid var(--hairline)',
          background: danger ? 'color-mix(in oklab, var(--danger) 12%, transparent)' : 'transparent',
          color: danger ? 'var(--danger)' : 'var(--fg-muted)',
        })}
      >
        <b mix={css({ color: danger ? 'var(--danger)' : 'var(--fg)', fontWeight: '600' })}>{value}</b>
        <span mix={css({ letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: 'var(--fs-10)' })}>
          {label}
        </span>
      </span>
    );
  };
}

function TrendRow(handle: Handle<{ label: string; d: Delta; worseWhenUp?: boolean }>) {
  return () => {
    const { label, d, worseWhenUp } = handle.props;
    const up = d.delta > 0;
    const down = d.delta < 0;
    const arrow = d.delta === 0 ? '→' : up ? '↑' : '↓';
    // Colour only the metrics where direction means good/bad (risks, todos).
    const color = !worseWhenUp || d.delta === 0
      ? 'var(--fg-muted)'
      : up
        ? 'var(--danger)'
        : 'var(--ok)';
    return (
      <RuledRow>
        <RuledCell>{label}</RuledCell>
        <RuledCell mono align="right">{fmt(d.before)}</RuledCell>
        <RuledCell mono align="right">{fmt(d.after)}</RuledCell>
        <RuledCell mono align="right">
          {/* Arrow conveys direction; magnitude is unsigned (mirrors the
              CLI diff convention). Colour flags good/bad only where it means
              something (risks, TODOs). */}
          <span mix={css({ color })}>
            {arrow} {fmt(Math.abs(d.delta))}
          </span>
        </RuledCell>
      </RuledRow>
    );
  };
}

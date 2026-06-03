/**
 * CssSuggestionsPanel — a global, collapsible right-hand drawer surfacing the
 * scanned project's CSS / styling audit (data.styles).
 *
 * Collapsed: a vertical handle pinned to the right edge whose badge is a live
 * count ticker of open suggestions, tinted by the worst severity. Expanded: a
 * non-modal drawer with a device-coverage strip (mobile → desktop, the
 * "responsiveviewer" comparison), summary stats, and every finding with its
 * evidence + a paste-able fix (media/container query snippets get a Copy).
 *
 * Mounted once in App.tsx's Shell, so it rides along on every tab. Hides
 * entirely when the project has no CSS sources.
 */
import type { Handle } from 'remix/ui';
import { css, on } from 'remix/ui';
import type { StyleFinding, StyleSeverity } from '@factstack/spec';
import type { Dataset } from '../lib/loadArtifacts.ts';

const SEV: Record<StyleSeverity, { label: string; color: string; rank: number }> = {
  high: { label: 'High', color: 'var(--danger, #ff6b6b)', rank: 3 },
  medium: { label: 'Medium', color: 'var(--warn, #f5a623)', rank: 2 },
  low: { label: 'Low', color: 'var(--accent)', rank: 1 },
  info: { label: 'Info', color: 'var(--fg-subtle, #8a8f98)', rank: 0 },
};

const CAT_LABEL: Record<string, string> = {
  naming: 'naming', conflict: 'conflict', override: 'override', important: '!important',
  specificity: 'specificity', responsive: 'responsive', 'container-query': 'container query',
  paradigm: 'paradigm', fallback: 'fallback', duplicate: 'duplicate',
};

/* ─────────── styles ─────────── */

const handle = (color: string) => css({
  position: 'fixed', right: '0', top: '50%', transform: 'translateY(-50%)', zIndex: '40',
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
  background: 'var(--surface-2, #1b1f25)', border: '1px solid var(--border)', borderRight: 'none',
  borderRadius: '12px 0 0 12px', padding: '10px 8px', cursor: 'pointer',
  boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
  transition: 'transform var(--dur-quick, 140ms) var(--ease-out-quart, ease), background 140ms',
  '&:hover': { transform: 'translateY(-50%) translateX(-2px)' },
  '&:focus-visible': { outline: '2px solid ' + color, outlineOffset: '2px' },
});
const ticker = (color: string) => css({
  fontFamily: 'var(--font-mono)', fontSize: '17px', fontWeight: '700', lineHeight: '1',
  color: 'var(--bg)', background: color, minWidth: '26px', height: '26px', borderRadius: '999px',
  display: 'grid', placeItems: 'center', padding: '0 6px', fontVariantNumeric: 'tabular-nums',
});
const handleLabel = css({ writingMode: 'vertical-rl', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--fg-muted)' });

const drawer = css({
  position: 'fixed', right: '0', top: '0', bottom: '0', zIndex: '41',
  width: 'min(440px, 94vw)', display: 'flex', flexDirection: 'column',
  background: 'var(--surface-1, #14171c)', borderLeft: '1px solid var(--border)',
  boxShadow: '-12px 0 40px rgba(0,0,0,0.35)',
});
const head = css({ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--hairline)' });
const headTitle = css({ fontSize: 'var(--fs-16)', fontWeight: '600', color: 'var(--fg)', flex: '1 1 auto' });
const headCount = (color: string) => css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', fontWeight: '700', color: 'var(--bg)', background: color, borderRadius: '999px', padding: '2px 9px' });
const closeBtn = css({ background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--fg-muted)', cursor: 'pointer', width: '28px', height: '28px', display: 'grid', placeItems: 'center', fontSize: '16px', '&:hover': { color: 'var(--fg)', borderColor: 'var(--fg-faint)' } });
const body = css({ overflowY: 'auto', padding: 'var(--space-4) var(--space-5)', flex: '1 1 auto' });

const sectionLabel = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--fg-subtle)', margin: 'var(--space-4) 0 var(--space-2)' });
const stats = css({ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: 'var(--space-2)' });
const stat = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--fg-muted)', border: '1px solid var(--hairline)', borderRadius: '6px', padding: '2px 7px' });

const devStrip = css({ display: 'flex', gap: '3px', marginBottom: 'var(--space-2)' });
const devCell = (covered: boolean) => css({
  flex: '1 1 0', minWidth: '0', borderRadius: '6px', padding: '6px 4px', textAlign: 'center',
  background: covered ? 'color-mix(in oklab, var(--ok, #4ade80) 16%, transparent)' : 'color-mix(in oklab, var(--warn, #f5a623) 18%, transparent)',
  border: '1px solid ' + (covered ? 'var(--ok, #4ade80)' : 'var(--warn, #f5a623)'),
});
const devName = css({ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
const devState = css({ fontSize: '9px', fontFamily: 'var(--font-mono)' });

const card = css({ border: '1px solid var(--hairline)', borderRadius: '10px', background: 'var(--surface-2, #1b1f25)', padding: 'var(--space-3) var(--space-4)', marginBottom: 'var(--space-2)' });
const cardTop = css({ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', marginBottom: '4px' });
const sevDot = (color: string) => css({ width: '8px', height: '8px', borderRadius: '50%', background: color, flex: '0 0 auto', alignSelf: 'center' });
const catTag = css({ fontFamily: 'var(--font-mono)', fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-subtle)', flex: '0 0 auto' });
const cardTitle = css({ fontSize: 'var(--fs-13)', fontWeight: '600', color: 'var(--fg)', flex: '1 1 auto' });
const cardDetail = css({ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', lineHeight: '1.5' });
const evidence = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--fg-subtle)', marginTop: '4px' });
const snipWrap = css({ marginTop: '6px', position: 'relative' });
const snip = css({ margin: '0', background: 'var(--code-bg, rgba(255,255,255,0.04))', border: '1px solid var(--hairline)', borderRadius: '8px', padding: 'var(--space-3)', paddingRight: '52px', overflowX: 'auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-11)', lineHeight: '1.5', color: 'var(--fg-muted)', whiteSpace: 'pre-wrap' });
const copyBtn = css({ position: 'absolute', top: '6px', right: '6px', fontFamily: 'var(--font-mono)', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted)', border: '1px solid var(--border)', borderRadius: '6px', padding: '2px 6px', cursor: 'pointer', background: 'var(--surface-1)', '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent)' } });
const clean = css({ color: 'var(--ok, #4ade80)', fontSize: 'var(--fs-13)', padding: 'var(--space-4) 0' });
const para = css({ display: 'flex', flexWrap: 'wrap', gap: '6px' });
const paraChip = css({ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-10)', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '999px', padding: '2px 8px', opacity: '0.85' });

function copy(text: string): void {
  try {
    const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } };
    void nav.clipboard?.writeText(text);
  } catch { /* clipboard blocked — non-fatal */ }
}

export function CssSuggestionsPanel(handleRef: Handle<{ data: Dataset }>) {
  let open = false;
  const toggle = () => { open = !open; void handleRef.update(); };
  const close = () => { open = false; void handleRef.update(); };

  return () => {
    const styles = handleRef.props.data.styles;
    if (!styles) return <></>;

    const findings: StyleFinding[] = styles.findings.slice().sort((a, b) => SEV[b.severity].rank - SEV[a.severity].rank);
    const count = findings.length;
    const worstRank = findings.reduce((m, f) => Math.max(m, SEV[f.severity].rank), 0);
    const worstColor = (Object.values(SEV).find((s) => s.rank === worstRank) ?? SEV.info).color;

    if (!open) {
      return (
        <button
          type="button"
          aria-label={`CSS suggestions — ${count} ${count === 1 ? 'item' : 'items'}`}
          aria-expanded="false"
          mix={[handle(count ? worstColor : 'var(--ok, #4ade80)'), on('click', toggle)]}
        >
          <span mix={ticker(count ? worstColor : 'var(--ok, #4ade80)')}>{count}</span>
          <span mix={handleLabel}>CSS</span>
        </button>
      );
    }

    const breakpointTxt = styles.breakpoints.length
      ? styles.breakpoints.map((b) => b.px + 'px').join(' · ')
      : 'none';

    return (
      <aside mix={drawer} role="region" aria-label="CSS suggestions">
        <div mix={head}>
          <span mix={headTitle}>CSS Suggestions</span>
          <span mix={headCount(count ? worstColor : 'var(--ok, #4ade80)')}>{count}</span>
          <button type="button" mix={[closeBtn, on('click', close)]} aria-label="Collapse panel">×</button>
        </div>
        <div mix={body}>
          <div mix={stats}>
            <span mix={stat}>{styles.ruleCount} rules</span>
            <span mix={stat}>{styles.classCount} classes</span>
            <span mix={stat}>{styles.importantCount} !important</span>
            <span mix={stat}>{styles.breakpoints.length} breakpoints</span>
            {styles.containerQueries ? <span mix={stat}>{styles.containerQueries} @container</span> : null}
          </div>
          {styles.paradigms.length ? (
            <div mix={para}>{styles.paradigms.map((p) => <span key={p} mix={paraChip}>{p}</span>)}</div>
          ) : null}

          <p mix={sectionLabel}>Device coverage</p>
          <div mix={devStrip}>
            {styles.devices.map((d) => (
              <div key={d.name} mix={devCell(d.covered)} title={`${d.minPx}–${d.maxPx ?? '∞'}px`}>
                <div mix={devName}>{d.name.replace('large-', 'lg-')}</div>
                <div mix={[devState, css({ color: d.covered ? 'var(--ok, #4ade80)' : 'var(--warn, #f5a623)' })]}>
                  {d.covered ? '✓' : 'gap'}
                </div>
              </div>
            ))}
          </div>
          <p mix={css({ fontSize: 'var(--fs-10)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)', margin: '0 0 var(--space-4)' })}>
            breakpoints: {breakpointTxt}
          </p>

          <p mix={sectionLabel}>{count} suggestion{count === 1 ? '' : 's'}</p>
          {count === 0 ? (
            <p mix={clean}>✓ No CSS issues detected. Naming, specificity, responsiveness, and tooling look healthy.</p>
          ) : (
            findings.map((f) => (
              <div key={f.id} mix={card}>
                <div mix={cardTop}>
                  <span aria-hidden="true" mix={sevDot(SEV[f.severity].color)} />
                  <span mix={cardTitle}>{f.title}</span>
                  <span mix={catTag}>{CAT_LABEL[f.category] ?? f.category}</span>
                </div>
                <div mix={cardDetail}>{f.detail}</div>
                {f.file || f.selector ? (
                  <div mix={evidence}>
                    {f.selector ? f.selector + '  ' : ''}{f.file ?? ''}{typeof f.line === 'number' ? ':' + f.line : ''}
                  </div>
                ) : null}
                {f.suggestion ? (
                  <div mix={snipWrap}>
                    <pre mix={snip}><code>{f.suggestion}</code></pre>
                    <button type="button" mix={[copyBtn, on('click', () => copy(f.suggestion ?? ''))]}>copy</button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </aside>
    );
  };
}

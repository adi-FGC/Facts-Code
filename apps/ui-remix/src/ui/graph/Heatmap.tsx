/**
 * Heatmap — folder × folder adjacency matrix.
 *
 * Each cell shows the count of edges (imports) from row → column.
 * Color intensity is log-scaled so 1 edge ≠ 100 edges. Diagonal cells
 * (intra-folder coupling) get a subtle different tint.
 *
 * Why a heatmap, not a force-directed graph:
 *   - Force layouts on > 100 nodes look like exploded yarn — pretty
 *     enough to demo, useless for understanding.
 *   - The actual question the reader asks is "where is the coupling
 *     concentrated?" — and an adjacency matrix answers that in a
 *     single eyeful.
 *
 * The diagram view (SugiyamaDag) covers the "how does it flow?"
 * question; this view covers "where is the weight?". Both serve the
 * Graph tab's goal: surface dependency structure in editorial form.
 *
 * Component contract:
 *   Pure render of a HeatmapResult (already computed by lib/graphAnalysis).
 *   No data-fetching, no analysis math — keeps the component thin and
 *   the math centrally testable.
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import type { HeatmapResult } from '../../lib/graphAnalysis.ts';

interface HeatmapProps {
  data: HeatmapResult;
}

/* ─────────── styles ─────────── */

const wrap = css({
  marginTop: 'var(--space-4)',
  overflowX: 'auto',
  paddingBottom: 'var(--space-5)',
});

const matrix = css({
  display: 'grid',
  gridAutoColumns: 'minmax(44px, 1fr)',
  borderTop: '1px solid var(--hairline)',
  borderLeft: '1px solid var(--hairline)',
});

const colLabel = css({
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  paddingTop: 'var(--space-4)',
  paddingBottom: 'var(--space-2)',
  borderRight: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  color: 'var(--fg-subtle)',
  letterSpacing: '0.04em',
  height: '88px',
  '> span': {
    transformOrigin: 'left bottom',
    transform: 'rotate(-45deg) translateY(-6px)',
    whiteSpace: 'nowrap',
  },
});

const rowLabel = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  paddingInline: 'var(--space-3)',
  borderRight: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg)',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
});

const cell = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRight: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  height: '36px',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  fontVariantNumeric: 'tabular-nums',
  /* Subtle hover state — helpful when the user is trying to read a
     cell value in a dim/dense matrix. */
  transition: 'outline-color var(--dur-quick) var(--ease-out-quart)',
  outline: '1px solid transparent',
  outlineOffset: '-1px',
  '&:hover': { outlineColor: 'var(--accent)' },
});

const cellSelf = css({
  background: 'color-mix(in oklab, var(--fg-faint) 8%, transparent)',
});

const corner = css({
  borderRight: '1px solid var(--hairline)',
  borderBottom: '1px solid var(--hairline)',
  height: '88px',
});

const legendRow = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-4)',
  marginTop: 'var(--space-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-subtle)',
});

const legendSwatch = css({
  display: 'inline-block',
  width: '20px',
  height: '8px',
  marginRight: '6px',
  verticalAlign: 'middle',
});

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString('en-US');
}

export function Heatmap(_h: Handle<HeatmapProps>) {
  return ({ data }: HeatmapProps) => {
    const { folders, matrix: matrixData, maxCell } = data;
    const logMax = Math.log10(maxCell + 1) || 1;
    const intensity = (n: number): number =>
      n === 0 ? 0 : Math.log10(n + 1) / logMax;

    return (
      <div mix={wrap}>
        <div mix={[matrix, css({ gridTemplateColumns: `160px repeat(${folders.length}, minmax(44px, 1fr))` })]}>
          <div mix={corner} />
          {folders.map((f) => (
            <div key={`col-${f}`} mix={colLabel}><span>{f}</span></div>
          ))}
          {folders.map((rowName, i) => (
            <>
              <div key={`row-${rowName}`} mix={rowLabel}>{rowName}</div>
              {folders.map((_, j) => {
                const v = matrixData[i]![j]!;
                const t = intensity(v);
                return (
                  <div
                    key={`c-${i}-${j}`}
                    mix={[
                      cell,
                      i === j ? cellSelf : css({}),
                      css({
                        background: v === 0
                          ? 'transparent'
                          : `color-mix(in oklab, var(--accent) ${Math.round(t * 60)}%, transparent)`,
                        color: t > 0.55 ? 'var(--bg)' : 'var(--fg)',
                      }),
                    ]}
                    title={`${rowName} → ${folders[j]}: ${v} edge${v === 1 ? '' : 's'}`}
                  >
                    {v > 0 ? v : ''}
                  </div>
                );
              })}
            </>
          ))}
        </div>
        <div mix={legendRow}>
          <span>
            <span mix={[legendSwatch, css({ background: 'color-mix(in oklab, var(--accent) 12%, transparent)' })]} /> Few
          </span>
          <span>
            <span mix={[legendSwatch, css({ background: 'color-mix(in oklab, var(--accent) 36%, transparent)' })]} /> Some
          </span>
          <span>
            <span mix={[legendSwatch, css({ background: 'color-mix(in oklab, var(--accent) 60%, transparent)' })]} /> Many
          </span>
          <span style="margin-left:auto">log scale · max {fmt(maxCell)} edges</span>
        </div>
      </div>
    );
  };
}

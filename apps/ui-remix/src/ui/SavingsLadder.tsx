/**
 * SavingsLadder — renders the cross-model savings chart.
 *
 * Dumb by design: all geometry comes from the pure `computeSavingsLadder`
 * (lib/savingsLadder.ts), mirroring the computeSankey / SankeyDiagram split.
 * This file decides nothing about the data.
 *
 * Reading the chart: one row per model on a shared log10 dollar axis. The
 * hollow dot is what one whole-codebase send costs on that model; the solid
 * accent bar is what the same send costs as a FACTS artifact; the hairline
 * between them is the saving. Because the axis is logarithmic, that hairline
 * is the SAME LENGTH on every row — the artifact's effect, drawn.
 *
 * CSP: every dynamic value is an SVG presentation attribute (x, y, width,
 * fill, stroke, stroke-width, stroke-dasharray, text-anchor). No `style=`
 * anywhere; static styling comes from css() classes via adopted stylesheets,
 * exactly as SankeyDiagram does. Tooltips are child <title> elements.
 *
 * Accessibility: the <svg> is role="img" with a computed summary, and the
 * real numbers live in a visually-hidden <table> beside it — a screen reader
 * gets the figures rather than a shape. Nothing in the SVG is focusable, so
 * there is no roving-tabindex machinery to get wrong. Mode is encoded by
 * SHAPE (hollow dot vs solid bar), not by colour alone, so the chart survives
 * greyscale and both themes.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import {
  computeSavingsLadder,
  fmtLadderUsd,
  type LadderModel,
  type LadderProject,
} from '../lib/savingsLadder.ts';

export interface SavingsLadderProps {
  models: readonly LadderModel[];
  project: LadderProject;
  width?: number;
  /** Narrow layout: labels above each row instead of in a left gutter. */
  stacked?: boolean;
}

/* ─────────── styles ─────────── */

const figure = css({ width: '100%', display: 'block', margin: '0' });

const svgEl = css({
  width: '100%',
  height: 'auto',
  overflow: 'visible',
  display: 'block',
});

const rowLabel = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-11)',
  fill: 'var(--fg)',
  pointerEvents: 'none',
});

const rowVendor = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fill: 'var(--fg-faint)',
  pointerEvents: 'none',
});

const rowValue = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fill: 'var(--accent)',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
});

const axisLabel = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fill: 'var(--fg-faint)',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
});

const legend = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-4)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
  marginBottom: 'var(--space-3)',
});

const finding = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.5',
  color: 'var(--fg-muted)',
  marginTop: 'var(--space-3)',
  maxWidth: '64ch',
});

const unpricedNote = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-12)',
  lineHeight: '1.5',
  color: 'var(--fg-faint)',
  marginTop: 'var(--space-2)',
  maxWidth: '64ch',
});

const emptyNote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-faint)',
  padding: 'var(--space-4)',
});

export function SavingsLadder(handle: Handle<SavingsLadderProps>) {
  return () => {
    const { models, project, width = 760, stacked = false } = handle.props;
    const L = computeSavingsLadder(models, project, { width, stacked });

    if (L.rows.length === 0) {
      return (
        <div mix={emptyNote}>
          No model in the catalog has a published per-token price to chart.
          {L.unpriced.length > 0 && ` (${L.unpriced.length} listed without one.)`}
        </div>
      );
    }

    return (
      <figure mix={figure}>
        <div mix={legend}>
          <span>○ whole codebase</span>
          <span>▮ with FACTS</span>
          <span>— the saving</span>
          {L.rows.some((r) => r.flagged) && <span>* price not vendor-confirmed</span>}
        </div>

        <svg
          mix={svgEl}
          viewBox={`0 0 ${L.width} ${L.height}`}
          role="img"
          aria-label={L.ariaSummary}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Decade gridlines first, so every mark paints over them. */}
          <g>
            {L.axisTicks.map((t, i) => (
              <line
                key={`ax-${i}`}
                x1={t.x}
                x2={t.x}
                y1={L.plotTop}
                y2={L.plotBottom}
                stroke="var(--hairline)"
                stroke-width="1"
                stroke-dasharray="2 4"
              />
            ))}
          </g>

          {/* The crossover rule: where the dearest artifact run sits. */}
          {L.crossover && (
            <line
              x1={L.crossover.x}
              x2={L.crossover.x}
              y1={L.plotTop}
              y2={L.plotBottom}
              stroke="var(--accent)"
              stroke-width="1"
              stroke-dasharray="3 3"
              stroke-opacity="0.5"
            />
          )}

          <g>
            {L.rows.map((r) => (
              <g key={`row-${r.id}`}>
                {/* The saving, drawn: a constant-length hairline on every row. */}
                <line
                  x1={r.artifactX}
                  x2={r.fullX}
                  y1={r.y}
                  y2={r.y}
                  stroke="var(--fg-muted)"
                  stroke-width="1"
                  stroke-opacity="0.45"
                />
                {/* Whole-codebase cost: hollow, because you would rather not pay it. */}
                <circle
                  cx={r.fullX}
                  cy={r.y}
                  r="3.5"
                  fill="var(--bg)"
                  stroke="var(--fg-muted)"
                  stroke-width="1.25"
                >
                  <title>{`${r.label}: ${fmtLadderUsd(r.fullCost)} to send the whole codebase`}</title>
                </circle>
                {/* Artifact cost: solid, accent — the number you actually pay. */}
                <rect
                  x={r.artifactX - 1.5}
                  y={r.y - 5}
                  width="3"
                  height="10"
                  rx="0.75"
                  fill="var(--accent)"
                >
                  <title>{`${r.label}: ${fmtLadderUsd(r.artifactCost)} with the FACTS artifact — saves ${fmtLadderUsd(r.savedCost)}`}</title>
                </rect>

                {!stacked && (
                  <>
                    <text
                      mix={rowLabel}
                      x={L.plotLeft - 10}
                      y={r.y - 1}
                      text-anchor="end"
                      dominant-baseline="middle"
                    >
                      {r.flagged ? `${r.label} *` : r.label}
                    </text>
                    <text
                      mix={rowVendor}
                      x={L.plotLeft - 10}
                      y={r.y + 9}
                      text-anchor="end"
                      dominant-baseline="middle"
                    >
                      {r.vendor}
                    </text>
                  </>
                )}
                {stacked && (
                  <text
                    mix={rowLabel}
                    x={L.plotLeft}
                    y={r.y - 11}
                    text-anchor="start"
                    dominant-baseline="middle"
                  >
                    {`${r.vendor} ${r.label}${r.flagged ? ' *' : ''}`}
                  </text>
                )}

                <text
                  mix={rowValue}
                  x={L.width}
                  y={r.y}
                  text-anchor="end"
                  dominant-baseline="middle"
                >
                  {r.valueText}
                </text>
              </g>
            ))}
          </g>

          {/* Axis labels: dollars for ONE whole-codebase send of this repo. */}
          <g>
            {L.axisTicks.map((t, i) => (
              <text key={`axl-${i}`} mix={axisLabel} x={t.x} y={L.height - 8} text-anchor="middle">
                {t.label}
              </text>
            ))}
          </g>
        </svg>

        {/* The numbers themselves, for screen readers. Visually hidden, not
            display:none — a hidden table is still read; a removed one is not.

            The .sr-only clip goes on a WRAPPER div, not on the <table>. A
            table's used width is driven by its content, so `width: 1px` acts
            as a minimum rather than a cap and the clip never engages — the
            full ~1470px table then widens the page and the whole document
            scrolls sideways. Putting the clip on a block-level wrapper
            contains it, and keeps the table's semantics intact (setting
            `display: block` on the table would also fix the geometry, but it
            strips the table role that makes these numbers navigable). */}
        <div class="sr-only">
          <table>
            <caption>{L.ariaSummary}</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Vendor</th>
                <th scope="col">Whole codebase</th>
                <th scope="col">With FACTS</th>
                <th scope="col">Saved</th>
              </tr>
            </thead>
            <tbody>
              {L.rows.map((r) => (
                <tr key={`srt-${r.id}`}>
                  <th scope="row">
                    {r.flagged ? `${r.label} (price not vendor-confirmed)` : r.label}
                  </th>
                  <td>{r.vendor}</td>
                  <td>{fmtLadderUsd(r.fullCost)}</td>
                  <td>{fmtLadderUsd(r.artifactCost)}</td>
                  <td>{fmtLadderUsd(r.savedCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {L.crossover && <figcaption mix={finding}>{L.crossover.caption}</figcaption>}

        {L.unpriced.length > 0 && (
          <p mix={unpricedNote}>
            Not charted — no published per-token price:{' '}
            {L.unpriced.map((u) => `${u.vendor} ${u.label}`).join(', ')}. Listed rather than
            dropped, so the gap is visible.
          </p>
        )}
      </figure>
    );
  };
}

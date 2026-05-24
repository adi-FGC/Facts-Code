/**
 * SwimlanesDiagram — horizontal-lane architecture diagram.
 *
 * Layout:
 *   - Each non-empty tier becomes a horizontal "lane" (a band the full
 *     width of the diagram).
 *   - Reading order is top-to-bottom: Entry → UI → Route → Handler →
 *     Data → External → Lib → Config → Test → Other. This matches the
 *     conventional architecture-diagram metaphor: request enters at
 *     the top, data lands at the bottom.
 *   - Each lane shows: label, file count (large numeral), and 3 sample
 *     filenames. The lane is the unit, not the file — for 20+ files in
 *     a tier, drawing each as a node would crowd the visual without
 *     adding signal.
 *   - Arrows between lanes carry aggregated edge counts. Stroke-width
 *     is log-scaled (1–6 px) so a 1-edge connection and a 100-edge
 *     connection are visually distinguishable without the 100-edge one
 *     dominating.
 *   - Cross-lane arrows that skip intermediate lanes (e.g. Entry →
 *     Data, jumping over UI/Route/Handler) arc around the right edge
 *     so they don't slice through the bypassed lanes.
 *
 * Interactions:
 *   - Hover a lane → all incident arrows brighten to accent, others
 *     fade. Same delegation pattern as SugiyamaDag.
 *   - Click a lane → navigates to Files tab filtered to that tier
 *     (when v0.5.1 ships the filter; today the link goes to /files).
 *
 * Accessibility:
 *   - SVG carries role="img" with an aria-label describing the
 *     overall shape ("Architecture flow with 6 tiers and 312 edges").
 *   - Each lane is a <g> with an aria-label and tabIndex so keyboard
 *     users can tab through.
 *
 * Why not d3-sankey: this is structurally a sankey but at ≤10 lanes
 * the math is trivial and the d3-sankey bundle is 12 KB gzipped.
 * Hand-rolled keeps the editorial language consistent (thin strokes,
 * no gradients, no transitions on the lane positions themselves).
 */
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';
import {
  TIER_LABEL,
  TIER_ORDER,
  type FlowResult,
  type Tier,
  type TierEdge,
} from '../../lib/flowAnalysis.ts';

interface SwimlanesDiagramProps {
  result: FlowResult;
}

/* ─────────── motion ─────────── */

const KEYFRAMES_ID = 'swimlanes-keyframes';
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const s = document.createElement('style');
  s.id = KEYFRAMES_ID;
  s.textContent = `
    @media (prefers-reduced-motion: no-preference) {
      @keyframes swimlanes-lane-in {
        from { opacity: 0; transform: translateY(-4px) }
        to   { opacity: 1; transform: translateY(0) }
      }
      @keyframes swimlanes-arrow-draw {
        from { stroke-dashoffset: var(--len, 200) }
        to   { stroke-dashoffset: 0 }
      }
    }
  `;
  document.head.appendChild(s);
}

/* ─────────── styles ─────────── */

const wrap = css({
  marginTop: 'var(--space-4)',
  border: '1px solid var(--hairline)',
  background: 'var(--surface, var(--bg))',
  overflow: 'auto',
  maxHeight: '70vh',
});

const meta = css({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 'var(--space-3)',
  paddingInline: 'var(--space-3)',
  paddingBlock: 'var(--space-2)',
  borderBottom: '1px solid var(--hairline)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-faint)',
});

const metaCount = css({
  color: 'var(--fg-muted)',
  fontVariantNumeric: 'tabular-nums',
});

const empty = css({
  paddingInline: 'var(--space-4)',
  paddingBlock: 'var(--space-6)',
  textAlign: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-12)',
  color: 'var(--fg-muted)',
});

const svgEl = css({
  display: 'block',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  userSelect: 'none',
  WebkitUserSelect: 'none',
});

const laneGroup = css({
  cursor: 'pointer',
  /* All lane backgrounds get the same subtle hover. Highlighted state
     lives on incident arrows (data-hover-lane attribute on SVG). */
  '> rect.lane-bg': {
    transition: 'fill var(--dur-quick) var(--ease-out-quart), stroke var(--dur-quick) var(--ease-out-quart)',
  },
  '&:hover > rect.lane-bg': {
    fill: 'var(--accent-soft)',
    stroke: 'var(--accent)',
  },
  animation: 'swimlanes-lane-in 280ms var(--ease-out-quart) both',
  animationDelay: 'calc(min(var(--row, 0), 8) * 40ms)',
});

/* ─────────── helpers ─────────── */

/** Sample top-3 files in a tier by total degree — gives the lane a
 *  foothold without listing every file. */
function sampleLaneFiles(tier: Tier, result: FlowResult, limit = 3): string[] {
  const list: Array<{ path: string; deg: number }> = [];
  for (const f of result.files.values()) {
    if (f.tier !== tier) continue;
    list.push({ path: f.path, deg: f.inDegree + f.outDegree });
  }
  list.sort((a, b) => b.deg - a.deg);
  return list.slice(0, limit).map((x) => x.path);
}

/** Trim a path to its basename + immediate parent for the sample
 *  display. Full path lives in the SVG <title>. */
function shortPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

/** Log-scaled stroke width for tier→tier arrows. 1 edge = 1 px, 100
 *  edges = ~5 px. Capped at 6 to keep dense graphs from being
 *  dominated by one runaway connection. */
function arrowStrokeWidth(count: number, maxCount: number): number {
  if (count <= 0) return 1;
  const logMax = Math.log10(maxCount + 1) || 1;
  return Math.min(6, 1 + (Math.log10(count + 1) / logMax) * 5);
}

export function SwimlanesDiagram(_h: Handle<SwimlanesDiagramProps>) {
  ensureKeyframes();

  return ({ result }: SwimlanesDiagramProps) => {
    /* Filter to non-empty tiers, preserving TIER_ORDER. The diagram
       reads cleanly only when empty lanes are dropped (otherwise the
       "Tests" lane sits there at zero, looking broken). */
    const activeTiers: Tier[] = TIER_ORDER.filter((t) => (result.tierCounts.get(t) ?? 0) > 0);

    if (activeTiers.length === 0) {
      return (
        <div mix={wrap}>
          <div mix={empty}>No files to classify into tiers.</div>
        </div>
      );
    }

    /* SVG sizing. Lanes are horizontal bands with fixed height; the
       diagram width is fixed-ish so the file-sample text fits without
       wrapping. */
    const laneHeight = 92;
    const laneGap = 16;
    const padding = 32;
    const labelColumnWidth = 200;  // left column holds the tier label + count
    const detailColumnWidth = 380; // right column holds sample file paths
    const arrowGutter = 80;        // space at the right for arcing arrows
    const svgWidth = padding * 2 + labelColumnWidth + detailColumnWidth + arrowGutter;
    const svgHeight = padding * 2 + activeTiers.length * laneHeight + (activeTiers.length - 1) * laneGap;

    /* Lane geometry — compute once, reuse for both lane render and
       arrow path computation. */
    const laneY = (i: number) => padding + i * (laneHeight + laneGap);
    const laneCenterY = (i: number) => laneY(i) + laneHeight / 2;
    const tierIndex = new Map<Tier, number>(activeTiers.map((t, i) => [t, i]));

    /* Inter-tier edges only (intra-tier self-loops noted in the chrome
       but not drawn — they'd be tight self-arcs inside each lane). */
    const interEdges = result.tierEdges.filter((e) => e.from !== e.to);
    const intraEdges = result.tierEdges.filter((e) => e.from === e.to);
    const maxEdgeCount = Math.max(1, ...interEdges.map((e) => e.count));
    const totalCrossEdges = interEdges.reduce((s, e) => s + e.count, 0);

    /* Arrow path: source-lane bottom-center → dest-lane top-center,
       arcing around the right edge so non-adjacent lanes don't get
       sliced through. The control points sit to the right of the
       lane box, pulled further out for longer jumps. */
    function arrowPath(edge: TierEdge): string | null {
      const i = tierIndex.get(edge.from);
      const j = tierIndex.get(edge.to);
      if (i == null || j == null) return null;
      const fromY = laneCenterY(i);
      const toY = laneCenterY(j);
      const span = Math.abs(j - i);
      /* Arrows leave the right edge of the lane and arc clockwise (for
         downward) or counter-clockwise (for upward) around the right
         gutter. Control point x is pulled further right for bigger
         jumps so the arc clearance scales with distance. */
      const laneRightX = padding + labelColumnWidth + detailColumnWidth;
      const arcX = laneRightX + Math.min(arrowGutter - 12, 12 + span * 12);
      return `M ${laneRightX} ${fromY} C ${arcX} ${fromY}, ${arcX} ${toY}, ${laneRightX} ${toY}`;
    }

    return (
      <div mix={wrap}>
        <div mix={meta}>
          <span>Architecture · {activeTiers.length} tier{activeTiers.length === 1 ? '' : 's'}</span>
          <span mix={metaCount}>
            {totalCrossEdges} cross-tier edge{totalCrossEdges === 1 ? '' : 's'}
            {intraEdges.length > 0 && ` · ${intraEdges.reduce((s, e) => s + e.count, 0)} intra-tier`}
          </span>
        </div>
        <svg
          mix={svgEl}
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          role="img"
          aria-label={`Architecture flow diagram with ${activeTiers.length} tiers and ${totalCrossEdges} cross-tier edges`}
        >
          {/* SVG arrow marker definition. Used by every inter-tier arrow.
              Filled triangle, sized small so it doesn't overpower the
              thin strokes. */}
          <defs>
            <marker
              id="swim-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong, var(--fg-muted))" />
            </marker>
            <marker
              id="swim-arrow-active"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
          </defs>

          {/* Lanes first — arrows paint over them. Each lane is a
              clickable <a> jumping to the Files tab. */}
          <g>
            {activeTiers.map((tier, i) => {
              const count = result.tierCounts.get(tier) ?? 0;
              const samples = sampleLaneFiles(tier, result);
              const y = laneY(i);
              return (
                <a
                  key={tier}
                  href={`/files`}
                  mix={laneGroup}
                  style={`--row: ${i}`}
                  data-tier={tier}
                >
                  <title>{TIER_LABEL[tier]} — {count} file{count === 1 ? '' : 's'}</title>
                  <rect
                    class="lane-bg"
                    x={padding}
                    y={y}
                    width={labelColumnWidth + detailColumnWidth}
                    height={laneHeight}
                    fill="var(--bg)"
                    stroke="var(--hairline)"
                    stroke-width="1"
                  />
                  {/* Lane label column — tier name on top, file count
                      below as a large numeral. Reads "UI · views / 47". */}
                  <text
                    x={padding + 16}
                    y={y + 24}
                    fill="var(--fg-faint)"
                    style="font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase"
                  >
                    {TIER_LABEL[tier]}
                  </text>
                  <text
                    x={padding + 16}
                    y={y + 60}
                    fill="var(--fg)"
                    style="font-size: 28px; font-family: var(--font-display, var(--font-body)); font-variant-numeric: tabular-nums"
                  >
                    {count}
                  </text>
                  <text
                    x={padding + 16}
                    y={y + 80}
                    fill="var(--fg-faint)"
                    style="font-size: 10px"
                  >
                    file{count === 1 ? '' : 's'}
                  </text>

                  {/* Detail column — 3 sample paths, top-aligned. */}
                  {samples.map((p, k) => (
                    <text
                      key={k}
                      x={padding + labelColumnWidth + 12}
                      y={y + 22 + k * 18}
                      fill="var(--fg-muted)"
                      style="font-size: 11px; font-family: var(--font-mono)"
                    >
                      <title>{p}</title>
                      {shortPath(p)}
                    </text>
                  ))}
                  {count > samples.length && (
                    <text
                      x={padding + labelColumnWidth + 12}
                      y={y + 22 + samples.length * 18}
                      fill="var(--fg-faint)"
                      style="font-size: 10px; letter-spacing: 0.06em"
                    >
                      + {count - samples.length} more
                    </text>
                  )}
                </a>
              );
            })}
          </g>

          {/* Inter-tier arrows. Drawn last so they paint on top of the
              lane backgrounds; their right-arc geometry keeps them
              out of the lane interiors. */}
          <g aria-hidden="true">
            {interEdges.map((edge, idx) => {
              const path = arrowPath(edge);
              if (!path) return null;
              const sw = arrowStrokeWidth(edge.count, maxEdgeCount);
              const midI = ((tierIndex.get(edge.from) ?? 0) + (tierIndex.get(edge.to) ?? 0)) / 2;
              const labelY = padding + midI * (laneHeight + laneGap) + laneHeight / 2;
              const laneRightX = padding + labelColumnWidth + detailColumnWidth;
              const span = Math.abs((tierIndex.get(edge.from) ?? 0) - (tierIndex.get(edge.to) ?? 0));
              const labelX = laneRightX + Math.min(arrowGutter - 12, 12 + span * 12) + 6;
              return (
                <g key={idx}>
                  <path
                    d={path}
                    fill="none"
                    stroke="var(--border-strong, var(--fg-muted))"
                    stroke-width={sw}
                    stroke-opacity="0.62"
                    marker-end="url(#swim-arrow)"
                  />
                  {/* Edge count label sits at the midpoint of the arc.
                      Small, mono, slightly recessed color so it reads
                      as metadata. */}
                  <text
                    x={labelX}
                    y={labelY + 3}
                    fill="var(--fg-faint)"
                    style="font-size: 10px; font-variant-numeric: tabular-nums"
                  >
                    {edge.count}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    );
  };
}

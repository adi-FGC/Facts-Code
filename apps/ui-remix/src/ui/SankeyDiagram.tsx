/**
 * SankeyDiagram — reusable flow-ribbon diagram, shared by every Sankey surface
 * (Flow tier→tier, Architecture folder coupling, Overview token economics,
 * Vulnerabilities pkg→severity).
 *
 * Layout geometry comes from the pure `computeSankey` (lib/sankey.ts); this
 * component only renders it. Everything dynamic — ribbon `d`/`stroke-width`,
 * node `x/y/width/height`, per-datum `fill`/`stroke` — is an SVG PRESENTATION
 * ATTRIBUTE, which CSP does not police, so the diagram stays clean under the
 * strict `style-src` (SEC-3). Static styling (label font, hover) is a `css()`
 * class injected via adopted stylesheets. No inline `style=` anywhere.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import { computeSankey, type SankeyNodeInput, type SankeyLinkInput } from '../lib/sankey.ts';

export interface SankeyDiagramProps {
  nodes: ReadonlyArray<SankeyNodeInput>;
  links: ReadonlyArray<SankeyLinkInput>;
  /** viewBox width / height (the SVG scales to its container width). */
  width?: number;
  height?: number;
  /** Format a flow value for tooltips / counts (default: localized integer). */
  formatValue?: (n: number) => string;
  /** Accessible name for the figure. */
  ariaLabel?: string;
}

const figure = css({
  width: '100%',
  display: 'block',
});

const svgEl = css({
  width: '100%',
  height: 'auto',
  overflow: 'visible',
  display: 'block',
});

const linkPath = css({
  fill: 'none',
  transition: 'stroke-opacity var(--dur-quick, 120ms) var(--ease-out-quart, ease)',
  '&:hover': { strokeOpacity: '0.7' },
});

const nodeRect = css({
  transition: 'fill-opacity var(--dur-quick, 120ms) var(--ease-out-quart, ease)',
});

const nodeLabel = css({
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--fs-11)',
  fill: 'var(--fg)',
  pointerEvents: 'none',
});

const nodeValue = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fill: 'var(--fg-faint)',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
});

const emptyNote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-faint)',
  padding: 'var(--space-4)',
});

export function SankeyDiagram(handle: Handle<SankeyDiagramProps>) {
  return () => {
    const {
      nodes,
      links,
      width = 760,
      height = 380,
      formatValue = (n: number) => Math.round(n).toLocaleString('en-US'),
      ariaLabel = 'Sankey flow diagram',
    } = handle.props;

    const layout = computeSankey(nodes, links, { width, height });
    if (layout.nodes.length === 0) {
      return <div mix={emptyNote}>No flow to chart for this view yet.</div>;
    }

    const lastColumn = layout.nodes.reduce((m, n) => Math.max(m, n.column), 0);

    return (
      <div mix={figure}>
        <svg
          mix={svgEl}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Ribbons first so nodes + labels paint over them. */}
          <g>
            {layout.links.map((l, i) => (
              <path
                key={`lnk-${i}`}
                mix={linkPath}
                d={l.path}
                stroke={l.color ?? 'var(--accent)'}
                stroke-width={l.width}
                stroke-opacity="0.32"
                stroke-linecap="round"
              >
                <title>{`${l.source} → ${l.target} · ${formatValue(l.value)}`}</title>
              </path>
            ))}
          </g>
          <g>
            {layout.nodes.map((n) => {
              const onRight = n.column === lastColumn;
              const labelX = onRight ? n.x - 6 : n.x + n.width + 6;
              const anchor = onRight ? 'end' : 'start';
              const midY = n.y + n.height / 2;
              return (
                <g key={`node-${n.id}`}>
                  <rect
                    mix={nodeRect}
                    x={n.x}
                    y={n.y}
                    width={n.width}
                    height={n.height}
                    rx="1.5"
                    fill={n.color ?? 'var(--fg-muted)'}
                  >
                    <title>{`${n.label} · ${formatValue(n.value)}`}</title>
                  </rect>
                  <text mix={nodeLabel} x={labelX} y={midY - 1} text-anchor={anchor} dominant-baseline="middle">
                    {n.label}
                  </text>
                  <text mix={nodeValue} x={labelX} y={midY + 11} text-anchor={anchor} dominant-baseline="middle">
                    {formatValue(n.value)}
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

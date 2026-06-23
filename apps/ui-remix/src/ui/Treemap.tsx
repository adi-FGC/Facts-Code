/**
 * Treemap — area-proportional code map. Each tile is one item (a file),
 * sized by weight (token cost) and coloured by language. The big tiles ARE
 * the answer to "where is the weight?"; the colour mix is the answer to
 * "what is this codebase made of?".
 *
 * Layout geometry comes from the pure `computeTreemap` (lib/treemap.ts);
 * this component only renders it. Everything dynamic — tile x/y/width/height,
 * per-tile fill — is an SVG PRESENTATION ATTRIBUTE, which CSP does not
 * police, so the map stays clean under the strict style-src (SEC-3). Labels
 * use the paint-order halo trick (dark stroke under light fill) so they read
 * on any language colour without per-tile luminance maths.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';
import { computeTreemap, type TreemapItem } from '../lib/treemap.ts';

export interface TreemapProps {
  items: ReadonlyArray<TreemapItem>;
  width?: number;
  height?: number;
  /** Format a tile's value for labels / tooltips (default: localized integer). */
  formatValue?: (n: number) => string;
  /** Optional href per tile id → makes tiles clickable (e.g. into file detail). */
  linkFor?: (id: string) => string;
  ariaLabel?: string;
}

const figure = css({ width: '100%', display: 'block' });

const svgEl = css({
  width: '100%',
  height: 'auto',
  display: 'block',
});

const tile = css({
  transition: 'fill-opacity var(--dur-quick, 120ms) var(--ease-out-quart, ease)',
  fillOpacity: '0.88',
  '&:hover': { fillOpacity: '1' },
});

const tileName = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  fill: '#fff',
  stroke: 'rgba(0,0,0,0.55)',
  pointerEvents: 'none',
});

const tileValue = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-10)',
  fill: 'rgba(255,255,255,0.85)',
  stroke: 'rgba(0,0,0,0.5)',
  fontVariantNumeric: 'tabular-nums',
  pointerEvents: 'none',
});

const emptyNote = css({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-11)',
  color: 'var(--fg-faint)',
  padding: 'var(--space-4)',
});

/** Rough monospace truncation so a label never overflows its tile. */
function fitLabel(label: string, w: number): string {
  const maxChars = Math.floor((w - 8) / 6.4);
  if (maxChars <= 1) return '';
  if (label.length <= maxChars) return label;
  if (maxChars <= 2) return label.slice(0, maxChars);
  return label.slice(0, maxChars - 1) + '…';
}

export function Treemap(handle: Handle<TreemapProps>) {
  return () => {
    const {
      items,
      width = 760,
      height = 460,
      formatValue = (n: number) => Math.round(n).toLocaleString('en-US'),
      linkFor,
      ariaLabel = 'Treemap',
    } = handle.props;

    const layout = computeTreemap(items, { width, height, padding: 1.5 });
    if (layout.rects.length === 0) {
      return <div mix={emptyNote}>Nothing to map for this view yet.</div>;
    }

    return (
      <div mix={figure}>
        <svg
          mix={svgEl}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={ariaLabel}
          preserveAspectRatio="xMidYMid meet"
        >
          {layout.rects.map((r) => {
            const showName = r.w >= 52 && r.h >= 26;
            const showVal = r.w >= 64 && r.h >= 40;
            const name = showName ? fitLabel(r.label, r.w) : '';
            const body = (
              <g key={`g-${r.id}`}>
                <rect
                  mix={tile}
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  rx="1.5"
                  fill={r.color ?? 'var(--fg-muted)'}
                >
                  <title>{`${r.label} · ${formatValue(r.value)}`}</title>
                </rect>
                {name && (
                  <text
                    mix={tileName}
                    x={r.x + 5}
                    y={r.y + 15}
                    stroke-width="2.6"
                    paint-order="stroke"
                    stroke-linejoin="round"
                  >
                    {name}
                  </text>
                )}
                {showVal && (
                  <text
                    mix={tileValue}
                    x={r.x + 5}
                    y={r.y + 28}
                    stroke-width="2.2"
                    paint-order="stroke"
                    stroke-linejoin="round"
                  >
                    {formatValue(r.value)}
                  </text>
                )}
              </g>
            );
            return linkFor ? (
              <a key={`a-${r.id}`} href={linkFor(r.id)} aria-label={`${r.label}, ${formatValue(r.value)}`}>
                {body}
              </a>
            ) : (
              body
            );
          })}
        </svg>
      </div>
    );
  };
}

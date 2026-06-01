/**
 * Sparkline — inline SVG mini-chart, no chart lib.
 *
 * Per design_spec.md anti-slop guidance: sparklines are NOT decoration
 * here. They're scoped to the History tab where the data series is real
 * and consequential (LOC over time, risk count trend). Each one carries
 * a label + last value + delta — it earns its place.
 *
 * Renders a polyline + area fill. Tuned for editorial subtlety: 1px
 * stroke, 12% accent fill, no gradient, no markers.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';

interface SparklineProps {
  /** Numeric series. Must have ≥2 points to render meaningfully. */
  values: number[];
  /** Pixel width. Default fits the LabelNumber column. */
  width?: number;
  /** Pixel height. Default 28 (subtle). */
  height?: number;
  /** Color override; defaults to accent. */
  color?: string;
  /** ARIA label for accessibility. */
  label?: string;
}

export function Sparkline(handle: Handle<SparklineProps>) {
  return () => {
    const {
      values,
      width = 120,
      height = 28,
      color = 'var(--accent)',
      label = 'trend',
    } = handle.props;
    if (values.length < 2) {
      return (
        <span
          mix={css({
            display: 'inline-block',
            width: width + 'px',
            height: height + 'px',
            color: 'var(--fg-faint)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-10)',
          })}
        >
          —
        </span>
      );
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const stepX = width / (values.length - 1);
    const points = values
      .map((v, i) => {
        const x = i * stepX;
        const y = height - 2 - ((v - min) / range) * (height - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    const area = `${points} ${(width).toFixed(1)},${height} 0,${height}`;
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={String(width)}
        height={String(height)}
        role="img"
        aria-label={label}
        mix={css({ display: 'inline-block', verticalAlign: 'middle', overflow: 'visible' })}
      >
        <polygon points={area} fill={color} fillOpacity="0.12" />
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  };
}

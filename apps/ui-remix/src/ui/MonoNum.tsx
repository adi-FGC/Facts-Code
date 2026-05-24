/**
 * MonoNum — every numeric in the app is wrapped here.
 *
 * Why: tabular-nums prevents column dance when numbers update in
 * place (re-analyze, snapshot diffs, etc.). Variable-axis JetBrains
 * Mono lets weight do the visual lifting on data without throwing
 * shadow or color at the problem. This is the single point where
 * "numbers feel intentional" lives.
 *
 * Anti-slop rule: any literal numeric inside a stat / metric / table
 * MUST go through MonoNum. Catches drift toward styled-prose-stat
 * AI patterns.
 */
import type { Handle } from 'remix/ui';
import { css } from 'remix/ui';

interface MonoNumProps {
  children: string | number;
  /** Slightly bolder for the hero figure. Default 500. */
  weight?: 400 | 500 | 600;
  /** Inherits font-size by default; pass to override. */
  size?: string;
}

const base = css({
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums lining-nums',
  fontFeatureSettings: '"ss01", "cv03"',
  letterSpacing: '-0.01em',
});

export function MonoNum(_h: Handle<MonoNumProps>) {
  return ({ children, weight = 500, size }: MonoNumProps) => (
    <span
      mix={[
        base,
        css({
          fontWeight: String(weight),
          ...(size ? { fontSize: size } : {}),
        }),
      ]}
    >
      {children}
    </span>
  );
}

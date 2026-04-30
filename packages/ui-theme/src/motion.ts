/**
 * @factstack/ui-theme/motion — shared motion vocabulary.
 *
 * Mirrors the CSS custom properties in tokens.css so JS code (framer-motion,
 * Web Animations API, manual rAF tweens) can read the same vocabulary
 * without parsing computed styles. Motion principles:
 *
 *  - ≤300ms for common actions, ≤500ms for signature moments.
 *  - Enter uses `easeEnter`; exit is ~75% duration with `easeExit`.
 *  - No bounce/elastic — they feel dated and pull attention to themselves.
 *  - All motion respects `prefers-reduced-motion: reduce`.
 */

export const EASINGS = {
  enter: [0.2, 0, 0, 1] as const,
  exit:  [0.4, 0, 1, 1] as const,
  outQuart: [0.25, 1, 0.5, 1] as const,
  outQuint: [0.22, 1, 0.36, 1] as const,
  outExpo:  [0.16, 1, 0.3, 1] as const,
} as const;

export const DURATIONS = {
  instant:   120,   // button press, toggle
  quick:     180,   // tab underline slide
  state:     260,   // hover → focus, zoom button tween
  layout:    380,   // accordion expand, panel swap
  signature: 500,   // hero entry, camera fit
} as const;

/** CSS-var fallbacks — match tokens.css exactly so we stay in sync. */
export const CSS_VARS = {
  easeEnter: 'var(--ease-enter)',
  easeExit: 'var(--ease-exit)',
  easeOutQuart: 'var(--ease-out-quart)',
  durInstant: 'var(--dur-instant)',
  durQuick: 'var(--dur-quick)',
  durState: 'var(--dur-state)',
  durLayout: 'var(--dur-layout)',
  durSignature: 'var(--dur-signature)',
} as const;

/** Helper for `@media (prefers-reduced-motion: reduce)` checks from JS. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

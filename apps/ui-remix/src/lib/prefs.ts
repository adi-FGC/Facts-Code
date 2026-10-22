/**
 * Browser preferences — the storage keys and ranges the Config tab writes
 * and the no-flash boot script in index.html reads BEFORE the app loads.
 * One list, so the two cannot drift again (F-45: Config wrote
 * `facts-fs-mult`, the boot script read `facts-font-scale`, and every reload
 * reset the type size; density was never applied at boot at all).
 * test/bootScript.test.ts pins index.html to this module.
 */
export const PREF_KEYS = {
  theme: 'facts-theme',
  fontScale: 'facts-font-scale',
  density: 'facts-density',
} as const;

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.35;

export type Density = 'comfortable' | 'compact';
/** `--row-pad-mult` per density; the boot script applies the same value. */
export const DENSITY_ROW_PAD: Record<Density, string> = { comfortable: '1', compact: '0.65' };

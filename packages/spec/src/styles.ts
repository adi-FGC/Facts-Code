/**
 * styles — the CSS / styling-audit slice of the agent artifact.
 *
 * `analyze()` extracts every CSS source in the SCANNED project (.css/.scss/
 * .sass/.less files + `<style>` blocks in HTML/Vue/Svelte/Astro) and audits
 * it: a class map, selector specificity, conflicting/overriding rules,
 * `!important` overuse, the responsive breakpoints in use vs. standard device
 * bands, container-query usage, the styling paradigms/frameworks in play, and
 * whether a CSS transform tool (lightningcss/postcss/autoprefixer) is present
 * for fallbacks. The dashboard's collapsible "CSS suggestions" panel renders
 * `findings`; the count drives the ticker.
 *
 * Additive-only within a major version.
 */

import { z } from 'zod';

export const StyleFindingCategorySchema = z.enum([
  'naming', // non-semantic / inconsistent class names
  'conflict', // same class defined in multiple places with differing rules
  'override', // a rule is shadowed by a higher-specificity one
  'important', // !important overuse
  'specificity', // dangerously high specificity / id-in-selector
  'responsive', // missing breakpoint / device-band coverage
  'container-query', // candidate for @container instead of @media
  'paradigm', // mixed/inconsistent styling approaches
  'fallback', // modern CSS used without a transpiler/prefixer
  'duplicate', // duplicate declaration blocks
]);
export type StyleFindingCategory = z.infer<typeof StyleFindingCategorySchema>;

export const StyleSeveritySchema = z.enum(['info', 'low', 'medium', 'high']);
export type StyleSeverity = z.infer<typeof StyleSeveritySchema>;

export const StyleFindingSchema = z.object({
  id: z.string(),
  category: StyleFindingCategorySchema,
  severity: StyleSeveritySchema,
  title: z.string(),
  detail: z.string(),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  selector: z.string().optional(),
  /** A concrete, paste-able fix — e.g. a media/container query snippet. */
  suggestion: z.string().optional(),
});
export type StyleFinding = z.infer<typeof StyleFindingSchema>;

/** A media-query breakpoint actually used in the project. */
export const BreakpointSchema = z.object({
  px: z.number().int().nonnegative(),
  feature: z.enum(['min-width', 'max-width', 'other']),
  raw: z.string(),
  count: z.number().int().nonnegative(),
});
export type Breakpoint = z.infer<typeof BreakpointSchema>;

/**
 * A standard device band (mobile / tablet / desktop / large). `covered` is
 * true when at least one of the project's breakpoints serves this range — the
 * "compare against device sizes like responsiveviewer.org" check.
 */
export const DeviceBandSchema = z.object({
  name: z.string(),
  minPx: z.number().int().nonnegative(),
  maxPx: z.number().int().nonnegative().nullable(),
  representativeWidths: z.array(z.number().int().nonnegative()),
  covered: z.boolean(),
});
export type DeviceBand = z.infer<typeof DeviceBandSchema>;

export const StyleSheetInfoSchema = z.object({
  path: z.string(),
  origin: z.enum(['css', 'scss', 'sass', 'less', 'html-style', 'sfc-style']),
  rules: z.number().int().nonnegative(),
  classes: z.number().int().nonnegative(),
  mediaQueries: z.number().int().nonnegative(),
  importantCount: z.number().int().nonnegative(),
  /** Highest selector specificity in the sheet, as [id, class, type]. */
  maxSpecificity: z.tuple([z.number(), z.number(), z.number()]),
});
export type StyleSheetInfo = z.infer<typeof StyleSheetInfoSchema>;

export const StyleToolingSchema = z.object({
  lightningcss: z.boolean(),
  postcss: z.boolean(),
  autoprefixer: z.boolean(),
  sass: z.boolean(),
  tailwind: z.boolean(),
});
export type StyleTooling = z.infer<typeof StyleToolingSchema>;

export const StyleAuditSchema = z.object({
  sheets: z.array(StyleSheetInfoSchema).default([]),
  ruleCount: z.number().int().nonnegative().default(0),
  classCount: z.number().int().nonnegative().default(0),
  importantCount: z.number().int().nonnegative().default(0),
  containerQueries: z.number().int().nonnegative().default(0),
  breakpoints: z.array(BreakpointSchema).default([]),
  devices: z.array(DeviceBandSchema).default([]),
  /** Detected styling paradigms/frameworks (e.g. "Tailwind", "CSS Modules",
   *  "BEM", "CSS-in-JS", "Bootstrap", "Sass"). */
  paradigms: z.array(z.string()).default([]),
  tooling: StyleToolingSchema.default({
    lightningcss: false, postcss: false, autoprefixer: false, sass: false, tailwind: false,
  }),
  findings: z.array(StyleFindingSchema).default([]),
});
export type StyleAudit = z.infer<typeof StyleAuditSchema>;

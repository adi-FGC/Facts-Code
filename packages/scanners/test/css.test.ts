/**
 * Tests for the CSS / styling auditor — statement at-rules, Media Queries L4
 * range syntax, and direction-aware device-band coverage (2026-09-24).
 */

import { describe, expect, it } from 'vitest';
import { StyleAuditSchema } from '@factstack/spec';
import { analyzeCss, type CssSource } from '../src/css.js';

const ctx = { deps: new Set<string>(), frameworks: [] };
const audit = (css: string) =>
  analyzeCss([{ path: 'a.css', css, origin: 'css' } satisfies CssSource], ctx);
const titles = (css: string) =>
  audit(css).findings.map((f) => `${f.category}/${f.severity}: ${f.title}`);
const bps = (css: string) => audit(css).breakpoints.map((b) => `${b.feature}:${b.px}`);

describe('analyzeCss — statement at-rules (SCN-11)', () => {
  it('an @import does not swallow the @media that follows it', () => {
    const css =
      '@import url(reset.css);\n@media (max-width:480px){.btn{padding:4px}}\n.btn{padding:8px}';
    expect(bps(css)).toEqual(['max-width:480']);
    expect(titles(css).filter((t) => t.startsWith('conflict'))).toEqual([]);
  });

  it('@charset / @use / @tailwind do not drop or rename the next rule', () => {
    for (const lead of ['@charset "UTF-8";', "@use 'sass:math';", '@tailwind base;']) {
      const a = audit(`${lead}\n.card{color:red}\n.btn{color:blue}`);
      expect(a.ruleCount, lead).toBe(2);
      expect(a.sheets[0]!.classes, lead).toBe(2);
    }
  });

  it('declarations inside a non-rule at-block (@font-face) do not leak into the next selector', () => {
    const css = '@font-face{font-family:x;src:url(a.woff)}\n.btn{padding:1px}\n.btn{padding:2px}';
    expect(titles(css)).toContain('conflict/medium: .btn redefined 2× with differing rules');
  });
});

describe('analyzeCss — Media Queries level 4 range syntax (SCN-12)', () => {
  const rules = Array.from({ length: 10 }, (_, i) => `.r${i}{color:red}`).join('\n');

  it('reads `width >= N`, `width <= N` and the reversed `N <= width` forms', () => {
    const css = `${rules}\n@media (width >= 768px){.a{color:red}}\n@media (width <= 480px){.b{color:red}}\n@media (1024px <= width){.c{color:red}}\n@media (width < 40em){.d{color:red}}`;
    expect(bps(css)).toEqual(['max-width:480', 'max-width:639', 'min-width:768', 'min-width:1024']);
    expect(titles(css).some((t) => t.includes('No responsive breakpoints'))).toBe(false);
  });

  // SCN-REV-5 — `<` / `>` exclude the bound itself: `width < 768px` (Tailwind
  // v4's `max-md:`) stops at 767 and never reaches the 768px tablet band.
  it('strict `<` / `>` exclude their bound, in both orders', () => {
    const covered = (css: string, band: string) =>
      audit(css).devices.find((d) => d.name === band)!.covered;
    expect(bps('@media (width < 768px){.a{color:red}}')).toEqual(['max-width:767']);
    expect(covered('@media (width < 768px){.a{color:red}}', 'tablet')).toBe(false);
    expect(covered('@media (width < 768px){.a{color:red}}', 'large-mobile')).toBe(true);
    expect(bps('@media (width > 1023px){.a{color:red}}')).toEqual(['min-width:1024']);
    expect(covered('@media (width > 1023px){.a{color:red}}', 'tablet')).toBe(false);
    expect(bps('@media (768px > width){.a{color:red}}')).toEqual(['max-width:767']);
    expect(bps('@media (1023px < width){.a{color:red}}')).toEqual(['min-width:1024']);
    expect(bps('@media (width < 767.5px){.a{color:red}}')).toEqual(['max-width:767']);
  });

  it('reads a double range `A <= width <= B` as both bounds', () => {
    expect(bps(`@media (320px <= width <= 480px){.a{color:red}}`)).toEqual([
      'min-width:320',
      'max-width:480',
    ]);
  });
});

describe('analyzeCss — device-band coverage follows the query direction (SCN-13)', () => {
  const bootstrap =
    '@media (max-width: 767.98px){.a{color:red}}\n@media (min-width: 768px){.b{color:red}}\n@media (min-width: 1024px){.c{color:red}}';

  it('a Bootstrap-style max-width query covers the phone bands', () => {
    const a = audit(bootstrap);
    expect(a.devices.filter((d) => !d.covered).map((d) => d.name)).toEqual([]);
    expect(titles(bootstrap).filter((t) => t.startsWith('responsive'))).toEqual([]);
  });

  it('a fractional breakpoint still yields a schema-valid (integer px) audit', () => {
    expect(() => StyleAuditSchema.parse(audit(bootstrap))).not.toThrow();
    expect(bps(bootstrap)).toEqual(['max-width:767', 'min-width:768', 'min-width:1024']);
  });

  it('a desktop-only min-width query still leaves mobile uncovered', () => {
    const css = '@media (min-width: 1024px){.c{color:red}}';
    expect(titles(css)).toContain('responsive/medium: No breakpoint covers mobile (320–480px)');
  });
});

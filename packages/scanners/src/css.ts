/**
 * @factstack/scanners — CSS / styling auditor.
 *
 * Pure / isomorphic. Given the scanned project's CSS sources (.css/.scss/.less
 * files + `<style>` blocks already sliced out of HTML/SFCs), produces a
 * StyleAudit: a class map, selector specificity, conflicting/overriding rules,
 * `!important` overuse, the responsive breakpoints in use mapped onto standard
 * device bands, container-query usage, the styling paradigms in play, and a
 * lightningcss/tooling check for modern-CSS fallbacks. Each issue becomes a
 * grounded, paste-able suggestion (the dashboard's RHS ticker counts them).
 *
 * The parser is deliberately lightweight + brace-aware (not a full CSSOM): the
 * audit needs selectors, declaration blocks, and @-rule context — not a
 * round-trippable tree. SCSS nesting is captured at the outer-rule level.
 */

import type {
  StyleAudit,
  StyleFinding,
  StyleFindingCategory,
  StyleSeverity,
  StyleSheetInfo,
  Breakpoint,
  DeviceBand,
} from '@factstack/spec';

export interface CssSource {
  path: string;
  /** CSS text. For HTML/SFCs this is the concatenated `<style>` contents. */
  css: string;
  origin: StyleSheetInfo['origin'];
}

export interface CssAuditContext {
  /** All dependency names (lowercased) for framework/tooling detection. */
  deps: Set<string>;
  /** Frameworks from the framework scanner (e.g. "Tailwind CSS"). */
  frameworks: string[];
}

/** Standard device bands — the "compare against mobile/tablet/desktop" axis. */
const DEVICE_BANDS: ReadonlyArray<Omit<DeviceBand, 'covered'>> = [
  { name: 'mobile', minPx: 320, maxPx: 480, representativeWidths: [360, 390, 414] },
  { name: 'large-mobile', minPx: 481, maxPx: 767, representativeWidths: [540, 600] },
  { name: 'tablet', minPx: 768, maxPx: 1023, representativeWidths: [768, 834] },
  { name: 'desktop', minPx: 1024, maxPx: 1439, representativeWidths: [1280, 1366] },
  { name: 'large-desktop', minPx: 1440, maxPx: null, representativeWidths: [1440, 1920] },
];

interface Rule {
  selector: string;
  decls: string;
  line: number;
  file: string;
  important: number;
  /** True when the rule sits inside an @media / @container block (so its
   *  redefinition of a class is an intentional responsive override). */
  media: boolean;
  /** Cascade scope: a file path for standalone HTML/SFC `<style>` blocks
   *  (each is its own cascade), or 'global' for linked stylesheets that
   *  share one cascade in the app. */
  scope: string;
}

/* ───────────────────────── parsing ───────────────────────── */

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

interface ParsedSheet {
  rules: Rule[];
  medias: Array<{ raw: string; line: number }>;
  containerQueries: number;
  importantCount: number;
}

function parseSheet(rawCss: string, file: string, scope: string): ParsedSheet {
  const css = stripComments(rawCss);
  const rules: Rule[] = [];
  const medias: Array<{ raw: string; line: number }> = [];
  let containerQueries = 0;
  let importantCount = 0;

  let i = 0;
  let line = 1;
  let buf = '';
  const atStack: string[] = [];

  while (i < css.length) {
    const c = css[i];
    if (c === '\n') line++;

    if (c === '{') {
      const prelude = buf.trim();
      buf = '';
      if (prelude.startsWith('@')) {
        const lower = prelude.toLowerCase();
        if (lower.startsWith('@media')) { medias.push({ raw: prelude, line }); atStack.push('media'); }
        else if (lower.startsWith('@container')) { containerQueries++; atStack.push('container'); }
        else atStack.push('at');
        i++;
        continue;
      }
      // selector rule — read its declaration block (brace-balanced for SCSS).
      let depth = 1;
      let decls = '';
      const startLine = line;
      i++;
      while (i < css.length && depth > 0) {
        const d = css[i] ?? '';
        if (d === '\n') line++;
        if (d === '{') depth++;
        else if (d === '}') { depth--; if (depth === 0) break; }
        decls += d;
        i++;
      }
      const imp = (decls.match(/!important/g) ?? []).length;
      importantCount += imp;
      const inMedia = atStack.includes('media') || atStack.includes('container');
      rules.push({ selector: prelude, decls, line: startLine, file, important: imp, media: inMedia, scope });
      i++; // consume closing }
      continue;
    }

    if (c === '}') {
      atStack.pop();
      i++;
      continue;
    }

    buf += c ?? '';
    i++;
  }

  return { rules, medias, containerQueries, importantCount };
}

/* ───────────────────────── specificity ───────────────────────── */

/** [id, class, type] specificity, approximate but order-correct. */
export function specificity(selector: string): [number, number, number] {
  const sel = selector.replace(/::?[\w-]+\([^)]*\)/g, (m) => m); // keep functional pseudos
  const a = (sel.match(/#[\w-]+/g) ?? []).length;
  const b = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const c = (sel.match(/(?:^|[\s>+~(])[a-zA-Z][\w-]*/g) ?? []).length + (sel.match(/::[\w-]+/g) ?? []).length;
  return [a, b, c];
}

function specGt(x: [number, number, number], y: [number, number, number]): boolean {
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
}

/* ───────────────────────── helpers ───────────────────────── */

const CLASS_RE = /\.(-?[A-Za-z_][\w-]*)/g;

function classesIn(selector: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(selector))) if (m[1]) out.push(m[1]);
  return out;
}

function breakpointsFromMedia(raw: string): Array<{ px: number; feature: Breakpoint['feature'] }> {
  const out: Array<{ px: number; feature: Breakpoint['feature'] }> = [];
  const re = /(min|max)-width\s*:\s*([\d.]+)(px|rem|em)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const n = parseFloat(m[2] ?? '0');
    const unit = (m[3] ?? 'px').toLowerCase();
    const px = unit === 'px' ? n : Math.round(n * 16);
    out.push({ px, feature: (m[1] ?? '').toLowerCase() === 'min' ? 'min-width' : 'max-width' });
  }
  return out;
}

const MODERN_FEATURES: Array<{ re: RegExp; label: string }> = [
  { re: /\bcolor-mix\s*\(/i, label: 'color-mix()' },
  { re: /:has\s*\(/i, label: ':has()' },
  { re: /@container\b/i, label: 'container queries' },
  { re: /\boklch\s*\(|\boklab\s*\(/i, label: 'oklch()/oklab()' },
  { re: /\blight-dark\s*\(/i, label: 'light-dark()' },
  { re: /\baspect-ratio\s*:/i, label: 'aspect-ratio' },
  { re: /:is\s*\(|:where\s*\(/i, label: ':is()/:where()' },
  { re: /\binset\s*:/i, label: 'inset shorthand' },
];

const NON_SEMANTIC = /^(box|wrap(per)?|cont(ainer)?|div|el|elem|item|thing|block|inner|outer|main|content|temp|test|foo|bar)\d*$/i;

/* ───────────────────────── audit ───────────────────────── */

export function analyzeCss(sources: CssSource[], ctx: CssAuditContext): StyleAudit {
  const sheets: StyleSheetInfo[] = [];
  const allRules: Rule[] = [];
  const allMedias: Array<{ raw: string; line: number }> = [];
  let containerQueries = 0;
  let importantCount = 0;

  for (const src of sources) {
    const scopeKey = src.origin === 'html-style' || src.origin === 'sfc-style' ? src.path : 'global';
    const parsed = parseSheet(src.css, src.path, scopeKey);
    allRules.push(...parsed.rules);
    allMedias.push(...parsed.medias);
    containerQueries += parsed.containerQueries;
    importantCount += parsed.importantCount;

    const sheetClasses = new Set<string>();
    let maxSpec: [number, number, number] = [0, 0, 0];
    for (const r of parsed.rules) {
      for (const part of r.selector.split(',')) {
        for (const cls of classesIn(part)) sheetClasses.add(cls);
        const s = specificity(part);
        if (specGt(s, maxSpec)) maxSpec = s;
      }
    }
    sheets.push({
      path: src.path,
      origin: src.origin,
      rules: parsed.rules.length,
      classes: sheetClasses.size,
      mediaQueries: parsed.medias.length,
      importantCount: parsed.importantCount,
      maxSpecificity: maxSpec,
    });
  }

  // Class definition map (class → defining rules) for conflict detection.
  const classDefs = new Map<string, Rule[]>();
  for (const r of allRules) {
    for (const part of r.selector.split(',')) {
      // Only count rules whose KEY (rightmost) is a class, to avoid noise.
      const cls = classesIn(part);
      for (const c of cls) {
        const arr = classDefs.get(c) ?? [];
        arr.push(r);
        classDefs.set(c, arr);
      }
    }
  }

  // Breakpoints (unique px, counted).
  const bpMap = new Map<string, Breakpoint>();
  for (const md of allMedias) {
    for (const b of breakpointsFromMedia(md.raw)) {
      const key = b.feature + ':' + b.px;
      const ex = bpMap.get(key);
      if (ex) ex.count++;
      else bpMap.set(key, { px: b.px, feature: b.feature, raw: `${b.feature}: ${b.px}px`, count: 1 });
    }
  }
  const breakpoints = [...bpMap.values()].sort((a, b) => a.px - b.px);

  // Device-band coverage.
  const devices: DeviceBand[] = DEVICE_BANDS.map((band) => {
    const max = band.maxPx ?? Number.MAX_SAFE_INTEGER;
    const covered = breakpoints.some((bp) => bp.px >= band.minPx - 1 && bp.px <= max);
    return { ...band, covered };
  });

  // Tooling / paradigms.
  const has = (name: string) => ctx.deps.has(name.toLowerCase());
  const tooling = {
    lightningcss: has('lightningcss'),
    postcss: has('postcss'),
    autoprefixer: has('autoprefixer'),
    sass: has('sass') || has('node-sass') || has('sass-embedded'),
    tailwind: has('tailwindcss') || ctx.frameworks.includes('Tailwind CSS'),
  };

  const paradigms = detectParadigms(sources, allRules, ctx, tooling);

  // ── findings ──
  const findings: StyleFinding[] = [];
  let fid = 0;
  const add = (
    category: StyleFindingCategory, severity: StyleSeverity, title: string, detail: string,
    extra: Partial<StyleFinding> = {},
  ) => findings.push({ id: `css-${fid++}`, category, severity, title, detail, ...extra });

  // conflicts: a BARE single-class selector (`.foo`) redefined ≥2× in the SAME
  // cascade scope (one HTML file, or the shared/linked CSS) with differing
  // bodies, OUTSIDE any media query. This deliberately excludes (a) intentional
  // responsive overrides and (b) identically-named classes living in separate
  // standalone HTML pages — neither actually conflicts.
  const bareDefs = new Map<string, Rule[]>();
  for (const r of allRules) {
    if (r.media) continue;
    const sel = r.selector.trim();
    if (!/^\.[-\w]+$/.test(sel)) continue;
    const key = r.scope + ' ' + sel.slice(1);
    const arr = bareDefs.get(key) ?? [];
    arr.push(r);
    bareDefs.set(key, arr);
  }
  let conflictCount = 0;
  let dupCount = 0;
  for (const defs of bareDefs.values()) {
    if (defs.length < 2) continue;
    const first = defs[0]!;
    const cls = first.selector.trim().slice(1);
    const bodies = new Set(defs.map((d) => normalizeDecls(d.decls)));
    if (bodies.size > 1) {
      conflictCount++;
      if (conflictCount <= 12) {
        const where = first.scope === 'global' ? 'the shared/linked CSS' : first.file;
        add('conflict', 'medium', `.${cls} redefined ${defs.length}× with differing rules`,
          `\`.${cls}\` is defined ${defs.length} times as a bare class in ${where}, with different declarations and no media-query scoping — only the last wins, so an edit can silently break earlier intent. Consolidate into one rule.`,
          { selector: `.${cls}`, file: first.file, line: first.line });
      }
    } else {
      dupCount++;
    }
  }
  if (conflictCount > 12) {
    add('conflict', 'medium', `+${conflictCount - 12} more redefined classes`,
      `${conflictCount} bare classes total are redefined with differing rules within one cascade scope. Showing the first 12.`);
  }
  if (dupCount > 0) {
    add('duplicate', 'low', `${dupCount} class(es) with identical duplicate definitions`,
      `${dupCount} bare class selectors are defined more than once with the SAME declarations in one scope — harmless but dead weight; remove the repeats.`);
  }

  // overrides: id-bearing selectors raising specificity.
  const idSelectors = allRules.filter((r) => r.selector.includes('#'));
  if (idSelectors.length) {
    const sample = idSelectors[0]!;
    add('specificity', idSelectors.length > 5 ? 'high' : 'medium',
      `${idSelectors.length} selector(s) use an #id`,
      `ID selectors have very high specificity (1,0,0) and are hard to override — a later class rule can't win without its own ID or \`!important\`. Prefer classes. e.g. \`${truncate(sample.selector, 60)}\`.`,
      { file: sample.file, line: sample.line, selector: truncate(sample.selector, 80) });
  }

  // !important overuse.
  if (importantCount > 0) {
    const sev: StyleSeverity = importantCount > 30 ? 'high' : importantCount > 8 ? 'medium' : 'low';
    add('important', sev, `${importantCount} \`!important\` declaration(s)`,
      `\`!important\` short-circuits the cascade and compounds — each one makes the next override need its own \`!important\`. ${importantCount > 8 ? 'This is above a healthy threshold; ' : ''}refactor by lowering competing specificity instead.`);
  }

  // naming lint.
  const badNames = [...classDefs.keys()].filter((c) => NON_SEMANTIC.test(c) || /^[a-z]$/i.test(c) || /\d{2,}$/.test(c));
  if (badNames.length) {
    add('naming', 'low', `${badNames.length} non-semantic class name(s)`,
      `Names like ${badNames.slice(0, 5).map((n) => `\`.${n}\``).join(', ')} describe markup, not meaning — they don't survive refactors. Prefer role-based names (\`.card\`, \`.alert\`) or a convention (BEM \`block__el--mod\`).`);
  }
  // mixed casing convention.
  const casing = classCasing([...classDefs.keys()]);
  if (casing.kebab && casing.camel && casing.kebab > 2 && casing.camel > 2) {
    add('naming', 'info', 'Mixed class-naming conventions',
      `Class names mix kebab-case (${casing.kebab}) and camelCase (${casing.camel}). Pick one — consistency makes the stylesheet greppable and lints cleanly.`);
  }

  // responsive / device-band coverage.
  const uncovered = devices.filter((d) => !d.covered && (d.name === 'mobile' || d.name === 'tablet' || d.name === 'desktop'));
  if (breakpoints.length === 0 && allRules.length > 8) {
    add('responsive', 'high', 'No responsive breakpoints at all',
      `The project has ${allRules.length} rules but zero \`@media\` breakpoints — the layout is fixed across mobile, tablet, and desktop. Add at least the three standard tiers.`,
      { suggestion: '@media (max-width: 480px) { /* mobile */ }\n@media (min-width: 768px) { /* tablet+ */ }\n@media (min-width: 1024px) { /* desktop */ }' });
  } else if (uncovered.length) {
    for (const band of uncovered) {
      add('responsive', band.name === 'mobile' ? 'medium' : 'low',
        `No breakpoint covers ${band.name} (${band.minPx}–${band.maxPx ?? '∞'}px)`,
        `Nothing in the stylesheet adapts around the ${band.name} range (${band.representativeWidths.join(', ')}px-class devices). Add a query so the layout responds there.`,
        { suggestion: band.maxPx && band.name === 'mobile'
          ? `@media (max-width: ${band.maxPx}px) {\n  /* ${band.name}: ${band.representativeWidths.join('/')}px */\n}`
          : `@media (min-width: ${band.minPx}px) {\n  /* ${band.name}: ${band.representativeWidths.join('/')}px */\n}` });
    }
  }

  // container-query opportunity.
  if (containerQueries === 0) {
    const widthOnClass = allRules.filter((r) => /\bwidth\s*:/.test(r.decls) && r.selector.includes('.')).length;
    if (widthOnClass >= 3 && breakpoints.length > 0) {
      add('container-query', 'info', 'Components could use container queries',
        `${widthOnClass} class rules set a fixed \`width\` and the project already uses \`@media\`. For reusable components, \`@container\` adapts to the parent's size instead of the viewport — more robust in varied layouts.`,
        { suggestion: '.card-wrap { container-type: inline-size; }\n@container (min-width: 360px) {\n  .card { /* wide-parent layout */ }\n}' });
    }
  }

  // modern-CSS fallback / lightningcss.
  const usedModern = new Set<string>();
  for (const r of allRules) for (const f of MODERN_FEATURES) if (f.re.test(r.decls)) usedModern.add(f.label);
  if (usedModern.size > 0 && !tooling.lightningcss && !tooling.postcss && !tooling.autoprefixer) {
    add('fallback', 'medium', 'Modern CSS used without a transform/prefix tool',
      `The stylesheet uses ${[...usedModern].slice(0, 4).join(', ')}${usedModern.size > 4 ? '…' : ''} but no lightningcss / postcss / autoprefixer is in the dependencies. Older browsers get no fallback. Add lightningcss (fast, Rust-based) to your bundler to down-level + prefix automatically.`,
      { suggestion: '// vite.config — lightningcss is built into Vite:\ncss: { transformer: \'lightningcss\', lightningcss: { targets: browserslistToTargets(browserslist(\'>= 0.25%\')) } }' });
  } else if (usedModern.size > 0 && tooling.lightningcss) {
    add('fallback', 'info', 'lightningcss present — good',
      `Modern CSS (${[...usedModern].slice(0, 3).join(', ')}) is in use and lightningcss is available to down-level + prefix it. Make sure your bundler is actually configured to use it (\`css.transformer: 'lightningcss'\` in Vite) and that \`targets\` matches your browserslist.`);
  }

  // paradigm consistency.
  if (paradigms.length >= 3) {
    add('paradigm', 'low', `Multiple styling paradigms in use (${paradigms.length})`,
      `Detected: ${paradigms.join(', ')}. Mixing approaches is fine deliberately, but unintentional mixes fragment the styling story and make overrides unpredictable. Consider standardizing on one primary approach.`);
  }

  return {
    sheets,
    ruleCount: allRules.length,
    classCount: classDefs.size,
    importantCount,
    containerQueries,
    breakpoints,
    devices,
    paradigms,
    tooling,
    findings,
  };
}

/* ───────────────────────── sub-detectors ───────────────────────── */

function detectParadigms(
  sources: CssSource[], rules: Rule[], ctx: CssAuditContext, tooling: { tailwind: boolean; sass: boolean },
): string[] {
  const out = new Set<string>();
  if (tooling.tailwind) out.add('Tailwind');
  if (tooling.sass || sources.some((s) => s.origin === 'scss' || s.origin === 'sass')) out.add('Sass');
  if (sources.some((s) => s.origin === 'less')) out.add('Less');
  if (sources.some((s) => /\.module\.css$/i.test(s.path))) out.add('CSS Modules');
  if (sources.some((s) => s.origin === 'sfc-style')) out.add('SFC scoped styles');
  const cssInJs = ['styled-components', '@emotion/react', '@emotion/styled', '@stitches/react', '@vanilla-extract/css'];
  if (cssInJs.some((d) => ctx.deps.has(d))) out.add('CSS-in-JS');
  if (ctx.deps.has('bootstrap') || rules.some((r) => /\.(col|row|btn)-[a-z0-9]/.test(r.selector))) out.add('Bootstrap');
  // BEM heuristic: a meaningful share of classes look like block__el--mod.
  const classes = rules.flatMap((r) => classesIn(r.selector));
  const bem = classes.filter((c) => /__|--/.test(c)).length;
  if (bem >= 5 && bem / Math.max(1, classes.length) > 0.15) out.add('BEM');
  if (rules.length > 0 && out.size === 0) out.add('Plain CSS');
  return [...out];
}

function normalizeDecls(decls: string): string {
  return decls.replace(/\s+/g, ' ').replace(/\s*([:;{}])\s*/g, '$1').trim();
}

function classCasing(classes: string[]): { kebab: number; camel: number } {
  let kebab = 0, camel = 0;
  for (const c of classes) {
    if (c.includes('-') && !/[A-Z]/.test(c)) kebab++;
    else if (/[a-z][A-Z]/.test(c)) camel++;
  }
  return { kebab, camel };
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/* ───────────────────────── source extraction ───────────────────────── */

/** Pull `<style>…</style>` blocks out of an HTML / Vue / Svelte / Astro file. */
export function extractStyleBlocks(text: string): string {
  const out: string[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? '');
  return out.join('\n');
}

/** Classify a path's CSS origin, or null if it isn't a stylesheet source. */
export function cssOrigin(path: string, ext: string): CssSource['origin'] | null {
  const e = ext.toLowerCase();
  if (e === '.css') return 'css';
  if (e === '.scss') return 'scss';
  if (e === '.sass') return 'sass';
  if (e === '.less') return 'less';
  if (e === '.html' || e === '.htm') return 'html-style';
  if (e === '.vue' || e === '.svelte' || e === '.astro') return 'sfc-style';
  return null;
}

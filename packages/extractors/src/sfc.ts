/**
 * @factstack/extractors/sfc — the `<script>` blocks of Vue and Svelte
 * single-file components, sliced out so the JS/TS extractors can read them.
 *
 * Same idea as the Astro frontmatter helper: the template references
 * components by their imported names, so capturing the script's imports is
 * what puts the component's edges in the graph. Without this, every edge
 * that STARTS in a .vue/.svelte file was missing (Vue, Nuxt, Svelte and
 * SvelteKit apps lost most of their graph).
 *
 * Handles Vue `<script>` + `<script setup>` and Svelte's instance +
 * module (`context="module"` / `module`) scripts; `lang="ts"` selects the
 * TypeScript parser. A `<script src="…">` has no inline code and is skipped,
 * as is a block whose `type` is not JavaScript (JSON-LD, templates).
 */

export interface SfcScript {
  /** The block body, ready for parseJS with `ext`. */
  source: string;
  /** Zero-based line where the body starts (the line of the tag's `>`):
   *  body line N (1-based, as Babel reports it) is original line
   *  `lineOffset + N` — as for Astro's frontmatter. */
  lineOffset: number;
  /** Parser extension picked from the `lang` attribute. */
  ext: '.js' | '.jsx' | '.ts' | '.tsx';
}

const SFC_EXTS = new Set(['.vue', '.svelte']);

export function isSfc(ext: string): boolean {
  return SFC_EXTS.has(ext.toLowerCase());
}

/* Attributes may quote a `>` (`generic="T extends Record<string, X>"`). */
const SCRIPT_RE = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;

const TYPE_ATTR = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
/* A `type` that still means script code. Anything else — JSON-LD in
   <svelte:head>, `text/x-template`, import maps — is data, not JS. */
const JS_TYPE = /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma|type)script|text\/babel)$/i;

export function extractSfcScripts(source: string): SfcScript[] {
  const out: SfcScript[] = [];
  for (const m of source.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? '';
    if (/(^|\s)src\s*=/i.test(attrs)) continue;
    const type = TYPE_ATTR.exec(attrs);
    if (type && !JS_TYPE.test((type[1] ?? type[2] ?? type[3] ?? '').trim())) continue;
    const lang = /\blang\s*=\s*["']?(tsx|ts|typescript|jsx)\b/i.exec(attrs)?.[1]?.toLowerCase();
    const ext = lang === 'tsx' ? '.tsx' : lang === 'jsx' ? '.jsx' : lang ? '.ts' : '.js';
    // The body starts right after the tag's `>` (the tag may span lines).
    const bodyStart = (m.index ?? 0) + '<script'.length + attrs.length + 1;
    const lineOffset = source.slice(0, bodyStart).split('\n').length - 1;
    out.push({ source: m[2] ?? '', lineOffset, ext });
  }
  return out;
}

/**
 * @factstack/extractors/astro — preprocess .astro files so the
 * existing JS/TS extractor pipeline can analyze their frontmatter.
 *
 * Astro file shape:
 *   ┌── frontmatter (TypeScript, optional) ──┐
 *   ---
 *   import Foo from './Foo.astro';
 *   const { title } = Astro.props;
 *   ---
 *   ┌── template (JSX-flavored markup) ──────┐
 *   <html><Foo title={title} /></html>
 *
 * For dependency analysis we only need the frontmatter. The template
 * references components by their imported name; once the import is
 * captured the graph edge is correct. We don't try to parse the
 * template — that would require Astro's own compiler.
 *
 * History: pre-v0.4.6 the analyzer walked .astro files but had no
 * extractor for them, so all 86 .astro files in RallyPro contributed
 * zero edges. The Sugiyama diagram + Flow swimlanes were near-empty
 * as a result. This helper unlocks Astro projects with ~30 lines.
 */

import { parseJS, type ParsedFile } from './parse.js';

/**
 * Astro frontmatter delimiter. Spec says exactly three hyphens on a
 * line by themselves; in practice authors sometimes have trailing
 * whitespace. We match `^---\s*$` (anchored, optional trailing space).
 *
 * The opening fence must be on the very first content line. Astro
 * doesn't allow a shebang or BOM before frontmatter (unlike Markdown);
 * we still strip a UTF-8 BOM if present, since editors sometimes add it.
 */
const FRONTMATTER_FENCE = /^---[ \t]*$/m;

export interface AstroFrontmatter {
  /** The frontmatter source as a TS string, ready for parseJS('.ts'). */
  source: string;
  /** Zero-based line offset of the frontmatter's first line in the
   *  original file. Used to translate line numbers back to source
   *  locations downstream (env-var detection, symbol-refs). */
  lineOffset: number;
}

/**
 * Extract the frontmatter block from an .astro source.
 *
 * Returns null when:
 *   - The file has no frontmatter at all (pure-template astro file,
 *     allowed by Astro spec).
 *   - The opening fence isn't on the first content line (whatever
 *     follows isn't frontmatter — could be HTML or markdown).
 *   - The closing fence is missing (malformed file; we'd rather
 *     return null than parse the whole template as TS).
 */
export function extractAstroFrontmatter(source: string): AstroFrontmatter | null {
  /* Strip a UTF-8 BOM if present (rare but happens with Windows
     editors). Doing it on the original string keeps the line offset
     accurate — BOMs don't introduce a newline. */
  const trimmed = source.charCodeAt(0) === 0xFEFF ? source.slice(1) : source;

  const lines = trimmed.split(/\r\n|\n|\r/);
  if (lines.length === 0) return null;

  /* The opening fence must be the very first content line. Allow
     blank lines BEFORE it? The Astro spec is strict — no leading
     whitespace before `---`. But blank lines? Astro itself allows
     them in practice; the official parser treats them as ignorable.
     We mirror that: scan past blank lines until we find a non-blank,
     and that must be the fence. */
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? '';
    if (ln.trim() === '') continue;
    if (/^---[ \t]*$/.test(ln)) {
      openIdx = i;
    }
    break;
  }
  if (openIdx < 0) return null;

  /* Find the closing fence. Must be after the opening, on its own line. */
  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return null;

  /* Slice the frontmatter body (exclusive of both fences) and return
     it as a TS source. lineOffset points at the FIRST frontmatter
     line, not the fence — so a line-number reported by Babel maps
     directly to the original-file line via `lineOffset + reportedLine`. */
  const body = lines.slice(openIdx + 1, closeIdx).join('\n');
  return { source: body, lineOffset: openIdx + 1 };
}

/**
 * Convenience: extract + parse in one call. Returns a `ParsedFile`
 * tagged as `.ts` so downstream consumers (imports, symbols, env-vars)
 * treat it like any TS module.
 *
 * Returns null when there's no frontmatter (caller treats this as
 * "no imports" — same as a binary file).
 */
export function parseAstro(source: string): ParsedFile | null {
  const fm = extractAstroFrontmatter(source);
  if (!fm) return null;
  /* Parse as TypeScript. Astro frontmatter is always TS (Astro doesn't
     have a plain-JS mode for it — even if the rest of the project is
     .js, the frontmatter accepts TS syntax). The synthesized `.ts`
     ext steers parseJS toward the typescript Babel plugin. */
  return parseJS(fm.source, '.ts');
}

/**
 * True when the extension is one we have a frontmatter extractor for.
 * Mirrors the shape of @factstack/extractors's `isParseable` so callers
 * can do `isParseable(ext) || isAstro(ext)`. We deliberately don't
 * fold this into `isParseable` because `parseJS` doesn't know how to
 * handle the .astro wrapper — only `parseAstro` does.
 */
export function isAstro(ext: string): boolean {
  return ext.toLowerCase() === '.astro';
}

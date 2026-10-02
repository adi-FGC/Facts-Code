/**
 * What would break in an HTML page served under the site's strict CSP
 * (`style-src 'self'`, `script-src 'self' 'sha256-…'`, no third-party
 * origins). Returns human-readable problems; empty = the page renders as
 * written. Pure (text in, list out) so check-bundle-size.mjs and the repo-root
 * test suite share it.
 *
 * `allowBootScript` admits ONE inline executable script — index.html's
 * hash-pinned theme boot, whose hash check-bundle-size verifies separately.
 * `<script type="application/json">` is data, never executed, so it is fine.
 */
const FETCHING_LINK_RELS = /\b(?:stylesheet|preload|modulepreload|prefetch|icon|manifest)\b/i;

export function strictPageProblems(html, { allowBootScript = false } = {}) {
  const problems = [];
  const text = html.replace(/<!--[\s\S]*?-->/g, '');
  let inlineScripts = 0;
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    const src = attrs.match(/\bsrc\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (src) {
      if (/^(?:https?:)?\/\//i.test(src)) problems.push(`loads a third-party script (${src}).`);
      continue;
    }
    if (/\btype\s*=\s*["']?application\/(?:ld\+)?json\b/i.test(attrs)) continue;
    if (m[2].trim()) inlineScripts++;
  }
  if (inlineScripts > (allowBootScript ? 1 : 0))
    problems.push(
      `has ${inlineScripts} inline <script> block(s) — the CSP runs none but the hash-pinned boot script.`,
    );
  // Everything below scans markup only: script bodies (the baked dataset) are data.
  const markup = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '<script></script>');
  const styles = (markup.match(/<style\b/gi) ?? []).length;
  if (styles)
    problems.push(`has ${styles} inline <style> block(s) — style-src 'self' blocks them.`);
  const styleAttrs = (markup.match(/<[a-z][^>]*\sstyle\s*=/gi) ?? []).length;
  if (styleAttrs)
    problems.push(`has ${styleAttrs} style= attribute(s) — style-src 'self' blocks them.`);
  const handlers = (markup.match(/<[a-z][^>]*\son[a-z]+\s*=/gi) ?? []).length;
  if (handlers)
    problems.push(`has ${handlers} inline on*= event handler(s) — the CSP blocks them.`);
  for (const m of markup.matchAll(/<link\b([^>]*)>/gi)) {
    const rel = m[1].match(/\brel\s*=\s*["']?([^"'>]+)/i)?.[1] ?? '';
    const href = m[1].match(/\bhref\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? '';
    if (FETCHING_LINK_RELS.test(rel) && /^(?:https?:)?\/\//i.test(href))
      problems.push(`fetches a third-party resource (<link rel="${rel}" href="${href}">).`);
  }
  for (const m of markup.matchAll(
    /<(?:img|iframe|source|video|audio)\b[^>]*\ssrc\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi,
  ))
    problems.push(`embeds a third-party resource (${m[1]}).`);
  return problems;
}

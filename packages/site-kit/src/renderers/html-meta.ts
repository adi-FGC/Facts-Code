/**
 * HTML `<meta>` / `<link>` fragment for `index.html`'s `<head>`.
 *
 * Unlike the file renderers, this returns a STRING spliced into the
 * existing HTML at the `<!-- FACTSTACK_META_SLOT -->` needle by the
 * build script — so it emits only `<meta>` / `<link>` tags, NEVER a
 * `<script>` (which would break the CSP inline-script hash guard).
 *
 * Escapes attribute values so a description with a `"` can't break out
 * of the attribute.
 */

import type { SiteRegistry } from '@factstack/registry';

/** Escape a value destined for a double-quoted HTML attribute. */
function attr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Return the `<meta>` + `<link>` fragment (no wrapping element, no
 * trailing newline discipline beyond `\n`-joined lines). The caller
 * splices it into `<head>` in place of the placeholder comment.
 */
export function renderMetaFragment(reg: SiteRegistry): string {
  const title = `${reg.product.name} — Fun AI Coding Tools`;
  const desc = reg.product.description;
  const canonical = reg.hosts.cloudflare;
  const lines = [
    `<meta name="description" content="${attr(desc)}" />`,
    `<link rel="canonical" href="${attr(canonical)}" />`,
    `<meta property="og:title" content="${attr(title)}" />`,
    `<meta property="og:description" content="${attr(desc)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${attr(canonical)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
    `<link rel="alternate" type="text/plain" href="/llms.txt" />`,
  ];
  return lines.join('\n    ');
}

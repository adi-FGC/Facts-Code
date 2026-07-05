/**
 * `sitemap.xml` renderer — one `<url>` per web route, `<loc>` anchored on
 * the canonical Cloudflare host. Deterministic ordering (route order) so
 * the drift guard can byte-compare.
 */

import type { SiteRegistry } from '@factstack/registry';
import type { SiteRenderer } from '../types.js';

/** Minimal XML-text escape for the handful of chars that matter inside a
 *  `<loc>`. Routes are static ASCII paths today, but escaping keeps the
 *  output well-formed if a path ever carries `&` / `<`. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const sitemapRenderer: SiteRenderer = {
  id: 'sitemap',
  render(reg: SiteRegistry): Record<string, string> {
    const base = reg.hosts.cloudflare;
    const urls = reg.routes
      .map((r) => {
        const loc = xmlEscape(`${base}${r.path === '/' ? '/' : r.path}`);
        return `  <url><loc>${loc}</loc></url>`;
      })
      .join('\n');
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls +
      '\n</urlset>\n';
    return { 'sitemap.xml': xml };
  },
};

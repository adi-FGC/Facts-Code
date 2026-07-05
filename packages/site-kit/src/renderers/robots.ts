/**
 * `robots.txt` renderer — allow-all for a public demo, plus a `Sitemap:`
 * line pointing at the generated sitemap on the canonical host.
 */

import type { SiteRegistry } from '@factstack/registry';
import type { SiteRenderer } from '../types.js';

export const robotsRenderer: SiteRenderer = {
  id: 'robots',
  render(reg: SiteRegistry): Record<string, string> {
    const body = ['User-agent: *', 'Allow: /', `Sitemap: ${reg.hosts.cloudflare}/sitemap.xml`, ''].join('\n');
    return { 'robots.txt': body };
  },
};

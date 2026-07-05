/**
 * `site.webmanifest` renderer — the PWA web app manifest. Referenced from
 * `index.html` via `<link rel="manifest" href="/site.webmanifest">` (added
 * by the html-meta fragment). Points at the standalone `/icon.svg`.
 */

import type { SiteRegistry } from '@factstack/registry';
import type { SiteRenderer } from '../types.js';

export const manifestRenderer: SiteRenderer = {
  id: 'manifest',
  render(reg: SiteRegistry): Record<string, string> {
    const manifest = {
      name: reg.product.name,
      short_name: reg.product.name,
      description: reg.product.description,
      start_url: '/',
      display: 'standalone',
      theme_color: '#0f0f0f',
      background_color: '#0f0f0f',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    };
    return { 'site.webmanifest': JSON.stringify(manifest, null, 2) + '\n' };
  },
};

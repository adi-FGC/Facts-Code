/**
 * @factstack/site-kit — public surface.
 *
 * Two entry points consumers reach for:
 *   - `buildSiteArtifactsTo(writer, reg, ids?)` — render + write every
 *     discoverability file (llms.txt, .well-known/mcp.json, sitemap.xml,
 *     robots.txt, site.webmanifest, .well-known/security.txt).
 *   - `renderMetaFragment(reg)` — the HTML `<meta>`/`<link>` fragment to
 *     splice into `index.html`'s `<head>` (NOT a standalone file, so it's
 *     not part of the orchestrator registry).
 *
 * Renderers + types are re-exported for direct composition + tests.
 */

export * from './types.js';
export * from './orchestrator.js';
export { renderMetaFragment } from './renderers/html-meta.js';

/* Direct renderer access — uncommon but useful for tests + one-off
 * composition. */
export { llmsTxtRenderer } from './renderers/llms-txt.js';
export { mcpManifestRenderer } from './renderers/mcp-manifest.js';
export { sitemapRenderer } from './renderers/sitemap.js';
export { robotsRenderer } from './renderers/robots.js';
export { manifestRenderer } from './renderers/manifest.js';
export { securityTxtRenderer } from './renderers/security-txt.js';

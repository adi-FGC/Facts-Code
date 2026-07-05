#!/usr/bin/env node
/**
 * Generate the LLM/agent discoverability artifacts into dist/ after
 * `vite build`, and splice the SEO/social <meta> fragment into
 * dist/index.html.
 *
 * Single source of truth: everything here derives from
 * `buildSiteRegistry()` (which reads the MCP tool catalog, resource
 * catalog, and route catalog from @factstack/spec). That's the whole
 * point — the README can no longer claim "5 tools" while the server ships
 * 17, because the tool list is GENERATED from the catalog the server
 * itself renders ListTools from.
 *
 * Emits into dist/:
 *   llms.txt, llms-full.txt          (llmstxt.org convention)
 *   .well-known/mcp.json             (MCP launch manifest)
 *   sitemap.xml, robots.txt          (crawlers)
 *   site.webmanifest                 (PWA)
 *   .well-known/security.txt         (RFC 9116)
 * and rewrites dist/index.html's <!-- FACTSTACK_META_SLOT --> with the
 * <meta>/<link> fragment (NO <script> — the CSP inline-script hash guard
 * pins only the theme-init IIFE).
 *
 * Ordering: runs AFTER `vite build` (needs dist/index.html to exist) and
 * BEFORE `scripts/inject-data.mjs` (which bakes the dataset into the same
 * index.html) — see package.json build:static. Both scripts anchor on a
 * distinct needle so their order is independent.
 *
 * Usage:
 *   node scripts/generate-discovery.mjs          # auto (root package.json version)
 *   node scripts/generate-discovery.mjs --root ../..
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const DEFAULT_REPO_ROOT = resolve(APP_DIR, '..', '..');

const META_NEEDLE = '<!-- FACTSTACK_META_SLOT -->';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REPO_ROOT = resolve(arg('--root', DEFAULT_REPO_ROOT));
const DIST = resolve(APP_DIR, 'dist');
const distHtml = join(DIST, 'index.html');

/* Resolve the product version: prefer the repo-root package.json (the
   published product version), fall back to the app's own. Matches the
   .facts → fixture priority spirit of inject-data.mjs. */
function readVersion() {
  for (const p of [join(REPO_ROOT, 'package.json'), join(APP_DIR, 'package.json')]) {
    try {
      const v = JSON.parse(readFileSync(p, 'utf8')).version;
      if (typeof v === 'string' && v.length > 0) return v;
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0';
}

/* Dynamic-import the registry builder + site-kit renderers + the Node
   FileWriter — the same shape inject-data.mjs uses to reach @factstack/emit.
   Keeping them dynamic means a missing workspace link fails loudly here,
   not at module-eval before the friendly error handling below. */
const { buildSiteRegistry } = await import('@factstack/registry');
const { buildSiteArtifactsTo, renderMetaFragment } = await import('@factstack/site-kit');
const { NodeFileWriter } = await import('@factstack/emit');

const version = readVersion();
const reg = buildSiteRegistry({ version, generatedAt: new Date().toISOString() });

/* Write every artifact into dist/. Passing subdir='' scopes the writer to
   dist/ itself (not dist/.facts/); it auto-mkdirp's parents, so
   `.well-known/mcp.json` creates dist/.well-known/ on the fly. */
const writer = new NodeFileWriter(DIST, '');
const result = await buildSiteArtifactsTo(writer, reg);
console.log(`[generate-discovery] wrote ${Object.keys(result.files).length} artifacts into dist/ (${(result.bytesWritten / 1024).toFixed(1)} KB)`);
for (const p of Object.keys(result.files).sort()) console.log(`  + ${p}`);

/* Splice the <meta> fragment into dist/index.html at the placeholder
   comment. Anchored replace (like inject-data.mjs) so a re-run is a no-op
   and we never target a stray needle inside baked content. */
let html;
try {
  html = readFileSync(distHtml, 'utf8');
} catch (e) {
  console.error(`[generate-discovery] dist/index.html missing — run \`vite build\` first.`);
  console.error('  Underlying error:', e?.message || e);
  process.exit(1);
}

if (!html.includes(META_NEEDLE)) {
  /* Either already injected (re-run) or the placeholder was removed from
     index.html. A missing needle on a fresh build is a real regression, so
     warn rather than silently skip — but don't fail the build, since the
     artifacts above are the load-bearing output. */
  console.log(`[generate-discovery] meta slot "${META_NEEDLE}" not found in dist/index.html — skipping meta injection (already injected or placeholder removed).`);
} else {
  const fragment = renderMetaFragment(reg);
  const next = html.replace(META_NEEDLE, () => fragment);
  writeFileSync(distHtml, next, 'utf8');
  console.log(`[generate-discovery] injected ${fragment.length} B of <meta>/<link> tags into dist/index.html`);
}

console.log(`[generate-discovery] version ${version} · ${reg.mcp.tools.length} MCP tools · ${reg.routes.length} routes`);

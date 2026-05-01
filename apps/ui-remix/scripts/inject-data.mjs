#!/usr/bin/env node
/**
 * Bake the project dataset into dist/index.html for static deploys.
 *
 * After `vite build`, dist/index.html still contains the placeholder
 *   <script id="factstack-data" type="application/json">__INLINE_FACTSTACK_JSON__</script>
 * Reading from `/data/factstack.json` works in dev (Vite proxies to
 * `factstack ui` on :4848) but a pure static deploy (Netlify, VS Code
 * webview, exported HTML) has no such endpoint. So we substitute the
 * placeholder with real JSON at build time.
 *
 * Source of truth: legacy/prototype/data/factstack.json. That file is
 * a stable demo dataset of FACTS analyzing itself, baked when commits
 * land. The new app reuses it until we wire `factstack export` to emit
 * a fresh blob into the Remix app's dist/.
 *
 * Why a separate script instead of a Vite plugin: keeps Vite's build
 * cacheable and idempotent. The substitution is a single file edit
 * post-build, easy to reason about, easy to remove when CLI export
 * generates dist/data/factstack.json directly.
 *
 * Usage:
 *   node scripts/inject-data.mjs                 # uses default source
 *   node scripts/inject-data.mjs --src path.json # custom source
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');

const PLACEHOLDER = '__INLINE_FACTSTACK_JSON__';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const srcPath = arg('--src', resolve(REPO_ROOT, 'legacy', 'prototype', 'data', 'factstack.json'));
const distHtml = resolve(APP_DIR, 'dist', 'index.html');

let raw;
try {
  raw = readFileSync(srcPath, 'utf8');
} catch (e) {
  console.error(`[inject-data] could not read dataset at ${srcPath}`);
  console.error('  did you run `vite build` first? do you have legacy/prototype/data/factstack.json?');
  console.error('  Underlying error:', e?.message || e);
  process.exit(1);
}

let dataset;
try {
  dataset = JSON.parse(raw);
} catch (e) {
  console.error(`[inject-data] dataset at ${srcPath} is not valid JSON:`, e?.message);
  process.exit(1);
}

let html;
try {
  html = readFileSync(distHtml, 'utf8');
} catch (e) {
  console.error(`[inject-data] dist/index.html missing — run \`vite build\` first.`);
  console.error('  Underlying error:', e?.message || e);
  process.exit(1);
}

if (!html.includes(PLACEHOLDER)) {
  // Idempotency: if the placeholder is already gone, the build is
  // already baked. Don't fail; just exit cleanly so re-runs are safe.
  console.log(`[inject-data] placeholder already replaced — skipping (build already baked).`);
  process.exit(0);
}

const replacement = JSON.stringify(dataset);
const next = html.replace(PLACEHOLDER, replacement);
writeFileSync(distHtml, next, 'utf8');

const sizeKb = (Buffer.byteLength(replacement) / 1024).toFixed(1);
console.log(`[inject-data] baked ${sizeKb} KB of dataset into dist/index.html`);
console.log(`  source : ${srcPath}`);
console.log(`  project: ${dataset?.project?.name ?? '(unknown)'}`);
console.log(`  files  : ${dataset?.stats?.files ?? '?'}`);

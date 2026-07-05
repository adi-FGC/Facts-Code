#!/usr/bin/env node
/**
 * Generate dist/mcp-auth-config.json from the repo-root fb.mjs (gitignored), so
 * the PUBLIC Firebase web config reaches the MCP sign-in page + the MCP server
 * WITHOUT being committed to this (public) repo. The config is public by design
 * — it ships to browsers on the deployed auth page — but keeping it out of git
 * avoids handing it out in the source tree.
 *
 * Warn-and-skip when fb.mjs is absent (a clone / CI build): only the owner's
 * deploy build has fb.mjs, and clones/CI use the already-deployed site's config.
 * fb.mjs is the raw Firebase console snippet (an un-exported `const`), so we
 * extract the fields by text-match rather than importing it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fbPath = resolve(here, '../../../fb.mjs'); // apps/ui-remix/scripts -> repo root
const outPath = resolve(here, '../dist/mcp-auth-config.json');

if (!existsSync(fbPath)) {
  console.warn(
    '[gen-fb-config] fb.mjs not found at repo root — skipping mcp-auth-config.json. ' +
      'The sign-in page will have no config until built where fb.mjs exists (owner deploy build).',
  );
  process.exit(0);
}

const text = readFileSync(fbPath, 'utf8');
const KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'];
const cfg = {};
for (const k of KEYS) {
  const m = text.match(new RegExp(k + "\\s*:\\s*['\"]([^'\"]+)['\"]"));
  if (m) cfg[k] = m[1];
}
if (!cfg.apiKey || !cfg.projectId) {
  console.error('[gen-fb-config] fb.mjs did not yield apiKey + projectId — aborting build.');
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(cfg));
console.log(`[gen-fb-config] wrote dist/mcp-auth-config.json (${Object.keys(cfg).length} fields, projectId=${cfg.projectId}).`);

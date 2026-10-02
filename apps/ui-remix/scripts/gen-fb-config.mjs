#!/usr/bin/env node
/**
 * Generate dist/mcp-auth-config.json — the PUBLIC Firebase web config the MCP
 * sign-in page (public/mcp-auth.js) and the MCP server's optional cloud sync
 * read. The config is public by design (it ships to every browser that opens
 * the sign-in page), but it is kept out of this public repo's source tree.
 *
 * Sources, first hit wins:
 *   1. <checkout>/fb.mjs — the raw Firebase console snippet (gitignored).
 *   2. <main checkout>/fb.mjs — found via `git rev-parse --git-common-dir`, so
 *      a build from a linked worktree (how the owner deploys) finds the one
 *      copy in the main checkout. Before this, every worktree and CI build
 *      shipped a site without the file and the sign-in page broke.
 *   3. FACTS_FB_WEB_CONFIG — the same config as JSON in the environment. CI
 *      (the weekly cve-refresh publish) gets it from a repository Variable.
 *
 * None found: a LOUD warning (plus a ::warning:: annotation on GitHub Actions)
 * and exit 0, so dev and CI builds still build the rest of the site. Every
 * build that publishes passes `--require`, which makes it exit 1: a deploy
 * without the file replaces the live one and breaks sign-in.
 *
 * fb.mjs is the raw console snippet (an un-exported `const`), so its fields are
 * extracted by text-match rather than importing it.
 *
 * Usage: node scripts/gen-fb-config.mjs [--require] [--root <checkout>] [--out <file>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

/** The fields a Firebase web app config carries; anything else is dropped. */
export const FB_KEYS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
  'measurementId',
];

const usable = (cfg) => Boolean(cfg && cfg.apiKey && cfg.projectId);

/** Fields from the raw Firebase console snippet (`const firebaseConfig = {…}`). */
export function parseFbSnippet(text) {
  const cfg = {};
  for (const k of FB_KEYS) {
    const m = text.match(new RegExp(k + '\\s*:\\s*[\'"]([^\'"]+)[\'"]'));
    if (m) cfg[k] = m[1];
  }
  return cfg;
}

/** Fields from FACTS_FB_WEB_CONFIG (JSON). Throws on malformed JSON. */
export function parseFbEnv(json) {
  const raw = JSON.parse(json);
  const cfg = {};
  for (const k of FB_KEYS) if (typeof raw?.[k] === 'string' && raw[k]) cfg[k] = raw[k];
  return cfg;
}

/** The main checkout of the repo `root` belongs to, or null (not a git checkout). */
export function mainCheckoutOf(root) {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return common ? dirname(common) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the config. `{ cfg, source }` on a hit, else `{ cfg: null, tried,
 * problems }` — `problems` names sources that exist but are unusable (a fb.mjs
 * without apiKey/projectId, malformed JSON), so the warning says why.
 */
export function findFbConfig({ root, env = process.env, mainCheckout = mainCheckoutOf(root) }) {
  const tried = [];
  const problems = [];
  const files = [resolve(root, 'fb.mjs')];
  if (mainCheckout && resolve(mainCheckout) !== resolve(root))
    files.push(resolve(mainCheckout, 'fb.mjs'));
  for (const file of files) {
    tried.push(file);
    if (!existsSync(file)) continue;
    const cfg = parseFbSnippet(readFileSync(file, 'utf8'));
    if (usable(cfg)) return { cfg, source: file };
    problems.push(`${file} did not yield apiKey + projectId`);
  }
  tried.push('$FACTS_FB_WEB_CONFIG');
  const json = env.FACTS_FB_WEB_CONFIG;
  if (json && json.trim()) {
    try {
      const cfg = parseFbEnv(json);
      if (usable(cfg)) return { cfg, source: 'FACTS_FB_WEB_CONFIG' };
      problems.push('FACTS_FB_WEB_CONFIG has no apiKey + projectId');
    } catch (e) {
      problems.push(`FACTS_FB_WEB_CONFIG is not valid JSON (${e?.message || e})`);
    }
  }
  return { cfg: null, tried, problems };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(arg('--root', resolve(here, '../../..'))); // scripts -> checkout root
  const outPath = resolve(arg('--out', resolve(here, '../dist/mcp-auth-config.json')));
  const required = process.argv.includes('--require');

  const found = findFbConfig({ root });
  if (!found.cfg) {
    const lines = [
      'No Firebase web config found: dist/mcp-auth-config.json NOT written.',
      'A site deployed from this build has a BROKEN MCP sign-in page (/mcp-auth).',
      'Every local MCP tool still works; only the optional cloud sync needs it.',
      `Tried: ${found.tried.join(', ')}`,
      ...found.problems.map((p) => `Problem: ${p}`),
      'Fix: put fb.mjs in the main checkout, or set FACTS_FB_WEB_CONFIG to the',
      'config JSON (a repository Variable in CI).',
    ];
    const bar = '!'.repeat(78);
    console.warn(['', bar, ...lines.map((l) => `!! [gen-fb-config] ${l}`), bar, ''].join('\n'));
    if (process.env.GITHUB_ACTIONS)
      console.warn(`::warning title=MCP sign-in config missing::${lines.slice(0, 3).join(' ')}`);
    if (required) console.error('[gen-fb-config] --require: refusing to continue a deploy build.');
    process.exit(required ? 1 : 0);
  }
  writeFileSync(outPath, JSON.stringify(found.cfg));
  const from = found.source === 'FACTS_FB_WEB_CONFIG' ? found.source : 'fb.mjs';
  console.log(
    `[gen-fb-config] wrote mcp-auth-config.json from ${from} ` +
      `(${Object.keys(found.cfg).length} fields, projectId=${found.cfg.projectId}).`,
  );
}

/* Run only as a script (tsx/node), not when imported by the test suite. */
if (isMain(import.meta.url)) main();

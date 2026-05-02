#!/usr/bin/env node
/**
 * Bake the project dataset into dist/index.html for static deploys.
 *
 * After `vite build`, dist/index.html still contains the placeholder
 *   <script id="factstack-data" type="application/json">__INLINE_FACTSTACK_JSON__</script>
 *
 * Reading from `/data/factstack.json` works in dev (Vite proxies to
 * `factstack ui` on :4848) but a pure static deploy (Netlify, VS Code
 * webview, exported HTML) has no such endpoint. So we substitute the
 * placeholder with real JSON at build time.
 *
 * v0.3.11: source priority changed.
 *   1. `--src <path>` — explicit override (legacy behavior preserved)
 *   2. `<repoRoot>/.facts/agent.json` + `<repoRoot>/.facts/human.json`
 *      → adapted via `humanToViz()` from @factstack/emit so the
 *      dashboard renders YOUR project, not the pinned fixture
 *   3. `<repoRoot>/legacy/prototype/data/factstack.json` — last-resort
 *      fallback so a fresh-clone build still produces a renderable
 *      static site
 *
 * `humanToViz()` is the same canonical adapter the CLI's
 * `factstack ui` server uses to serve `/data/factstack.json`. Sharing
 * it here means dev mode (CLI proxy) and static-deploy mode (this
 * script) produce identical wire output.
 *
 * Usage:
 *   node scripts/inject-data.mjs                 # auto-detect (.facts → fixture)
 *   node scripts/inject-data.mjs --src path.json # explicit override
 *   node scripts/inject-data.mjs --root ../..    # custom repo root
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const DEFAULT_REPO_ROOT = resolve(APP_DIR, '..', '..');

const PLACEHOLDER = '__INLINE_FACTSTACK_JSON__';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const REPO_ROOT = resolve(arg('--root', DEFAULT_REPO_ROOT));
const explicitSrc = arg('--src', null);
const distHtml = resolve(APP_DIR, 'dist', 'index.html');

/* Resolve the dataset source. Priority order documented above. */
let dataset;
let sourceLabel;

if (explicitSrc) {
  const srcPath = resolve(explicitSrc);
  sourceLabel = srcPath;
  dataset = JSON.parse(readFileSync(srcPath, 'utf8'));
} else {
  const factsAgent = join(REPO_ROOT, '.facts', 'agent.json');
  const factsHuman = join(REPO_ROOT, '.facts', 'human.json');
  if (existsSync(factsAgent) && existsSync(factsHuman)) {
    sourceLabel = `.facts/{agent,human}.json (adapted)`;
    /* Dynamic-import humanToViz — the canonical adapter the CLI's
       `factstack ui` server already uses for /data/factstack.json.
       Sharing it here means static-deploy + CLI dev produce
       byte-identical wire output. */
    const { humanToViz } = await import('@factstack/emit');
    const agent = JSON.parse(readFileSync(factsAgent, 'utf8'));
    const human = JSON.parse(readFileSync(factsHuman, 'utf8'));
    dataset = humanToViz(agent, human);
    /* Snapshots: load the history series from .facts/snapshots/ if
       present so the History tab renders. Each snapshot file is
       date-stamped + holds {at, stats, risks, broken, stale, ...}.
       VizArtifact has an optional history field that the CLI's UI
       endpoint also populates this way. */
    const history = loadSnapshots(join(REPO_ROOT, '.facts', 'snapshots'));
    if (history.length > 0) dataset.history = history;
  } else {
    /* Last-resort fallback for fresh clones with no `.facts/` yet. */
    const fallback = join(REPO_ROOT, 'legacy', 'prototype', 'data', 'factstack.json');
    if (!existsSync(fallback)) {
      console.error(`[inject-data] no dataset source found.`);
      console.error(`  Tried: ${factsAgent}`);
      console.error(`         ${factsHuman}`);
      console.error(`         ${fallback}`);
      console.error(`  Run \`factstack analyze .\` from the repo root to populate .facts/.`);
      process.exit(1);
    }
    sourceLabel = fallback + ' (fallback fixture)';
    dataset = JSON.parse(readFileSync(fallback, 'utf8'));
  }
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
  console.log(`[inject-data] placeholder already replaced — skipping (build already baked).`);
  process.exit(0);
}

const replacement = JSON.stringify(dataset);
const next = html.replace(PLACEHOLDER, replacement);
writeFileSync(distHtml, next, 'utf8');

const sizeKb = (Buffer.byteLength(replacement) / 1024).toFixed(1);
console.log(`[inject-data] baked ${sizeKb} KB of dataset into dist/index.html`);
console.log(`  source : ${sourceLabel}`);
console.log(`  project: ${dataset?.project?.name ?? '(unknown)'}`);
console.log(`  files  : ${dataset?.stats?.files ?? '?'}`);

/* ─────────────────────────────────────────────────────────────────
 * Snapshot loader — feeds the History tab's sparkline.
 * ─────────────────────────────────────────────────────────────── */
function loadSnapshots(snapDir) {
  if (!existsSync(snapDir)) return [];
  try {
    const files = readdirSync(snapDir).filter((n) => n.endsWith('.json')).sort();
    const out = [];
    for (const name of files) {
      try {
        const body = JSON.parse(readFileSync(join(snapDir, name), 'utf8'));
        out.push({
          at: body.at,
          loc: body.stats?.loc ?? 0,
          tokens: body.stats?.totalTokenCost ?? 0,
          files: body.stats?.fileCount ?? 0,
          risks: body.risks ?? 0,
          todos: body.todos ?? 0,
        });
      } catch { /* skip malformed snapshot files */ }
    }
    return out;
  } catch {
    return [];
  }
}

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
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubSharedText, shareableDataset } from '@factstack/spec';

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

/* Privacy scrub — adversarial-review findings #8 (contributor PII) and
   #31 (absolute local paths / sibling-repo leak), plus v0.3.11's git topology
   (every checkout's absolute path, every local agent prompt). One shared
   implementation (@factstack/spec shareableDataset), also used by
   `factstack export`, applied to the in-memory dataset so EVERY public sink
   (the inline bake AND dist/data/factstack.json) ships redacted. `textSubs`
   carries the same substitutions to the pack, which is scrubbed as text. */
const shared = shareableDataset(dataset, REPO_ROOT);
dataset = shared.data;
const textSubs = shared.textSubs;

/* Lean the inline dataset for the static bake. HTML docs are full
   generated pages (their own <svg>, <style>, <script>); baking their raw
   content bloats index.html ~6x AND the Docs tab iframes them via
   `srcdoc`, which surfaces the page's own SVG attributes in the parent
   console. Drop HTML raw content here — the Docs tab still lists every
   doc with its parsed structure (headings, todos, diagrams), and HTML
   bodies fall back to the UI's "content omitted" note. Markdown/text
   bodies stay inline so they preview normally. */
if (dataset && Array.isArray(dataset.docs)) {
  let stripped = 0;
  for (const d of dataset.docs) {
    if (d && d.format === 'html' && d.content != null) {
      d.content = null;
      stripped++;
    }
  }
  if (stripped > 0)
    console.log(
      `[inject-data] dropped raw content from ${stripped} HTML doc(s) to keep the static dataset lean`,
    );
}

/* ─────────────────────────────────────────────────────────────────
 * Additive static fallbacks (v0.12 discoverability):
 *   1. dist/data/factstack.json — the same dataset as a fetchable file,
 *      so an agent (or a debugging human) can GET the JSON directly
 *      instead of scraping it out of the inline <script>. The inline bake
 *      below is UNCHANGED — this is a parallel copy, not a migration.
 *   2. dist/factstack.pack — the token-compressed agent.pack, copied from
 *      <repoRoot>/.facts/agent.pack when present, so agents can pull the
 *      cheap pack over HTTP from the deployed site.
 * ─────────────────────────────────────────────────────────────── */
try {
  const dataDir = resolve(APP_DIR, 'dist', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'factstack.json'), JSON.stringify(dataset), 'utf8');
  console.log(`[inject-data] wrote dist/data/factstack.json (fetchable dataset fallback)`);
} catch (e) {
  /* Non-fatal — the inline bake below is the primary path; the fetchable
     copy is a convenience. Don't fail the build over it. */
  console.warn(`[inject-data] could not write dist/data/factstack.json: ${e?.message || e}`);
}

/* Small, chatbot-fetchable digest (~KB). A plain browsing model can GET this
   whole file and reason over it — the full dataset is ~2 MB / ~500k tokens and
   overflows most chat context windows. Derived from the SAME scrubbed dataset,
   so no PII/paths leak. Heavy per-risk fields (preview/messageTechnical) dropped. */
try {
  const s = dataset || {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const digest = {
    $schema: 'https://factstack.dev/schema/summary.v1.json',
    generatedAt: s.generatedAt,
    project: s.project,
    oneLiner: s.summary?.oneLiner,
    description: s.summary?.description,
    capabilities: s.summary?.capabilities,
    health: s.summary?.health,
    stats: s.stats,
    counts: {
      files: s.stats?.files,
      edges: arr(s.edges).length,
      cycles: arr(s.cycles).length,
      routes: arr(s.routes).length,
      risks: arr(s.risks).length,
      vulnerabilities: arr(s.vulnerabilities).length,
      docs: arr(s.docs).length,
      dependencyManifests: arr(s.dependencyManifests).length,
    },
    entryPoints: s.entryPoints,
    risks: arr(s.risks).map((r) => ({
      severity: r.severity,
      category: r.category,
      rule: r.rule,
      file: r.file,
      line: r.line,
      message: r.message,
    })),
    vulnerabilities: s.vulnerabilities,
    fullDataset: '/data/factstack.json',
    pack: '/factstack.pack',
  };
  writeFileSync(
    resolve(APP_DIR, 'dist', 'data', 'summary.json'),
    JSON.stringify(digest, null, 2),
    'utf8',
  );
  console.log(`[inject-data] wrote dist/data/summary.json (compact chatbot digest)`);
} catch (e) {
  console.warn(`[inject-data] could not write dist/data/summary.json: ${e?.message || e}`);
}

try {
  const packSrc = join(REPO_ROOT, '.facts', 'agent.pack');
  if (existsSync(packSrc)) {
    /* The pack is a separate file (not derived from `dataset`), so it needs
       its own text-level scrub — otherwise /factstack.pack would re-leak the
       same email + paths the JSON scrub just removed. */
    const packText = scrubPack(readFileSync(packSrc, 'utf8'), textSubs);
    writeFileSync(resolve(APP_DIR, 'dist', 'factstack.pack'), packText, 'utf8');
    console.log(`[inject-data] wrote scrubbed .facts/agent.pack → dist/factstack.pack`);
  } else {
    console.log(`[inject-data] no .facts/agent.pack to copy (skipping dist/factstack.pack)`);
  }
} catch (e) {
  console.warn(`[inject-data] could not write dist/factstack.pack: ${e?.message || e}`);
}

let html;
try {
  html = readFileSync(distHtml, 'utf8');
} catch (e) {
  console.error(`[inject-data] dist/index.html missing — run \`vite build\` first.`);
  console.error('  Underlying error:', e?.message || e);
  process.exit(1);
}

/* Anchor on the placeholder AS THE SCRIPT TAG'S TEXT CONTENT (>…<), not a
   bare substring. The baked dataset can itself *contain* the placeholder
   string — a project doc (apps/ui-remix/test/e2e/README.md) documents this
   very pipeline. A bare `html.includes(PLACEHOLDER)` would then (a) misfire
   this "already baked" guard on a re-run and (b) make `replace()` target the
   placeholder buried inside the JSON instead of the real tag, corrupting the
   bake. The `>…<` delimiters only match the real, empty-content script tag. */
const NEEDLE = `>${PLACEHOLDER}<`;
if (!html.includes(NEEDLE)) {
  console.log(`[inject-data] placeholder already replaced — skipping (build already baked).`);
  process.exit(0);
}

/* Exactly one anchor, or stop. `replace()` takes the FIRST match, so a second
   copy of the needle earlier in the document — an HTML comment that spells the
   placeholder between its delimiters, say — silently swallows the dataset and
   ships a page whose real script tag is still the bare token. That failure
   looks like a successful build: the "baked N KB" line prints, the file grows
   by the right amount, and the app quietly falls back to fetching
   /data/factstack.json (which a static host may not even serve). Caught here
   because it shipped once. */
const anchors = html.split(NEEDLE).length - 1;
if (anchors !== 1) {
  console.error(
    `[inject-data] found ${anchors} copies of the dataset placeholder in dist/index.html; expected exactly 1.\n` +
      `  The dataset is injected at the FIRST one, so the real <script id="factstack-data"> would be left un-baked.\n` +
      `  Fix: keep one placeholder, and never write it between '>' and '<' anywhere else in index.html (comments included).`,
  );
  process.exit(1);
}

/* Escape `<` so a literal `</script>` inside any baked string value (a doc
   body, source snippet, TODO text, …) cannot terminate the inline
   `<script type="application/json">` element early and spill the rest of the
   JSON into the document. `<` is valid JSON and parses back to `<`, so
   JSON.parse in loadArtifacts is unaffected. Without this, any analyzed
   project whose markdown/source contains `</script>` produces a broken
   static export. */
const replacement = JSON.stringify(dataset).replace(/</g, '\\u003c');
/* Function replacer: a plain string replacement interprets `$&`, `$1`, `$$`
   etc. as match backreferences, and the dataset JSON can contain literal `$`
   sequences. A replacer function is inserted verbatim. */
const next = html.replace(NEEDLE, () => `>${replacement}<`);
writeFileSync(distHtml, next, 'utf8');

const sizeKb = (Buffer.byteLength(replacement) / 1024).toFixed(1);
console.log(`[inject-data] baked ${sizeKb} KB of dataset into dist/index.html`);
console.log(`  source : ${sourceLabel}`);
console.log(`  project: ${dataset?.project?.name ?? '(unknown)'}`);
console.log(`  files  : ${dataset?.stats?.files ?? '?'}`);

/**
 * Text-level scrub for `dist/factstack.pack`, which is a separate file the
 * JSON scrub never sees. Applies the dataset scrub's own substitutions
 * (checkout paths, root, parent, emails), drops the `features` rows carrying
 * agent prompts and
 * the interned worktree paths, then RE-MINTS the `; end` trailer — the pack's
 * sha256 covers every preceding byte, so any scrub (including the pre-existing
 * email/path substitution) left the published pack failing its own integrity
 * check, which tells a reader to discard it.
 */
function scrubPack(raw, subs) {
  let text = scrubSharedText(raw, subs);
  const kept = [];
  let table = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('& ')) {
      table = line.slice(2).split('\t')[0];
      kept.push(line);
      continue;
    }
    if (/^; end rows=\d+ tables=\d+ sha256=[0-9a-f]{12}$/.test(line)) continue; // re-minted below
    if (table === 'features' && /^[-+] /.test(line)) {
      const cells = line.slice(2).split('\t');
      if (cells[2] === 'request') continue; // an agent session prompt — never public
    }
    kept.push(line);
  }
  let body = kept.join('\n').replace(/\n+$/, '') + '\n';
  const rows = body.split('\n').filter((l) => /^[-+x] /.test(l)).length;
  const tables = body.split('\n').filter((l) => l.startsWith('& ')).length;
  /* The HEADER carries rowCount too (field 4) and a strict decoder rejects a
     pack whose header and trailer disagree — dropping rows without re-minting
     it published a pack that fails its own validation. */
  const nlIx = body.indexOf('\n');
  const head = body.slice(0, nlIx).split('\t');
  if (head[0] && head[0].startsWith('# ') && head.length > 3) {
    head[3] = String(rows);
    body = head.join('\t') + body.slice(nlIx);
  }
  const sha = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
  return `${body}; end rows=${rows} tables=${tables} sha256=${sha}\n`;
}

/* ─────────────────────────────────────────────────────────────────
 * Snapshot loader — feeds the History tab's sparkline.
 * ─────────────────────────────────────────────────────────────── */
function loadSnapshots(snapDir) {
  if (!existsSync(snapDir)) return [];
  try {
    const files = readdirSync(snapDir)
      .filter((n) => n.endsWith('.json'))
      .sort();
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
      } catch {
        /* skip malformed snapshot files */
      }
    }
    return out;
  } catch {
    return [];
  }
}

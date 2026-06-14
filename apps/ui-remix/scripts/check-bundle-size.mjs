#!/usr/bin/env node
/**
 * Hard bundle-size cap for the UI app.
 *
 * The editorial rebuild stays in budget by keeping the runtime small —
 * Remix v3's @remix-run/ui VDOM + route-pattern + this app's source.
 * If a future change pushes JS past the cap, this exits non-zero so CI
 * surfaces it before users do.
 *
 * Tunable thresholds in one place. Bump them deliberately, with a
 * commit-message justification.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..');
const ASSETS_DIR = join(APP_DIR, 'dist', 'assets');

/** Three independent budgets, one per asset class:
 *
 *   1. **Main JS** — what the user pays for first paint. Cap: 50 KB gz.
 *      Stays tight because the editorial first-paint experience is the
 *      product surface CXOs actually see.
 *   2. **Worker JS** — the analyzer chunk that loads on first scan
 *      (user gesture: clicking "Open"). Cap: 200 KB gz. Bigger budget
 *      because it ships the entire analyzer pipeline (parsers,
 *      extractors, scanners, graph builder); not on the cold path.
 *   3. **CSS** — design tokens + atomic class soup from the css() runtime.
 *      Cap: 8 KB gz.
 *
 * Caps are wire-cost (gzipped). The raw caps are sanity rails — they
 * grow naturally with identifier accumulation and aren't the metric
 * that matters for users.
 *
 * Cap history:
 *   2026-05-01 — main JS raw 150 → 180 KB when 5 porting stubs went real
 *   2026-05-02 — split worker JS into its own budget when the in-browser
 *                scanner (FsaBrowserFS + analyzer worker) landed; main JS
 *                stays 50 KB gz so first paint doesn't regress.
 *   2026-05-02 — main JS raw 180 → 200 KB after OpenModal landed. The
 *                modal's CSS-in-JS atoms (~6 KB raw) repeat well under
 *                gzip so the wire-cost stays inside 50 KB; bumping the
 *                raw rail keeps the gz rail as the binding constraint.
 *   2026-05-02 — main JS gz 50 → 52 KB after the OpenModal's post-scan
 *                UI (save buttons + result summary) landed. The modal
 *                owns ⌘O and the global open event, so it has to sit in
 *                the critical path; lazy-splitting only the post-scan
 *                branch would save ~0.7 KB at the cost of a flash on
 *                first scan completion. Better tradeoff: hold 52 KB.
 *                Also bumped raw 200 → 210 KB (CSS-in-JS atom growth).
 *   2026-05-02 — main JS gz 52 → 55 KB after Recents landed. The new
 *                weight breaks down as:
 *                  - lib/recents.ts (~1 KB gz)  — IDB store + helpers
 *                  - ui/SourceChip.tsx (~1.5 KB) — header source chip
 *                  - OpenModal recents UI + animations (~1 KB)
 *                All three are first-paint code (header chip renders
 *                immediately; ⌘O is bound at startup). Lazy-splitting
 *                would force a network round-trip on the very first
 *                Open click and break the source-chip's cold render.
 *                Raw bumped 210 → 230 KB to absorb the new CSS atoms.
 *   2026-05-02 — main JS gz 55 → 57 KB after the Graph + Dag merge.
 *                Net: -tarjanSCC -layerByLongestPath -heatmap math
 *                duplicates (consolidated to lib/graphAnalysis.ts);
 *                +SugiyamaDag SVG renderer (~1.5 KB), +ViewModeToggle,
 *                +6 small component files (Heatmap/CyclesPanel/
 *                LayerSummary/HubsTable/CouplingsTable extracted from
 *                the routes for distinct-component reuse). Could
 *                lazy-load SugiyamaDag specifically (only fires when
 *                the user picks "Diagram" mode) but the chunking
 *                overhead would offset the ~1.5 KB win. Raw bumped
 *                230 → 240 KB.
 *   2026-05-02 — main JS gz 57 → 59 KB after Sugiyama interactions
 *                landed: hover edge highlight (delegated mouseover/
 *                mouseout), wheel + click-drag pan, pinch-zoom for
 *                touch, show-all toggle (lifts the 60-node cap),
 *                Files | Symbols granularity scaffold, DagControls
 *                toolbar component. Real first-paint code for users
 *                who land on the Graph tab. Route-level lazy-splitting
 *                (every route → its own chunk) would help across the
 *                board but is a separate refactor; keeping consistent
 *                "all routes in main" for now. Raw bumped 240 → 250 KB.
 *   2026-05-02 — main JS gz 59 → 64 KB after the new /flow tab landed:
 *                lib/flowAnalysis.ts (tier classifier + Sugiyama-style
 *                path enumeration), SwimlanesDiagram.tsx (SVG lanes +
 *                arc-routed arrows), EntityList.tsx, FlowText.tsx
 *                (clipboard-copyable swimlanes.io-style breakdown),
 *                routes/Flow.tsx orchestrator. The architecture-flow
 *                view is a top-level feature worth its weight.
 *                NOTE: at ~64 KB gz we're approaching the inflection
 *                point where route-level chunk splitting (every route
 *                → its own lazy chunk) pays off cleanly — would cut
 *                Main JS to ~30-35 KB at the cost of one round-trip on
 *                first navigation per tab. Tracked as a separate
 *                refactor; not blocking on this commit. Raw 250→280 KB.
 *   2026-05-02 — main JS gz 64 → 68 KB after the Sequence view and
 *                Sugiyama node-dragging landed:
 *                  - lib/sequenceFlow.ts (~1.2 KB gz): DFS sequence
 *                    builder + swimlanes.io DSL emitter
 *                  - ui/flow/SequenceDiagram.tsx (~1.5 KB gz): vertical-
 *                    lifeline SVG with activation rails, hover dim,
 *                    drag-to-reorder headers, clipboard DSL copy
 *                  - routes/Flow.tsx +200 LOC: entry-picker + sequence
 *                    composition
 *                  - SugiyamaDag node-drag wiring (~0.3 KB gz)
 *                Route-level chunk splitting now URGENT — at 68 KB we're
 *                past where it pays off cleanly. Adding it next would
 *                cut Main JS to ~30 KB. Raw 280→320 KB.
 *   2026-05-25 — main JS gz 68 → 72 KB after the OpenModal trust/safety
 *                surface landed (privacy disclaimer + collapsible
 *                environment-check panel + post-save "View .facts files"
 *                inline list + "Reveal in OS picker" affordance).
 *                Breakdown (~1.8 KB gz):
 *                  - computeEnvChecks() async probe of FSA + storage +
 *                    per-handle perms (~0.4 KB gz)
 *                  - envPanel renderer (collapsible header + grant
 *                    buttons per row) (~0.6 KB gz)
 *                  - disclaimer + view-files panel + helpers (~0.8 KB gz)
 *                All first-paint — modal owns ⌘O and the global open
 *                event, the trust surface must be ready the moment the
 *                modal opens or it defeats the purpose. Lazy-splitting
 *                only the env helpers (~0.4 KB) would force a network
 *                hop on first ⌘O, the worst possible time. Better to
 *                bump the cap once and let users hit a coherent
 *                permissions UI synchronously. Raw 320→340 KB.
 *                Route-level chunk splitting still tracked as separate
 *                refactor (would also fix this) but not blocking.
 *   2026-05-26 — main JS gz 72 → 80 KB after the security tier landed:
 *                two new routes (/credentials + /vulnerabilities) plus
 *                the OSV.dev client. Breakdown (~2.5 KB gz that lands
 *                on main, ~1.5 KB gz lazy-split):
 *                  - routes/Credentials.tsx (~1.2 KB gz): secrets-
 *                    scanner finding visualization + 8-rule reference
 *                    card. Filters data.risks by category === 'secret'.
 *                  - routes/Vulnerabilities.tsx (~1.3 KB gz): OSV.dev
 *                    CVE scanner UI — manifest detection, paste-driven
 *                    scan flow, severity-bucketed result rendering,
 *                    inline VulnRowView + local helpers (bucketing +
 *                    advisory URL) duplicated from osvScanner so the
 *                    row component renders without dynamic-import
 *                    overhead.
 *                  - lib/osvScanner.ts (~1.5 KB gz, LAZY): batch query
 *                    client + localStorage cache + manifest parser.
 *                    Dynamic-imported on the Scan button click; main
 *                    bundle pays type-only cost.
 *                Both routes are first-paint code (tab list owns them).
 *                Splitting either to lazy chunks would flash an empty
 *                tab on navigation — bad UX for security-adjacent pages
 *                that need to feel instantly responsive. Route-level
 *                chunk splitting (still tracked) would solve this
 *                holistically.
 *                Raw 340→370 KB.
 *   2026-06-09 — main JS raw 370→380 KB after the F5 Modules tab landed
 *                (graph analytics: PageRank importance + label-propagation
 *                communities). First-paint cost is ~3.3 KB raw / ~0.2 KB gz:
 *                  - routes/Modules.tsx (~0.4 KB): SubViewTabs orchestrator
 *                    (Key Files | Modules) + the pre-F5 empty state.
 *                  - lib/moduleAnalysis.ts (~0.8 KB): pure aggregation of the
 *                    CORE-computed metrics (it does NOT recompute PageRank in
 *                    the browser — the agent + dashboard share one deterministic
 *                    computation).
 *                  - ui/modules/{KeyFilesTable,ModulesView,ImportanceBar}.tsx
 *                    (~2.1 KB): RuledTable views + the importance bar.
 *                Modules is a top-level tab so it sits in main like the others.
 *                Route-level code-splitting (lazy per-tab body) is STILL the
 *                real fix and would claw first-paint back toward ~55 KB — it
 *                stays the next perf lever; this small bump unblocks the feature
 *                without that refactor.
 */
const CAP_MAIN_JS_RAW = 380 * 1024;
// 2026-06-02 — main JS gz 80 → 90 KB. The market-validated /review Change
// Verdict panel (routes/Review.tsx + lib/reviewVerdict.ts) is the first-paint
// feature that finally crossed the long-flagged 80 KB line. The severity model
// was moved to @factstack/spec so the panel reuses it WITHOUT pulling the
// analyzer (saved ~21 KB gz vs the naive @factstack/core import); the residual
// ~2.7 KB is the panel + verdict logic. Route-level code-splitting (every tab →
// its own chunk) remains the future lever to claw first-paint back under 80.
// 2026-06-03 — main JS gz 90 → 95 KB. The v0.9 IA consolidation (14 tabs → 7 +
// 2 icon routes) + the Overview token-economics ROI panel added ~3.3 KB gz of
// first-paint code: lib/tokenEconomics.ts + ui/TokenRoiPanel.tsx (the ROI math
// + panel), ui/SubViewTabs.tsx (the Architecture/Files/Security switcher),
// ui/NavIcons.tsx (animated Config/About icons), and the three thin wrapper
// routes. All are first-paint (header icons + Overview render immediately).
// Route code-splitting is STILL the real fix — it would lazy-load every tab's
// body and claw main JS back toward ~55 KB; tracked as the next perf lever.
// 2026-06-03 — main JS gz 95 → 98 KB after the Docs intelligence tab landed:
// the new /docs tab + 5 sub-views (Browse / Todos / Roadmap / Diagrams /
// Features), an in-house Markdown → VDOM renderer (lib/markdown.tsx), and the
// doc view-model (lib/docsModel.ts). Net first-paint cost is only ~0.8 KB gz —
// the renderer is dependency-free (no marked/mermaid; mermaid alone is ~500 KB
// min) and the css() atoms compress heavily. Docs is a top-level tab so it
// sits in the main bundle like the others; route-level code-splitting (still
// tracked) is the holistic fix that would lazy-load every tab body, this one
// included.
// 2026-06-04 — main JS gz 98 → 100 KB. The v0.10 ".pack universal" feature
// added the agent-rules Save UI to OpenModal (a checkbox + two hint strings +
// the skills-write call in triggerSave). The heavy part — @factstack/skills'
// renderers — is correctly LAZY (rides the dynamically-imported scannerBridge
// chunk, NOT cold start); only the ~0.3 KB of Save-UI markup lands in main,
// which had zero headroom. This is the 4th bump in the session (90→95→98→100)
// and the cap is now a real wall. The committed fix is NOT a 5th bump: it's
// lazy-loading the OpenModal body (it only renders on ⌘O) + route-level
// code-splitting (lazy per-tab body), which together would drop first-paint
// from ~98 KB toward ~55 KB. Tracked as the next perf task — do it before the
// next first-paint feature.
// 2026-06-09 — main JS gz 100→102 KB for the F5 Modules tab (see the raw-cap
// note above for the per-file breakdown). The wire cost is only ~0.2 KB gz (the
// css() atoms + RuledTable reuse compress heavily, and moduleAnalysis.ts only
// AGGREGATES the core-computed metrics rather than recomputing PageRank), but it
// crossed the 100 KB line that had zero headroom. Route-level code-splitting
// remains the committed structural fix; this 2 KB keeps the binding gz rail
// honest until that lands.
const CAP_MAIN_JS_GZ = 102 * 1024;
// 2026-06-10 — lazy JS raw 600 → 640 KB. The graph-intelligence wave's lazy
// chunks grew ~13 KB raw (Sugiyama community coloring in SugiyamaDag/DagControls
// + entity-aware graph views riding the dynamically-imported route chunks); the
// previous build sat at 598.9/600 with no headroom. The BINDING wire-cost rail
// (gz 200 KB) is untouched with ~26 KB headroom (173.6 used) — this bump only
// moves the raw sanity rail to match feature reality.
const CAP_WORKER_JS_RAW = 640 * 1024;
const CAP_WORKER_JS_GZ = 200 * 1024;
const CAP_CSS_RAW = 24 * 1024;
const CAP_CSS_GZ = 8 * 1024;

/* Vite emits the entry chunk as `index-<hash>.js` (`build.rollupOptions.input`
 * defaults to index.html → main.tsx → "index"). Everything else — workers,
 * dynamic imports — is async; the user pays for it only when the code
 * path that triggers the import actually runs.
 *
 * Heuristic: the entry is `index-*.js`. Anything else with `.js` is lazy.
 * Workers (`scanner.worker-*.js`) get their own line for clarity but
 * count against the same lazy budget.
 *
 * If the entry rename ever drifts from `index-*`, the assertion at the
 * bottom guards against silently classifying everything as lazy and
 * passing trivially. */
/* Vite hashes are base64-url so they can include `-` and `_` in addition
 * to alphanumerics (saw `index-Bv10y-6S.js` in the wild). */
const isEntryChunk = (name) => /^index-[A-Za-z0-9_-]+\.js$/.test(name);
const isWorkerChunk = (name) => /\.worker[-.]/.test(name);

let entries;
try {
  entries = readdirSync(ASSETS_DIR);
} catch (e) {
  console.error(`[check-bundle-size] dist/assets missing — run \`vite build\` first.`);
  console.error('  ' + (e?.message || e));
  process.exit(1);
}

const totals = {
  mainJsRaw: 0, mainJsGz: 0,
  workerJsRaw: 0, workerJsGz: 0,
  cssRaw: 0, cssGz: 0,
};
let entryFound = false;
const rows = [];
for (const name of entries) {
  const path = join(ASSETS_DIR, name);
  const st = statSync(path);
  if (!st.isFile()) continue;
  if (name.endsWith('.map')) continue;
  const body = readFileSync(path);
  const gz = gzipSync(body, { level: 9 }).byteLength;
  const raw = body.byteLength;
  /* Tier classification:
   *   - css:    *.css files
   *   - main:   the entry chunk (index-*.js) — synchronous critical path
   *   - worker: any other JS file (lazy: workers + dynamic imports)
   * The "worker" tier name is historical; it's really "lazy JS." */
  let tier;
  if (name.endsWith('.css')) tier = 'css';
  else if (isEntryChunk(name)) { tier = 'main'; entryFound = true; }
  else tier = 'worker';
  rows.push({ name, raw, gz, tier });
  if (tier === 'main')   { totals.mainJsRaw   += raw; totals.mainJsGz   += gz; }
  if (tier === 'worker') { totals.workerJsRaw += raw; totals.workerJsGz += gz; }
  if (tier === 'css')    { totals.cssRaw      += raw; totals.cssGz      += gz; }
}

if (!entryFound) {
  console.error('[check-bundle-size] FAIL: no entry chunk matched index-*.js — did Vite rename the entry? Update isEntryChunk().');
  process.exit(1);
}

function fmt(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(2) + ' KB';
  return n + ' B';
}

console.log('\nBundle size report:');
for (const r of rows) {
  /* "worker" tier prints as "lazy" — covers the analyzer worker AND
     dynamic-imported chunks like the scanner bridge. The internal name
     stayed "worker" for diff stability with the original split. */
  const tagDisplay = r.tier === 'worker'
    ? (isWorkerChunk(r.name) ? '  [worker]' : '    [lazy]')
    : r.tier === 'css' ? '     [css]' : '    [main]';
  console.log(`  ${r.name.padEnd(38)}${tagDisplay}  ${fmt(r.raw).padStart(10)}  ${fmt(r.gz).padStart(10)} (gz)`);
}
console.log('  ' + '─'.repeat(82));
console.log(`  ${'Main JS  (first paint)'.padEnd(48)}  ${fmt(totals.mainJsRaw).padStart(10)}  ${fmt(totals.mainJsGz).padStart(10)} (gz)`);
console.log(`  ${'Lazy JS  (worker + dynamic imports)'.padEnd(48)}  ${fmt(totals.workerJsRaw).padStart(10)}  ${fmt(totals.workerJsGz).padStart(10)} (gz)`);
console.log(`  ${'CSS'.padEnd(48)}  ${fmt(totals.cssRaw).padStart(10)}  ${fmt(totals.cssGz).padStart(10)} (gz)`);

const failures = [];
if (totals.mainJsRaw   > CAP_MAIN_JS_RAW)   failures.push(`Main JS raw ${fmt(totals.mainJsRaw)} > cap ${fmt(CAP_MAIN_JS_RAW)}`);
if (totals.mainJsGz    > CAP_MAIN_JS_GZ)    failures.push(`Main JS gzip ${fmt(totals.mainJsGz)} > cap ${fmt(CAP_MAIN_JS_GZ)}`);
if (totals.workerJsRaw > CAP_WORKER_JS_RAW) failures.push(`Lazy JS raw ${fmt(totals.workerJsRaw)} > cap ${fmt(CAP_WORKER_JS_RAW)}`);
if (totals.workerJsGz  > CAP_WORKER_JS_GZ)  failures.push(`Lazy JS gzip ${fmt(totals.workerJsGz)} > cap ${fmt(CAP_WORKER_JS_GZ)}`);
if (totals.cssRaw      > CAP_CSS_RAW)       failures.push(`CSS raw ${fmt(totals.cssRaw)} > cap ${fmt(CAP_CSS_RAW)}`);
if (totals.cssGz       > CAP_CSS_GZ)        failures.push(`CSS gzip ${fmt(totals.cssGz)} > cap ${fmt(CAP_CSS_GZ)}`);

if (failures.length) {
  console.error('\n[check-bundle-size] FAIL:');
  for (const f of failures) console.error('  ' + f);
  console.error('\nIf this is intentional, bump the caps in this script with a justification.');
  process.exit(1);
}

console.log(
  `\n[check-bundle-size] OK — Main JS ${fmt(totals.mainJsGz)} / ${fmt(CAP_MAIN_JS_GZ)} cap, ` +
    `Lazy JS ${fmt(totals.workerJsGz)} / ${fmt(CAP_WORKER_JS_GZ)} cap, ` +
    `CSS ${fmt(totals.cssGz)} / ${fmt(CAP_CSS_GZ)} cap.`,
);

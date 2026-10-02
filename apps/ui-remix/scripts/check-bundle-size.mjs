#!/usr/bin/env node
/**
 * Post-build report + release guards for the UI app.
 *
 * Despite the filename (kept so the `build` scripts, CI job and docs that
 * reference it keep working), this no longer caps anything. It does two jobs:
 *
 *   1. REPORT the built bundle — per chunk and per tier, raw and gzipped — so
 *      the number is visible on every build. Nothing fails on size.
 *   2. ENFORCE the guards that catch silent breakage: the CSP inline-script
 *      hash, SEC-3 style-src and the scoped /mcp-auth policy in both the
 *      Cloudflare (`public/_headers`) and Netlify (`netlify.toml`) files
 *      (lib/csp-guard.mjs), the headers each host actually sends per path
 *      (one CSP each, the HTML cache policy on every route, and every header, CSP included,
 *      identical on Cloudflare and Netlify),
 *      strict-CSP-safe HTML pages, the dataset sections served beside
 *      index.html (present, content-addressed, preloaded, immutable),
 *      discovery-kit freshness, and a privacy scan of every public sink (no
 *      home-directory paths, no agent prompts). These exit non-zero.
 *
 * Usage: node scripts/check-bundle-size.mjs [--dist <dir>]   (default dist/)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareHeaderProblems, effectiveHeaders, parseHeadersFile } from './lib/cf-headers.mjs';
import { AUTH_PATHS, bootScriptToken, cspFor, cspPolicyProblems } from './lib/csp-guard.mjs';
import { SECTIONS_DIR, inlineDataset, sectionProblems } from './lib/dataset-sections.mjs';
import { strictPageProblems } from './lib/html-guard.mjs';
import { LEAKS, localRootPatterns } from './lib/privacy-guard.mjs';
import {
  hostParityProblems,
  netlifyHeaderProblems,
  parseNetlifyTomlHeaders,
} from './lib/netlify-headers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..');
/** The repo root the build baked from (inject-data's default --root). */
const APP_DIR_ROOT = resolve(APP_DIR, '..', '..');
const distAt = process.argv.indexOf('--dist');
const DIST =
  distAt > 0 && process.argv[distAt + 1]
    ? resolve(process.argv[distAt + 1])
    : join(APP_DIR, 'dist');
const ASSETS_DIR = join(DIST, 'assets');

/* Size is REPORTED here, never capped.
 *
 * 2026-09-23 — the owner removed the hard bundle-size caps: sizes are worth
 * knowing, but they are not the gate. What matters is that the site is fast
 * and responsive to the user's actions, and that is measured directly (first
 * paint on a throttled connection) rather than proxied by a byte count. The
 * per-chunk raw + gzip report below still prints on every build; nothing in
 * this script fails the build on size any more.
 *
 * Why the proxy was worth dropping: the v0.3.13 load work moved first paint
 * from ~3.4-6.2 s to ~600 ms on slow 4G without changing the bundle at all —
 * the win came from where the bytes sat in the document (the baked dataset was
 * in <head>, blocking asset discovery) and from self-hosting fonts. A cap
 * would not have caught that regression and did not help fix it.
 *
 * Two durable lessons from the era of caps, kept because they are still true
 * and still cheap to honour:
 *   - The dashboard must never import the @factstack/spec BARREL at runtime.
 *     Doing so drags every zod schema into the entry chunk — it cost ~66 KB
 *     raw once, silently, on a dependency bump. Use the zod-free subpaths
 *     (`@factstack/spec/routes`, `@factstack/spec/review-severity`) and pull
 *     types with `import type`.
 *   - Route-level code splitting: done 2026-09-24. Only the landing tab
 *     (Overview) ships in main; every other tab is its own chunk, loaded on
 *     open and prefetched one per idle slot after load (App.tsx). Main went
 *     125.5 -> 59.6 KB gz. Keep new tabs out of main the same way.
 *   - Nothing the first screen doesn't show belongs in index.html: doc bodies
 *     live in dist/data/docs/ and load on demand (inject-data.mjs). The same
 *     2026-09-24 pass took LCP 4.9 s -> 3.0 s on throttled mobile. Moving
 *     the heavy dataset sections out too (performance#5) measured SLOWER while
 *     the loader awaits them before the first render (LCP +0.4 s), so it is
 *     opt-in: inject-data.mjs --split-sections (lib/dataset-sections.mjs).
 *
 * The CSP guards and discovery-kit freshness check further down are NOT
 * budgets — they catch silent breakage (a blocked boot script, a drifted
 * connect-src, a stale tool manifest) — so they stay and still fail the build.
 */

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
  mainJsRaw: 0,
  mainJsGz: 0,
  workerJsRaw: 0,
  workerJsGz: 0,
  cssRaw: 0,
  cssGz: 0,
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
  else if (isEntryChunk(name)) {
    tier = 'main';
    entryFound = true;
  } else tier = 'worker';
  rows.push({ name, raw, gz, tier });
  if (tier === 'main') {
    totals.mainJsRaw += raw;
    totals.mainJsGz += gz;
  }
  if (tier === 'worker') {
    totals.workerJsRaw += raw;
    totals.workerJsGz += gz;
  }
  if (tier === 'css') {
    totals.cssRaw += raw;
    totals.cssGz += gz;
  }
}

if (!entryFound) {
  console.error(
    '[check-bundle-size] FAIL: no entry chunk matched index-*.js — did Vite rename the entry? Update isEntryChunk().',
  );
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
  const tagDisplay =
    r.tier === 'worker'
      ? isWorkerChunk(r.name)
        ? '  [worker]'
        : '    [lazy]'
      : r.tier === 'css'
        ? '     [css]'
        : '    [main]';
  console.log(
    `  ${r.name.padEnd(38)}${tagDisplay}  ${fmt(r.raw).padStart(10)}  ${fmt(r.gz).padStart(10)} (gz)`,
  );
}
console.log('  ' + '─'.repeat(82));
console.log(
  `  ${'Main JS  (first paint)'.padEnd(48)}  ${fmt(totals.mainJsRaw).padStart(10)}  ${fmt(totals.mainJsGz).padStart(10)} (gz)`,
);
console.log(
  `  ${'Lazy JS  (worker + dynamic imports)'.padEnd(48)}  ${fmt(totals.workerJsRaw).padStart(10)}  ${fmt(totals.workerJsGz).padStart(10)} (gz)`,
);
console.log(
  `  ${'CSS'.padEnd(48)}  ${fmt(totals.cssRaw).padStart(10)}  ${fmt(totals.cssGz).padStart(10)} (gz)`,
);

/* First-paint bytes: dist/index.html carries the inline dataset, and nothing
   runs until all of it has parsed (660 KB raw / ~100 KB br on 2026-09-24).
   Sections an --split-sections build preloads are reported on their own
   line: the app awaits them before its first render too, and they need a
   round trip of their own (why the split is opt-in). Reported
   brotli-compressed, as Cloudflare serves them. FACTS_WARN_FIRST_PAINT_KB
   sets an optional warn line for index.html — still report-only, never a
   failure (the owner removed size caps 2026-09-23). */
try {
  const br = (buf) =>
    brotliCompressSync(buf, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength;
  const html = readFileSync(join(DIST, 'index.html'));
  const firstPaintBr = br(html);
  console.log(
    `  ${'index.html (first-paint bytes, incl. inline data)'.padEnd(48)}  ${fmt(html.byteLength).padStart(10)}  ${fmt(firstPaintBr).padStart(10)} (br)`,
  );
  const sectionUrls = Object.values(inlineDataset(html.toString('utf8'))?.sectionUrls ?? {});
  const sectionBufs = sectionUrls
    .map((u) => join(DIST, ...String(u).split('/').filter(Boolean)))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f));
  if (sectionBufs.length > 0) {
    const raw = sectionBufs.reduce((n, b) => n + b.byteLength, 0);
    const brSum = sectionBufs.reduce((n, b) => n + br(b), 0);
    console.log(
      `  ${`dataset sections (${sectionBufs.length} preloaded)`.padEnd(48)}  ${fmt(raw).padStart(10)}  ${fmt(brSum).padStart(10)} (br)`,
    );
  }
  const warnKb = Number(process.env.FACTS_WARN_FIRST_PAINT_KB);
  if (warnKb > 0 && firstPaintBr > warnKb * 1024) {
    const msg = `index.html is ${fmt(firstPaintBr)} br — over the ${warnKb} KB first-paint warn line (report-only).`;
    console.warn(
      process.env.GITHUB_ACTIONS ? `::warning title=First-paint bytes::${msg}` : `  WARN ${msg}`,
    );
  }
} catch {
  /* no index.html — the CSP guard below reports it */
}

/* No size entries are ever pushed here — see the note at the top of the file.
   `failures` collects only correctness problems (CSP drift, a blocked boot
   script, a stale discovery manifest, a privacy leak) from the guards below. */
const failures = [];

/* ── CSP guard ─────────────────────────────────────────────────────────────
 * public/_headers (Cloudflare) and netlify.toml (Netlify) pin the ONE inline
 * boot script, the no-flash theme init in index.html, by SHA-256, so it
 * survives a strict `script-src` with no 'unsafe-inline'. If that script
 * changes and the hash isn't updated, the browser SILENTLY blocks it (flash
 * of the wrong theme) and no test catches it. lib/csp-guard.mjs re-derives
 * the hash from the built HTML, keeps 'unsafe-inline' out of the main
 * style-src (SEC-3) and holds every /mcp-auth* block to one scoped policy, in
 * both files. Each file is parsed once, by the same models the header
 * simulation below uses; a non-Netlify checkout (no netlify.toml) checks
 * _headers only. */
try {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const headers = readFileSync(join(DIST, '_headers'), 'utf8');
  let netlifyToml = null;
  try {
    netlifyToml = readFileSync(join(APP_DIR_ROOT, 'netlify.toml'), 'utf8');
  } catch {
    /* no netlify.toml here — nothing to keep in sync */
  }
  const rules = parseHeadersFile(headers);
  const hosts = [{ file: '_headers', rules }];
  if (netlifyToml)
    hosts.push({ file: 'netlify.toml', rules: parseNetlifyTomlHeaders(netlifyToml) });
  const bootToken = bootScriptToken(html);
  if (!bootToken)
    failures.push(
      'CSP guard: no inline boot <script> found in dist/index.html — cannot verify the script-src hash.',
    );
  for (const p of cspPolicyProblems(hosts, { bootToken })) failures.push(`CSP guard: ${p}`);

  // ── What each host actually SENDS ─────────────────────────────────────
  // Comparing blocks is not enough: the block checks passed while /mcp-auth
  // shipped two CSPs (Cloudflare applies every matching rule and appends
  // repeats, so the `/*` policy rode along and blocked the Firebase SDK).
  // Simulate the merge per path: one CSP per page, the right one, and exactly
  // one HTML_CACHE_CONTROL on every route the sitemap lists (the rules
  // generate-discovery appends).
  let routePaths = [];
  try {
    const sitemap = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');
    routePaths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((mm) => new URL(mm[1]).pathname);
  } catch {
    /* a missing sitemap is reported by the discovery-kit guard below */
  }
  const expected = {
    authPaths: AUTH_PATHS,
    authCsp: cspFor(rules, '/mcp-auth'),
    appPaths: ['/', '/index.html', ...routePaths],
    appCsp: cspFor(rules, '/*'),
    routePaths,
  };
  for (const p of cloudflareHeaderProblems(headers, expected))
    failures.push(`header guard (Cloudflare): ${p}`);
  // Dataset sections are content-addressed, so they must be cached as
  // immutable — and only once: `/data/*` matches them too, and without the
  // detach Cloudflare appends its must-revalidate value (performance#5).
  // A synthetic name keeps the rule checked on a build that split nothing.
  const sectionPaths = [
    ...new Set([
      `/${SECTIONS_DIR}/tree.0123456789ab.json`,
      ...Object.values(inlineDataset(html)?.sectionUrls ?? {}).map(String),
    ]),
  ];
  for (const p of sectionPaths) {
    const got = effectiveHeaders(rules, p).get('cache-control') ?? [];
    if (got.length !== 1 || !/\bimmutable\b/.test(got[0]))
      failures.push(
        `header guard (Cloudflare): ${p} receives Cache-Control [${got.join(' | ') || 'none'}] — ` +
          'dataset sections are content-addressed and must get exactly one immutable policy.',
      );
  }
  // Netlify publishes the same dist/_headers, merged UNDER netlify.toml
  // (lib/netlify-headers.mjs). Same expectations, then the two hosts must
  // agree on every header either file sets (CSP included, byte for byte)
  // for the paths people load.
  if (netlifyToml) {
    for (const p of netlifyHeaderProblems(headers, netlifyToml, expected))
      failures.push(`header guard (Netlify): ${p}`);
    const probes = [
      ...new Set([
        ...expected.appPaths,
        ...expected.authPaths,
        ...routePaths.filter((p) => p !== '/').map((p) => `${p}/x`),
        '/assets/index-x.js',
        '/fonts/x.woff2',
        '/data/factstack.json',
        ...sectionPaths,
        '/factstack.pack',
        '/site.webmanifest',
        '/mcp-auth-config.json',
      ]),
    ];
    for (const p of hostParityProblems(headers, netlifyToml, probes))
      failures.push(`header guard (Cloudflare vs Netlify): ${p}`);
  }
} catch (e) {
  failures.push(`CSP guard: could not read built files (${e?.message || e}).`);
}

/* Strict-CSP page guard. Every HTML page the site serves runs under the main
   CSP (style-src 'self', hash-pinned script-src, no third-party origins) —
   except mcp-auth.html, which has its own scoped policy. A page that needs
   inline <style>, style= attributes, inline scripts or a CDN renders broken in
   production (briefing.html shipped that way). Fail the build instead. */
try {
  const htmlFiles = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.name.endsWith('.html') && r !== 'mcp-auth.html') htmlFiles.push(r);
    }
  };
  walk(DIST, '');
  for (const rel of htmlFiles) {
    const page = readFileSync(join(DIST, ...rel.split('/')), 'utf8');
    for (const p of strictPageProblems(page, { allowBootScript: rel === 'index.html' }))
      failures.push(`strict-CSP page guard: dist/${rel} ${p}`);
  }
} catch (e) {
  failures.push(`strict-CSP page guard: could not scan dist/ (${e?.message || e}).`);
}

/* Dataset sections guard (performance#5). The loader awaits every section the
   inline dataset lists before the first render and fails the load on a missing
   or unparsable one, so a listed file that is absent, renamed, not the bytes
   its hash names (it is cached as immutable) or not preloaded is a broken or
   slow site. lib/dataset-sections.mjs holds the contract. */
try {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const readDistFile = (rel) => {
    const f = join(DIST, ...rel.split('/'));
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  };
  for (const p of sectionProblems(html, readDistFile))
    failures.push(`dataset sections guard: ${p}`);
} catch (e) {
  failures.push(`dataset sections guard: could not read dist/index.html (${e?.message || e}).`);
}

/* Discovery-kit freshness (agent-discoverability feature). generate-discovery.mjs
   regenerates these from @factstack/spec on every build, so a missing/empty file
   means the step was skipped or failed — fail closed rather than ship a site that
   silently lost its llms.txt / mcp.json. Also assert the MCP manifest is internally
   consistent (toolCount === toolNames.length). node-safe: readFileSync + JSON only. */
const discoveryArtifacts = [
  'llms.txt',
  'llms-full.txt',
  'robots.txt',
  'sitemap.xml',
  'site.webmanifest',
  '.well-known/mcp.json',
  '.well-known/security.txt',
];
for (const rel of discoveryArtifacts) {
  try {
    const body = readFileSync(join(DIST, ...rel.split('/')), 'utf8');
    if (body.trim().length === 0)
      failures.push(
        `discovery-kit: dist/${rel} is empty — generate-discovery.mjs produced no output.`,
      );
  } catch {
    failures.push(
      `discovery-kit: dist/${rel} is missing — run scripts/generate-discovery.mjs before this guard.`,
    );
  }
}
try {
  const manifest = JSON.parse(readFileSync(join(DIST, '.well-known', 'mcp.json'), 'utf8'));
  const count = manifest?.mcp?.toolCount;
  const names = manifest?.mcp?.toolNames;
  if (!Array.isArray(names) || names.length === 0) {
    failures.push('discovery-kit: .well-known/mcp.json has no toolNames array.');
  } else if (count !== names.length) {
    failures.push(
      `discovery-kit: mcp.json toolCount (${count}) != toolNames.length (${names.length}) — regenerate.`,
    );
  }
} catch (e) {
  failures.push(`discovery-kit: .well-known/mcp.json unreadable/invalid (${e?.message || e}).`);
}

/* Privacy leak guard. inject-data.mjs scrubs every public sink; this proves it
   on the built bytes, so a new field or a new sink that bypasses the scrub
   fails the build instead of publishing a home directory or agent prompts.
   The patterns (home directories in Windows, Git Bash and POSIX spellings;
   this checkout and its parent in every spelling) live in lib/privacy-guard.mjs. */
const localRoots = localRootPatterns([APP_DIR_ROOT, dirname(APP_DIR_ROOT)]);
const publicSinks = ['index.html', 'factstack.pack'];
for (const dir of ['data', 'data/docs', SECTIONS_DIR]) {
  // data/docs/ holds the per-doc bodies and data/sections/ the dataset
  // sections moved out of index.html — public sinks like any other, so the
  // guard proves them too.
  try {
    for (const f of readdirSync(join(DIST, ...dir.split('/')))) {
      if (f.endsWith('.json')) publicSinks.push(`${dir}/${f}`);
    }
  } catch {
    /* directory absent — nothing extra to scan */
  }
}
for (const rel of publicSinks) {
  let body;
  try {
    body = readFileSync(join(DIST, ...rel.split('/')), 'utf8');
  } catch {
    continue; // optional sink (the pack only ships when .facts/agent.pack exists)
  }
  for (const [re, what] of LEAKS) {
    const m = body.match(re);
    if (m)
      failures.push(`privacy guard: dist/${rel} contains ${what} near "${m[0].slice(0, 32)}".`);
  }
  const root = localRoots.find((re) => re.test(body));
  if (root) failures.push(`privacy guard: dist/${rel} contains this checkout's absolute path.`);
  if (rel.endsWith('.pack')) {
    let table = null;
    for (const line of body.split('\n')) {
      if (line.startsWith('& ')) table = line.slice(2).split('\t')[0];
      else if (table === 'features' && /^[-+] /.test(line)) {
        if (line.slice(2).split('\t')[2] === 'request') {
          failures.push(`privacy guard: dist/${rel} still has an agent-prompt features row.`);
          break;
        }
      }
    }
  }
}

if (failures.length) {
  console.error('\n[check-bundle-size] FAIL:');
  for (const f of failures) console.error('  ' + f);
  console.error(
    '\nThese are correctness failures (CSP drift / blocked boot script / stale discovery\n' +
      'manifest / privacy leak), not size budgets — there are no size budgets. Fix the\n' +
      'cause; do not silence the guard.',
  );
  process.exit(1);
}

console.log(
  `\n[check-bundle-size] OK — Main JS ${fmt(totals.mainJsGz)} gz, ` +
    `Lazy JS ${fmt(totals.workerJsGz)} gz, ` +
    `CSS ${fmt(totals.cssGz)} gz (reported, not capped).`,
);

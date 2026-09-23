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
 *      hash, full CSP directive parity between the Cloudflare (`public/_headers`)
 *      and Netlify (`netlify.toml`) policies, the scoped /mcp-auth policy,
 *      discovery-kit freshness, and a privacy scan of every public sink (no
 *      home-directory paths, no agent prompts). These exit non-zero.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..');
/** The repo root the build baked from (inject-data's default --root). */
const APP_DIR_ROOT = resolve(APP_DIR, '..', '..');
const ASSETS_DIR = join(APP_DIR, 'dist', 'assets');

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
 *   - Route-level code splitting (every tab -> its own lazy chunk) is the
 *     structural lever with the most headroom; every route currently ships in
 *     main. Unclaimed, and still the right first move if first paint regresses.
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

/* No size entries are ever pushed here — see the note at the top of the file.
   `failures` collects only correctness problems (CSP drift, a blocked boot
   script, a stale discovery manifest, a privacy leak) from the guards below. */
const failures = [];

/* ── CSP inline-script hash guard ──────────────────────────────────────────
 * The CSP in public/_headers (and netlify.toml) pins the ONE inline boot
 * script — the no-flash theme init in index.html — by SHA-256, so it survives
 * a strict `script-src` with no 'unsafe-inline'. If that script ever changes
 * and the hash isn't updated, the browser SILENTLY blocks it (flash of wrong
 * theme) with no test to catch it. Re-derive the hash from the built HTML and
 * fail the build unless the shipped _headers CSP carries the matching token. */
const DIST = join(APP_DIR, 'dist');
try {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/); // first bare inline script = the theme boot IIFE
  if (!m) {
    failures.push(
      'CSP guard: no inline boot <script> found in dist/index.html — cannot verify the script-src hash.',
    );
  } else {
    const token = `sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}`;
    const headers = readFileSync(join(DIST, '_headers'), 'utf8');
    if (!headers.includes(token)) {
      failures.push(
        `CSP guard: inline boot script drifted — script-src must pin '${token}'. ` +
          `Update the Content-Security-Policy hash in apps/ui-remix/public/_headers AND netlify.toml.`,
      );
    }
    // CSP value extractor — both files describe directives in prose comments too,
    // so isolate the actual policy string before matching directives.
    //   _headers form:     `Content-Security-Policy: <value>` (to EOL)
    //   netlify.toml form: `Content-Security-Policy = "<value>"`
    const cspValue = (s) => {
      const quoted = s.match(/Content-Security-Policy\s*=\s*"([^"]*)"/);
      if (quoted) return quoted[1];
      // Anchor to a real header line (start-of-line, optional indent) so a prose
      // comment that merely mentions `Content-Security-Policy:` can't be mistaken
      // for the policy value.
      const bare = s.match(/^[ \t]*Content-Security-Policy:[ \t]*(.+)$/m);
      return bare ? bare[1] : null;
    };
    const styleSrc = (s) => {
      const csp = cspValue(s);
      if (!csp) return null;
      const mm = csp.match(/style-src ([^;]*)/);
      return mm ? mm[1].trim() : null;
    };
    // SEC-3: style-src must NOT carry 'unsafe-inline'. The css() runtime injects
    // rules via constructable adoptedStyleSheets (CSSOM — CSP-exempt), and every
    // inline style= attribute was converted to a css() class or SVG presentation
    // attribute, so the dashboard renders fully under a strict style-src.
    // Re-adding 'unsafe-inline' would silently undo that hardening — fail here.
    const headersStyle = styleSrc(headers);
    if (headersStyle && headersStyle.includes("'unsafe-inline'")) {
      failures.push(
        "CSP guard: _headers style-src must not contain 'unsafe-inline' (SEC-3) — " +
          'inline styles were eliminated; the css() runtime uses adopted stylesheets.',
      );
    }
    // OPD-1/OPD-4: the Netlify CSP (root netlify.toml) must stay in lockstep
    // with the Cloudflare CSP (_headers). They drifted once — netlify.toml's
    // connect-src omitted the GitHub origins, silently breaking the in-browser
    // GitHub scan on every Netlify deploy. Assert BOTH the script-src hash and
    // the connect-src directive match. Skip silently when netlify.toml is absent
    // (a non-Netlify checkout); only enforce parity when the file exists.
    let netlifyToml = null;
    try {
      netlifyToml = readFileSync(join(APP_DIR, '..', '..', 'netlify.toml'), 'utf8');
    } catch {
      /* no netlify.toml here — nothing to keep in sync */
    }
    if (netlifyToml) {
      if (!netlifyToml.includes(token)) {
        failures.push(
          `CSP guard: netlify.toml script-src must also pin '${token}' (drifted from _headers).`,
        );
      }
      // connect-src + style-src parity reuse the hoisted cspValue extractor.
      const connectSrc = (s) => {
        const csp = cspValue(s);
        if (!csp) return null;
        const mm = csp.match(/connect-src ([^;]*)/);
        return mm ? mm[1].trim().split(/\s+/).sort().join(' ') : null;
      };
      const hc = connectSrc(headers);
      const nc = connectSrc(netlifyToml);
      if (hc && nc && hc !== nc) {
        failures.push(
          `CSP guard: connect-src drift — _headers has [${hc}] but netlify.toml has [${nc}]. Keep the two CSPs in sync.`,
        );
      }
      // SEC-3: style-src must also stay byte-equal across the two hosts (and thus
      // both free of 'unsafe-inline' — netlify can't pass if it diverges from the
      // _headers value already asserted clean above).
      const ns = styleSrc(netlifyToml);
      const norm = (v) => v.trim().split(/\s+/).sort().join(' ');
      if (headersStyle && ns && norm(headersStyle) !== norm(ns)) {
        failures.push(
          `CSP guard: style-src drift — _headers has [${headersStyle}] but netlify.toml has [${ns}]. Keep the two CSPs in sync.`,
        );
      }
      // Review #1: the three checks above cover only script-src / connect-src /
      // style-src. Assert FULL parity so frame-ancestors, object-src, img-src,
      // base-uri, form-action, default-src, font-src, worker-src, manifest-src
      // can never silently drift between the two byte-identical hosts.
      const parseCsp = (s) => {
        const csp = cspValue(s);
        if (!csp) return null;
        const map = {};
        for (const part of csp.split(';')) {
          const toks = part.trim().split(/\s+/).filter(Boolean);
          if (toks.length) map[toks[0]] = toks.slice(1).sort().join(' ');
        }
        return map;
      };
      const hCsp = parseCsp(headers);
      const nCsp = parseCsp(netlifyToml);
      if (hCsp && nCsp) {
        for (const d of new Set([...Object.keys(hCsp), ...Object.keys(nCsp)])) {
          if (hCsp[d] !== nCsp[d]) {
            failures.push(
              `CSP guard: directive '${d}' drift — _headers=[${hCsp[d] ?? '(absent)'}] ` +
                `netlify.toml=[${nCsp[d] ?? '(absent)'}]. Every CSP directive must match across hosts.`,
            );
          }
        }
      }

      // ── Scoped mcp-auth CSP coverage ──────────────────────────────────────
      // Everything above inspects only the FIRST CSP occurrence (the main /* app
      // policy). The MCP Google-sign-in page ships its OWN relaxed CSP, keyed
      // /mcp-auth.html (both hosts) + /mcp-auth (Cloudflare clean-URL only). The
      // comments in _headers/netlify.toml promise those stay byte-equal — so
      // ENFORCE it here; otherwise the scoped policy can silently drift or regain
      // 'unsafe-inline' in script-src with nothing to catch it. Parse every CSP
      // block keyed by its path from each host file (not just the first).
      const headerCsps = (txt) => {
        const map = {};
        let curPath = null;
        for (const line of txt.split(/\r?\n/)) {
          if (/^\/\S/.test(line)) {
            curPath = line.trim();
            continue;
          } // e.g. "/mcp-auth.html"
          const mm = line.match(/^\s+Content-Security-Policy:\s*(.+)$/);
          if (mm && curPath) map[curPath] = mm[1].trim();
        }
        return map;
      };
      const netlifyCsps = (txt) => {
        const map = {};
        for (const blk of txt.split(/\[\[headers\]\]/).slice(1)) {
          const f = blk.match(/for\s*=\s*"([^"]*)"/);
          const c = blk.match(/Content-Security-Policy\s*=\s*"([^"]*)"/);
          if (f && c) map[f[1]] = c[1].trim();
        }
        return map;
      };
      const hMap = headerCsps(headers);
      const nMap = netlifyCsps(netlifyToml);
      // (1) The login flow's /mcp-auth.html scoped CSP must exist on BOTH hosts and match.
      if (!hMap['/mcp-auth.html'])
        failures.push('CSP guard: _headers is missing the /mcp-auth.html scoped CSP block.');
      if (!nMap['/mcp-auth.html'])
        failures.push('CSP guard: netlify.toml is missing the /mcp-auth.html scoped CSP block.');
      if (
        hMap['/mcp-auth.html'] &&
        nMap['/mcp-auth.html'] &&
        hMap['/mcp-auth.html'] !== nMap['/mcp-auth.html']
      ) {
        failures.push(
          'CSP guard: /mcp-auth.html scoped CSP drift between _headers and netlify.toml — keep them byte-equal.',
        );
      }
      // (2) Cloudflare serves the page at the clean URL /mcp-auth (it 308s .html →
      //     there), so _headers MUST key it too or the page falls back to the strict
      //     main CSP and Firebase sign-in breaks. Netlify serves .html verbatim, so
      //     netlify.toml deliberately omits /mcp-auth — not an error.
      if (!hMap['/mcp-auth']) {
        failures.push(
          'CSP guard: _headers is missing the /mcp-auth clean-URL block — Cloudflare 308s /mcp-auth.html there and would fall back to the strict main CSP, breaking Firebase sign-in.',
        );
      }
      // (3) Every scoped block, wherever it appears, must equal the one canonical
      //     scoped policy — no per-key drift, no re-introduced 'unsafe-inline' in script-src.
      const canonicalAuthCsp =
        hMap['/mcp-auth.html'] || nMap['/mcp-auth.html'] || hMap['/mcp-auth'];
      for (const [label, map] of [
        ['_headers', hMap],
        ['netlify.toml', nMap],
      ]) {
        for (const [p, v] of Object.entries(map)) {
          if (p.startsWith('/mcp-auth') && canonicalAuthCsp && v !== canonicalAuthCsp) {
            failures.push(
              `CSP guard: ${label} ${p} scoped CSP differs from the canonical mcp-auth policy — all /mcp-auth* blocks must be byte-equal.`,
            );
          }
        }
      }
    }
  }
} catch (e) {
  failures.push(`CSP guard: could not read built files (${e?.message || e}).`);
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
   fails the build instead of publishing a home directory or agent prompts. */
const LEAKS = [
  [/[A-Za-z]:[\\/]+Users[\\/]+[^\\/"<\s]+/i, 'a Windows home-directory path'],
  // Case-SENSITIVE on purpose: macOS homes are `/Users/`, and a lowercase
  // `/users/<name>/` is usually a URL (api.github.com/users/octocat/…).
  [/\/(?:home|Users)\/[A-Za-z0-9._-]+\//, 'a POSIX home-directory path'],
  [/"requests":\[\{/, 'agent session prompts (git.worktrees[].requests)'],
  [/"source":"request"/, 'a request-derived feature (an agent prompt)'],
];
/* The checkout this build ran in, and its parent, in every spelling a sink
   could carry — any separator run (`/`, `\\`, JSON- or pack-escaped
   `\\\\`), any case. The home-directory patterns above cannot see a repo that
   lives outside a home dir (D:/dev/… on the maintainer's machine), so match the
   actual paths too, the same way @factstack/spec's scrub does. */
const localRoots = [APP_DIR_ROOT, dirname(APP_DIR_ROOT)]
  .map((p) => p.split(/[\\/]+/).filter(Boolean))
  .filter((segs) => segs.length >= 2)
  .map(
    (segs) =>
      new RegExp(
        segs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+') +
          '(?![A-Za-z0-9_-])',
        'i',
      ),
  );
const publicSinks = ['index.html', 'factstack.pack'];
try {
  for (const f of readdirSync(join(DIST, 'data'))) {
    if (f.endsWith('.json')) publicSinks.push(`data/${f}`);
  }
} catch {
  /* no dist/data — nothing extra to scan */
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

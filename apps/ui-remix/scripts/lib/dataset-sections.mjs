/**
 * performance#5 — the heavy dataset sections a static build serves BESIDE
 * index.html instead of inside its inline <script id="factstack-data">.
 *
 * On 2026-09-24 the inline bake was ~700 KB, and 94% of it was four sections
 * (tree ~41%, docs metadata ~29%, edges ~15%, nodeMetrics ~8%). A module
 * script runs only after the whole document has parsed, so all of it held back
 * app start, and the one blob was re-downloaded whenever anything in it
 * changed. A split build ships each of those sections as its own JSON file,
 * preloaded from <head>; the inline dataset keeps a `sectionUrls` map and
 * apps/ui-remix/src/lib/loadArtifacts.ts (hydrateSections) fetches every
 * listed section before the first render.
 *
 * OPT-IN (`inject-data.mjs --split-sections`). Measured 2026-09-24 on this
 * repo's own bake under perf-report's throttling, it made first load SLOWER
 * (median LCP 2628 → 3056 ms over HTTP/2): because that loader awaits the
 * sections, the data needs a second round trip the inline bake avoids. It
 * pays off only once the first render stops waiting for these sections.
 *
 * Content-addressed (`/data/sections/<name>.<sha256-12>.json`) on purpose:
 * a visitor can still be running an OLD index.html right after a redeploy
 * (a tab left open, a back/forward-cache restore). A fixed name (edges.json)
 * would pair that page with the NEW deploy's sections — a tree and a graph
 * from two different analyses. With the hash in the name the old page asks
 * for its own files: from the browser cache (they are immutable — the
 * /data/sections/* rules in public/_headers and netlify.toml), or it misses
 * and the loader stops with its reload hint. Never mixed data.
 *
 * HAZARD (latent while the split is off): a miss is NOT a 404 on either host.
 * The SPA fallback (`/* /index.html 200` in public/_redirects and
 * netlify.toml) answers with index.html, under this path's immutable
 * Cache-Control, so the browser keeps that HTML as the section for a year.
 * After a routine rollback to the deploy that does ship the file, every
 * normal load still fails to parse it until a hard reload. Before the default
 * flips, the loader must re-fetch a failed or non-JSON section once with
 * `{ cache: 'reload' }` (which overwrites the bad entry);
 * test/dataset-sections.test.mjs fails a default-on split until it does.
 *
 * Text in, data out (plus a hash). Shared by inject-data.mjs (writes the
 * files), check-bundle-size.mjs (verifies a build) and the repo-root tests.
 */
import { createHash } from 'node:crypto';

/** The sections moved out, largest first. Must stay a subset of the loader's
 *  DATASET_SECTIONS — a section it does not hydrate would simply be missing
 *  (test/dataset-sections.test.mjs reads loadArtifacts.ts to pin that). */
export const SPLIT_SECTIONS = ['tree', 'docs', 'edges', 'nodeMetrics'];

/** Below this many JSON chars a section stays inline: a tiny project's
 *  `edges: []` is not worth a request. */
export const MIN_SPLIT_CHARS = 4096;

/** dist-relative folder and URL prefix of the section files. */
export const SECTIONS_DIR = 'data/sections';

/** The URLs the loader accepts (mirror of loadArtifacts.ts SECTION_URL):
 *  root-relative, under /data/, `.json`, no `..` segment. */
export const SECTION_URL = /^\/data\/(?:[\w-]+\/)*[\w.-]+\.json$/;

export const isSectionUrl = (u) =>
  typeof u === 'string' && SECTION_URL.test(u) && !u.split('/').includes('..');

/** `<key>.<first 12 hex of sha256(body)>.json` — the name changes whenever
 *  the bytes do, which is what makes the immutable cache rule safe. */
export function sectionFileName(key, body) {
  return `${key}.${createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)}.json`;
}

/**
 * Split `dataset` for a static bake. Returns the dataset to inline (a shallow
 * copy without the moved keys, plus `sectionUrls`) and the files to write,
 * `{ key, name, url, body }`. `dataset` itself is not modified. A
 * `sectionUrls` the source already carried is dropped: only this build's
 * files exist in this dist.
 */
export function splitSections(dataset, { keys = SPLIT_SECTIONS, minChars = MIN_SPLIT_CHARS } = {}) {
  if (!dataset || typeof dataset !== 'object') return { inline: dataset, files: [] };
  const inline = { ...dataset };
  delete inline.sectionUrls;
  const files = [];
  for (const key of keys) {
    if (inline[key] === undefined) continue;
    const body = JSON.stringify(inline[key]);
    if (body.length < minChars) continue;
    const name = sectionFileName(key, body);
    files.push({ key, name, url: `/${SECTIONS_DIR}/${name}`, body });
    delete inline[key];
  }
  if (files.length) inline.sectionUrls = Object.fromEntries(files.map((f) => [f.key, f.url]));
  return { inline, files };
}

/** One `<link rel=preload as=fetch crossorigin>` per section. `crossorigin`
 *  (anonymous) matches the loader's default same-origin fetch, so the browser
 *  reuses the preloaded response instead of fetching twice. */
export function preloadLinks(files) {
  return files
    .map((f) => `<link rel="preload" href="${f.url}" as="fetch" crossorigin />`)
    .join('\n    ');
}

/** `html` with the preload links inserted just before `</head>`. `ok` is
 *  false when there is no `</head>` (the page still works: the loader fetches
 *  the sections itself, only later) — check-bundle-size fails such a build. */
export function withPreloads(html, files) {
  if (!files.length) return { html, ok: true };
  const at = html.search(/<\/head\s*>/i);
  if (at < 0) return { html, ok: false };
  return { html: `${html.slice(0, at)}  ${preloadLinks(files)}\n  ${html.slice(at)}`, ok: true };
}

const INLINE_OPEN = /<script id="factstack-data" type="application\/json">/;

/** The inline dataset baked into a built index.html, or null. */
export function inlineDataset(html) {
  const m = INLINE_OPEN.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
}

/**
 * What would break when a built page loads its sections. `readFile(rel)`
 * returns a dist-relative file's text, or null when it does not exist.
 * Empty = every listed section is a section the loader hydrates, at a URL it
 * accepts, absent inline, present in dist under its content hash, valid JSON,
 * and preloaded from <head>.
 */
export function sectionProblems(html, readFile) {
  const data = inlineDataset(html);
  const urls = data?.sectionUrls;
  if (!urls || typeof urls !== 'object') return [];
  const head = html.slice(0, Math.max(0, html.search(/<\/head\s*>/i)));
  const problems = [];
  for (const [key, url] of Object.entries(urls)) {
    if (!SPLIT_SECTIONS.includes(key)) {
      problems.push(`sectionUrls lists "${key}", which the loader never hydrates.`);
      continue;
    }
    if (!isSectionUrl(url)) {
      problems.push(
        `the ${key} section is listed at ${JSON.stringify(url)} — the loader only accepts root-relative /data/…json URLs.`,
      );
      continue;
    }
    if (data[key] !== undefined)
      problems.push(`the ${key} section is both inline and listed in sectionUrls.`);
    const body = readFile(url.slice(1));
    if (body == null) {
      problems.push(`the ${key} section file dist${url} is missing.`);
      continue;
    }
    try {
      JSON.parse(body);
    } catch {
      problems.push(`the ${key} section file dist${url} is not valid JSON.`);
    }
    if (url.split('/').pop() !== sectionFileName(key, body))
      problems.push(
        `dist${url} does not match its content hash — the name must change with the bytes (the file is cached as immutable).`,
      );
    const preload = [...head.matchAll(/<link\b[^>]*>/gi)].some(
      ([tag]) =>
        tag.includes(`href="${url}"`) &&
        /\brel="preload"/.test(tag) &&
        /\bas="fetch"/.test(tag) &&
        /\scrossorigin\b/.test(tag),
    );
    if (!preload)
      problems.push(
        `the ${key} section has no <link rel="preload" href="${url}" as="fetch" crossorigin> in <head>.`,
      );
  }
  return problems;
}

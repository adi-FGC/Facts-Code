/**
 * Dataset hot-swap helpers for e2e.
 *
 * A ⌘O scan (or Re-analyze) replaces the dashboard's data by dispatching a
 * `factstack:dataset` CustomEvent; the Shell keeps every mounted component and
 * re-renders it with the new `data` prop. These helpers fire that same event
 * with the baked dataset plus overrides, so specs can pin "state from the old
 * project must not leak into the new one" without running the scanner.
 */
import type { Page, Route } from '@playwright/test';

/** Merge `overrides` over the baked dataset and publish it. The swapped
 *  dataset is left on `window.__swapped` for assertions. The base includes
 *  any section a build serves beside the page (`sectionUrls`), exactly as
 *  loadArtifacts hydrates it. */
export async function swapDataset(page: Page, overrides: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (o) => {
    const raw = document.getElementById('factstack-data')?.textContent ?? '{}';
    const base = JSON.parse(raw) as Record<string, unknown>;
    const urls = (base.sectionUrls ?? {}) as Record<string, string>;
    for (const [k, u] of Object.entries(urls)) {
      if (base[k] === undefined && !(k in o)) base[k] = await (await fetch(u)).json();
    }
    const next = { ...base, ...o };
    (window as unknown as { __swapped: unknown }).__swapped = next;
    window.dispatchEvent(new CustomEvent('factstack:dataset', { detail: next }));
  }, overrides);
}

/** The baked dataset as the page loaded it: the inline block plus every
 *  section the build serves beside the page (`sectionUrls` — tree, edges,
 *  docs … no longer sit in the inline block). `keys` limits what comes back
 *  to the test: the tree and docs sections run to hundreds of KB. */
export async function bakedDataset<T = Record<string, unknown>>(
  page: Page,
  keys?: string[],
): Promise<T> {
  const data = await page.evaluate(async (only) => {
    const raw = document.getElementById('factstack-data')?.textContent ?? '{}';
    const base = JSON.parse(raw) as Record<string, unknown>;
    const urls = (base.sectionUrls ?? {}) as Record<string, string>;
    for (const [k, u] of Object.entries(urls)) {
      if (base[k] === undefined && (!only || only.includes(k))) {
        base[k] = await (await fetch(u)).json();
      }
    }
    return only ? Object.fromEntries(only.map((k) => [k, base[k]])) : base;
  }, keys ?? null);
  return data as T;
}

const INLINE_BLOCK = /<script id="factstack-data" type="application\/json">([\s\S]*?)<\/script>/;
const SECTION_PRELOAD =
  /[ \t]*<link rel="preload" href="\/data\/sections\/[^"]*" as="fetch" crossorigin \/>\r?\n?/g;
const SIM_SECTION = /^\/data\/sections\/e2e-(\w+)\.json$/;

/** Where simulateSplitSections serves a moved section. */
export const simSectionUrl = (key: string): string => `/data/sections/e2e-${key}.json`;

/** A response simulateSplitSections serves in place of a section's JSON. */
export type SectionResponse = Parameters<Route['fulfill']>[0];

/**
 * Serve the page the way an `inject-data.mjs --split-sections` build does
 * (performance#5), on ANY build: the document's inline block loses `keys`
 * and lists them in `sectionUrls` instead, and each is answered from
 * simSectionUrl(key) with its JSON (or `opts.fail[key]`), once `opts.gate`
 * settles. A build that already split its sections is folded back first, so
 * exactly `keys` load beside the page. The split is opt-in, so without this
 * a default build never reaches the browser's section hydration at all.
 */
export async function simulateSplitSections(
  page: Page,
  keys: readonly string[],
  opts: {
    /** Hold every section response until this settles. */
    gate?: Promise<void>;
    /** Answer these sections with this response instead of their JSON. */
    fail?: Partial<Record<string, SectionResponse>>;
  } = {},
): Promise<void> {
  const bodies = new Map<string, string>();
  await page.route(
    (url) => SIM_SECTION.test(url.pathname),
    async (route) => {
      const key = SIM_SECTION.exec(new URL(route.request().url()).pathname)![1]!;
      const body = bodies.get(key);
      if (body === undefined) return route.fulfill({ status: 404, body: 'not simulated' });
      await opts.gate;
      await route.fulfill(
        opts.fail?.[key] ?? { status: 200, contentType: 'application/json', body },
      );
    },
  );
  /* Registered last, so it sees every request first; all but the page
     itself fall back to the section route above or the network. */
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const res = await route.fetch();
    const html = await res.text();
    const m = INLINE_BLOCK.exec(html);
    if (!m) return route.fulfill({ response: res });
    const data = JSON.parse(m[1]!) as Record<string, unknown>;
    for (const [k, u] of Object.entries((data.sectionUrls ?? {}) as Record<string, string>)) {
      if (data[k] === undefined) {
        data[k] = await (await page.request.get(new URL(u, route.request().url()).href)).json();
      }
    }
    const sectionUrls: Record<string, string> = {};
    for (const k of keys) {
      if (data[k] === undefined) continue; // the assertions catch a key that never moved
      bodies.set(k, JSON.stringify(data[k]));
      delete data[k];
      sectionUrls[k] = simSectionUrl(k);
    }
    data.sectionUrls = sectionUrls;
    // Same escaping as inject-data.mjs: nothing in the block can close it.
    const block = JSON.stringify(data).replace(/</g, '\\u003c');
    const start = m.index + m[0].indexOf('>') + 1;
    const out = (html.slice(0, start) + block + html.slice(start + m[1]!.length)).replace(
      SECTION_PRELOAD,
      '',
    );
    const headers = { ...res.headers() };
    delete headers['content-length'];
    delete headers['content-encoding'];
    await route.fulfill({ status: res.status(), headers, body: out });
  });
}

/** In-app navigation exactly as the SPA's link handler does it. */
export async function clientNav(page: Page, href: string): Promise<void> {
  await page.evaluate((h) => {
    history.pushState({}, '', h);
    window.dispatchEvent(new Event('factstack:nav'));
  }, href);
}

/** A minimal DocFile (see @factstack/spec docs.ts). */
export function makeDoc(
  path: string,
  content: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    path,
    name,
    ext: name.includes('.') ? name.slice(name.lastIndexOf('.')) : '',
    format: 'markdown',
    kind: 'doc',
    bytes: content?.length ?? 0,
    loc: content ? content.split('\n').length : 0,
    title: name,
    wordCount: 10,
    readingMinutes: 1,
    headings: [],
    todos: [],
    diagrams: [],
    links: [],
    tableCount: 0,
    content,
    truncated: false,
    lastModifiedMs: null,
    ...extra,
  };
}

/** A small project, as a browser scan of a tiny repo would produce. */
export const TINY_PROJECT: Record<string, unknown> = {
  project: { name: 'tiny-swap', root: 'tiny-swap', languages: [], frameworks: [] },
  stats: { files: 3, loc: 120, size: 42_000, gzip: 9_000, tokens: 12_000 },
  tree: { name: 'tiny-swap', path: '', files: [], children: [] },
  edges: [],
  nodeMetrics: [],
  entryPoints: [],
  routes: [],
  risks: [],
  history: [],
  docs: [],
  dependencyManifests: [],
  vulnerabilities: [],
  vulnerabilityScan: undefined,
  config: undefined,
  styles: undefined,
  git: undefined,
};

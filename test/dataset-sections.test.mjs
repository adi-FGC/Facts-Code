/**
 * performance#5 — the heavy dataset sections served beside index.html
 * (apps/ui-remix/scripts/lib/dataset-sections.mjs, inject-data.mjs,
 * check-bundle-size.mjs) and the cache rules both hosts give them.
 *
 * Regression: ~94% of the ~700 KB inline dataset (tree, docs metadata, edges,
 * nodeMetrics) sat in index.html, which the app cannot start before it has
 * fully parsed. The split must stay loadable by the UI's loader
 * (loadArtifacts.ts hydrateSections: listed keys, root-relative /data/…json
 * URLs), keep dist/data/factstack.json complete, and never let an old
 * page still open across a redeploy pair with a newer deploy's sections — hence
 * content-addressed names, cached as immutable exactly once per host.
 *
 * The split is OPT-IN (`--split-sections`): measured on 2026-09-24 it made
 * first load slower (median LCP 2628 → 3056 ms over HTTP/2) because the
 * loader awaits the sections before the first render. The default bake must
 * stay fully inline until that changes.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  effectiveHeaders,
  parseHeadersFile,
  withRouteCacheRules,
} from '../apps/ui-remix/scripts/lib/cf-headers.mjs';
import {
  MIN_SPLIT_CHARS,
  SECTION_URL,
  SPLIT_SECTIONS,
  inlineDataset,
  isSectionUrl,
  sectionFileName,
  sectionProblems,
  splitSections,
  withPreloads,
} from '../apps/ui-remix/scripts/lib/dataset-sections.mjs';
import {
  hostParityProblems,
  netlifyEffectiveHeaders,
} from '../apps/ui-remix/scripts/lib/netlify-headers.mjs';
import { ROUTE_CATALOG } from '../packages/spec/src/routes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps/ui-remix');
const lf = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

/** A dataset whose four heavy sections are each well over MIN_SPLIT_CHARS. */
function bigDataset() {
  const n = 200;
  const files = Array.from({ length: n }, (_, i) => ({ name: `f${i}.ts`, path: `src/f${i}.ts` }));
  return {
    generatedAt: '2026-09-24T00:00:00.000Z',
    project: { name: 'demo', root: 'demo', languages: [], frameworks: [] },
    stats: { files: n, loc: 1, size: 1, gzip: 1, tokens: 1 },
    tree: { name: 'demo', path: '', files, children: [] },
    edges: files.slice(1).map((f, i) => ({ from: f.path, to: files[i].path, kind: 'import' })),
    nodeMetrics: files.map((f, i) => ({ path: f.path, importance: i / n, community: i % 7 })),
    docs: Array.from({ length: 60 }, (_, i) => ({
      path: `docs/d${i}.md`,
      name: `d${i}.md`,
      format: 'markdown',
      title: `Doc ${i} </script><b>`,
      content: `# Doc ${i}\n\nbody ${'x'.repeat(40)}\n`,
    })),
    risks: [],
    summary: { oneLiner: 'demo', description: '', capabilities: [], health: { headline: 'A' } },
  };
}

describe('the split matches what the UI loader hydrates', () => {
  const loader = lf('apps/ui-remix/src/lib/loadArtifacts.ts');

  it('moves only sections loadArtifacts.ts DATASET_SECTIONS lists', () => {
    const list = loader.match(/export const DATASET_SECTIONS = \[([^\]]*)\]/)?.[1];
    expect(list, 'DATASET_SECTIONS in loadArtifacts.ts').toBeTruthy();
    const loaded = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const k of SPLIT_SECTIONS) expect(loaded).toContain(k);
  });

  it('writes URLs the loader accepts (same SECTION_URL, no ..)', () => {
    const src = loader.match(/const SECTION_URL = \/(.+)\/;/)?.[1];
    expect(src).toBe(SECTION_URL.source);
    expect(isSectionUrl('/data/sections/tree.0123456789ab.json')).toBe(true);
    expect(isSectionUrl('data/sections/tree.json')).toBe(false); // relative: breaks deep links (UI-R4)
    expect(isSectionUrl('/data/../x.json')).toBe(false);
  });
});

describe('splitSections', () => {
  it('moves each heavy section to a content-addressed file and lists it', () => {
    const data = bigDataset();
    const before = JSON.stringify(data);
    const { inline, files } = splitSections(data);
    expect(JSON.stringify(data)).toBe(before); // input untouched
    expect(files.map((f) => f.key)).toEqual(SPLIT_SECTIONS);
    for (const f of files) {
      expect(inline[f.key]).toBeUndefined();
      expect(f.name).toBe(sectionFileName(f.key, f.body));
      expect(f.name).toMatch(new RegExp(`^${f.key}\\.[0-9a-f]{12}\\.json$`));
      expect(f.url).toBe(`/data/sections/${f.name}`);
      expect(isSectionUrl(f.url)).toBe(true);
      expect(JSON.parse(f.body)).toEqual(data[f.key]);
    }
    expect(inline.sectionUrls).toEqual(Object.fromEntries(files.map((f) => [f.key, f.url])));
    expect(inline.project).toBe(data.project); // everything else stays inline
    expect(inline.risks).toBe(data.risks);
  });

  it('keeps small sections inline and adds no sectionUrls when nothing moved', () => {
    const tiny = { project: { name: 't' }, tree: { files: [] }, edges: [], docs: [] };
    const { inline, files } = splitSections(tiny);
    expect(files).toEqual([]);
    expect(inline).toEqual(tiny);
    expect('sectionUrls' in inline).toBe(false);
    expect(JSON.stringify(bigDataset().edges).length).toBeGreaterThan(MIN_SPLIT_CHARS);
  });

  it('drops a sectionUrls the source carried (only this build’s files exist)', () => {
    const src = { ...bigDataset(), sectionUrls: { edges: '/data/sections/edges.old.json' } };
    const { inline } = splitSections(src);
    expect(inline.sectionUrls.edges).not.toBe('/data/sections/edges.old.json');
    const small = splitSections({ edges: [], sectionUrls: { edges: '/data/x.json' } }).inline;
    expect(small).toEqual({ edges: [] });
  });

  it('names change with the bytes and only with the bytes', () => {
    const a = splitSections(bigDataset()).files.find((f) => f.key === 'edges');
    const b = splitSections(bigDataset()).files.find((f) => f.key === 'edges');
    const changed = bigDataset();
    changed.edges[0].kind = 'dynamic-import';
    const c = splitSections(changed).files.find((f) => f.key === 'edges');
    expect(b.name).toBe(a.name);
    expect(c.name).not.toBe(a.name);
  });
});

describe('withPreloads + sectionProblems', () => {
  const PAGE =
    '<!doctype html><html><head><title>x</title></head><body>' +
    '<script id="factstack-data" type="application/json">__DATA__</script></body></html>';
  const build = (mutate = (x) => x) => {
    const { inline, files } = splitSections(bigDataset());
    const disk = new Map(files.map((f) => [f.url.slice(1), f.body]));
    const html = withPreloads(PAGE, files).html.replace(
      '__DATA__',
      JSON.stringify(inline).replace(/</g, '\\u003c'),
    );
    return mutate({ html, disk, files, inline });
  };
  const problems = ({ html, disk }) => sectionProblems(html, (rel) => disk.get(rel) ?? null);

  it('preloads every section from <head>, as=fetch + crossorigin, once each', () => {
    const { html, files } = build();
    const head = html.slice(0, html.indexOf('</head>'));
    for (const f of files)
      expect(head).toContain(`<link rel="preload" href="${f.url}" as="fetch" crossorigin />`);
    expect(head.match(/as="fetch"/g)).toHaveLength(files.length);
    expect(withPreloads('<body>no head</body>', files)).toEqual({
      html: '<body>no head</body>',
      ok: false,
    });
    expect(withPreloads(PAGE, [])).toEqual({ html: PAGE, ok: true });
  });

  it('passes a correct build and parses the inline block back', () => {
    const b = build();
    expect(problems(b)).toEqual([]);
    expect(inlineDataset(b.html)).toEqual(JSON.parse(JSON.stringify(b.inline)));
    expect(sectionProblems(PAGE.replace('__DATA__', '{}'), () => null)).toEqual([]);
  });

  it('flags a missing file, bytes that do not match the hash, a missing preload', () => {
    const missing = build((b) => (b.disk.delete(b.files[0].url.slice(1)), b));
    expect(problems(missing).join('\n')).toMatch(/tree section file .* is missing/);
    const edited = build((b) => (b.disk.set(b.files[2].url.slice(1), '[]'), b));
    expect(problems(edited).join('\n')).toMatch(/does not match its content hash/);
    const noPreload = build((b) => ({
      ...b,
      html: b.html.replace(/<link rel="preload" href="\/data\/sections\/docs[^>]*>/, ''),
    }));
    expect(problems(noPreload)).toEqual([expect.stringMatching(/docs section has no <link/)]);
  });

  it('flags URLs and keys the loader would refuse or ignore', () => {
    const withUrls = (urls, extra = {}) => {
      const html = PAGE.replace('__DATA__', JSON.stringify({ ...extra, sectionUrls: urls }));
      return sectionProblems(html, () => '[]').join('\n');
    };
    expect(withUrls({ edges: 'data/sections/e.json' })).toMatch(/only accepts root-relative/);
    expect(withUrls({ risks: '/data/sections/r.json' })).toMatch(/"risks", which the loader/);
    expect(withUrls({ edges: '/data/sections/e.json' }, { edges: [] })).toMatch(
      /both inline and listed/,
    );
  });
});

describe('host cache rules for /data/sections/*', () => {
  const HEADERS = withRouteCacheRules(
    lf('apps/ui-remix/public/_headers'),
    ROUTE_CATALOG.map((r) => r.path),
  );
  const TOML = lf('netlify.toml');
  const SECTION = '/data/sections/edges.0123456789ab.json';
  const IMMUTABLE = 'public, max-age=31536000, immutable';
  const cc = (text, path) => effectiveHeaders(parseHeadersFile(text), path).get('cache-control');

  it('Cloudflare sends ONE immutable Cache-Control for a section, must-revalidate for other data', () => {
    expect(cc(HEADERS, SECTION)).toEqual([IMMUTABLE]);
    expect(cc(HEADERS, '/data/factstack.json')).toEqual(['public, max-age=0, must-revalidate']);
    expect(cc(HEADERS, '/data/docs/0123456789abcdef.json')).toEqual([
      'public, max-age=0, must-revalidate',
    ]);
  });

  it('needs the `! Cache-Control` detach — without it Cloudflare appends /data/*’s value', () => {
    const noDetach = HEADERS.replace(/(\/data\/sections\/\*\n)\s+! Cache-Control\n/, '$1');
    expect(noDetach).not.toBe(HEADERS);
    expect(cc(noDetach, SECTION)).toHaveLength(2);
  });

  it('Netlify sends the same, and the two hosts agree on every header', () => {
    expect(netlifyEffectiveHeaders(HEADERS, TOML, SECTION).get('cache-control')).toEqual([
      IMMUTABLE,
    ]);
    expect(
      hostParityProblems(HEADERS, TOML, [SECTION, '/data/factstack.json', '/data/summary.json']),
    ).toEqual([]);
    // netlify.toml's /data/* alone would override the _headers rule on Netlify.
    const tomlWithout = TOML.replace(/\[\[headers\]\]\nfor = "\/data\/sections\/\*"[^[]*/, '');
    expect(tomlWithout).not.toBe(TOML);
    expect(hostParityProblems(HEADERS, tomlWithout, [SECTION])).toHaveLength(1);
  });

  /* HAZARD, pinned on purpose (T3-R5; see dataset-sections.mjs): a section
     URL this deploy does not have is NOT a 404. The SPA fallback answers it
     with index.html (200) under the same immutable header, so a stale page
     can leave HTML cached as a section for a year, and a rollback to the
     deploy that has the file keeps failing until a hard reload. Harmless
     while the split is opt-in; the next describe blocks turning it on until
     the loader re-fetches such a section with cache: 'reload'. */
  it('a missing section falls through to index.html under the immutable header', () => {
    expect(lf('apps/ui-remix/public/_redirects')).toMatch(/^\/\*\s+\/index\.html\s+200\s*$/m);
    const fallback = TOML.match(
      /\[\[redirects\]\]\nfrom = "\/\*"\nto = "\/index\.html"\n[^[]*/,
    )?.[0];
    expect(fallback).toMatch(/status = 200/);
    expect(fallback).not.toMatch(/force = true/); // existing files still win
    const MISSING = '/data/sections/tree.ffffffffffff.json';
    expect(cc(HEADERS, MISSING)).toEqual([IMMUTABLE]);
    expect(netlifyEffectiveHeaders(HEADERS, TOML, MISSING).get('cache-control')).toEqual([
      IMMUTABLE,
    ]);
  });
});

/** Why the split may not be on by default yet, or null. On = a build or
 *  deploy command passes --split-sections, or inject-data.mjs stops treating
 *  it as opt-in. Allowed only once hydrateSections re-fetches a failed or
 *  non-JSON section with `cache: 'reload'` (the T3-R5 hazard above). */
function splitDefaultProblem({ commands, injectData, loader }) {
  const on =
    commands.some((c) => /inject-data\.mjs\b[^&|;\n]*--split-sections/.test(c)) ||
    !/const SPLIT_SECTIONS = process\.argv\.includes\('--split-sections'\);/.test(injectData);
  if (!on) return null;
  const at = loader.indexOf('export async function hydrateSections');
  const hydrate = at < 0 ? '' : loader.slice(at, loader.indexOf('\n}\n', at));
  return /cache:\s*['"]reload['"]/.test(hydrate)
    ? null
    : "the split is on by default, but hydrateSections never re-fetches a bad section with { cache: 'reload' }";
}

describe('the split stays opt-in until the loader can recover a bad cached section', () => {
  const code = (f) =>
    lf(f)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  const scripts = (f) => Object.values(JSON.parse(lf(f)).scripts ?? {});
  const real = {
    commands: [
      ...scripts('apps/ui-remix/package.json'),
      ...scripts('package.json'),
      code('netlify.toml'),
      ...readdirSync(join(ROOT, '.github/workflows'))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => code(`.github/workflows/${f}`)),
    ],
    injectData: lf('apps/ui-remix/scripts/inject-data.mjs'),
    loader: lf('apps/ui-remix/src/lib/loadArtifacts.ts'),
  };

  it('no build or deploy turns the split on before hydrateSections retries with cache: reload', () => {
    expect(real.commands.some((c) => /inject-data\.mjs/.test(c))).toBe(true);
    expect(splitDefaultProblem(real)).toBeNull();
  });

  it('the guard fails a default-on split without the retry, and passes it with one', () => {
    const onByScript = {
      ...real,
      commands: [...real.commands, 'tsx scripts/inject-data.mjs --split-sections'],
    };
    const onByDefault = {
      ...real,
      injectData: real.injectData.replace(
        "process.argv.includes('--split-sections')",
        "!process.argv.includes('--no-split-sections')",
      ),
    };
    expect(onByDefault.injectData).not.toBe(real.injectData);
    const retrying = real.loader.replace(
      'export async function hydrateSections(',
      "export async function hydrateSections( /* retry: { cache: 'reload' } */",
    );
    if (!/cache:\s*['"]reload['"]/.test(real.loader)) {
      expect(splitDefaultProblem(onByScript)).toMatch(/cache: 'reload'/);
      expect(splitDefaultProblem(onByDefault)).toMatch(/cache: 'reload'/);
      // A retry elsewhere in the file does not count.
      const elsewhere = `${real.loader}\nfetch(u, { cache: 'reload' });\n`;
      expect(splitDefaultProblem({ ...onByScript, loader: elsewhere })).toMatch(/cache: 'reload'/);
    }
    expect(splitDefaultProblem({ ...onByScript, loader: retrying })).toBeNull();
  });
});

describe('inject-data.mjs writes the split (end to end)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fx-sections-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const TEMPLATE =
    '<!doctype html><html><head><title>t</title></head><body>' +
    '<script id="factstack-data" type="application/json">__INLINE_FACTSTACK_JSON__</script></body></html>';

  const bake = (name, dataset, extra = ['--split-sections']) => {
    const root = join(tmp, `repo-${name}`);
    const dist = join(tmp, `dist-${name}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(dist, { recursive: true });
    const src = join(tmp, `${name}.json`);
    writeFileSync(src, JSON.stringify(dataset));
    writeFileSync(join(dist, 'index.html'), TEMPLATE);
    const r = spawnSync(
      process.execPath,
      [
        join(APP, 'node_modules/tsx/dist/cli.mjs'),
        'scripts/inject-data.mjs',
        '--root',
        root,
        '--dist',
        dist,
        '--src',
        src,
        ...extra,
      ],
      { cwd: APP, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const read = (rel) => {
      const f = join(dist, ...rel.split('/'));
      return existsSync(f) ? readFileSync(f, 'utf8') : null;
    };
    return { dist, html, read, stdout: r.stdout };
  };

  it('inlines the small rest, preloads content-addressed sections, keeps factstack.json complete', () => {
    const { html, read, stdout } = bake('big', bigDataset());
    expect(stdout).toMatch(/moved 4 section\(s\) out of index\.html/);
    const inline = inlineDataset(html);
    for (const k of SPLIT_SECTIONS) expect(inline[k], k).toBeUndefined();
    expect(Object.keys(inline.sectionUrls).sort()).toEqual([...SPLIT_SECTIONS].sort());
    expect(sectionProblems(html, read)).toEqual([]);

    // What hydrateSections rebuilds = the fetchable full dataset, except that
    // doc bodies are served on demand (contentUrl), as before the split.
    const full = JSON.parse(read('data/factstack.json'));
    expect(full.sectionUrls).toBeUndefined();
    const hydrated = { ...inline };
    for (const [k, url] of Object.entries(inline.sectionUrls))
      hydrated[k] = JSON.parse(read(url.slice(1)));
    delete hydrated.sectionUrls;
    const docs = hydrated.docs;
    delete hydrated.docs;
    const { docs: fullDocs, ...fullRest } = full;
    expect(hydrated).toEqual(fullRest);
    expect(docs.map((d) => d.path)).toEqual(fullDocs.map((d) => d.path));
    for (const d of docs) {
      expect(d.content).toBeNull();
      expect(JSON.parse(read(d.contentUrl.slice(1))).content).toBe(
        fullDocs.find((f) => f.path === d.path).content,
      );
    }
    // A `</script>` in a section never reaches the page: it is in a JSON file.
    expect(html).not.toContain('</script><b>');
  });

  it('without --split-sections (the default build) everything stays inline', () => {
    const data = bigDataset();
    const { dist, html, stdout } = bake('default', data, []);
    expect(stdout).not.toMatch(/section\(s\) out of index\.html/);
    const inline = inlineDataset(html);
    expect(inline.sectionUrls).toBeUndefined();
    for (const k of SPLIT_SECTIONS) expect(inline[k], k).toBeDefined();
    expect(inline.edges).toEqual(data.edges);
    expect(html).not.toContain('as="fetch"');
    expect(existsSync(join(dist, 'data', 'sections'))).toBe(false);
  });

  it('a small dataset stays fully inline: no sectionUrls, no preloads, no section files', () => {
    const tiny = { project: { name: 'tiny' }, stats: { files: 1 }, tree: { files: [] }, docs: [] };
    const { dist, html } = bake('tiny', tiny);
    expect(inlineDataset(html).sectionUrls).toBeUndefined();
    expect(html).not.toContain('as="fetch"');
    expect(existsSync(join(dist, 'data', 'sections'))).toBe(false);
  });
});

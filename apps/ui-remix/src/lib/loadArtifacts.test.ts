/**
 * UI-05 — the token panel measured the page's baked inline block, so every
 * hot-swapped dataset (⌘O scan) was priced as the demo. artifactCharsOf keys
 * the exact inline size by dataset identity; anything else re-serializes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactCharsOf,
  hasBakedInline,
  hydrateSections,
  loadArtifacts,
  type Dataset,
} from './loadArtifacts.ts';

const g = globalThis as { document?: unknown };
afterEach(() => {
  delete g.document;
});

describe('artifactCharsOf', () => {
  it('reports the inline block length for the baked dataset only', async () => {
    const baked = { project: { name: 'demo' }, pad: 'x'.repeat(5000) };
    /* Whitespace makes the inline text longer than JSON.stringify's output,
       so the two measurements are distinguishable. */
    const inline = JSON.stringify(baked, null, 2);
    g.document = { querySelector: () => ({ textContent: inline }) };

    const data = await loadArtifacts();
    expect(artifactCharsOf(data)).toBe(inline.length);

    const swapped = { project: { name: 'tiny' } } as unknown as Dataset;
    expect(artifactCharsOf(swapped)).toBe(JSON.stringify(swapped).length);
    expect(artifactCharsOf(swapped)).toBeLessThan(inline.length);

    /* A structurally equal copy is still a different dataset. */
    const copy = { ...data };
    expect(artifactCharsOf(copy)).toBe(JSON.stringify(copy).length);
  });

  it('falls back to 0 for an unserializable dataset instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(artifactCharsOf(cyclic as unknown as Dataset)).toBe(0);
  });
});

/* ux#4 — the Re-analyze button used `includes()` on the placeholder token, so a
   baked dataset that merely MENTIONS the token (factstack's own README does)
   was read as "no data baked in". Both callers share this exact match now. */
describe('hasBakedInline', () => {
  const token = '__INLINE_' + 'FACTSTACK_JSON__';
  it('is false only for the bare placeholder (or an empty block)', () => {
    expect(hasBakedInline(token)).toBe(false);
    expect(hasBakedInline('  \n' + token + '\n  ')).toBe(false);
    expect(hasBakedInline('')).toBe(false);
    expect(hasBakedInline(null)).toBe(false);
  });

  it('is true for a real dataset that mentions the placeholder', () => {
    const data = JSON.stringify({ docs: [{ content: `inject-data.mjs replaces ${token}` }] });
    expect(hasBakedInline(data)).toBe(true);
  });
});

/* performance#5 — a static build may serve heavy sections beside the page.
   The loader fills in each one before the first render; with none listed it
   is a no-op, so today's fully-inline bake behaves exactly as before. */
describe('hydrateSections', () => {
  const serve = (files: Record<string, unknown>) => {
    const asked: string[] = [];
    const impl = (async (url: string) => {
      asked.push(url);
      const body = files[url];
      return body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    return { impl, asked };
  };

  it('fetches every listed section that is absent inline, and only those', async () => {
    const edges = [{ from: 'a.ts', to: 'b.ts', kind: 'import' }];
    const { impl, asked } = serve({ '/data/sections/edges.json': edges });
    const data = {
      docs: [],
      sectionUrls: { edges: '/data/sections/edges.json', docs: '/data/sections/docs.json' },
    } as unknown as Dataset;
    const chars = await hydrateSections(data, impl);
    expect(data.edges).toEqual(edges);
    expect(asked).toEqual(['/data/sections/edges.json']); // docs was inline
    expect(chars).toBe(JSON.stringify(edges).length);
  });

  it('is a no-op without sectionUrls', async () => {
    const { impl, asked } = serve({});
    expect(await hydrateSections({ edges: [] } as unknown as Dataset, impl)).toBe(0);
    expect(asked).toEqual([]);
  });

  it('never fetches anything but a root-relative /data/*.json path, and fails naming it', async () => {
    for (const [k, url] of [
      ['edges', 'https://evil.example/edges.json'],
      ['docs', '/data/../secrets.json'],
      ['tree', '//cdn.example/data/tree.json'],
      ['nodeMetrics', 'javascript:alert(1)'],
    ] as const) {
      const { impl, asked } = serve({});
      const data = { sectionUrls: { [k]: url } } as unknown as Dataset;
      await expect(hydrateSections(data, impl)).rejects.toThrow(
        new RegExp(`${k} section is listed at an unsupported URL`),
      );
      expect(asked).toEqual([]);
    }
  });

  /* UI-R4 — a relative `data/…` resolves against a deep link (/docs/a/b →
     /docs/a/data/…), where the SPA fallback serves index.html with a 200. */
  it('refuses a relative data/… URL instead of fetching it against the current path', async () => {
    const { impl, asked } = serve({ 'data/sections/docs.json': [] });
    const data = { sectionUrls: { docs: 'data/sections/docs.json' } } as unknown as Dataset;
    await expect(hydrateSections(data, impl)).rejects.toThrow(/docs section .* unsupported URL/);
    expect(asked).toEqual([]);
  });

  it('turns a non-JSON 200 (the SPA fallback page) into a named reload error', async () => {
    const impl = (async () =>
      new Response('<!doctype html><html></html>', { status: 200 })) as unknown as typeof fetch;
    const data = { sectionUrls: { edges: '/data/sections/edges.json' } } as unknown as Dataset;
    await expect(hydrateSections(data, impl)).rejects.toThrow(
      "Could not parse the dataset's edges section (/data/sections/edges.json) — the site may have been updated since this page opened; reload.",
    );
    expect(data.edges).toBeUndefined();
  });

  it('fails the load when a listed section cannot be fetched', async () => {
    const { impl } = serve({});
    const data = { sectionUrls: { docs: '/data/sections/docs.json' } } as unknown as Dataset;
    await expect(hydrateSections(data, impl)).rejects.toThrow(/HTTP 404 .* docs section/);
  });

  it('counts section bytes toward the baked artifact size', async () => {
    const tree = { name: '', path: '', files: [], children: [] };
    const inline = JSON.stringify({ sectionUrls: { tree: '/data/sections/tree.json' } });
    const { impl } = serve({ '/data/sections/tree.json': tree });
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      g.document = { querySelector: () => ({ textContent: inline }) };
      const data = await loadArtifacts();
      expect(data.tree).toEqual(tree);
      expect(artifactCharsOf(data)).toBe(inline.length + JSON.stringify(tree).length);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/**
 * First-load behaviour pinned by the 2026-09-24 performance pass. Each of
 * these made the page faster by NOT doing something up front; each test
 * proves the deferred thing still happens when it's actually needed.
 *
 *   - Doc bodies are not in index.html; the Docs tab fetches one on open.
 *   - Non-landing tabs are separate chunks, loaded when opened.
 *   - The file tree is not built at phone widths, where CSS hides it.
 *   - Heavy dataset sections a build serves beside the page (sectionUrls)
 *     are loaded before any tab renders against them. The split is opt-in
 *     (`inject-data.mjs --split-sections`), so one test simulates it on any
 *     build and one checks a real split build (skipped on a default build).
 *     Failure paths live in resilience.spec.ts.
 *
 * Specs that need a section (tree, edges, docs …) read it through
 * swap.ts' bakedDataset(), never straight from the inline block.
 */

import type { Page } from '@playwright/test';
import { expect, test, waitForReady } from './fixtures.js';
import { bakedDataset, clientNav, simSectionUrl, simulateSplitSections } from './swap.js';

/** The inline block's sectionUrls, and which of them are still inline too. */
async function inlineSections(
  page: Page,
): Promise<{ urls: Record<string, string>; stillInline: string[] }> {
  return page.evaluate(() => {
    const d = JSON.parse(document.getElementById('factstack-data')?.textContent ?? '{}') as {
      sectionUrls?: Record<string, string>;
    } & Record<string, unknown>;
    const urls = d.sectionUrls ?? {};
    return { urls, stillInline: Object.keys(urls).filter((k) => k in d) };
  });
}

/** On /architecture: the edges and docs sections reached the views. */
async function expectEdgesAndDocsRendered(page: Page): Promise<void> {
  const { edges, docs } = await bakedDataset<{ edges: unknown[]; docs: Array<{ path: string }> }>(
    page,
    ['edges', 'docs'],
  );
  expect(edges.length).toBeGreaterThan(0);
  const main = page.locator('main#main');
  // The stat row's "Edges" cell (a table header also reads "Edges").
  const edgesCell = main.getByText('Edges', { exact: true }).first().locator('xpath=..');
  await expect(edgesCell).toBeVisible();
  await expect(edgesCell).not.toHaveText(/Edges\s*0$/);

  await clientNav(page, '/docs');
  await expect(main.getByText(docs[0]!.path).first()).toBeVisible();
}

test.describe('deferred loading', () => {
  test('doc bodies ship outside the page and load when a doc is opened', async ({ page }) => {
    const bodyReq = page.waitForResponse((r) => /\/data\/docs\/[0-9a-f]{16}\.json$/.test(r.url()));
    await page.goto('/docs');
    await waitForReady(page);

    /* The baked dataset (inline block or its docs section) carries a pointer,
       never the body itself. */
    const { docs } = await bakedDataset<{
      docs: Array<{ content: unknown; contentUrl?: string }> | undefined;
    }>(page, ['docs']);
    expect(docs?.filter((d) => typeof d.content === 'string').length).toBe(0);
    expect(docs?.filter((d) => typeof d.contentUrl === 'string').length).toBeGreaterThan(0);

    expect((await bodyReq).ok()).toBe(true);
    const main = page.locator('main section').first();
    await expect(main.getByText('Loading document…')).toHaveCount(0);
    await expect(main.getByText(/No content stored|Couldn’t load/)).toHaveCount(0);
  });

  test('a non-landing tab arrives as its own chunk and renders', async ({ page }) => {
    const chunk = page.waitForResponse((r) => /\/assets\/Architecture-[\w-]+\.js$/.test(r.url()));
    await page.goto('/architecture');
    await waitForReady(page);
    expect((await chunk).ok()).toBe(true);
    await expect(page.locator('main h1, main h2').first()).toBeVisible();
    await expect(page.getByText('Loading view…')).toHaveCount(0);
  });

  test('phones never build the file tree they cannot show', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await waitForReady(page);
    await page.waitForTimeout(500); // past the post-paint reveal on wide screens
    const tree = page.getByRole('complementary', { name: 'Project tree' });
    await expect(tree).toBeHidden();
    expect(await tree.locator('li').count()).toBe(0);
  });

  test('sections served beside the page load before any tab renders (performance#5, simulated)', async ({
    page,
  }) => {
    /* Any build: the page is served as a --split-sections build would be,
       and both sections are held in flight to prove nothing renders first. */
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await simulateSplitSections(page, ['edges', 'docs'], { gate });
    const held = Promise.all(
      ['edges', 'docs'].map((k) => page.waitForRequest((r) => r.url().endsWith(simSectionUrl(k)))),
    );
    await page.goto('/architecture', { waitUntil: 'domcontentloaded' });
    await held;
    await page.waitForTimeout(250); // a render that skipped the wait would land by now
    await expect(page.getByRole('status', { name: 'Loading FACTS dashboard' })).toBeVisible();
    await expect(page.locator('main#main')).toHaveCount(0);

    release();
    await waitForReady(page);
    const inline = await inlineSections(page);
    expect(inline.urls).toEqual({ edges: simSectionUrl('edges'), docs: simSectionUrl('docs') });
    expect(inline.stillInline).toEqual([]);
    await expectEdgesAndDocsRendered(page);
  });

  test('a --split-sections build serves its heavy sections beside the page (performance#5)', async ({
    page,
  }) => {
    /* inject-data.mjs --split-sections moves the heavy sections out of the
       inline block into /data/sections/<name>.<hash>.json and lists them in
       `sectionUrls`; every listed one is fetched before the first render. */
    const fetched = new Map<string, number>();
    page.on('response', (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/data/sections/')) fetched.set(path, r.status());
    });

    await page.goto('/architecture');
    await waitForReady(page);
    const inline = await inlineSections(page);
    test.skip(
      Object.keys(inline.urls).length === 0,
      'default build keeps sections inline (--split-sections is opt-in)',
    );
    expect(Object.keys(inline.urls)).toEqual(expect.arrayContaining(['edges', 'docs']));
    expect(inline.stillInline).toEqual([]);
    for (const url of Object.values(inline.urls)) expect(fetched.get(url), url).toBe(200);
    await expectEdgesAndDocsRendered(page);
  });

  test('desktop builds the tree right after first paint', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await waitForReady(page);
    const tree = page.getByRole('complementary', { name: 'Project tree' });
    await expect(tree.locator('li').first()).toBeVisible();
  });
});

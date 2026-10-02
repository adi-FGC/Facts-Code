/**
 * ux#4 / UI-R5 — the Re-analyze button decides at mount whether the page is
 * a static bake (no /api/reanalyze to call, so it renders nothing). It used
 * `includes()` on the inline block's placeholder token, so a baked dataset
 * that merely MENTIONS the token (factstack's own docs describe the bake
 * pipeline) read as un-baked and offered a Re-analyze that could only fail.
 * Both the loader and the button now share hasBakedInline's exact match.
 *
 * The build's own bake does not mention the token, so each case rewrites the
 * served document's inline block.
 */
import type { Page } from '@playwright/test';
import { expect, test, waitForReady } from './fixtures.js';
import { makeDoc } from './swap.js';

/* Split so this file never carries the bare token itself. */
const TOKEN = '__INLINE_' + 'FACTSTACK_JSON__';
const OPEN = '<script id="factstack-data" type="application/json">';

/** The baked dataset plus one doc whose body mentions the placeholder. */
function mentionToken(inline: string): string {
  const data = JSON.parse(inline) as { docs?: unknown[] };
  data.docs = [
    ...(data.docs ?? []),
    makeDoc('docs/bake.md', `inject-data.mjs replaces ${TOKEN} with the dataset.`),
  ];
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** Serve `/` with its inline block replaced: the bare placeholder (un-baked)
 *  or the baked dataset mentioning it. An un-baked page loads its dataset
 *  from /data/factstack.json, which `factstack ui` serves (vite preview
 *  proxies it to a server that is not running here), so the test serves it. */
async function serveInline(page: Page, bare: boolean): Promise<void> {
  let dataset = '';
  await page.route('**/data/factstack.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: dataset }),
  );
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const res = await route.fetch();
      const html = await res.text();
      const at = html.indexOf(OPEN) + OPEN.length;
      const end = html.indexOf('</script>', at);
      dataset = html.slice(at, end);
      const inline = bare ? TOKEN : mentionToken(dataset);
      await route.fulfill({ response: res, body: html.slice(0, at) + inline + html.slice(end) });
    },
  );
}

test.describe('Re-analyze button: static-bake check', () => {
  test('a baked dataset that mentions the placeholder token stays static (no Re-analyze)', async ({
    page,
  }) => {
    await serveInline(page, false);
    await page.goto('/');
    await waitForReady(page);
    expect(
      await page.evaluate(() => document.getElementById('factstack-data')?.textContent ?? ''),
    ).toContain(TOKEN);
    await expect(page.getByRole('button', { name: 'Open project' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Re-analyze/ })).toHaveCount(0);
  });

  test('an un-baked page (the bare placeholder) offers Re-analyze', async ({ page }) => {
    /* The loader falls back to /data/factstack.json, as under `factstack ui`. */
    await serveInline(page, true);
    await page.goto('/');
    await waitForReady(page);
    await expect(page.getByRole('button', { name: 'Open project' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Re-analyze/ })).toBeVisible();
  });
});

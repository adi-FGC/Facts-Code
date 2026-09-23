/**
 * First-load behaviour pinned by the 2026-09-24 performance pass. Each of
 * these made the page faster by NOT doing something up front; each test
 * proves the deferred thing still happens when it's actually needed.
 *
 *   - Doc bodies are not in index.html; the Docs tab fetches one on open.
 *   - Non-landing tabs are separate chunks, loaded when opened.
 *   - The file tree is not built at phone widths, where CSS hides it.
 */

import { expect, test, waitForReady } from './fixtures.js';

test.describe('deferred loading', () => {
  test('doc bodies ship outside the page and load when a doc is opened', async ({ page }) => {
    const bodyReq = page.waitForResponse((r) => /\/data\/docs\/[0-9a-f]{16}\.json$/.test(r.url()));
    await page.goto('/docs');
    await waitForReady(page);

    // The baked dataset carries a pointer, never the body itself.
    const inline = await page.evaluate(() => {
      const raw = document.getElementById('factstack-data')?.textContent ?? '{}';
      const docs =
        (JSON.parse(raw) as { docs?: Array<{ content: unknown; contentUrl?: string }> }).docs ?? [];
      return {
        withBody: docs.filter((d) => typeof d.content === 'string').length,
        withUrl: docs.filter((d) => typeof d.contentUrl === 'string').length,
      };
    });
    expect(inline.withBody).toBe(0);
    expect(inline.withUrl).toBeGreaterThan(0);

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

  test('desktop builds the tree right after first paint', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await waitForReady(page);
    const tree = page.getByRole('complementary', { name: 'Project tree' });
    await expect(tree.locator('li').first()).toBeVisible();
  });
});

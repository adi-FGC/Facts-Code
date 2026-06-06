/**
 * Client-side navigation regression — the exact gap that let the
 * "blank page on nav, fine on hard refresh" bug ship to production
 * (2026-06-03).
 *
 * Why the smoke suite missed it: smoke.spec.ts (and the ROUTES catalog)
 * exercise every route with `page.goto()` — a HARD load, which boots the
 * SPA once and always renders. The bug only appeared on in-app navigation:
 * clicking an `<a>` nav link goes through the SPA's pushState + re-render
 * path, and re-rendering the root-adjacent App component blanked the whole
 * `#root` (this Remix v3 reconciler corrupts on an in-place patch near the
 * mount). The fix moved per-navigation reactivity into DEEP components
 * (App.tsx `RouteView`, `NumberedNav`, the Config/About icons), whose
 * `handle.update()` patches a small subtree reliably.
 *
 * This spec clicks every primary nav tab + uses the back button, and
 * asserts the page actually rendered: `#root` keeps children and `<main>`
 * shows an `<h1>`. A blank tree = the bug is back. The auto-fail-on-console
 * -errors fixture applies here too.
 */

import { expect, test, waitForReady } from './fixtures.js';

const PRIMARY_TABS = [
  'Architecture',
  'Files',
  'Docs',
  'Review',
  'Security',
  'Tests',
  'History',
  'Overview',
] as const;

test.describe('client-side navigation (must never blank the tree)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
  });

  test('clicking each primary nav tab renders content + tracks the highlight', async ({ page }) => {
    const nav = page.getByRole('tablist', { name: 'Primary navigation' });

    for (const label of PRIMARY_TABS) {
      await nav.getByRole('tab', { name: new RegExp(label) }).click();

      // 1. The tree survived the re-render — the actual bug was #root emptying.
      await expect(page.locator('#root')).not.toBeEmpty();
      // 2. The route mounted real content (every route renders an <h1>).
      await expect(page.locator('main h1').first()).toBeVisible();
      // 3. The active-tab highlight followed the URL (NumberedNav re-rendered).
      await expect(nav.getByRole('tab', { selected: true })).toContainText(new RegExp(label));
    }
  });

  test('back button (popstate) re-renders without blanking', async ({ page }) => {
    const nav = page.getByRole('tablist', { name: 'Primary navigation' });

    await nav.getByRole('tab', { name: /Security/ }).click();
    await expect(page).toHaveURL(/\/security$/);
    await expect(page.locator('main h1').first()).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/(?:\?.*)?$/); // back to Overview
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.locator('main h1').first()).toBeVisible();
  });
});

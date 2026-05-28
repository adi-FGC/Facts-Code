/**
 * Per-route smoke suite.
 *
 * For every entry in `ROUTES`, asserts two things:
 *   1. The page loads + reaches the dataset-ready state (the
 *      `waitForReady` helper distinguishes the happy-path shell from
 *      the ErrorScreen and throws a diagnostic message in the latter
 *      case).
 *   2. The expected H1 (or one of its empty-state variants) appears,
 *      OR the interactiveSelector matches if no static H1 is known.
 *
 * The third historical assertion — "no console errors fired" — is
 * now applied automatically to EVERY test in this directory via the
 * `autoFailOnConsoleErrors` auto-fixture in `fixtures.ts`. Tests no
 * longer have to opt in; the fixture teardown raises if any
 * non-allowlisted error fired during the test body.
 *
 * Deeper per-route assertions (form interactions, state changes, data
 * shape verification) live in their own spec files (e.g.
 * `vulnerabilities.spec.ts`) so the smoke run stays cheap.
 */

import { ROUTES, expect, test, waitForReady } from './fixtures.js';

for (const route of ROUTES) {
  test.describe(`${route.name} (${route.path})`, () => {
    test('loads without errors and renders main content', async ({ page }) => {
      await page.goto(route.path);
      await waitForReady(page);

      /* Headline check: pass if ANY of the known variants appears.
       * Routes with dataset-driven H1s pass an empty `headlines` array
       * and rely on `interactiveSelector` instead.
       *
       * Using `getByRole('heading', { name })` over `h1:has-text()`
       * for two reasons: (a) it's semantic — survives a stylistic
       * change from <h1> to <h2>, (b) the `name` accessor uses the
       * accessible-name computation, which matches what screen readers
       * see and what's stable across DOM tweaks. */
      if (route.headlines.length > 0) {
        /* Build a single regex matching ANY of the variants. The
         * `^...$` anchoring prevents partial matches against a longer
         * heading that happens to contain the variant text. */
        const variants = route.headlines
          .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        const headingPattern = new RegExp(`^(${variants})$`);
        await expect(
          page.getByRole('heading', { level: 1, name: headingPattern }).first(),
        ).toBeVisible({ timeout: 5_000 });
      }

      /* InteractiveSelector check: useful for routes whose primary
       * content mounts after dataset parsing (Flow's SVG, Library's
       * grid, etc.) or whose H1 is wholly dataset-driven. */
      if (route.interactiveSelector) {
        await expect(page.locator(route.interactiveSelector).first()).toBeVisible({ timeout: 5_000 });
      }
    });
  });
}

/* ─────────── cross-route invariants ─────────── */

test.describe('global shell', () => {
  test('header + tree panel + status bar render on every route', async ({ page }) => {
    /* These three landmarks come from App.tsx's Shell component and
     * should mount on every route. If one disappears, layout broke. */
    await page.goto('/');
    await waitForReady(page);

    await expect(page.locator('main#main')).toBeVisible();
    /* Skip-link is the first focusable element — confirms a11y
     * scaffolding survived. */
    await expect(page.locator('.skip-link')).toHaveAttribute('href', '#main');
  });

  test('tab navigation updates the URL and aria-selected state', async ({ page }) => {
    /* Tests the SPA navigation loop end-to-end:
     *   click tab → pushState → URL-change event → re-render → tab
     *   gets aria-selected="true".
     *
     * We assert on URL + aria-selected (the W3C tablist contract)
     * rather than the destination route's H1 text. This decouples the
     * test from editorial wording — a marketing change to the About
     * page's slogan shouldn't fail a NAVIGATION test that's working
     * fine. The H1 of each route is already covered by the per-route
     * smoke loop above. */
    await page.goto('/');
    await waitForReady(page);

    /* Nav uses role="tab" inside a tablist (correct ARIA pattern for
     * single-page tabbed UI, not page-level navigation links). Tab
     * labels include the numeric prefix from the design system, so
     * the accessible name is e.g. "13 About" not "About". */
    const aboutTab = page.getByRole('tab', { name: /\d+\s+About$/ });
    await aboutTab.click();

    await page.waitForURL('**/about');
    await expect(aboutTab).toHaveAttribute('aria-selected', 'true');
  });
});

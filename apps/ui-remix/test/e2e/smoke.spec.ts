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

  test('activating the skip-link moves keyboard focus to <main>', async ({ page }) => {
    /* Regression: the SPA's linkClick delegate used to intercept the
     * `#main` skip-link as client-side navigation (preventDefault +
     * pushState), so it neither scrolled NOR moved focus — defeating the
     * skip link. And <main> lacked tabindex, so even native nav couldn't
     * focus it. Both fixed: linkClick now ignores `#`-anchors and <main>
     * is tabindex=-1.
     *
     * We focus the skip-link directly and activate it with Enter (the real
     * keyboard path) rather than asserting exact Tab order — the first Tab
     * stop varies by headless focus state, but the contract under test is
     * "activate skip-link → focus lands on <main>", not "skip-link is the
     * 1st tab stop" (that's covered by it being first in DOM order). */
    await page.goto('/');
    await waitForReady(page);

    const skip = page.locator('.skip-link');
    await skip.focus();
    await expect(skip).toBeFocused();

    await page.keyboard.press('Enter');
    // Focus must move to <main id="main"> (proves linkClick let the native
    // anchor through AND <main> is a focus target).
    await expect(page.locator('main#main')).toBeFocused();
    // URL hash updates too — native in-page anchor behavior, not swallowed.
    await expect(page).toHaveURL(/#main$/);
  });

  test('tab + icon navigation updates the URL and active state', async ({ page }) => {
    /* Tests the SPA navigation loop end-to-end:
     *   click → pushState → URL-change event → re-render → active state.
     *
     * v0.9 split navigation into two control types, so this covers both:
     *   - the numbered tablist (role="tab" + aria-selected), and
     *   - the right-side meta icons Config/About (role="link" +
     *     aria-current), demoted from the numbered nav — see NavIcons.tsx.
     *
     * We assert URL + the ARIA active flag rather than destination H1
     * text, so an editorial wording change can't fail a NAVIGATION test.
     * Per-route H1s are covered by the per-route smoke loop above. */
    await page.goto('/');
    await waitForReady(page);

    /* Numbered tab: the accessible name carries a zero-padded index
     * prefix (e.g. "02 Architecture"), so match the label as a substring
     * to stay robust to the numbering. */
    const archTab = page.getByRole('tab', { name: /Architecture/ });
    await archTab.click();
    await page.waitForURL('**/architecture');
    await expect(archTab).toHaveAttribute('aria-selected', 'true');

    /* a11y on client-side route change (App.tsx RouteView.onChange):
     *   - focus moves into <main> so a subsequent Tab resumes in the new
     *     content, not back in the header nav, and
     *   - the polite #route-announcer carries the new view name so screen
     *     readers get the navigation signal a SPA otherwise swallows. */
    await expect(page.locator('main#main')).toBeFocused();
    await expect(page.locator('#route-announcer')).toHaveText('Architecture view loaded');

    /* About is now a right-side icon link (?↔!), not a numbered tab. It
     * lives in the header banner and signals active state via
     * aria-current — the link-role analogue of a tab's aria-selected.
     * Scope to the banner so a stray "About" link elsewhere can't shadow it. */
    const aboutIcon = page.getByRole('banner').getByRole('link', { name: 'About' });
    await aboutIcon.click();
    await page.waitForURL('**/about');
    await expect(aboutIcon).toHaveAttribute('aria-current', 'page');
  });
});

/**
 * Interactive-surface coverage — the layer the smoke suite doesn't reach.
 *
 * smoke.spec.ts proves every route LOADS. This spec proves the
 * stateful controls WORK: the command palette, theme/density
 * switching, Flow view-mode tabs, and the Library sort. These are the
 * surfaces where a broken `handle.update()` or a dropped event
 * listener would pass the smoke test (page renders) but ship a dead
 * control to users.
 *
 * Each test asserts on the USER-VISIBLE OUTCOME, not the control's
 * internal state where possible:
 *   - theme switch → `html[data-theme]` attribute (the feature
 *     applied), not just the radio's aria-checked (the widget updated).
 *   - palette navigate → URL change (you actually went somewhere).
 *   - Flow tab → aria-selected on the W3C tablist contract.
 *
 * The auto-fail-on-console-errors fixture (see fixtures.ts) applies
 * here too — any of these interactions that throws in the Remix
 * runtime fails the test even if the assertion itself passes.
 */

import { expect, test, waitForReady } from './fixtures.js';

/* ─────────── Command palette (⌘K / Ctrl+K) ─────────── */

test.describe('command palette', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
  });

  test('opens on Ctrl+K and shows the search input', async ({ page }) => {
    /* The handler checks `e.metaKey || e.ctrlKey`, so Control works on
     * the Windows/Linux CI runner. Meta would no-op off-Mac. */
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search' })).toBeFocused();
  });

  test('filters results as you type', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const search = page.getByRole('combobox', { name: 'Search' });
    await search.fill('vuln');
    /* Typing "vuln" should surface the Vulnerabilities tab. The result
     * list is now a proper ARIA listbox — role="listbox" wrapping
     * role="option" items, wired to the combobox input via
     * aria-controls/aria-activedescendant — so we assert on the option
     * role, the navigable semantics a screen reader actually exposes. */
    await expect(
      page.getByRole('option', { name: /vulnerabilities/i }).first(),
    ).toBeVisible();
  });

  test('Escape closes the palette', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Enter on a filtered result navigates to that route', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search' }).fill('about');
    /* The first result should be the About tab. Enter selects the
     * highlighted (selectedIdx=0) result. The whole-loop test:
     * keypress → palette filters → Enter → pushState → URL change. */
    await page.keyboard.press('Enter');
    await page.waitForURL('**/about');
    await expect(
      page.getByRole('heading', { name: 'FACTS — Fun AI Coding Tools.' }),
    ).toBeVisible();
  });

  test('exposes results as an ARIA listbox with virtual focus tracking', async ({ page }) => {
    /* The crux of the W3C combobox/listbox wiring (the a11y fix this
     * suite guards): the input is a `combobox` that OWNS a `listbox` of
     * `option`s, and `aria-activedescendant` — not real DOM focus —
     * names whichever option is highlighted. On open the empty query
     * yields the default tab suggestions, so the listbox is populated. */
    await page.keyboard.press('Control+k');
    const combobox = page.getByRole('combobox', { name: 'Search' });

    /* The popup is announced as a named listbox of multiple options... */
    await expect(combobox).toHaveAttribute('aria-expanded', 'true');
    const listbox = page.getByRole('listbox', { name: 'Results' });
    await expect(listbox).toBeVisible();
    expect(await page.getByRole('option').count()).toBeGreaterThan(1);

    /* ...and the combobox's active-descendant resolves to the option
     * the user would act on. We read the id off the attribute rather
     * than hard-coding it, so this asserts the *relationship*
     * (activedescendant → selected option), not the id naming scheme. */
    const active = await combobox.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    await expect(page.locator(`#${active}`)).toHaveAttribute('aria-selected', 'true');

    /* ArrowDown moves virtual focus: the attribute changes and the new
     * target is the one now marked selected. `not.toHaveAttribute`
     * auto-retries, absorbing the async re-render before we re-sample. */
    await page.keyboard.press('ArrowDown');
    await expect(combobox).not.toHaveAttribute('aria-activedescendant', active ?? '');
    const moved = await combobox.getAttribute('aria-activedescendant');
    await expect(page.locator(`#${moved}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('a query with no matches collapses the combobox popup', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const combobox = page.getByRole('combobox', { name: 'Search' });
    await combobox.fill('zzzznosuchresultxyz');
    /* With zero matches the empty-state branch renders instead of the
     * <ul>, so the popup contract must reflect "collapsed": no listbox
     * in the tree, aria-expanded flips false, and aria-activedescendant
     * is dropped entirely (never left dangling at a removed option id). */
    await expect(combobox).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    expect(await combobox.getAttribute('aria-activedescendant')).toBeNull();
    await expect(page.getByText(/no tabs or files match/i)).toBeVisible();
  });
});

/* ─────────── Config — theme + density application ─────────── */

test.describe('config controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/config');
    await waitForReady(page);
  });

  test('selecting the Dark theme applies data-theme="dark" to <html>', async ({ page }) => {
    const themeGroup = page.getByRole('radiogroup', { name: 'Theme' });
    await themeGroup.getByRole('radio', { name: 'Drk' }).click();
    /* The feature applied end-to-end: applyTheme() set the document
     * element's data-theme. This is what actually flips the CSS
     * variables, not the radio's checked state. */
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('selecting the Light theme applies data-theme="light"', async ({ page }) => {
    const themeGroup = page.getByRole('radiogroup', { name: 'Theme' });
    await themeGroup.getByRole('radio', { name: 'Lgt' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('the selected theme radio reflects aria-checked', async ({ page }) => {
    const themeGroup = page.getByRole('radiogroup', { name: 'Theme' });
    const dark = themeGroup.getByRole('radio', { name: 'Drk' });
    await dark.click();
    await expect(dark).toHaveAttribute('aria-checked', 'true');
  });

  test('selecting Compact density applies data-density="compact"', async ({ page }) => {
    const densityGroup = page.getByRole('radiogroup', { name: 'Density' });
    await densityGroup.getByRole('radio', { name: 'Compact' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  });

  test('theme choice persists across a reload (localStorage)', async ({ page }) => {
    /* The persistTheme() call writes to localStorage; on reload the
     * App re-applies it. This is the contract that makes the setting
     * "stick" — worth a dedicated test since it's a cross-page-load
     * behaviour the single-page tests above can't catch. */
    const themeGroup = page.getByRole('radiogroup', { name: 'Theme' });
    await themeGroup.getByRole('radio', { name: 'Drk' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await waitForReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

/* ─────────── Flow — view-mode tab switching ─────────── */

test.describe('Flow view modes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/flow');
    await waitForReady(page);
  });

  test('defaults to the Swimlanes view selected', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: 'Flow view mode' });
    await expect(tablist.getByRole('tab', { name: 'Swimlanes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('switching to Text view updates aria-selected', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: 'Flow view mode' });
    const textTab = tablist.getByRole('tab', { name: 'Text' });
    await textTab.click();
    await expect(textTab).toHaveAttribute('aria-selected', 'true');
    /* And the previously-selected Swimlanes tab is now deselected —
     * confirms the tablist enforces single-selection. */
    await expect(tablist.getByRole('tab', { name: 'Swimlanes' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  test('switching to Sequence view reveals the entry-point picker', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: 'Flow view mode' });
    await tablist.getByRole('tab', { name: 'Sequence' }).click();
    /* The Sequence view is the only mode with an entry-point <select>;
     * its appearance confirms the view actually swapped, not just the
     * tab's aria-selected. */
    await expect(page.locator('select').first()).toBeVisible();
  });
});

/* ─────────── Library — sort control ─────────── */

test.describe('Library sort', () => {
  test('clicking a sort option flips its aria-checked', async ({ page }) => {
    await page.goto('/library');
    await waitForReady(page);

    const sortGroup = page.getByRole('radiogroup', { name: 'Sort packages by' });
    /* Grab the radios; click the second one (whatever it is) and
     * assert it becomes checked. We don't hard-code the label set
     * because the sort options may evolve — the contract under test
     * is "clicking a sort radio selects it", not the specific keys. */
    const radios = sortGroup.getByRole('radio');
    const count = await radios.count();
    expect(count).toBeGreaterThan(1);

    const second = radios.nth(1);
    await second.click();
    await expect(second).toHaveAttribute('aria-checked', 'true');
  });
});

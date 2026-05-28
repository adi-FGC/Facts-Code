/**
 * Vulnerabilities route — deeper interaction test.
 *
 * The smoke spec already confirms the page loads + the H1 renders.
 * This spec exercises the form interaction surface:
 *
 *   1. Detected manifest list renders from the artifact.
 *   2. The "Scan now" button is disabled until the textarea has
 *      non-whitespace content.
 *   3. Clicking a manifest row populates the textarea with the
 *      "open file and paste" placeholder.
 *
 * Why the OSV network call isn't exercised here: see the
 * `test.fixme('OSV scan returns results', ...)` block below. That's
 * a design decision the team owns (stub vs live), and the helper
 * scaffolding is in place but unwired.
 */

import { expect, test, waitForReady } from './fixtures.js';

test.describe('Vulnerabilities — interaction surface', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/vulnerabilities');
    await waitForReady(page);
  });

  test('Scan button is disabled when textarea is empty', async ({ page }) => {
    const scanButton = page.getByRole('button', { name: /^Scan now$/ });
    await expect(scanButton).toBeDisabled();
  });

  test('Scan button enables after pasting non-empty content', async ({ page }) => {
    /* Simulating "user pastes a real manifest" with the simplest
     * possible package.json that flattenManifests will accept. The
     * exact contents don't matter for the enable-state test — only
     * that pasteText.trim() becomes non-empty. */
    const textarea = page.locator('#manifest-paste');
    await textarea.fill('{"name":"demo","dependencies":{"lodash":"4.17.20"}}');

    const scanButton = page.getByRole('button', { name: /^Scan now$/ });
    await expect(scanButton).toBeEnabled();
  });

  test('Clicking a detected manifest populates the textarea hint', async ({ page }) => {
    /* The "Detected manifests" list only renders when the artifact
     * carries dependencyManifests[]. If the loaded dataset has zero
     * manifests, skip — the assertion would be vacuous and a stale
     * artifact shouldn't fail the suite. */
    const manifestList = page.locator('text=/Detected manifests · \\d+/');
    const hasManifests = await manifestList.isVisible().catch(() => false);
    test.skip(!hasManifests, 'Loaded dataset has no dependency manifests to click.');

    /* Click the first manifest row. We don't care which one — any
     * row should trigger the same code path that writes the
     * placeholder hint into the textarea. */
    const firstManifestRow = page
      .locator('button[title^="Load "][title*=" hint into the paste box"]')
      .first();
    await firstManifestRow.click();

    const textarea = page.locator('#manifest-paste');
    /* The hint format is hardcoded in Vulnerabilities.tsx — assert
     * on the stable substring rather than the full text so future
     * wording tweaks don't break the test. */
    await expect(textarea).toHaveValue(/Open .+ in your editor and paste its contents here/);
  });

  test('Headline renders for either populated or scan-prompt state', async ({ page }) => {
    /* Headline is dataset-driven:
     *   - With artifact vulns: "N critical, M high, K total"
     *   - Without vulns + scan ready: "Check your dependencies against the OSV database."
     *   - Post-scan with results: same numeric format as the artifact branch.
     * Assert that ONE non-empty H1 mounted; the wording itself varies. */
    const h1 = page.locator('main h1').first();
    await expect(h1).toBeVisible();
    const text = await h1.textContent();
    expect(text?.trim().length ?? 0).toBeGreaterThan(0);
  });

  /* ────── OSV scan — deferred pending stub/live decision ──────
   *
   * The "click Scan now → assert results render" loop is intentionally
   * NOT implemented here. It requires picking ONE of two strategies:
   *
   *   A) STUB the OSV API. Add `page.route('https://api.osv.dev/**', …)`
   *      with canned responses. Tests run fast + deterministic, but pass
   *      even if our real osvScanner integration drifts from the live
   *      API shape.
   *
   *   B) HIT live OSV. Real network call against api.osv.dev. Catches
   *      "API shape changed" regressions, but tests become flaky on weak
   *      networks + impose a runtime dependency on a third party + need a
   *      `test.slow()` annotation (OSV calls take ~1-2s).
   *
   * The team that owns this feature picks based on what they're optimizing
   * for. The fixme below is the TODO marker; replace with a real test
   * once the strategy is chosen. */
  test.fixme('Scan returns results and renders advisory list', async ({ page: _page }) => {
    /* When implementing:
     *   1. Decide stub vs live (see comment above).
     *   2. If stub: add page.route() for https://api.osv.dev/v1/querybatch
     *      AND https://api.osv.dev/v1/vulns/{id} with realistic fixtures.
     *      Fixtures should live in test/e2e/fixtures/osv-*.json.
     *   3. Fill the textarea with a real package.json containing a
     *      KNOWN vulnerable version (lodash@4.17.20 is the canonical
     *      example FACTS uses in its own scanner tests).
     *   4. Click "Scan now", wait for the "Querying OSV…" label to
     *      disappear (scan complete signal).
     *   5. Assert: severity pill (.sevPillCritical or .sevPillHigh)
     *      renders, advisory ID matches /^(GHSA|CVE)-/, "fixed in"
     *      version appears, advisory URL links to a real domain. */
  });
});

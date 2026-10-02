/**
 * Docs tab rendering of real-world doc content (browser-scan datasets carry
 * doc bodies inline, so a swap is the most direct way to feed one in).
 *
 *   - UI-07  relative links inside a doc open the linked doc in-app
 *   - UI-08  fences with an info string don't swap code and prose
 *   - UI-12  HTML docs: CSP notice + source, never a broken styled iframe
 */
import { expect, test, waitForReady } from './fixtures.js';
import { makeDoc, swapDataset } from './swap.js';

test.describe('Docs rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/docs');
    await waitForReady(page);
  });

  test('a relative link opens the linked doc in the Docs tab (UI-07)', async ({ page }) => {
    await swapDataset(page, {
      docs: [
        makeDoc('guide/README.md', '# Guide\n\nRead [the next page](reference/next.md#top) now.'),
        makeDoc('guide/reference/next.md', '# Next\n\nNEXT-DOC-BODY'),
      ],
    });
    const main = page.locator('main section').first();
    await main.getByRole('link', { name: 'the next page' }).click();
    await expect(page).toHaveURL(/\/docs\?doc=guide%2Freference%2Fnext\.md$/);
    await expect(main.getByText('NEXT-DOC-BODY')).toBeVisible();
    await expect(main.getByText('guide/reference/next.md', { exact: true })).toBeVisible();

    /* Back to the /docs entry (no ?doc=) shows the doc it showed before. */
    await page.goBack();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(main.getByText('guide/README.md', { exact: true })).toBeVisible();
    await expect(main.getByText('NEXT-DOC-BODY')).toHaveCount(0);
  });

  test('a fence with an info string stays code, and the prose after it stays prose (UI-08)', async ({
    page,
  }) => {
    await swapDataset(page, {
      docs: [
        makeDoc(
          'guide/install.md',
          [
            '# Install',
            '',
            '```bash title="install"',
            '# install deps',
            'pnpm i',
            '```',
            '',
            '## Usage',
            '',
            'AFTER-FENCE-PROSE',
          ].join('\n'),
        ),
      ],
    });
    const main = page.locator('main section').first();
    await expect(main.locator('pre code')).toHaveText('# install deps\npnpm i');
    await expect(main.getByRole('heading', { name: 'Usage' })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'install deps' })).toHaveCount(0);
    await expect(main.locator('p', { hasText: 'AFTER-FENCE-PROSE' })).toBeVisible();
  });

  test('an HTML doc shows a notice and its source, not a CSP-broken iframe (UI-12)', async ({
    page,
  }) => {
    const html = '<style>body{background:red}</style><p>HTML-DOC-TEXT</p>';
    await swapDataset(page, {
      docs: [makeDoc('docs/page.html', html, { format: 'html', title: 'Page' })],
    });
    const main = page.locator('main section').first();
    await expect(main.getByText(/HTML preview is off/)).toBeVisible();
    await expect(main.locator('pre code')).toHaveText(html);
    await expect(page.locator('main iframe')).toHaveCount(0);
  });
});

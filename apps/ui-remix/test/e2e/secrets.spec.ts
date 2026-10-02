/**
 * Secrets view — a generic "possible secret" (category 'secret', severity
 * 'info', owner decision 2026-09-24) is listed but never counted as exposed,
 * in the Credentials view and in the Review verdict alike.
 */
import { SECRET_SCAN_MAX_BYTES } from '@factstack/spec/fs';
import { expect, test, waitForReady } from './fixtures.js';
import { clientNav, swapDataset, TINY_PROJECT } from './swap.js';

const risk = (severity: string, rule: string, file: string) => ({
  severity,
  category: 'secret',
  rule,
  file,
  line: 3,
  message: `${rule} finding`,
  preview: '***',
});

test.describe('possible secrets', () => {
  test('are listed apart from exposed ones and never read as "rotate these now"', async ({
    page,
  }) => {
    await page.goto('/credentials');
    await waitForReady(page);
    await swapDataset(page, {
      ...TINY_PROJECT,
      risks: [risk('info', 'env-secret-pair', '.env'), risk('low', 'github-token', 'test/k.ts')],
    });
    const main = page.locator('main#main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText('Nothing counts as exposed.');
    await expect(
      main.getByText('Credentials · 0 exposed · 1 in test/fixture files · 1 possible, not graded'),
    ).toBeVisible();
    await expect(main.getByText('possible secrets · not graded')).toBeVisible();
    /* UI-R7 — the lede no longer repeats the headline word for word… */
    await expect(main.getByText('Nothing counts as exposed.')).toHaveCount(1);
    /* …and the generic rule a possible secret came from has a reference row. */
    await expect(
      main.getByText(/Rule reference · \d+ patterns · 3 possible-secret heuristics/),
    ).toBeVisible();
    await expect(main.getByText('Secret-named config value')).toBeVisible();
    await expect(main.getByText('possible · not graded')).toHaveCount(3);

    await swapDataset(page, {
      ...TINY_PROJECT,
      risks: [risk('info', 'connection-string-password', 'src/db.ts')],
    });
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      'Only possible secrets to check.',
    );

    await swapDataset(page, {
      ...TINY_PROJECT,
      risks: [risk('high', 'github-token', 'src/k.ts'), risk('info', 'generic-secret', 'a.json')],
    });
    await expect(main.getByRole('heading', { level: 1 })).toHaveText('Rotate these now.');
    await expect(main.getByText('Credentials · 1 exposed · 1 possible, not graded')).toBeVisible();

    /* The Review verdict splits them the same way. */
    await clientNav(page, '/review');
    await expect(main.getByText('1 exposed secret').first()).toBeVisible();
    await expect(main.getByText('1 possible secret, not graded').first()).toBeVisible();
  });
});

/* The clean state said a browser GitHub scan fetches files up to 1 MB
   after that fetch moved to the shared 16 MB ceiling. */
test('the clean state states the one secret-scan size ceiling', async ({ page }) => {
  await page.goto('/credentials');
  await waitForReady(page);
  await swapDataset(page, TINY_PROJECT);
  const main = page.locator('main#main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('Nothing leaked.');
  const mb = SECRET_SCAN_MAX_BYTES / (1024 * 1024);
  await expect(
    main.getByText(`up to ${mb} MB, from the CLI or a GitHub scan in the browser`, {
      exact: false,
    }),
  ).toBeVisible();
  await expect(main.getByText('up to 1 MB', { exact: false })).toHaveCount(0);
});

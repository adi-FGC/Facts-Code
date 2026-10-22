/**
 * F-35 — a scan the host knew was incomplete (a truncated GitHub tree, files
 * it could not download) is said on the Overview before the grade, so a
 * partial repo never reads as a complete, clean one.
 */
import { expect, test, waitForReady } from './fixtures.js';
import { swapDataset } from './swap.js';

const CAVEAT =
  'GitHub truncated the file listing (the repository tree is too large for one request) — files past the cut-off are missing from this scan.';

test('the Overview leads with the partial-scan caveat when the artifact carries one', async ({
  page,
}) => {
  await page.goto('/');
  await waitForReady(page);
  await expect(page.getByText('Partial scan.')).toHaveCount(0);
  const project = await page.evaluate(
    () =>
      (
        JSON.parse(document.getElementById('factstack-data')?.textContent ?? '{}') as {
          project: Record<string, unknown>;
        }
      ).project,
  );
  await swapDataset(page, { project: { ...project, scanWarnings: [CAVEAT] } }, 'opened');
  const caveat = page.getByRole('status').filter({ hasText: 'Partial scan.' });
  await expect(caveat).toBeVisible();
  await expect(caveat).toContainText('files past the cut-off are missing');
  await expect(caveat).toContainText('The grade below covers only what was scanned.');
});

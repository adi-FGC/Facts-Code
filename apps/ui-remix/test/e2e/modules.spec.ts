/**
 * Modules tab (/modules). The smoke loop only proves the default sub-view
 * mounts; this opens both, so the console guard (fixtures.ts — errors and
 * Remix runtime warnings) sees the communities view too.
 */
import { expect, test, waitForReady } from './fixtures.js';

test('renders Key Files, then the Modules sub-view on click', async ({ page }) => {
  await page.goto('/modules');
  await waitForReady(page);

  const tabs = page.getByRole('tablist', { name: 'Modules view' });
  const keyFiles = tabs.getByRole('tab', { name: 'Key Files', exact: true });
  const modules = tabs.getByRole('tab', { name: 'Modules', exact: true });

  await expect(keyFiles).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Key files by graph centrality' }),
  ).toBeVisible();

  await modules.click();
  await expect(modules).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { level: 2, name: 'Modules', exact: true })).toBeVisible();
});

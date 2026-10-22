/**
 * Phone-width layout guards.
 *
 *   - ux#5   the status bar's health group (broken / todos / secrets) was
 *            pushed past 375px and clipped by the shell's overflow-x:hidden
 *   - UI-09  the Open modal's action row sat below a phone's viewport with
 *            no way to scroll to it
 */
import { expect, test, waitForReady } from './fixtures.js';
import type { Locator, Page } from '@playwright/test';

async function expectReachable(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const vp = page.viewportSize();
  expect(box).not.toBeNull();
  expect(vp).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  /* Whole pixels: scrollTop snaps to integers while text rows have fractional
     heights, so a "nearest" scroll can leave the control a fraction of a pixel
     past the edge (667.14 on a 667px phone once the GitHub form grew its
     remember-token row). That is reachable; a whole missing pixel is not. */
  expect(Math.round(box!.y + box!.height)).toBeLessThanOrEqual(vp!.height);
}

test.describe('phone layout', () => {
  test('status bar keeps broken / todos / secrets on screen at 375px (ux#5)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await waitForReady(page);
    const footer = page.getByRole('contentinfo');
    const { scrollWidth, clientWidth } = await footer.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    for (const label of ['broken', 'todos', 'secrets']) {
      const box = await footer.getByText(label, { exact: true }).boundingBox();
      expect(box, label).not.toBeNull();
      expect(box!.x + box!.width, label).toBeLessThanOrEqual(375);
    }
  });

  for (const mode of ['local', 'github'] as const) {
    test(`Open modal's primary action is reachable on a 375×667 phone (${mode}, UI-09)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto('/');
      await waitForReady(page);
      await page.evaluate(
        (m) => window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: m } })),
        mode,
      );
      const dialog = page.getByRole('dialog', { name: 'Open project for analysis' });
      const primary = dialog.getByRole('button', {
        name: mode === 'local' ? /choose folder/i : /fetch & analyze/i,
      });
      await expect(primary).toBeAttached();
      await expectReachable(page, primary);
      /* Close / Cancel sits in the same row. */
      await expectReachable(page, dialog.getByRole('button', { name: 'Close', exact: true }));
    });
  }
});

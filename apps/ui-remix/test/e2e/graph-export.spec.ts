/**
 * Graph tab — view-mode toggle + Mermaid export coverage.
 *
 * The pre-existing suite tests the *Flow* tab's view toggle but never the
 * *Graph* tab's, and nothing exercised the Export Mermaid buttons (copy +
 * download) shipped this session. This spec closes both gaps: it drives the
 * Graph "Diagram" lens and both export buttons in a real browser.
 *
 * Selectors mirror the actual DOM contract:
 *   - toggle: role="tablist" "Graph view mode" → role="tab" "Diagram" etc,
 *     single-selection via aria-selected (ViewModeToggle.tsx).
 *   - export: role="group" "Export diagram" → 2 buttons whose labels mutate
 *     (Copy Mermaid → Copying… → Copied ✓), so position-locate, not by name.
 */
import { expect, test, waitForReady } from './fixtures.js';

/** Open Graph → Diagram lens (where the export group lives). */
async function gotoGraphDiagram(page: import('@playwright/test').Page) {
  await page.goto('/graph');
  await waitForReady(page);
  const tablist = page.getByRole('tablist', { name: 'Graph view mode' });
  await tablist.getByRole('tab', { name: 'Diagram' }).click();
  await expect(tablist.getByRole('tab', { name: 'Diagram' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

test.describe('Graph view-mode toggle', () => {
  test('defaults to Heatmap selected', async ({ page }) => {
    await page.goto('/graph');
    await waitForReady(page);
    const tablist = page.getByRole('tablist', { name: 'Graph view mode' });
    await expect(tablist.getByRole('tab', { name: 'Heatmap' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('switching to Diagram updates aria-selected and mounts the SVG', async ({ page }) => {
    await page.goto('/graph');
    await waitForReady(page);
    const tablist = page.getByRole('tablist', { name: 'Graph view mode' });
    await tablist.getByRole('tab', { name: 'Diagram' }).click();
    await expect(tablist.getByRole('tab', { name: 'Diagram' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(tablist.getByRole('tab', { name: 'Heatmap' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    /* The Diagram lens is the only one that mounts the Sugiyama SVG —
     * confirms the view actually swapped, not just the tab's aria state. */
    await expect(page.locator('svg').first()).toBeVisible();
  });

  test('switching to Layers updates aria-selected', async ({ page }) => {
    await page.goto('/graph');
    await waitForReady(page);
    const tablist = page.getByRole('tablist', { name: 'Graph view mode' });
    await tablist.getByRole('tab', { name: 'Layers' }).click();
    await expect(tablist.getByRole('tab', { name: 'Layers' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

test.describe('Graph export Mermaid', () => {
  // Clipboard read/write needs an explicit grant in headless Chromium.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('Diagram lens shows the Export group with both buttons', async ({ page }) => {
    await gotoGraphDiagram(page);
    const group = page.getByRole('group', { name: 'Export diagram' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('button')).toHaveCount(2);
    await expect(group.getByRole('button', { name: /copy mermaid/i })).toBeVisible();
    await expect(group.getByRole('button', { name: /download \.mmd/i })).toBeVisible();
  });

  test('Copy Mermaid puts a fenced flowchart on the clipboard', async ({ page }) => {
    await gotoGraphDiagram(page);
    const group = page.getByRole('group', { name: 'Export diagram' });
    await group.getByRole('button').nth(0).click();
    await expect(group.getByRole('button', { name: /copied/i })).toBeVisible({
      timeout: 5_000,
    });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip.startsWith('```mermaid')).toBe(true);
    expect(clip).toContain('flowchart LR');
    expect(clip.trimEnd().endsWith('```')).toBe(true);
  });

  test('Download .mmd saves raw (unfenced) Mermaid source', async ({ page }) => {
    await gotoGraphDiagram(page);
    const group = page.getByRole('group', { name: 'Export diagram' });
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    await group.getByRole('button').nth(1).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('factstack-graph.mmd');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    const content = Buffer.concat(chunks).toString('utf8');
    expect(content.startsWith('flowchart LR')).toBe(true);
    expect(content).not.toContain('```'); // raw source, not markdown
  });
});

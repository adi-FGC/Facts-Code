/**
 * Architecture → Graph → Diagram: a ctrl/⌘ + wheel zoom must stick. The
 * first zoom tells GraphRoute to enable Reset, which re-renders the route.
 * The diagram layout used to be rebuilt on that render, and SugiyamaDag
 * resets to 100% on any new layout object, so every gesture snapped back.
 */
import { expect, test, waitForReady } from './fixtures.js';

const IDENTITY = 'translate(0 0) scale(1)';

test('a ctrl+wheel zoom on the diagram sticks, enables Reset, and Reset restores it', async ({
  page,
}) => {
  await page.goto('/architecture');
  await waitForReady(page);
  await page
    .getByRole('tablist', { name: 'Graph view mode' })
    .getByRole('tab', { name: 'Diagram' })
    .click();

  const diagram = page.getByRole('img', { name: /^Layered dependency diagram/ });
  await expect(diagram).toBeVisible();
  const zoomGroup = diagram.locator(':scope > g[transform]').first();
  await expect(zoomGroup).toHaveAttribute('transform', IDENTITY);

  const box = await diagram.boundingBox();
  if (!box) throw new Error('diagram has no layout box');
  await diagram.dispatchEvent('wheel', {
    deltaY: -400,
    ctrlKey: true,
    clientX: box.x + 40,
    clientY: box.y + 40,
  });

  const reset = page.getByRole('button', { name: 'Reset' });
  await expect(reset).toBeEnabled();
  // The route re-render that enabled Reset must not reset the view.
  await expect(zoomGroup).not.toHaveAttribute('transform', IDENTITY);
  await expect(reset).toBeEnabled();

  await reset.click();
  await expect(zoomGroup).toHaveAttribute('transform', IDENTITY);
  await expect(reset).toBeDisabled();
});

test('leaving Diagram while zoomed and coming back starts at 100% with Reset off', async ({
  page,
}) => {
  await page.goto('/architecture');
  await waitForReady(page);
  const modes = page.getByRole('tablist', { name: 'Graph view mode' });
  await modes.getByRole('tab', { name: 'Diagram' }).click();

  const diagram = page.getByRole('img', { name: /^Layered dependency diagram/ });
  await expect(diagram).toBeVisible();
  const box = await diagram.boundingBox();
  if (!box) throw new Error('diagram has no layout box');
  await diagram.dispatchEvent('wheel', {
    deltaY: -400,
    ctrlKey: true,
    clientX: box.x + 40,
    clientY: box.y + 40,
  });
  const reset = page.getByRole('button', { name: 'Reset' });
  await expect(reset).toBeEnabled();

  await modes.getByRole('tab', { name: 'Heatmap' }).click();
  await modes.getByRole('tab', { name: 'Diagram' }).click();
  await expect(diagram.locator(':scope > g[transform]').first()).toHaveAttribute(
    'transform',
    IDENTITY,
  );
  await expect(reset).toBeDisabled();
});

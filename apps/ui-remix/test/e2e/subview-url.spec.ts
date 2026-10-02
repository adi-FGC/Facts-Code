/**
 * UI-06 — sub-view tabs follow the URL after mount, not only at mount.
 *
 * Files hosts Files | Packages in one SubViewTabs instance. With Packages
 * showing, picking a file (⌘K, the left tree, any /files?p= link) navigates
 * in-app to /files?p=…; the instance survives, so it used to keep showing
 * Packages and the file detail never appeared.
 */
import type { Page } from '@playwright/test';
import { expect, test, waitForReady } from './fixtures.js';
import { bakedDataset, clientNav, makeDoc, swapDataset } from './swap.js';

type TreeNode = { files: Array<{ path: string; name: string }>; children: TreeNode[] };

/** A file from the baked tree (shallowest first). The tree is a section the
 *  build serves beside the page, not part of the inline block. */
async function firstFile(page: Page): Promise<{ path: string; name: string }> {
  const { tree } = await bakedDataset<{ tree: TreeNode }>(page, ['tree']);
  const stack = [tree];
  while (stack.length) {
    const n = stack.shift()!;
    const f = n.files[0];
    if (f) return { path: f.path, name: f.name };
    stack.push(...n.children);
  }
  throw new Error('the baked tree has no files');
}

test('a /files?p= link switches Packages back to the file detail', async ({ page }) => {
  await page.goto('/files');
  await waitForReady(page);
  const filesTab = page.getByRole('tab', { name: 'Files', exact: true });
  const packagesTab = page.getByRole('tab', { name: 'Packages', exact: true });
  await packagesTab.click();
  await expect(packagesTab).toHaveAttribute('aria-selected', 'true');

  const file = await firstFile(page);
  await clientNav(page, `/files?p=${encodeURIComponent(file.path)}`);
  await expect(filesTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('main h1')).toHaveText(file.name);

  /* URL-driven, not a user pick: the remembered choice is still Packages. */
  expect(await page.evaluate(() => localStorage.getItem('factstack:files-view'))).toBe('packages');
});

test('re-picking the file already in ?p= switches Packages back to Files', async ({ page }) => {
  await page.goto('/files');
  await waitForReady(page);
  const file = await firstFile(page);
  const href = `/files?p=${encodeURIComponent(file.path)}`;
  await clientNav(page, href);
  const filesTab = page.getByRole('tab', { name: 'Files', exact: true });
  const packagesTab = page.getByRole('tab', { name: 'Packages', exact: true });
  await expect(filesTab).toHaveAttribute('aria-selected', 'true');
  await packagesTab.click();
  await expect(packagesTab).toHaveAttribute('aria-selected', 'true');

  /* The same link the tree / ⌘K would follow, clicked through the SPA's
     global link handler. */
  await page.evaluate((h) => {
    const a = document.createElement('a');
    a.href = h;
    a.id = 'repick-link';
    a.textContent = 'repick';
    document.body.append(a);
  }, href);
  await page.locator('#repick-link').click();
  await expect(page).toHaveURL(href);
  await expect(filesTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('main h1')).toHaveText(file.name);
});

test('a fragment nav after a doc pick keeps the sub-view the user chose', async ({ page }) => {
  await page.goto('/docs');
  await waitForReady(page);
  await swapDataset(page, {
    docs: [makeDoc('docs/a.md', '# A\n\nA-BODY'), makeDoc('docs/b.md', '# B\n\nB-BODY')],
  });
  /* Picking from the list rewrites ?doc= in place (replaceState, no event). */
  await page.locator('main aside button', { hasText: 'b.md' }).click();
  await expect(page).toHaveURL(/\/docs\?doc=docs%2Fb\.md$/);

  const todosTab = page.getByRole('tab', { name: 'Todos', exact: true });
  await todosTab.click();
  await expect(todosTab).toHaveAttribute('aria-selected', 'true');

  /* Same URL + a fragment (what the skip link does); fires popstate. Wait
     for it and a couple of frames so any re-render has landed. */
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        window.addEventListener(
          'popstate',
          () => requestAnimationFrame(() => requestAnimationFrame(() => done())),
          { once: true },
        );
        location.hash = 'main';
      }),
  );
  await expect(page).toHaveURL(/#main$/);
  await expect(todosTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Browse', exact: true })).toHaveAttribute(
    'aria-selected',
    'false',
  );
});

/**
 * Scan sessions (D-10) — a GitHub scan persists in this browser's IndexedDB.
 *
 *   - SS-5  while files download, the progress rail names the step;
 *   - SS-3  reopening the same commit restores the finished scan and
 *           downloads no file again.
 *
 * GitHub is stubbed at the network layer (the scan runs in the worker, whose
 * fetches Playwright routes too), so nothing leaves the machine.
 */
import type { Page } from '@playwright/test';
import { expect, test, waitForReady } from './fixtures.js';

const SHA = 'c'.repeat(40);
const FILES = Array.from({ length: 40 }, (_, i) => ({
  path: `src/m${i}.ts`,
  body: `export const m${i} = ${i};\n`,
}));

async function openGithub(page: Page) {
  await page.goto('/');
  await waitForReady(page);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: 'github' } })),
  );
  const dialog = page.getByRole('dialog', { name: 'Open project for analysis' });
  await expect(dialog.getByLabel('Repository')).toBeVisible();
  return dialog;
}

/** A complete 40-file repo at one commit; each blob answers after `delayMs`.
 *  Returns a counter of raw-file requests the worker actually made. */
async function stubRepo(page: Page, delayMs: number) {
  const cors = { 'access-control-allow-origin': '*' };
  const raw = { count: 0 };
  await page.route('https://api.github.com/**', (r) => {
    const url = r.request().url();
    if (url.includes('/commits/')) return r.fulfill({ status: 200, headers: cors, body: SHA });
    if (url.includes('/git/trees/')) {
      return r.fulfill({
        status: 200,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({
          truncated: false,
          tree: FILES.map((f, i) => ({
            path: f.path,
            type: 'blob',
            mode: '100644',
            size: f.body.length,
            sha: String(i).padStart(40, '0'),
          })),
        }),
      });
    }
    return r.fulfill({ status: 404, headers: cors, body: 'not stubbed' });
  });
  await page.route('https://raw.githubusercontent.com/**', async (r) => {
    raw.count++;
    const path = decodeURIComponent(
      new URL(r.request().url()).pathname.split('/').slice(4).join('/'),
    );
    const f = FILES.find((x) => x.path === path);
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    return f
      ? r.fulfill({ status: 200, headers: cors, contentType: 'text/plain', body: f.body })
      : r.fulfill({ status: 404, headers: cors, body: 'nope' });
  });
  return raw;
}

test('the progress rail names the step while files download (SS-5)', async ({ page }) => {
  await stubRepo(page, 200);
  const dialog = await openGithub(page);
  await dialog.getByLabel('Repository').fill('octo/forty');
  await dialog.getByRole('button', { name: /fetch & analyze/i }).click();
  await expect(dialog.getByText(/Step 2 of 3 · Fetching files/)).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole('progressbar')).toBeVisible();
  await expect(dialog.getByText('Scan complete')).toBeVisible({ timeout: 30_000 });
});

test('reopening the same commit restores the scan without downloading a file (SS-3)', async ({
  page,
}) => {
  const raw = await stubRepo(page, 0);
  const first = await openGithub(page);
  await first.getByLabel('Repository').fill('octo/forty');
  await first.getByRole('button', { name: /fetch & analyze/i }).click();
  await expect(first.getByText('Scan complete')).toBeVisible({ timeout: 30_000 });
  expect(raw.count).toBe(FILES.length);
  await expect(first.getByText(/Restored from this browser/)).toHaveCount(0);

  // A reload later (openGithub navigates), the same commit comes back from
  // IndexedDB: no raw-file request, and the panel says so.
  const again = await openGithub(page);
  await again.getByLabel('Repository').fill('octo/forty');
  await again.getByRole('button', { name: /fetch & analyze/i }).click();
  await expect(again.getByText('Scan complete')).toBeVisible({ timeout: 30_000 });
  await expect(again.getByText(/Restored from this browser/)).toBeVisible();
  expect(raw.count).toBe(FILES.length);
});

test('Config lists the saved scans and can forget one or clear everything', async ({ page }) => {
  await stubRepo(page, 0);
  const dialog = await openGithub(page);
  await dialog.getByLabel('Repository').fill('octo/forty');
  await dialog.getByRole('button', { name: /fetch & analyze/i }).click();
  await expect(dialog.getByText('Scan complete')).toBeVisible({ timeout: 30_000 });

  await page.goto('/config');
  await waitForReady(page);
  await expect(page.getByText(/1 saved scan/)).toBeVisible();
  const list = page.getByRole('list', { name: 'Saved scans' });
  await expect(list.getByText('octo/forty')).toBeVisible();
  await expect(list.getByText(/GitHub · commit ccccccc · 40 files/)).toBeVisible();

  // Forget drops the result; the shared file text stays tracked until Clear.
  await page.getByRole('button', { name: 'Forget the saved scan of octo/forty' }).click();
  await expect(page.getByText('No scans saved')).toBeVisible();
  const clear = page.getByRole('button', { name: 'Clear saved scans' });
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(page.getByText(/^0 B of file text and parses tracked/)).toBeVisible();
  await expect(clear).toBeDisabled();
});

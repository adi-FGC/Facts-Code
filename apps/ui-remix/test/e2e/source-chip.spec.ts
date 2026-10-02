/**
 * UI-13 — the header source chip names the project actually on screen.
 *
 * A folder-input scan (no File System Access: Firefox, Safari, or after FSA
 * failed) has no handle, so it can't become a recent. It used to fall into
 * the GitHub branch of the recents bookkeeping and change nothing, so after
 * GitHub → folder the chip still named the GitHub repo over the folder's data.
 *
 * GitHub is stubbed at the network layer (the scan runs in the worker, whose
 * fetches Playwright routes too), so nothing leaves the machine.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, waitForReady } from './fixtures.js';

const SHA = 'a'.repeat(40);
const README = '# Hello\n\nA tiny stub repo.\n';

test('a folder-input scan after a GitHub scan re-labels the source chip', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'fx-chip-'));
  const dir = join(root, 'my-app');
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), '{"name":"my-app","version":"1.0.0"}\n');
  writeFileSync(join(dir, 'index.js'), 'export const answer = 42;\n');

  try {
    const cors = { 'access-control-allow-origin': '*' };
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
            tree: [
              { path: 'README.md', type: 'blob', mode: '100644', size: README.length, sha: SHA },
            ],
          }),
        });
      }
      return r.fulfill({ status: 404, headers: cors, body: 'not stubbed' });
    });
    await page.route('https://raw.githubusercontent.com/**', (r) =>
      r.fulfill({ status: 200, headers: cors, contentType: 'text/plain', body: README }),
    );
    /* No FSA → "Choose folder…" opens the <input webkitdirectory> path. */
    await page.addInitScript(() => {
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await waitForReady(page);
    const chip = page.getByRole('button', { name: /^Currently showing:/ });
    const dialog = page.getByRole('dialog', { name: 'Open project for analysis' });

    // 1. GitHub scan → the chip names the repo.
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: 'github' } })),
    );
    await dialog.getByLabel('Repository').fill('octo/hello');
    await dialog.getByRole('button', { name: /fetch & analyze/i }).click();
    await expect(dialog.getByText('Scan complete')).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveAttribute('aria-label', /Currently showing: octo\/hello.*GitHub repo/);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // 2. Folder-input scan of my-app → the chip must follow.
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: 'local' } })),
    );
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: /choose folder/i }).click();
    await (await chooser).setFiles(dir);
    await expect(dialog.getByText('Scan complete')).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveAttribute('aria-label', /Currently showing: my-app/);
    await expect(chip).not.toHaveAttribute('aria-label', /GitHub repo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

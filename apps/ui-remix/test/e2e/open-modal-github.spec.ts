/**
 * OpenModal — the GitHub side.
 *
 *   - UI-01  a stored personal access token can be forgotten from the UI;
 *   - UI-02  an incomplete download (truncated tree, failed files) says so
 *            after the scan instead of reading as a complete scan;
 *   - FSB-7  Save after a GitHub scan does not write that repo's agent-rules
 *            files into the picked folder unless asked.
 *
 * GitHub is stubbed at the network layer (the scan runs in the worker, whose
 * fetches Playwright routes too), so nothing leaves the machine.
 */
import type { Page } from '@playwright/test';
import { expect, test, waitForReady } from './fixtures.js';

const SHA = 'b'.repeat(40);
const README = '# Hello\n\nA tiny stub repo.\n';
const TOKEN_KEY = 'factstack:gh-token';

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

/** A one-file repo whose tree listing GitHub reports as truncated. */
async function stubTruncatedRepo(page: Page) {
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
          truncated: true,
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
}

test('a stored GitHub token can be forgotten (UI-01)', async ({ page }) => {
  // Not a token shape: the field and storage only need a non-empty value.
  await page.addInitScript((k) => localStorage.setItem(k, 'stored-e2e-value'), TOKEN_KEY);
  const dialog = await openGithub(page);
  const pat = dialog.getByLabel(/Personal access token/);
  await expect(pat).toHaveValue('stored-e2e-value');

  await dialog.getByRole('button', { name: 'Forget token' }).click();
  await expect(pat).toHaveValue('');
  expect(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)).toBeNull();
  await expect(dialog.getByRole('button', { name: 'Forget token' })).toHaveCount(0);

  // Typing one brings the control back; forgetting clears what was typed.
  await pat.fill('typed-e2e-value');
  await dialog.getByRole('button', { name: 'Forget token' }).click();
  await expect(pat).toHaveValue('');
});

test('an incomplete GitHub download is flagged and agent rules default off', async ({ page }) => {
  await stubTruncatedRepo(page);
  const dialog = await openGithub(page);
  await dialog.getByLabel('Repository').fill('octo/huge');
  await dialog.getByRole('button', { name: /fetch & analyze/i }).click();
  await expect(dialog.getByText('Scan complete')).toBeVisible({ timeout: 30_000 });

  // UI-02 — the worker's meta.warnings reach the post-scan panel.
  const warning = dialog.getByRole('status').filter({ hasText: 'Incomplete scan' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('GitHub truncated the file listing');

  // FSB-7 — rules describing octo/huge are not written by default.
  const rules = dialog.getByRole('checkbox');
  await expect(rules).toHaveAttribute('aria-checked', 'false');
  await expect(rules).toHaveText('Skip');
  await expect(dialog.getByText(/These files describe octo\/huge/)).toBeVisible();
  await rules.click();
  await expect(rules).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByText(/AGENTS\.md, \.cursorrules, \.github\/copilot/)).toBeVisible();
  /* UI-R8 — the Claude SKILL.md is FACTS-managed and always refreshed
     (skills orchestrator); only the other three are kept when hand-written. */
  await expect(dialog.getByText(/the FACTS skill file is refreshed/)).toBeVisible();
  await expect(dialog.getByText(/Hand-written ones are kept, never overwritten/)).toHaveCount(0);
});

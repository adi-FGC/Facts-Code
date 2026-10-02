/**
 * Failure paths: a chunk or worker that doesn't load must leave the user a
 * way forward, not a dead screen.
 *
 *   - UI-11  a failed lazy tab load recovers on the next visit / Try again
 *   - UI-10  a stale scanner chunk surfaces an error; a scan whose worker
 *            never answers can be cancelled (button or Escape)
 *   - performance#5  a dataset section that does not load fails the load
 *            with the reload hint, never renders as an empty tab
 *
 * These specs make loads fail on purpose, so the browser logs "Failed to
 * load resource" errors by design: they use Playwright's base `test`, not
 * the console-error-failing fixture, and assert on what the user sees.
 */
import { expect, test, type Page } from '@playwright/test';
import { waitForReady } from './fixtures.js';
import { clientNav, simulateSplitSections, type SectionResponse } from './swap.js';

const ARCH_CHUNK = /\/assets\/Architecture-[\w-]+\.js$/;
const BRIDGE_CHUNK = /\/assets\/scannerBridge-[\w-]+\.js$/;

test.describe('lazy tab load failure (UI-11)', () => {
  test('the next visit to the tab retries the load', async ({ page }) => {
    let fail = true;
    await page.route(ARCH_CHUNK, (r) => (fail ? r.abort() : r.continue()));
    await page.goto('/architecture');
    await waitForReady(page);
    await expect(page.getByRole('heading', { name: 'This view didn’t load.' })).toBeVisible();

    fail = false;
    await clientNav(page, '/');
    await clientNav(page, '/architecture');
    await expect(page.getByRole('heading', { name: 'Where the dependency lives.' })).toBeVisible();
  });

  test('Try again reloads the tab in place', async ({ page }) => {
    let fail = true;
    await page.route(ARCH_CHUNK, (r) => (fail ? r.abort() : r.continue()));
    await page.goto('/architecture');
    await waitForReady(page);
    await expect(page.getByRole('heading', { name: 'This view didn’t load.' })).toBeVisible();

    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Where the dependency lives.' })).toBeVisible();
  });
});

async function openGithub(page: Page) {
  await page.goto('/');
  await waitForReady(page);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: 'github' } })),
  );
  const dialog = page.getByRole('dialog', { name: 'Open project for analysis' });
  await dialog.getByLabel('Repository').fill('octo/hello');
  return dialog;
}

test.describe('scan failure paths (UI-10)', () => {
  test('a stale scanner chunk shows an error instead of doing nothing', async ({ page }) => {
    /* After a redeploy the host answers an old hashed chunk with index.html. */
    await page.route(/\/assets\/scannerBridge-[\w-]+\.js$/, (r) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>x</title>' }),
    );
    const dialog = await openGithub(page);
    await dialog.getByRole('button', { name: /fetch & analyze/i }).click();
    await expect(dialog.getByRole('alert')).toContainText(/reload/i);
    await expect(dialog.getByRole('button', { name: /fetch & analyze/i })).toBeEnabled();
  });

  for (const how of ['button', 'Escape'] as const) {
    test(`a scan whose worker never answers can be cancelled (${how})`, async ({ page }) => {
      await page.route(/\/assets\/scanner\.worker-[\w-]+\.js$/, (r) =>
        r.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: 'self.onmessage = () => {};',
        }),
      );
      const dialog = await openGithub(page);
      await dialog.getByRole('button', { name: /fetch & analyze/i }).click();
      await expect(dialog.getByRole('button', { name: 'Analyzing…' })).toBeVisible();

      if (how === 'button') await dialog.getByRole('button', { name: 'Cancel scan' }).click();
      else await page.keyboard.press('Escape');

      await expect(dialog.getByRole('button', { name: /fetch & analyze/i })).toBeEnabled();
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    });
  }

  /* Choose folder: the picked folder puts the modal in 'picking' (Cancel
     enabled) while the scanner chunk downloads. The chunk request is held
     open so the test controls the timing, then failed. `failed` resolves
     only if that request really happened and failed, so no test here can
     pass without exercising the load-failure path. */
  async function pickFolderWithHeldBridge(page: Page) {
    await page.addInitScript(() => {
      (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = () =>
        Promise.resolve({ kind: 'directory', name: 'proj' });
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(BRIDGE_CHUNK, async (r) => {
      await held;
      await r.abort();
    });
    await page.goto('/');
    await waitForReady(page);
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('factstack:open', { detail: { mode: 'local' } })),
    );
    const dialog = page.getByRole('dialog', { name: 'Open project for analysis' });
    const failed = page.waitForEvent('requestfailed', {
      predicate: (req) => BRIDGE_CHUNK.test(req.url()),
      timeout: 10_000,
    });
    await dialog.getByRole('button', { name: /choose folder/i }).click();
    await expect(dialog.getByRole('button', { name: 'Cancel scan' })).toBeVisible();
    return { dialog, release, failed };
  }

  test('a stale scanner chunk after Choose folder shows an error', async ({ page }) => {
    const { dialog, release, failed } = await pickFolderWithHeldBridge(page);
    release();
    await failed;
    await expect(dialog.getByRole('alert')).toContainText(/reload/i);
  });

  for (const how of ['button', 'Escape'] as const) {
    test(`cancelling (${how}) while the scanner chunk loads stays cancelled if it then fails`, async ({
      page,
    }) => {
      const { dialog, release, failed } = await pickFolderWithHeldBridge(page);
      if (how === 'button') await dialog.getByRole('button', { name: 'Cancel scan' }).click();
      else await page.keyboard.press('Escape');
      await expect(dialog.getByRole('button', { name: /choose folder/i })).toBeEnabled();

      release();
      await failed;
      /* Let the rejected import's catch and any re-render run before
         asserting absence; the test above shows the alert well within this. */
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    });
  }
});

/* The page is served as a --split-sections build (simulated, so this runs on
   any build); the docs section fails, the edges section loads. */
test.describe('dataset section load failure (performance#5)', () => {
  const cases: Array<{ what: string; docs: SectionResponse; diag: RegExp }> = [
    {
      what: 'a section that 404s',
      docs: { status: 404, body: 'Not found' },
      diag: /^HTTP 404 loading the dataset's docs section \(.+\) — .*reload\.$/,
    },
    {
      /* A newer deploy renamed the file; the SPA fallback answers 200 HTML. */
      what: "a section answered with the SPA's index.html",
      docs: { status: 200, contentType: 'text/html', body: '<!doctype html><title>x</title>' },
      diag: /^Could not parse the dataset's docs section \(.+\) — .*reload\.$/,
    },
  ];
  for (const { what, docs, diag } of cases) {
    test(`${what} shows the reload hint, never an empty tab`, async ({ page }) => {
      await simulateSplitSections(page, ['edges', 'docs'], { fail: { docs } });
      await page.goto('/docs');
      await expect(
        page.getByRole('heading', { name: /^Nothing to analyze yet\.?$/ }),
      ).toBeVisible();
      await expect(page.getByText(diag)).toBeVisible();
      await expect(page.locator('main#main')).toHaveCount(0);
    });
  }
});

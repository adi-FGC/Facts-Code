/**
 * State that must not survive a dataset hot-swap (⌘O scan / Re-analyze).
 *
 * The Shell keeps every mounted component across a `factstack:dataset` swap
 * and re-renders it with the new data, so anything a component cached for
 * the OLD dataset leaks into the new project unless it is keyed to the data.
 *
 *   - UI-03  Docs preview body cache (was keyed by path)
 *   - UI-04  Vulnerabilities weekly OSV re-check (ran once per mount)
 *   - UI-05  Token panel artifact size (read the baked inline block)
 *   - UI-15  Overview headline renders the README tagline's Markdown
 *   - UI-16  Token panel's matchMedia listener (never removed on unmount)
 */
import { expect, test, waitForReady } from './fixtures.js';
import { bakedDataset, clientNav, swapDataset, TINY_PROJECT } from './swap.js';
import { CHARS_PER_TOKEN, fmtTokens } from '../../src/lib/tokenEconomics.js';

test.describe('dataset hot-swap', () => {
  test('repeated swaps to a CSS-less project keep the dashboard mounted', async ({ page }) => {
    /* The CSS drawer (the Shell's last child) rendered an empty fragment
       for a project without styles; the NEXT swap then wiped #root — the
       second ⌘O scan of a session blanked the whole dashboard. */
    await page.goto('/');
    await waitForReady(page);
    for (const name of ['first', 'second', 'third']) {
      await swapDataset(page, {
        ...TINY_PROJECT,
        project: { name, root: name, languages: [], frameworks: [] },
      });
      await expect(page.locator('main#main')).toBeVisible();
      await expect(page.getByRole('contentinfo')).toBeVisible();
    }
  });

  test('Docs shows the new dataset’s body for a doc at the same path (UI-03)', async ({ page }) => {
    const bodyReq = page.waitForResponse((r) => /\/data\/docs\/[0-9a-f]{16}\.json$/.test(r.url()));
    await page.goto('/docs');
    await waitForReady(page);
    expect((await bodyReq).ok()).toBe(true);
    const main = page.locator('main section').first();
    await expect(main.getByText('Loading document…')).toHaveCount(0);

    /* Same path as the doc whose body was just fetched, but inline content —
       what a browser scan of another repo with the same README.md produces.
       The docs come from the build's docs section, not the inline block. */
    const { docs } = await bakedDataset<{ docs: Array<Record<string, unknown>> }>(page, ['docs']);
    const first: Record<string, unknown> = {
      ...docs[0],
      format: 'markdown',
      content: 'SWAPPED-BODY-MARKER',
    };
    delete first.contentUrl;
    await swapDataset(page, { docs: [first] });
    await expect(main.getByText('SWAPPED-BODY-MARKER')).toBeVisible();
  });

  test('a weekly OSV re-check is not shown for the next project (UI-04)', async ({ page }) => {
    /* Never touch the network: the re-check below is served from this
       browser's weekly cache, and anything else would fail loudly. */
    await page.route('**/api.osv.dev/**', (r) => r.abort());
    await page.goto('/');
    await waitForReady(page);
    await page.evaluate(() =>
      localStorage.setItem(
        'factstack:osv:auto',
        JSON.stringify({
          at: Date.now(),
          fingerprint: 'npm:left-pad@1.3.0',
          results: [
            {
              query: { ecosystem: 'npm', name: 'left-pad', version: '1.3.0' },
              vulns: [],
            },
          ],
        }),
      ),
    );
    const noScan = { vulnerabilities: [], vulnerabilityScan: undefined };
    await swapDataset(page, {
      ...noScan,
      dependencyManifests: [
        { path: 'package.json', ecosystem: 'npm', dependencies: { 'left-pad': '1.3.0' } },
      ],
    });
    await clientNav(page, '/vulnerabilities');
    const recheck = page.getByText(/re-checked in your browser/);
    await expect(recheck).toBeVisible();

    await swapDataset(page, { ...noScan, dependencyManifests: [] });
    await expect(recheck).toHaveCount(0);
    await expect(page.locator('main h1')).toHaveText(
      'Check your dependencies against the OSV database.',
    );
  });

  test('token panel prices the dataset on screen, not the baked one (UI-05)', async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
    await swapDataset(page, TINY_PROJECT);
    await expect(page.locator('main h1')).toBeVisible();
    const chars = await page.evaluate(
      () => JSON.stringify((window as unknown as { __swapped: unknown }).__swapped).length,
    );
    const artifact = fmtTokens(Math.round(chars / CHARS_PER_TOKEN));
    /* The flow diagram only renders when the artifact is smaller than the
       codebase — false for every swap while the baked 180K+ figure stuck. */
    const flow = page.getByRole('img', { name: /^Token flow:/ });
    await expect(flow).toHaveAttribute(
      'aria-label',
      new RegExp(`reading the FACTS artifact instead is ${artifact.replace('.', '\\.')};`),
    );
  });

  test('Overview headline shows the README tagline’s words, not its Markdown (UI-15)', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForReady(page);
    /* swapDataset, not the bare inline block: the build serves the tree and
       other heavy sections beside the page, and the app is only ever handed
       a complete dataset (a re-analyze or ⌘O scan result). */
    const { summary } = await bakedDataset<{ summary: Record<string, unknown> }>(page, ['summary']);
    await swapDataset(page, {
      summary: { ...summary, oneLiner: 'See [setup](docs/setup.md) for **fast** `cli` use.' },
    });
    await expect(page.locator('main h1')).toHaveText('See setup for fast cli use.');
  });

  test('visiting Overview repeatedly leaves one matchMedia listener (UI-16)', async ({ page }) => {
    await page.addInitScript(() => {
      const live = new Set<unknown>();
      const proto = MediaQueryList.prototype;
      const add = proto.addEventListener;
      const remove = proto.removeEventListener;
      proto.addEventListener = function (this: MediaQueryList, ...args: Parameters<typeof add>) {
        if (this.media.includes('620px')) live.add(args[1]);
        return add.apply(this, args);
      } as typeof add;
      proto.removeEventListener = function (
        this: MediaQueryList,
        ...args: Parameters<typeof remove>
      ) {
        if (this.media.includes('620px')) live.delete(args[1]);
        return remove.apply(this, args);
      } as typeof remove;
      (window as unknown as { __mqLive: () => number }).__mqLive = () => live.size;
    });
    await page.goto('/');
    await waitForReady(page);
    /* The row's label, not the Sankey node that shares its words. */
    const panel = page.locator('span').filter({ hasText: /^Difference on this read$/ });
    await expect(panel).toBeVisible();
    for (let i = 0; i < 3; i++) {
      await clientNav(page, '/about');
      await expect(page.locator('main h1')).toHaveText('FACTS — Fun AI Coding Tools.');
      await clientNav(page, '/');
      await expect(panel).toBeVisible();
    }
    expect(
      await page.evaluate(() => (window as unknown as { __mqLive: () => number }).__mqLive()),
    ).toBe(1);
  });
});

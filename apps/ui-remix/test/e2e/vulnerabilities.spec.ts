/**
 * Vulnerabilities route — deeper interaction test.
 *
 * The smoke spec already confirms the page loads + the H1 renders.
 * This spec exercises the form interaction surface:
 *
 *   1. Detected manifest list renders from the artifact.
 *   2. The "Scan now" button is disabled until the textarea has
 *      non-whitespace content.
 *   3. Clicking a manifest row populates the textarea with the
 *      "open file and paste" placeholder.
 *
 * The OSV scan itself runs against a STUBBED OSV (see "OSV scan —
 * stubbed" below): the paste flow, shared severity / fixed-version
 * grading, provenance labels, degraded answers and the weekly re-check.
 */

import { VULN_LABEL_TEXT } from '@factstack/scanners';
import { expect, test, waitForReady } from './fixtures.js';
import { swapDataset, TINY_PROJECT } from './swap.js';

test.describe('Vulnerabilities — interaction surface', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/vulnerabilities');
    await waitForReady(page);
  });

  test('Scan button is disabled when textarea is empty', async ({ page }) => {
    const scanButton = page.getByRole('button', { name: /^Scan now$/ });
    await expect(scanButton).toBeDisabled();
  });

  test('Scan button enables after pasting non-empty content', async ({ page }) => {
    /* Simulating "user pastes a real manifest" with the simplest
     * possible package.json that the paste flow (parseNpmManifestForOsv
     * → buildOsvQueries) will accept. The exact contents don't matter
     * for the enable-state test — only that pasteText.trim() becomes
     * non-empty. */
    const textarea = page.locator('#manifest-paste');
    await textarea.fill('{"name":"demo","dependencies":{"lodash":"4.17.20"}}');

    const scanButton = page.getByRole('button', { name: /^Scan now$/ });
    await expect(scanButton).toBeEnabled();
  });

  test('Clicking a detected manifest populates the textarea hint', async ({ page }) => {
    /* The "Detected manifests" list only renders when the artifact
     * carries dependencyManifests[]. If the loaded dataset has zero
     * manifests, skip — the assertion would be vacuous and a stale
     * artifact shouldn't fail the suite. */
    const manifestList = page.locator('text=/Detected manifests · \\d+/');
    const hasManifests = await manifestList.isVisible().catch(() => false);
    test.skip(!hasManifests, 'Loaded dataset has no dependency manifests to click.');

    /* Click the first manifest row. We don't care which one — any
     * row should trigger the same code path that writes the
     * placeholder hint into the textarea. */
    const firstManifestRow = page
      .locator('button[title^="Load "][title*=" hint into the paste box"]')
      .first();
    await firstManifestRow.click();

    const textarea = page.locator('#manifest-paste');
    /* The hint format is hardcoded in Vulnerabilities.tsx — assert
     * on the stable substring rather than the full text so future
     * wording tweaks don't break the test. */
    await expect(textarea).toHaveValue(/Open .+ in your editor and paste its contents here/);
  });

  test('Headline renders for either populated or scan-prompt state', async ({ page }) => {
    /* Headline is dataset-driven:
     *   - With artifact vulns: "N critical, M high, K total"
     *   - Without vulns + scan ready: "Check your dependencies against the OSV database."
     *   - Post-scan with results: same numeric format as the artifact branch.
     * Assert that ONE non-empty H1 mounted; the wording itself varies. */
    const h1 = page.locator('main h1').first();
    await expect(h1).toBeVisible();
    const text = await h1.textContent();
    expect(text?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

/* ────── OSV scan — stubbed ──────
 *
 * OSV is STUBBED (page.route): deterministic, offline, and the point here is
 * how the page grades and labels an answer, not OSV's wire shape (the shared
 * client's own tests pin that). The advisory below is shaped so the old
 * local copies in the route disagree with the shared helpers:
 *   - GHSA label HIGH + a C:H/I:H/A:H vector → the local bucketer said
 *     'critical'; the shared one (label wins) says 'high';
 *   - ws fixed on two lines (5.2.4, 8.17.1) → the local picker said
 *     "fixed in 5.2.4" for 8.16.0, a downgrade. */
const WS_ADVISORY = {
  id: 'GHSA-e2e-ws01-0001',
  summary: 'ws: DoS when handling a request with many HTTP headers',
  database_specific: { severity: 'HIGH' },
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:H/I:H/A:H' }],
  affected: [
    {
      package: { name: 'ws', ecosystem: 'npm' },
      ranges: [
        {
          type: 'SEMVER',
          events: [
            { introduced: '2.1.0' },
            { fixed: '5.2.4' },
            { introduced: '8.0.0' },
            { fixed: '8.17.1' },
          ],
        },
      ],
    },
  ],
  references: [{ type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-e2e-ws01-0001' }],
};

/** A CRITICAL advisory on a dev dependency: shown, but it must not drive the
 *  headline or the graded counts. */
const DEV_ADVISORY = {
  id: 'GHSA-e2e-dev1-0001',
  summary: 'vitest: arbitrary code execution in the dev server',
  database_specific: { severity: 'CRITICAL' },
  affected: [
    {
      package: { name: 'vitest', ecosystem: 'npm' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.6.1' }] }],
    },
  ],
};
/** A CRITICAL advisory on a direct runtime dependency: graded. */
const LODASH_ADVISORY = {
  id: 'GHSA-e2e-lod1-0001',
  summary: 'lodash: prototype pollution in zipObjectDeep',
  database_specific: { severity: 'CRITICAL' },
  affected: [
    {
      package: { name: 'lodash', ecosystem: 'npm' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
    },
  ],
};
const ADVISORIES: Record<string, unknown> = {
  [WS_ADVISORY.id]: WS_ADVISORY,
  [DEV_ADVISORY.id]: DEV_ADVISORY,
  [LODASH_ADVISORY.id]: LODASH_ADVISORY,
};

/** TINY_PROJECT with a lodash manifest and a baked scan `bakedDaysAgo` old. */
function withBakedScan(bakedDaysAgo: number): Record<string, unknown> {
  return {
    ...TINY_PROJECT,
    dependencyManifests: [
      {
        path: 'package.json',
        ecosystem: 'npm',
        name: 'tiny',
        version: '1.0.0',
        dependencies: { lodash: '4.17.20' },
        devDependencies: {},
      },
    ],
    vulnerabilityScan: {
      scannedAt: new Date(Date.now() - bakedDaysAgo * 86_400_000).toISOString(),
      source: 'osv.dev',
      packagesQueried: 1,
      packagesSkipped: 0,
      findings: 0,
    },
  };
}

/** Stub OSV: every query name in `hits` gets its advisory ids; details for
 *  the advisories above resolve, any other id fails (a degraded, id-only one).
 *  The failure is an unparseable body, not a 5xx: Chromium logs a 5xx as a
 *  console error, which the suite's fixture fails on. */
async function stubOsv(page: import('@playwright/test').Page, hits: Record<string, string[]>) {
  let batches = 0;
  let failing = false;
  await page.route('**/api.osv.dev/v1/querybatch', async (route) => {
    batches++;
    /* An unreachable OSV, without a console-logged 5xx: the client cannot
       parse the answer and the page reports the re-check as failed. */
    if (failing) {
      await route.fulfill({ contentType: 'application/json', body: 'unavailable' });
      return;
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      queries: Array<{ package: { name: string } }>;
    };
    await route.fulfill({
      json: {
        results: body.queries.map((q) => ({
          vulns: (hits[q.package.name] ?? []).map((id) => ({ id })),
        })),
      },
    });
  });
  await page.route('**/api.osv.dev/v1/vulns/**', async (route) => {
    const id = decodeURIComponent(route.request().url().split('/').pop() ?? '');
    const advisory = ADVISORIES[id];
    if (advisory) await route.fulfill({ json: advisory });
    else await route.fulfill({ contentType: 'application/json', body: 'unavailable' });
  });
  return {
    batches: () => batches,
    /** Every querybatch from now on fails (or answers again). */
    failBatches: (on: boolean) => {
      failing = on;
    },
  };
}

test.describe('Vulnerabilities — OSV scan (stubbed)', () => {
  test('a pasted package.json is scanned and graded with the shared helpers', async ({ page }) => {
    await stubOsv(page, { ws: [WS_ADVISORY.id], vitest: [DEV_ADVISORY.id] });
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    // A project with no baked advisories and no manifests: nothing but the paste.
    await swapDataset(page, TINY_PROJECT);
    await page.locator('#manifest-paste').fill(
      JSON.stringify({
        name: 'demo',
        dependencies: { ws: '8.16.0' },
        devDependencies: { vitest: '^1.2.0' },
      }),
    );
    await page.getByRole('button', { name: /^Scan now$/ }).click();

    /* Before the fix, the paste flow parsed nothing: "Could not extract any
       dependencies" for every package.json. */
    const main = page.locator('main#main');
    await expect(main.getByText('pasted manifest · 2 vulnerable / 2 scanned')).toBeVisible();
    await expect(main.getByRole('alert')).toHaveCount(0);
    /* Graded: only the direct ws finding counts (the dev vitest CRITICAL is
       shown, not graded), and the GHSA label (HIGH) beats the vector. */
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      '1 high-severity vulnerability found.',
    );
    const wsRow = main.locator('div', { hasText: /^ws@ 8\.16\.0/ }).first();
    // The shared VULN_LABEL_TEXT wording the CLI and MCP print (INV7).
    await expect(wsRow).toContainText(VULN_LABEL_TEXT.declaredRange);
    await expect(main.getByText('fixed in 8.17.1').first()).toBeVisible();
    await expect(main.getByText('fixed in 5.2.4')).toHaveCount(0);
    await expect(main.getByText(`dev: ${VULN_LABEL_TEXT.notGraded}`)).toBeVisible();
    // Only the dev row carries a critical pill.
    await expect(main.getByText(/^critical$/)).toHaveCount(1);
    await expect(main.getByText('fixed in 1.6.1')).toBeVisible();
  });

  /* Only ungraded (dev) advisories: the headline says so in the shared
     VULN_LABEL_TEXT wording, not a copy of it that can drift from the CLI. */
  test('only dev advisories: the headline reads shown, not graded (shared wording)', async ({
    page,
  }) => {
    await stubOsv(page, { vitest: [DEV_ADVISORY.id] });
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    await swapDataset(page, TINY_PROJECT);
    await page
      .locator('#manifest-paste')
      .fill(JSON.stringify({ name: 'demo', devDependencies: { vitest: '^1.2.0' } }));
    await page.getByRole('button', { name: /^Scan now$/ }).click();
    const main = page.locator('main#main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      `1 advisory on dev or transitive packages — ${VULN_LABEL_TEXT.notGraded}.`,
    );
    await expect(main.getByText(`dev: ${VULN_LABEL_TEXT.notGraded}`)).toBeVisible();
  });

  test('advisories whose details did not load are flagged, not shown as clean', async ({
    page,
  }) => {
    await stubOsv(page, { lodash: ['GHSA-e2e-lost-0001'] });
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    await swapDataset(page, TINY_PROJECT);
    await page
      .locator('#manifest-paste')
      .fill(JSON.stringify({ dependencies: { lodash: '4.17.20' } }));
    await page.getByRole('button', { name: /^Scan now$/ }).click();
    await expect(
      page.getByText('1 advisory could not be fully loaded from OSV.dev', { exact: false }),
    ).toBeVisible();
  });

  test('the weekly re-check holds a degraded answer for an hour, not a week; Force refresh re-runs it', async ({
    page,
  }) => {
    const osv = await stubOsv(page, { lodash: ['GHSA-e2e-lost-0001'] });
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    // Baked scan older than a week → the page re-checks OSV itself.
    await swapDataset(page, withBakedScan(30));
    const main = page.locator('main#main');
    await expect(main.getByText('re-checked in your browser', { exact: false })).toBeVisible();
    await expect(main.getByText('could not be fully loaded', { exact: false })).toBeVisible();
    await expect(main.getByText('after an hour, when OSV.dev answered only in part')).toBeVisible();

    /* UI-R3 — the partial answer IS stored (it used to be refused, so every
       page view re-asked OSV), and read back as partial: once it is an hour
       old the next visit asks again instead of serving it for the week. */
    const stored = await page.evaluate(() => localStorage.getItem('factstack:osv:auto'));
    expect(stored ?? '').toContain('npm:lodash@4.17.20');
    await page.evaluate(() => {
      const rec = JSON.parse(localStorage.getItem('factstack:osv:auto')!) as { at: number };
      rec.at = Date.now() - 2 * 60 * 60 * 1000;
      localStorage.setItem('factstack:osv:auto', JSON.stringify(rec));
    });
    const beforeRevisit = osv.batches();
    await swapDataset(page, withBakedScan(30));
    await expect.poll(() => osv.batches()).toBeGreaterThan(beforeRevisit);

    const before = osv.batches();
    await page.getByRole('button', { name: 'Force refresh' }).click();
    await expect.poll(() => osv.batches()).toBeGreaterThan(before);
    /* It used to run the paste scan, which has no text on this path. */
    await expect(main.getByText('Paste a package.json', { exact: false })).toHaveCount(0);
  });

  /* UI-R2 — a failed Force refresh keeps the previous re-check on screen, and
     the note used to claim the BAKED scan was showing. */
  test('a failed Force refresh names the re-check still on screen, not the baked scan', async ({
    page,
  }) => {
    const osv = await stubOsv(page, { lodash: [LODASH_ADVISORY.id] });
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    await swapDataset(page, withBakedScan(30));
    const main = page.locator('main#main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      '1 critical vulnerability found.',
    );
    await expect(main.getByText('re-checked in your browser', { exact: false })).toBeVisible();

    osv.failBatches(true);
    const before = osv.batches();
    await page.getByRole('button', { name: 'Force refresh' }).click();
    await expect.poll(() => osv.batches()).toBeGreaterThan(before);
    await expect(
      main.getByText('Could not reach OSV.dev to re-check', { exact: false }),
    ).toBeVisible();
    await expect(
      main.getByText("Still showing this browser's earlier re-check", { exact: false }),
    ).toBeVisible();
    await expect(
      main.getByText('Showing the scan baked at build time', { exact: false }),
    ).toHaveCount(0);
    // The previous re-check is indeed what is on screen.
    await expect(main.getByText(LODASH_ADVISORY.id)).toBeVisible();
  });

  /* The weekly re-check asks about the manifests' direct + dev packages
     only. It used to hide every baked row and read "clean" over a lockfile
     scan whose transitive advisories it never re-asked about. */
  test("a clean weekly re-check keeps the build scan's transitive rows listed", async ({
    page,
  }) => {
    await stubOsv(page, {});
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    const baked = withBakedScan(30);
    const transitive = {
      id: 'GHSA-e2e-tra1-0001',
      summary: 'a transitive advisory the lockfile scan found',
      severity: 'high',
      ecosystem: 'npm',
      package: 'deep-dep',
      installedVersion: '2.0.0',
      fixedVersion: '2.0.1',
      advisoryUrl: 'https://osv.dev/vulnerability/GHSA-e2e-tra1-0001',
      lastChecked: Date.now() - 30 * 86_400_000,
      manifestPath: 'package.json',
      scope: 'transitive',
    };
    await swapDataset(page, {
      ...baked,
      vulnerabilityScan: {
        ...(baked.vulnerabilityScan as Record<string, unknown>),
        packagesQueried: 5,
        findings: 1,
        lockfiles: ['pnpm-lock.yaml'],
      },
      vulnerabilities: [transitive],
    });

    const main = page.locator('main#main');
    await expect(main.getByText('re-checked in your browser', { exact: false })).toBeVisible();
    await expect(main.getByText('· clean ·', { exact: false })).toHaveCount(0);
    await expect(main.getByText('re-checked 1 of 5 packages', { exact: false })).toBeVisible();
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      `1 advisory on dev or transitive packages — ${VULN_LABEL_TEXT.notGraded}.`,
    );
    await expect(main.getByText(transitive.id)).toBeVisible();
  });

  /* A paste with nothing to query (a Detected-manifests hint) cleared
     the weekly re-check before it failed to parse; only a reload brought the
     re-check back. */
  test('a paste that does not parse keeps the weekly re-check on screen', async ({ page }) => {
    await stubOsv(page, { lodash: [LODASH_ADVISORY.id] });
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    await swapDataset(page, withBakedScan(30));
    const main = page.locator('main#main');
    await expect(main.getByText('re-checked in your browser', { exact: false })).toBeVisible();

    await page
      .locator('#manifest-paste')
      .fill('// Open package.json in your editor and paste its contents here.\n');
    await page.getByRole('button', { name: /^Scan now$/ }).click();
    await expect(main.getByRole('alert')).toContainText('Could not extract any dependencies');
    await expect(main.getByText('re-checked in your browser', { exact: false })).toBeVisible();
    await expect(main.getByText(LODASH_ADVISORY.id)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Force refresh' })).toBeVisible();
  });

  /* UI-R1 — the paste verdict sat under the baked scan's "clean" headline:
     a pasted CRITICAL rendered beneath "No known vulnerabilities". */
  test('a pasted CRITICAL leads the page even when the baked scan was clean', async ({ page }) => {
    await stubOsv(page, { lodash: [LODASH_ADVISORY.id] });
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    // Baked one day ago and clean: no weekly re-check, the bake's verdict leads.
    await swapDataset(page, { ...withBakedScan(1), dependencyManifests: [] });
    const main = page.locator('main#main');
    const h1 = main.getByRole('heading', { level: 1 });
    await expect(h1).toHaveText('No known vulnerabilities at the queried versions.');

    await page
      .locator('#manifest-paste')
      .fill(JSON.stringify({ dependencies: { lodash: '4.17.20' } }));
    await page.getByRole('button', { name: /^Scan now$/ }).click();

    await expect(h1).toHaveText('1 critical vulnerability found.');
    await expect(main.getByText('pasted manifest · 1 vulnerable / 1 scanned')).toBeVisible();
    await expect(main.getByText('scanned · clean', { exact: false })).toHaveCount(0);
    await expect(
      main.getByText('This verdict is for the pasted manifest', { exact: false }),
    ).toBeVisible();
    await expect(
      main.getByText("The project's own scan (1d ago) found no known advisories.", {
        exact: false,
      }),
    ).toBeVisible();
  });

  /* UI-R6 — the paste box parses package.json only; the copy said "or
     supported manifest" and a requirements.txt / Cargo.toml paste always
     failed with the package.json error. */
  test('the paste copy says package.json, and a non-npm manifest row says so', async ({ page }) => {
    await page.goto('/vulnerabilities');
    await waitForReady(page);
    await swapDataset(page, {
      ...TINY_PROJECT,
      tree: {
        name: 'tiny-swap',
        path: '',
        files: [
          {
            name: 'Cargo.toml',
            path: 'Cargo.toml',
            ext: '.toml',
            language: null,
            size: 320,
            gzip: null,
            loc: 12,
            tokens: 90,
            todos: 0,
            todoEntries: [],
            status: 'ok',
            mtime: 0,
          },
        ],
        children: [],
      },
    });
    const main = page.locator('main#main');
    await expect(main.getByText('Paste package.json contents', { exact: true })).toBeVisible();
    await expect(main.getByText('supported manifest', { exact: false })).toHaveCount(0);

    await main.locator('button[title="Load Cargo.toml hint into the paste box"]').click();
    await expect(page.locator('#manifest-paste')).toHaveValue(
      /only package\.json pastes are scanned here today[\s\S]*factstack scan-vulns[\s\S]*Cargo\.toml/,
    );
  });
});

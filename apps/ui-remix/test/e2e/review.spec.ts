/**
 * Review — the Change Verdict panel (/review).
 *
 * Owner call 2026-09-24: dev / transitive advisories are listed, never
 * graded. The verdict keeps them out of its level, and the page must not
 * dress the listed finding in a severity chip either: its `low` is only the
 * schema's placeholder (there is no "none" finding severity), so a LOW chip
 * read as a grade (UI-R3-REV-03).
 */
import { VULN_LABEL_TEXT } from '@factstack/scanners';
import { expect, test, waitForReady } from './fixtures.js';
import { swapDataset, TINY_PROJECT } from './swap.js';

/** A dataset vulnerability row (@factstack/spec VulnerabilitySchema). */
const vuln = (id: string, severity: string, scope: 'direct' | 'dev' | 'transitive') => ({
  id,
  summary: `${id} advisory`,
  severity,
  ecosystem: 'npm',
  package: `pkg-${id.toLowerCase()}`,
  installedVersion: '1.0.0',
  fixedVersion: '1.0.1',
  advisoryUrl: `https://osv.dev/vulnerability/${id}`,
  lastChecked: 1_758_000_000_000,
  manifestPath: 'package.json',
  scope,
});

const DEV_ONLY = [
  vuln('GHSA-e2e-dev1-0001', 'critical', 'dev'),
  vuln('GHSA-e2e-tra1-0001', 'high', 'transitive'),
];
const LISTED = `2 dev/transitive advisories (${VULN_LABEL_TEXT.notGraded})`;

test.describe('Review — dev / transitive advisories', () => {
  test('are listed as not graded and leave the verdict at No risk', async ({ page }) => {
    await page.goto('/review');
    await waitForReady(page);
    /* TINY_PROJECT: no edges, risks or history, so nothing else can set the
       level. */
    await swapDataset(page, { ...TINY_PROJECT, vulnerabilities: DEV_ONLY });

    const main = page.locator('main#main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(`No risk: ${LISTED}.`);
    // The hero kicker used to read "No risk risk".
    await expect(main.getByText('No risk · 1 finding', { exact: true })).toBeVisible();

    const findings = main
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'What the verdict flags' }) });
    await expect(findings.getByText(LISTED, { exact: true })).toBeVisible();
    await expect(findings.getByText('not graded', { exact: true })).toBeVisible();
    await expect(findings.getByText(/^(low|medium|high|critical)$/i)).toHaveCount(0);
  });

  test('beside a graded advisory, only the graded one carries a severity', async ({ page }) => {
    await page.goto('/review');
    await waitForReady(page);
    await swapDataset(page, {
      ...TINY_PROJECT,
      vulnerabilities: [...DEV_ONLY, vuln('GHSA-e2e-dir1-0001', 'medium', 'direct')],
    });

    const main = page.locator('main#main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      `Elevated risk: 1 known vulnerability; ${LISTED}.`,
    );
    await expect(main.getByText('Elevated risk · 2 findings', { exact: true })).toBeVisible();

    const findings = main
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'What the verdict flags' }) });
    await expect(findings.getByText(/^medium$/i)).toHaveCount(1);
    await expect(findings.getByText('not graded', { exact: true })).toHaveCount(1);
    await expect(findings.getByText(/^(low|high|critical)$/i)).toHaveCount(0);
  });
});

/* A possible secret (category 'secret', severity 'info') is "shown but
   never graded" (secretClass.ts). It used to set the level to Low and wear a
   LOW chip beside its own "…, not graded" title. */
test.describe('Review — possible secrets', () => {
  test('are listed as not graded and leave the verdict at No risk', async ({ page }) => {
    await page.goto('/review');
    await waitForReady(page);
    await swapDataset(page, {
      ...TINY_PROJECT,
      risks: [
        {
          severity: 'info',
          category: 'secret',
          rule: 'env-secret-pair',
          file: '.env.example',
          line: 1,
          message: 'env-secret-pair finding',
          preview: '***',
        },
      ],
    });

    const main = page.locator('main#main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      'No risk: 1 possible secret, not graded.',
    );
    const findings = main
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'What the verdict flags' }) });
    await expect(findings.getByText('not graded', { exact: true })).toBeVisible();
    await expect(findings.getByText(/^(low|medium|high|critical)$/i)).toHaveCount(0);
  });
});

/* A ⌘O swap patches /review in place, so a picked snapshot timestamp
   outlived the history it came from: the select matched no option and the
   trend read "no baseline" although Auto would have found one. */
test.describe('Review — baseline picker', () => {
  const snap = (at: string, risks: number) => ({
    at,
    loc: 120,
    tokens: 12_000,
    files: 3,
    risks,
    todos: 0,
  });

  test('a picked baseline resets to Auto when another project is swapped in', async ({ page }) => {
    await page.goto('/review');
    await waitForReady(page);
    await swapDataset(page, {
      ...TINY_PROJECT,
      history: [snap('2026-09-01T00:00:00.000Z', 1), snap('2026-09-02T00:00:00.000Z', 2)],
    });

    const main = page.locator('main#main');
    const picker = main.locator('select');
    await picker.selectOption('2026-09-01T00:00:00.000Z');
    await expect(main.getByText('comparing current → 2026-09-01 00:00')).toBeVisible();

    await swapDataset(page, { ...TINY_PROJECT, history: [snap('2026-08-01T00:00:00.000Z', 0)] });
    await expect(picker).toHaveValue('@auto');
    await expect(main.getByText('comparing current → 2026-08-01 00:00')).toBeVisible();
    await expect(main.getByText('no baseline — showing current posture only')).toHaveCount(0);
  });
});

/**
 * The GitHub workflows keep the promises their comments make.
 *
 * Regressions:
 *  - cve-refresh.yml rebuilt and published main HEAD under a "weekly OSV
 *    refresh" label — unreviewed code went live, and a hotfix deployed from a
 *    branch would be rolled back (owner decision: rebuild the LIVE commit);
 *  - its build had no sign-in config, so every publish would break /mcp-auth;
 *  - CI never ran a first-paint measurement, the root test suite or the
 *    boundary probes;
 *  - the legacy-UI DOM XSS test only ever skipped in CI (no browser yet);
 *  - CI never built, ran or packed the publishable CLI bundle (deploy-infra#7);
 *  - its comment said the DOM test used apps/cli's Playwright; it loads
 *    ui-remix's, which only matches while the lockfile has one version.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, '.github/workflows', f), 'utf8').replace(/\r\n/g, '\n');

/** Steps of the (single) job, in order: { name, body }. */
function steps(yml) {
  const part = yml.slice(yml.indexOf('\n    steps:\n'));
  return part
    .split(/\n {6}- /)
    .slice(1)
    .map((body) => ({
      name:
        body
          .match(/^(?:name:\s*(.+)|uses:\s*(.+))/m)
          ?.slice(1)
          .find(Boolean) ?? '',
      body,
    }));
}
const find = (list, re) => {
  const i = list.findIndex((s) => re.test(s.name));
  expect(i, `step matching ${re}`).toBeGreaterThanOrEqual(0);
  return { i, ...list[i] };
};

/**
 * Why apps/cli's legacy-ui-dom.test.ts might launch a Playwright other than
 * the one CI installed Chromium for (apps/cli's own `cliPin`), or null.
 */
function playwrightMismatch(domTest, cliPin, lock) {
  if (!domTest.includes('ui-remix/package.json'))
    return /\(\s*'playwright'\s*\)/.test(domTest)
      ? null // apps/cli's own devDependency, like the install
      : 'legacy-ui-dom.test.ts loads Playwright from neither apps/cli nor ui-remix';
  const versions = [
    ...new Set([...lock.matchAll(/^ {2}'?playwright@(\d[^:'(\s]*)'?:/gm)].map((m) => m[1])),
  ];
  if (versions.length === 1 && versions[0] === cliPin) return null;
  return `the lockfile resolves playwright ${versions.join(', ')}, but CI installs Chromium for apps/cli's ${cliPin}`;
}

describe('cve-refresh.yml — data-only refresh of the LIVE commit', () => {
  const list = steps(read('cve-refresh.yml'));
  const live = find(list, /^Read the live build/);
  const pin = find(list, /^Check out the live commit/);
  const install = find(list, /^Install$/);
  const analyze = find(list, /^Analyze$/);
  const scan = find(list, /^Re-query OSV$/);
  const carry = find(list, /^Carry the live History forward$/);
  const build = find(list, /^Build static site/);
  const gate = find(list, /^Check the build is safe to publish/);
  const publish = find(list, /^Publish$/);

  it('reads the live build, checks out its commit, THEN installs, analyzes, carries and builds', () => {
    const order = [
      live.i,
      pin.i,
      install.i,
      analyze.i,
      scan.i,
      carry.i,
      build.i,
      gate.i,
      publish.i,
    ];
    expect(order).toEqual(order.slice().sort((a, b) => a - b));
    expect(live.body).toMatch(/carry-history\.mjs --report-only/);
    expect(pin.body).toMatch(/git checkout --detach "\$LIVE"/);
    expect(pin.body).toMatch(/git branch -r --contains "\$LIVE"/);
  });

  /* Regression: the points were carried BEFORE analyze, whose
     50-snapshot retention then deleted the oldest live points for good. */
  it('carries the live History AFTER analyze and holds the bake to the live point count', () => {
    expect(carry.body).toMatch(/node "\$RUNNER_TEMP\/main-scripts\/carry-history\.mjs" --root \./);
    expect(carry.body).not.toMatch(/--report-only/);
    expect(carry.body).toMatch(/id: carry/);
    expect(gate.body).toMatch(/LIVE_POINTS: \$\{\{ steps\.carry\.outputs\.points \}\}/);
    expect(gate.body).toMatch(/--min-history "\$LIVE_POINTS"/);
    for (const s of list.slice(0, analyze.i))
      expect(s.body, s.name).not.toMatch(/carry-history\.mjs(?! --report-only)/);
  });

  it('carries History through the shared script, not an inline copy', () => {
    expect(read('cve-refresh.yml')).not.toMatch(/curl[^\n]*data\/factstack\.json/);
  });

  it('builds with the sign-in config Variable and gates publishing on it', () => {
    expect(build.body).toMatch(/FACTS_FB_WEB_CONFIG: \$\{\{ vars\.FACTS_FB_WEB_CONFIG \}\}/);
    expect(gate.body).toMatch(/deploy-check\.mjs" post/);
  });

  it('publishes only the gated live rebuild, tagged with the LIVE commit, to production', () => {
    for (const cond of [
      "steps.live.outcome == 'success'",
      "steps.pin.outcome == 'success'",
      "steps.carry.outcome == 'success'",
      "steps.gate.outcome == 'success'",
    ])
      expect(publish.body).toContain(cond);
    expect(publish.body).toMatch(/--commit-hash "\$LIVE"/);
    expect(publish.body).not.toMatch(/GITHUB_SHA/);
    expect(publish.body).toMatch(/--branch main/);
    expect(publish.body).toMatch(/wrangler@\d+\.\d+\.\d+/);
  });
});

describe('ci.yml', () => {
  const list = steps(read('ci.yml'));

  /* Steps that do not need the unit tests to pass run even after the Tests
     step failed, so one red suite cannot hide a broken build or guard. */
  const AFTER_FAILURE = /if: \$\{\{ !cancelled\(\)/;
  /* Every OS AND after a failure: the step's only condition is exactly this,
     so no OS filter (or any other condition) can slip in beside it. */
  const conditions = (body) => (body.match(/^\s*if:.*$/gm) ?? []).map((l) => l.trim());
  const EVERY_OS_AFTER_FAILURE = ['if: ${{ !cancelled() }}'];

  it('runs the boundary probes with the lint gate and the root tests on every OS', () => {
    expect(find(list, /^Lint \+ boundaries/).body).toMatch(/pnpm lint:boundaries/);
    const root = find(list, /^Root tests/);
    expect(root.body).toMatch(/pnpm test:root/);
    expect(conditions(root.body)).toEqual(EVERY_OS_AFTER_FAILURE);
  });

  it('reports every failing suite in one run, with a runner-sized fan-out', () => {
    const tests = find(list, /^Tests$/);
    expect(tests.body).toMatch(/pnpm turbo test --continue=dependencies-successful/);
    expect(tests.body).toMatch(/--concurrency=\d/);
  });

  it('runs the build, bench and bundle guards even when a test failed', () => {
    for (const name of [/^Smoke/, /^Build web dashboard/, /^Bench/, /^CLI bundle/]) {
      expect(find(list, name).body).toMatch(AFTER_FAILURE);
    }
  });

  it('runs the dashboard e2e on ubuntu under the production CSP and fails on a flaky pass', () => {
    const e2e = find(list, /^Dashboard e2e/);
    expect(e2e.body).toMatch(/matrix\.os == 'ubuntu-latest'/);
    expect(e2e.body).not.toMatch(/continue-on-error/);
    expect(e2e.body).toMatch(/pnpm --filter @factstack\/ui-remix test:e2e/);
    // Its `pnpm build` replaces the build:static dist the first-paint report
    // measures, and it bakes the .facts/ that the CLI bundle step rewrites.
    expect(e2e.i).toBeGreaterThan(find(list, /^First-paint report/).i);
    expect(e2e.i).toBeLessThan(find(list, /^CLI bundle/).i);
    const pw = readFileSync(join(ROOT, 'apps/ui-remix/playwright.config.ts'), 'utf8');
    expect(pw).toMatch(/failOnFlakyTests: !!process\.env\.CI/);
    const vite = readFileSync(join(ROOT, 'apps/ui-remix/vite.config.ts'), 'utf8');
    expect(vite).toMatch(/configurePreviewServer/);
  });

  it('runs the legacy-UI DOM XSS test with a real Chromium and lets it fail the job', () => {
    const dom = find(list, /^Legacy UI — DOM XSS regression/);
    // After the Tests step, whose run of the same file skips without a browser.
    expect(dom.i).toBeGreaterThan(find(list, /^Tests$/).i);
    expect(dom.body).toMatch(/matrix\.os == 'ubuntu-latest'/);
    expect(dom.body).not.toMatch(/continue-on-error/);
    expect(dom.body).toMatch(/FACTS_UI_DOM_TEST: '1'/);
    const install = dom.body.indexOf('playwright install --with-deps chromium');
    const run = dom.body.indexOf('vitest run scripts/test/legacy-ui-dom.test.ts');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(install);
    expect(existsSync(join(ROOT, 'apps/cli/scripts/test/legacy-ui-dom.test.ts'))).toBe(true);
    // Chromium comes from the Playwright apps/cli itself declares.
    expect(dom.body).toMatch(
      /pnpm --filter @factstack\/cli exec playwright install --with-deps chromium/,
    );
    const cliPkg = JSON.parse(readFileSync(join(ROOT, 'apps/cli/package.json'), 'utf8'));
    expect(cliPkg.devDependencies?.playwright).toBeTruthy();
  });

  /* The DOM test must launch the Chromium the step above installed. While it
     resolves Playwright through ui-remix's @playwright/test (declared ^1.49),
     that holds only when the lockfile has ONE playwright version, the one
     apps/cli pins; once it loads apps/cli's own `playwright`, it always holds. */
  it('the DOM XSS test launches the Playwright whose Chromium CI installed', () => {
    const dom = readFileSync(join(ROOT, 'apps/cli/scripts/test/legacy-ui-dom.test.ts'), 'utf8');
    const cliPkg = JSON.parse(readFileSync(join(ROOT, 'apps/cli/package.json'), 'utf8'));
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    expect(playwrightMismatch(dom, cliPkg.devDependencies.playwright, lock)).toBeNull();
    // The guard can fail: a second resolved version breaks the ui-remix route.
    const drifted = `${lock}\n  playwright@1.49.1:\n    resolution: {}\n`;
    if (dom.includes('ui-remix/package.json')) {
      // apps/cli's pin, whatever it is today — not a version copied in here.
      const pin = cliPkg.devDependencies.playwright.replace(/\./g, '\\.');
      expect(playwrightMismatch(dom, cliPkg.devDependencies.playwright, drifted)).toMatch(
        new RegExp(`1\\.49\\.1, ${pin}|${pin}, 1\\.49\\.1`),
      );
    }
  });

  it('builds, runs and dry-run packs the CLI bundle on every OS, and never publishes', () => {
    const bundle = find(list, /^CLI bundle/);
    expect(conditions(bundle.body)).toEqual(EVERY_OS_AFTER_FAILURE); // every OS in the matrix
    expect(bundle.body).not.toMatch(/continue-on-error/);
    expect(bundle.body).toMatch(/pnpm --filter @factstack\/cli pack:dry-run/);
    expect(bundle.body).toMatch(/node apps\/cli\/publish\/dist\/cli\.js --version/);
    expect(bundle.body).toMatch(/node apps\/cli\/publish\/dist\/cli\.js analyze \. /);
    expect(read('ci.yml')).not.toMatch(/\b(?:npm|pnpm) publish\b|changeset publish|pnpm release\b/);
    // Its analyze rewrites .facts/; the dashboard build must have baked first.
    expect(bundle.i).toBeGreaterThan(find(list, /^Build web dashboard/).i);
    const cliPkg = JSON.parse(readFileSync(join(ROOT, 'apps/cli/package.json'), 'utf8'));
    expect(cliPkg.scripts['pack:dry-run']).toMatch(/--pack-dry-run/);
  });

  it('reports first paint on ubuntu without ever failing the job', () => {
    const perf = find(list, /^First-paint report/);
    expect(perf.body).toMatch(/matrix\.os == 'ubuntu-latest'/);
    expect(perf.body).toMatch(/continue-on-error: true/);
    expect(perf.body).toMatch(/perf:report/);
    expect(perf.i).toBeGreaterThan(find(list, /^Build web dashboard/).i);
  });
});

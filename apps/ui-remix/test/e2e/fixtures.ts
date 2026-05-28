/**
 * Shared route catalog + Playwright fixtures for the e2e suite.
 *
 * One source of truth: the `ROUTES` array. Every smoke test iterates
 * it via `test.describe.each`-style loops, so adding a new tab to the
 * dashboard only needs one entry here (path + headlines). The smoke
 * suite picks it up automatically.
 *
 * The `headlines` field is an array — some routes (Risks, Files,
 * Credentials, History, Tests) render different H1s for the empty
 * vs populated states. The smoke test passes if EITHER variant
 * appears, so the suite doesn't go red just because your local
 * `.facts/agent.json` happens to have zero risks.
 *
 * The `interactiveSelector` field is optional; when set, the smoke
 * test waits for it after the page loads. Useful for routes that
 * render asynchronously after `networkidle` (e.g. Flow's SVG, which
 * mounts after the dataset is parsed).
 */

import { test as base, expect, type ConsoleMessage, type Page } from '@playwright/test';

export interface RouteSpec {
  /** URL path the route registers under (see `apps/ui-remix/src/lib/routes.ts`). */
  path: string;
  /** Human label for `test.describe` group naming. */
  name: string;
  /** Editorial H1 strings — pass if ANY one renders. Most routes
   *  have a populated variant + an empty-state variant. */
  headlines: string[];
  /** Optional CSS selector the test waits for after initial load —
   *  useful for routes whose primary content mounts after dataset
   *  parsing (Flow's SVG, Library's package grid, etc.). */
  interactiveSelector?: string;
}

/* Mirror of the tabPatterns map in src/lib/routes.ts. Keep alphabetical
 * by `path` so additions are easy to slot in. */
export const ROUTES: readonly RouteSpec[] = [
  {
    path: '/',
    name: 'Overview',
    /* Overview's H1 is the project's `summary.oneLiner` — fully
     * dataset-driven. Asserting on the H1 element existing (rather
     * than text matching) is the right primitive. */
    headlines: [],
    interactiveSelector: 'h1',
  },
  { path: '/about',           name: 'About',           headlines: ['FACTS — Fun AI Coding Tools.'] },
  { path: '/config',          name: 'Config',          headlines: ['What this codebase needs from its environment.'] },
  { path: '/credentials',     name: 'Credentials',     headlines: ['Nothing leaked.', 'Rotate these now.'] },
  { path: '/files',           name: 'Files',           headlines: ["That path isn't in the index.", 'Every file, ranked by weight.'] },
  { path: '/flow',            name: 'Flow',            headlines: ['How data moves through this system.'], interactiveSelector: 'svg' },
  { path: '/graph',           name: 'Graph',           headlines: ['Where the dependency lives.'] },
  { path: '/history',         name: 'History',         headlines: ['One snapshot so far.', 'Trends over time.'] },
  { path: '/library',         name: 'Library',         headlines: ["The project's table of contents."] },
  { path: '/risks',           name: 'Risks',           headlines: ['Nothing to flag today.', 'What to look at first.'] },
  { path: '/routes',          name: 'Routes',          headlines: ['No routes surfaced.', 'What this thing does.'] },
  { path: '/tests',           name: 'Tests',           headlines: ['No test files detected.', "What's actually tested."] },
  { path: '/vulnerabilities', name: 'Vulnerabilities', headlines: [] /* H1 is dataset-driven; assert on h1 existing */, interactiveSelector: 'h1' },
];

/* ─────────── shared fixtures ─────────── */

/**
 * Console-error capture. Hooks page.on('console') for the test
 * lifetime and exposes a getter for "errors observed so far." The
 * fixture auto-fails any test that ended with a non-empty error array,
 * but tests can opt out by capturing+asserting themselves.
 *
 * What counts as an "error": only entries with `type === 'error'`.
 * Warnings and info messages are noisy on a Vite HMR dev server (the
 * dashboard logs perf marks + the standard "[vite] connected" banner)
 * and aren't load-bearing for "did the page break."
 *
 * ### Known-error allowlist
 *
 * `KNOWN_ERROR_PATTERNS` filters out errors that are real bugs we've
 * triaged but haven't fixed yet. Without an allowlist the suite goes
 * permanently red and stops catching NEW regressions — defeating the
 * point of the smoke test. Each entry MUST cite the tracking issue +
 * an expiry / fix-target so dead allowlist entries don't accumulate.
 *
 * Add to this list reluctantly. Removing requires fixing the bug.
 */
export const KNOWN_ERROR_PATTERNS: ReadonlyArray<{
  /** Regex that matches the console error text. Use `^` to anchor when
   *  the message starts with a known prefix to avoid false positives. */
  pattern: RegExp;
  /** Why this error is here. Cite the issue + the target version. */
  reason: string;
}> = [];

/**
 * Filter a list of console errors against the known-error allowlist.
 * Returns only errors that DON'T match any known pattern.
 */
export function unknownErrors(errors: ConsoleMessage[]): ConsoleMessage[] {
  return errors.filter((e) => {
    const text = e.text();
    return !KNOWN_ERROR_PATTERNS.some(({ pattern }) => pattern.test(text));
  });
}

type ConsoleErrorFixture = {
  /** Returns all console.error messages observed so far. Use this
   *  inside a test to inspect errors mid-flight; the auto-fail in
   *  the fixture teardown catches anything you forgot to check. */
  consoleErrors: () => ConsoleMessage[];
  /** Auto-applied fixture (no test parameter needed). Asserts that
   *  no unexpected console errors fired during the test, AFTER the
   *  test body finished. Filters through `KNOWN_ERROR_PATTERNS`. */
  autoFailOnConsoleErrors: void;
};

export const test = base.extend<ConsoleErrorFixture>({
  consoleErrors: async ({ page }, use) => {
    const errors: ConsoleMessage[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg);
    });
    /* Page-level uncaught errors (thrown exceptions, unhandled
     * promise rejections) also count. The page.on('console')
     * listener doesn't catch these on its own. */
    page.on('pageerror', (err) => {
      /* Synthesize a ConsoleMessage-like shape so the test assertion
       * can treat both sources uniformly. We only need .text() for
       * error reporting in the test failure message. */
      errors.push({
        type: () => 'error',
        text: () => `[pageerror] ${err.message}`,
      } as unknown as ConsoleMessage);
    });
    await use(() => errors);
  },

  /* Auto-fixture: Playwright runs this for EVERY test, even tests that
   * don't list it as a parameter. The body sets up nothing, yields
   * control to the test, then runs the teardown after the test body
   * finishes. The teardown reads from `consoleErrors` (also a fixture)
   * so both the capture + the assertion are guaranteed for every test.
   *
   * Why this matters: with the previous opt-in pattern, a test that
   * forgot to call `consoleErrors()` silently swallowed any errors
   * that fired during its run — a classic test-quality footgun. The
   * auto-fixture eliminates that class of bug.
   *
   * The `[..., { auto: true }]` tuple shape is Playwright's syntax for
   * "always include this fixture, regardless of whether the test
   * declares it." See https://playwright.dev/docs/test-fixtures#automatic-fixtures. */
  autoFailOnConsoleErrors: [
    async ({ consoleErrors }, use) => {
      await use();
      /* Teardown runs AFTER the test body. If the test already failed,
       * we still report any console errors so the operator sees both
       * the assertion failure AND any DevTools-level evidence in one
       * place. */
      const errors = unknownErrors(consoleErrors());
      if (errors.length > 0) {
        const messages = errors.map((e) => e.text()).join('\n  ');
        throw new Error(`Unexpected console errors during test:\n  ${messages}`);
      }
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Wait for the dataset-loaded SPA to finish hydration.
 *
 * The Vite dev server serves the HTML shell + the JS bundle that
 * loads the FACTS artifact (in dev: fetched via XHR; in prod build:
 * inlined as `<script id="factstack-data">`). Tests must wait for
 * BOTH the network to settle AND the loading skeleton to disappear,
 * or selector queries race against the hydration cycle.
 *
 * The skeleton has `role="status"` and `aria-label="Loading FACTS dashboard"`
 * (see App.tsx Loading component). Once it's gone, EITHER:
 *   - the real shell mounted (`<main id="main">`) and the route ran, OR
 *   - the ErrorScreen mounted (`<h1>Nothing to analyze yet.</h1>`)
 *     because the dataset failed to load.
 *
 * We distinguish these two outcomes and THROW loudly on the
 * ErrorScreen path. The previous implementation accepted either as
 * "ready", which meant a broken `loadArtifacts()` call (502 on
 * `/data/factstack.json` in dev mode, missing `__INLINE_FACTSTACK_JSON__`
 * substitution in static mode, etc.) would silently let tests proceed
 * and fail later with a confusing "h1 not found" instead of pointing
 * at the actual root cause. The error message here links the symptom
 * (test failure) directly to the diagnosis (dataset never loaded).
 */
export async function waitForReady(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  /* The skeleton is conditional on `!cached && !loadError`. It may
   * be skipped entirely if the dataset loads before the first paint
   * — that's why we use waitFor with state: 'hidden' (also matches
   * "never appeared"). */
  await page
    .locator('[aria-label="Loading FACTS dashboard"]')
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => { /* skeleton never appeared — fine */ });

  /* Race: whichever of these resolves first wins.
   *   - `main#main` → happy path, shell + route mounted.
   *   - The ErrorScreen H1 → load failed; we'll throw next. */
  const mainAppearance = page.locator('main#main').waitFor({ state: 'visible', timeout: 5_000 });
  const errorAppearance = page
    .getByRole('heading', { name: /^Nothing to analyze yet\.?$/ })
    .waitFor({ state: 'visible', timeout: 5_000 });

  /* Promise.race resolves on the first settled (resolved OR rejected).
   * Wrapping both in `.then(() => marker)` lets us tell which path
   * won without inspecting the promise itself. */
  const winner = await Promise.race([
    mainAppearance.then(() => 'main' as const).catch(() => null),
    errorAppearance.then(() => 'error' as const).catch(() => null),
  ]);

  if (winner === 'error') {
    /* Pull the ErrorScreen's diagnostic line if it rendered (App.tsx
     * shows the err.message in a <p class="mono"> below the heading)
     * so the failure message includes both "what we saw" and "why". */
    const diag = await page.locator('.mono').first().textContent().catch(() => null);
    throw new Error(
      `waitForReady: dataset failed to load — page rendered the ErrorScreen.\n` +
        `  Diagnostic: ${diag?.trim() ?? '(not surfaced)'}\n` +
        `  Likely cause: stale dist/ (rebuild with \`pnpm -F @factstack/ui-remix build\`), ` +
        `or running tests against \`pnpm dev\` without a companion \`factstack ui\` ` +
        `server on :4848 to proxy \`/data/factstack.json\`.`,
    );
  }

  if (winner === null) {
    /* Neither resolved within 5s. Most likely cause: the page is still
     * showing the skeleton (load took >10s) or threw a hard error
     * before either DOM landed. */
    throw new Error(
      'waitForReady: neither <main id="main"> nor the ErrorScreen appeared within 5s. ' +
        'The page is probably stuck in the loading skeleton — check the dev server ' +
        'console for unhandled exceptions during loadArtifacts().',
    );
  }
}

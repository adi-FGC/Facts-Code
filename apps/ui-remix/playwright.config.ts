/**
 * Playwright config for apps/ui-remix end-to-end tests.
 *
 * Boots `pnpm dev` automatically (via `webServer`) and points tests at
 * the local Vite dev server. The `reuseExistingServer` flag means if
 * you already have `pnpm dev` running (local iteration), Playwright
 * won't fight for the port — it'll just connect.
 *
 * Chromium-only by default. The dashboard's primary target is
 * Chromium (Chrome + Edge cover ~70% of dev tooling usage); cross-
 * browser coverage would multiply CI minutes without catching bugs
 * we'd actually ship. Add `firefox` / `webkit` to `projects` when a
 * specific bug demands it.
 *
 * One-time setup before first run:
 *   npx playwright install chromium
 *
 * The browser binary download (~150 MB) is intentional — it's not in
 * the workspace install footprint so contributors who never run e2e
 * don't pay for it.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  /* Where to find specs. test/e2e is sibling to src/, mirrors the
     vitest convention in this repo (every other package puts tests in
     test/ and unit tests in test/*.test.ts; e2e gets its own subdir). */
  testDir: './test/e2e',

  /* CI-safe defaults: fail fast on retried tests, single worker on CI
     (vite dev server is process-per-port; multiple workers would
     thrash the cache), 4 workers locally (overlap network waits). */
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,

  /* Editorial defaults: HTML report opens locally on failure; CI
     uses the line reporter for terse log output. */
  reporter: process.env.CI ? 'line' : 'html',

  use: {
    baseURL: 'http://localhost:3000',
    /* Trace on first retry — Playwright's trace viewer is the single
       best debugging tool for flaky UI tests. Skipped on the first
       attempt to keep happy-path runs fast. */
    trace: 'on-first-retry',
    /* Screenshot + video on failure only — debugging without these is
       guessing; keeping them on always would bloat CI artifacts. */
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  /* Chromium only. See file header for rationale. */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Auto-boot the preview server (not `pnpm dev`).
   *
   * Why preview, not dev: the SPA's `loadArtifacts()` reads the FACTS
   * dataset from an inline `<script id="factstack-data">` block that
   * gets populated by `tsx scripts/inject-data.mjs` during the BUILD
   * step. The `pnpm dev` server skips this step and expects a separate
   * `factstack ui` Node server on port 4848 to serve `/data/factstack.json`
   * via Vite proxy. Without that companion server running, every
   * dev-mode request 502s and tests see "Nothing to analyze yet."
   *
   * `vite preview` serves `dist/index.html` post-build with data
   * already inlined — exactly the shape Netlify deploys + `factstack
   * export` ships. Same code path users see in production, no proxy
   * dependency, no analyzer required at test time.
   *
   * The 180s timeout absorbs the build step on cold runs (Vite + the
   * inject-data + check-bundle-size pipeline takes ~15-30s).
   *
   * Iteration tip: run `pnpm build && pnpm start` in another terminal
   * once; the `reuseExistingServer: !CI` flag makes Playwright reuse
   * it so subsequent test:e2e invocations skip the rebuild. */
  webServer: {
    command: 'pnpm build && pnpm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

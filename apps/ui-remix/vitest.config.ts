/**
 * Vitest config for apps/ui-remix unit tests.
 *
 * The reason this file exists at all: we added Playwright e2e specs
 * under `test/e2e/` using the standard `*.spec.ts` naming. Vitest's
 * default collector pattern is `**\/*.{spec,test}.{ts,tsx,js,jsx}`
 * which matches Playwright files too — and importing `@playwright/test`
 * inside vitest throws "Playwright Test did not expect test.describe()
 * to be called here." Excluding the e2e dir keeps the two runners in
 * separate lanes.
 *
 * If you ever add Vitest-flavored integration tests under `test/`
 * (i.e. NOT e2e), they'll be picked up automatically — the exclude
 * is scoped tight to `test/e2e/`.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      /* Playwright lives in its own runner (see playwright.config.ts). */
      'test/e2e/**',
    ],
  },
});

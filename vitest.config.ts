/**
 * Root vitest config — scopes the monorepo-wide `npx vitest run` to real unit
 * tests. Without this, vitest's default glob drags in two families of
 * non-vitest files and reports them as failures:
 *   - apps/ui-remix/test/e2e/*.spec.ts — Playwright specs, run by
 *     `playwright test` (vitest can't host test.describe from @playwright/test)
 *   - bench/corpus/** — the F13 benchmark's committed fixture repo; its
 *     "tests" are corpus *content* the benchmark measures, not suite members.
 *   - .claude/worktrees/** — isolated agent worktrees (`git worktree add`) whose
 *     copied test files have no provisioned node_modules, so they otherwise
 *     surface as phantom "failed to collect" suites in the monorepo-wide run.
 * Per-package runs (e.g. apps/ui-remix's own vitest.config.ts) are unaffected.
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'apps/ui-remix/test/e2e/**',
      'bench/corpus/**',
      'legacy/**',
      '.claude/**',
    ],
  },
});

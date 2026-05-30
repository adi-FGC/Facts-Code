# apps/ui-remix end-to-end tests

Playwright stubs that smoke-test every dashboard route + exercise the Vulnerabilities interaction surface.

## One-time setup

After `pnpm install`, download the Chromium binary that Playwright uses (~150 MB):

```bash
pnpm -F @factstack/ui-remix exec playwright install chromium
```

This is intentionally NOT part of the workspace install — contributors who never run e2e shouldn't pay 150 MB to clone the repo.

## Running

From the repo root:

```bash
# Run all e2e specs (auto-builds + auto-boots `pnpm start` via webServer).
pnpm -F @factstack/ui-remix test:e2e

# Interactive UI mode — debug a single failing test with the Playwright trace viewer.
pnpm -F @factstack/ui-remix test:e2e:ui

# Run one spec.
pnpm -F @factstack/ui-remix exec playwright test smoke.spec.ts

# Run one test by name.
pnpm -F @factstack/ui-remix exec playwright test -g "About"
```

If you already have `pnpm start` running, Playwright will reuse it (see `reuseExistingServer: !process.env.CI` in `playwright.config.ts`). On CI it always boots fresh from `pnpm build && pnpm start`.

### ⚠️ Stale-build trap (the #1 way these tests will lie to you)

The test runner serves the **built** output from `apps/ui-remix/dist/`, NOT the live source. If `dist/` is stale, you'll see tests fail against an old version of the app — usually with confusing error messages that point at "real bugs" that have already been fixed in source.

If your tests fail with one of these symptoms, **rebuild first**:

| Symptom | Likely root cause | Fix |
| --- | --- | --- |
| Console error: `scheduleUpdate not implemented` | Old build pre-dating the `@remix-run/ui` pnpm patch | `pnpm -F @factstack/ui-remix build` |
| `waitForReady` throws "dataset failed to load — ErrorScreen" | Old build with placeholder `__INLINE_FACTSTACK_JSON__` un-substituted | `pnpm -F @factstack/ui-remix build` (runs `inject-data.mjs`) |
| Test asserts on H1 wording that doesn't match | Wording changed in source but `dist/` hasn't been rebuilt | `pnpm -F @factstack/ui-remix build` |
| All tests pass locally, all fail on CI | CI has no `dist/` cached + builds aren't part of the test command | The `webServer: 'pnpm build && pnpm start'` config handles this; ensure you didn't override |

The `webServer` config does run `pnpm build` automatically when starting from scratch — but if you ran `pnpm start` in another terminal first (which triggers `reuseExistingServer`), the build step is skipped. **Killing that background server forces Playwright to do the build itself.**

## What's covered

| Spec | What it tests |
| --- | --- |
| `smoke.spec.ts` | All 13 routes: page loads, no console errors, the editorial H1 (or its empty-state variant) renders. Plus cross-route invariants: shell landmarks survive, tab navigation updates the URL. |
| `vulnerabilities.spec.ts` | The Vulnerabilities form interaction: scan button enable state, manifest-row click populates textarea. The actual OSV scan path is marked `test.fixme` pending a stub-vs-live decision (see the comment block in the spec). |
| `interactions.spec.ts` | Stateful controls the smoke suite can't reach: command palette (⌘K open / filter / Escape / Enter-navigate), Config theme + density switching (asserts `html[data-theme]` / `html[data-density]` actually applied, + localStorage persistence across reload), Flow view-mode tab switching, Library sort radio. |

## Adding a new route

When a new tab is added to the dashboard:

1. Add a `tabPatterns` entry in `src/lib/routes.ts` (existing pattern).
2. Add one entry to the `ROUTES` array in `fixtures.ts` (path + headlines).
3. Smoke spec picks it up automatically — no test code changes needed.

## When to write a per-route spec

The smoke spec catches "page broke" regressions. Write a dedicated `<route>.spec.ts` only when:

- The route has interactive state worth asserting (forms, toggles, sorting).
- A specific user flow keeps breaking and needs a regression guard.
- The route hits a network surface (OSV, future MCP) you want to either stub or live-call deliberately.

Don't write per-route specs for "I might want this later" — the smoke spec is the catch-all baseline.

## Debugging a failing test

1. Run with `--ui` (`test:e2e:ui`) to step through interactively.
2. On CI failures, the HTML report includes traces + videos + screenshots; download from the action artifact.
3. If the test asserts on an H1 string, check whether the H1 changed deliberately (editorial wording tweak) — update `fixtures.ts` first, not the test.

## Conventions

- **No selectors based on CSS class names.** They're generated (`remix/ui`'s `css()` returns hashed atomic classes) and will churn. Use role-based selectors (`getByRole`), text-based selectors (`getByText`, `has-text`), or stable IDs (`#manifest-paste`).
- **`waitForReady(page)` after every `goto`.** The dataset loads via XHR in dev mode; tests that skip the wait race the hydration cycle and produce flaky "element not found" errors.
- **Empty-state aware assertions.** Many routes (Risks, Files, Credentials, History, Tests) render different H1s when the loaded artifact has zero items in that category. Always include both variants in `fixtures.ts`'s `headlines`.

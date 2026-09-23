# @factstack/chrome-ext _(parked)_

**Status: parked.** A working Manifest V3 side-panel build lives here, but it is not published to the Chrome Web Store and is not being developed right now (owner's call, 2026-09-23). It stays in the tree so it keeps building against the shared packages; do not ship it until the gaps below are closed.

## What exists

- MV3 side panel (`panel.html`) + service worker (`src/sw.ts`), built with `pnpm --filter @factstack/chrome-ext build` into `dist/`.
- Analyzes the GitHub repo in the active tab, or a local folder, fully in the browser (`@factstack/fs-browser` + a module worker running `@factstack/core`).
- Fonts are bundled (`public/fonts`); the only network origins are `api.github.com` and `raw.githubusercontent.com`.

## Known gaps before it could ship

- No automated tests, and no `lint` beyond a placeholder.
- No icons (`icons` / `action.default_icon`).
- "Explore the demo" needs `scripts/make-demo.mjs` run by hand first — a fresh build 404s.
- No way to supply a GitHub token, so large repos hit the anonymous rate limit; the declared `storage` permission is unused.
- Dependency CVEs are not checked in the panel (the Security view says so).
- Timeout / cancel do not stop the analyze worker; closing the panel drops an in-flight analysis.
- Branch names containing `/` are parsed wrong from GitHub URLs.

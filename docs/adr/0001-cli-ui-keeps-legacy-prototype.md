# ADR 0001 — The CLI's local UI stays the legacy prototype

- **Status:** accepted — owner decision, 2026-09-24
- **Decider:** Aditya Mishra (owner)
- **Scope:** `factstack ui`, `factstack export`, `factstack quick`

## Context

- Two UIs render the same dataset:
  - `apps/ui-remix` — Remix v3 (own VDOM, no React); the hosted site, [factstack.pages.dev](https://factstack.pages.dev).
  - `legacy/prototype/index.html` — the single-file editorial UI.
- The CLI has always served (`ui`) or inlined (`export`, `quick`) the prototype. The README claimed
  `export` used the ui-remix static build; that was false.
- As shipped, the prototype pulled Tailwind's in-browser JIT, Google Fonts and `@babel/parser` from
  CDNs, carried an optional Supabase client, and rendered dataset strings unescaped (stored XSS,
  security#3).
- INV7 (browser/CLI parity) points at one UI for both surfaces.

## Decision

Keep the prototype as the CLI's local UI, hardened, rather than port the CLI to ui-remix now:

- `apps/cli/scripts/sync-ui.mjs` builds the committed `apps/cli/src/ui/index.html` from
  `legacy/prototype/index.html`: Tailwind compiled and inlined, system font stacks,
  `@babel/parser` bundled locally (`vendor/`, gitignored) and remote `import()`s — the Supabase
  client — replaced by an inert rejection.
- `factstack ui` sends a hash-based CSP (no `'unsafe-inline'` scripts); `export` / `quick` reports
  carry a static variant of it (no `'self'`, no `frame-ancestors`) as a `<meta>` tag. No
  third-party requests, except `api.github.com` / `raw.githubusercontent.com` when the user
  explicitly scans a GitHub repo.
- `apps/cli/scripts/test/legacy-ui-dom.test.ts` renders a hostile dataset in headless Chromium and
  asserts nothing executes; CI runs it as a blocking step on ubuntu.
- `apps/ui-remix` remains the hosted site.

## Consequences

- **INV7 exception, on purpose:** hosted UI = Remix, CLI UI = prototype. A feature added to one does
  not appear in the other unless it is ported.
- Edit `legacy/prototype/index.html`, then run `pnpm --filter @factstack/cli sync:ui`. The source
  renders unstyled on its own; open the built `apps/cli/src/ui/index.html`.
- The prototype's `?gh=` deep links and Supabase cache stay in the source; in the CLI build the
  Supabase path is inert.
- Static reports (`export` / `quick`) cannot load the vendored `@babel/parser` (no server, no
  `'self'`), so an open-folder scan inside one shows no import edges; that needs `factstack ui`.
- Revisit when ui-remix can produce an offline, single-file report (the VS Code webview work), at
  which point one UI can serve both surfaces.

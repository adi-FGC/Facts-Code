# apps/ui-remix — porting work tracker

> **What this is**: a punch-list for porting the rest of the legacy
> prototype (`legacy/prototype/index.html`) to the Remix v3 + React 19 +
> Vite + React Router 7 app under this folder.
>
> **Branch**: `apps-remix3`
>
> **Status**: 5 of 11 tabs ported. Top nav + tree panel + status bar +
> data loading + URL routing all live. Bundle: ~295 KB JS / ~92 KB gzip.

---

## What's ported

| Tab | Route | File | Notes |
|---|---|---|---|
| Overview | `/` | `src/routes/Overview.tsx` | Editorial hero + stack chips + capabilities. Done. |
| Graph | `/graph` | `src/routes/GraphRoute.tsx` | xyflow dependency graph. Done. |
| Files | `/files` | `src/routes/Files.tsx` | Tree-driven file outline + preview. Done. |
| Risks | `/risks` | `src/routes/Risks.tsx` | Severity-grouped findings. Done. |
| History | `/history` | `src/routes/History.tsx` | Snapshot trends. Done. |

## What's stubbed (porting from legacy)

Each row's "Legacy reference" links back to the legacy prototype's
implementation under `legacy/prototype/index.html` — you can read those
sections to find the exact rendering logic to port.

| Tab | Route | Stub file | Legacy reference (line ranges in index.html, approx) |
|---|---|---|---|
| DAG | `/dag` | `src/routes/Dag.tsx` | Look for `panel-dag` + the layered-graph rendering. The xyflow integration in `GraphRoute.tsx` is the right starting point — DAG is a different layout (Sugiyama / top-down) over the same edges. |
| Library | `/library` | `src/routes/Library.tsx` | `_renderLibraryInner` in legacy index.html — symbol rows grouped by role with search. |
| Routes | `/routes` | `src/routes/RoutesTab.tsx` | `panel-routes` — entry-points list + API endpoints with framework chips. Data is already in `Dataset.entryPoints` + `Dataset.routes`. |
| Tests | `/tests` | `src/routes/Tests.tsx` | `panel-tests` — coverage panel. Largely a v0.3.7 + v0.4.12 feature; the stub is fine until those land. |
| About | `/about` | `src/routes/About.tsx` | `panel-about` — what FACTS is + roadmap + MCP integration help. Mostly static markdown content. |
| Config | `/config` | `src/routes/Config.tsx` | `panel-config` — theme toggle, font slider, GitHub PAT, Supabase config. |

## What's been ADDED in the new app (not in the legacy)

| Feature | File | Notes |
|---|---|---|
| Typed route catalog | `src/lib/routes.ts` | Uses `remix/route-pattern` (Remix v3) for strongly-typed URLs. Single source of truth shared by `App.tsx` and `Header.tsx`. |
| Porting-aware Header | `src/components/Header.tsx` | Tabs flagged with `ported: false` show a small amber dot so users see the work in progress. |
| Stub component | `src/components/PortFromLegacy.tsx` | Shared placeholder for the 6 unported tabs. Includes a deep link back to the legacy demo at the same tab (`?gh=...#tab=name`) so users aren't stranded. |
| Build-time data injection | `scripts/inject-data.mjs` | Bakes `legacy/prototype/data/factstack.json` into `dist/index.html` so static deploys work without a server. |

## What needs porting beyond the 6 tabs

These are app-level features that the legacy prototype has and the
Remix v3 app doesn't yet:

1. **GitHub source flow** — the toolbar `GitHub` button + modal that
   accepts `owner/repo`, runs the trees-API+raw-blobs scanner, and
   uploads to Supabase. Needs to be ported into a React component
   under `src/components/GitHubModal.tsx` and wired to a stateful
   `Dataset` swap (the existing `onReanalyze` callback pattern works).
2. **Supabase persistence + cache-first deep links (`?gh=…`)** — same
   logic as legacy, just lifted into React hooks + a small
   `lib/supabase.ts` helper.
3. **Scan modal with live progress** — when a fresh scan runs, surface
   a `<dialog>` with phase/path/counter/progress bar. Existing
   `scanCtl` controller in legacy is closure-based and ports cleanly
   to a React component + reducer.
4. **Mobile drawer for the LHS tree** — legacy collapses the tree into
   a slide-in drawer on narrow viewports. New app does not yet.
5. **View Transitions** — legacy uses `document.startViewTransition`
   for tab switches. React Router 7 has `unstable_viewTransition`
   support; wire it on `<NavLink>`.
6. **Theme toggle + font-size slider** — existing in legacy, missing
   in new shell.

## Where to use Remix v3 modules going forward

The point of the rewrite is that **Remix v3 owns what it can**.
Concrete substitutions to make as we port:

| Legacy mechanism | Replace with |
|---|---|
| Custom URL parsing | `remix/route-pattern` (already wired in `lib/routes.ts`) |
| Hand-rolled cookies | `remix/cookie` (when cloud sync ships in v0.5+) |
| Custom file upload handling | `remix/multipart-parser` (when CLI gains upload) |
| Manual data validation | `remix/data-schema` — already paired with our Zod schemas, future state could converge |
| Future API server | `remix/fetch-router` + `remix/node-fetch-server` |

`@remix-run/ui` (the headless component primitives — accordion, combobox,
listbox, etc.) is **NOT React-compatible** — it has its own VDOM runtime.
We're sticking with React for the foreseeable future per the original
plan; revisit if Remix's UI runtime gains a React adapter.

## Build + run

```bash
# Dev with HMR
pnpm --filter @factstack/ui-remix dev
# → http://localhost:3000

# Production build (data baked into dist/index.html)
pnpm --filter @factstack/ui-remix build

# Preview the production bundle locally
pnpm --filter @factstack/ui-remix start

# Refresh the baked dataset (source = legacy/prototype/data/factstack.json)
pnpm --filter @factstack/ui-remix exec node scripts/inject-data.mjs
```

The Netlify deploy at https://factstack-demo.netlify.app runs
`pnpm install --frozen-lockfile && pnpm --filter @factstack/ui-remix build`
and serves `apps/ui-remix/dist/`.

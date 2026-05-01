# apps/ui-remix — porting work tracker

> **What this is**: a punch-list for porting the rest of the legacy
> single-file prototype (`legacy/prototype/index.html`) to this Remix
> v3 app, **which runs without React**.
>
> **Branch**: `apps-remix3`
>
> **Status**: shell + 3 of 11 tabs ported. Top nav + tree panel +
> status bar + data loading + URL routing + back/forward all live.
> Bundle: **92 KB JS / 29 KB gzip** (down from 295/92 with React).

---

## Stack

- **Runtime**: `@remix-run/ui`'s VDOM (NOT React). Components are
  `(handle: Handle<Props>) => (props: Props) => RemixElement`.
  `handle.update()` schedules a re-render; `handle.signal` aborts
  on unmount.
- **JSX**: esbuild's automatic runtime pointed at `@remix-run/ui`.
  `mix={css({...})}` for styles, `mix={[css({...}), on('click', fn)]}`
  for combined style + event mixins.
- **Routing**: typed via `remix/route-pattern`. SPA mount uses a
  custom `navigate()` helper (`src/lib/navigate.ts`) that pushState's
  + dispatches `factstack:nav`; `main.tsx` listens for that and
  `popstate` and re-renders the App. ~30 lines total.
- **Build**: Vite 8 with `jsx: 'automatic'` + `jsxImportSource:
  '@remix-run/ui'`. No React plugin, no React deps.

## What's ported

| Tab | Route | File | Notes |
|---|---|---|---|
| Overview | `/` | `src/routes/Overview.tsx` | Hero + Stack chips + frameworks + capabilities. Done. |
| Risks | `/risks` | `src/routes/Risks.tsx` | Severity-grouped findings + "nothing to flag" empty state. Done. |
| History | `/history` | `src/routes/History.tsx` | Snapshot-trends table + empty state. Done. |

## What's stubbed (porting from legacy)

| Tab | Route | Stub | Legacy reference |
|---|---|---|---|
| Graph | `/graph` | `routes/GraphRoute.tsx` | Force-directed dependency graph. Legacy uses xyflow (React); needs a React-free swap (d3-force + SVG, or cytoscape.js). |
| DAG | `/dag` | `routes/Dag.tsx` | Layered top-down view of the same edges. Same blocker as Graph. |
| Files | `/files` | `routes/Files.tsx` | Tree-driven file outline + preview. Legacy uses react-arborist; needs a React-free tree primitive or a hand-rolled recursive component. |
| Library | `/library` | `routes/Library.tsx` | Symbol-level browse. Largely a list-rendering tab; data is in `agent.json`, render is straightforward. |
| Routes | `/routes` | `routes/RoutesTab.tsx` | Entry-points list + API endpoints with framework chips. Data already in `Dataset.entryPoints` + `Dataset.routes`. |
| Tests | `/tests` | `routes/Tests.tsx` | Coverage panel — mostly v0.3.7 + v0.4.12 features. Stub fine until those land. |
| About | `/about` | `routes/About.tsx` | Static markdown content. |
| Config | `/config` | `routes/Config.tsx` | Theme toggle, font slider, GitHub PAT, Supabase config. |

## What's been ADDED in the new app

| Feature | File | Notes |
|---|---|---|
| Typed route catalog | `src/lib/routes.ts` | `remix/route-pattern` instances; single source of truth shared by App + Header. |
| Porting-aware Header | `src/components/Header.tsx` | Tabs flagged `ported: false` show a small amber dot. |
| Stub component | `src/components/PortFromLegacy.tsx` | Shared placeholder with a deep link back to the legacy demo at the same `#tab=name`. |
| SPA navigation | `src/lib/navigate.ts` | `navigate(href)` + `linkClick` global delegation; ~50 lines, no router lib. |
| Build-time data injection | `scripts/inject-data.mjs` | Bakes `legacy/prototype/data/factstack.json` into `dist/index.html`. Idempotent. |

## Substantive work still ahead (beyond stub→full ports)

App-level features the legacy prototype has and this app doesn't:

1. **GitHub source flow + Supabase persistence** — port from
   `legacy/prototype/index.html` (the `FACTSTACK_GH_API_START` block
   + the Supabase loader + scan modal + cache-first deep links).
   Most of it is browser-platform code that lifts cleanly into
   Remix v3 components.
2. **Live re-analyze** — Header should expose a Re-analyze button when
   served by `factstack ui` (proxy to `/api/reanalyze`). Hidden in
   static mode. The `linkClick` handler can be expanded to a typed
   action dispatcher, or use Remix v3's `on()` mixin per-button.
3. **Mobile drawer for the LHS tree** — legacy collapses the tree on
   < 720 px. New app currently hides it entirely; a slide-in drawer
   is a 50-line job.
4. **Theme toggle + font-size slider** — live in legacy `Config` tab
   in functional form. New app needs the hooks for `data-theme` swap
   on `<html>` and `--font-scale` on `:root`.
5. **View Transitions on tab switches** — easy with
   `document.startViewTransition` wrapping the `root.render()` call
   in `main.tsx`. Feature-detect first.
6. **Recursive collapsible TreePanel** — current v1 is a single-level
   listing. Recursive version is a Remix v3 component with per-row
   open/closed state in the closure + `handle.update()` per toggle.
7. **Search palette (⌘K)** — legacy has a quick-action palette;
   new app doesn't yet.

## Where Remix v3 modules already pull weight

| Use case | Remix module | Status |
|---|---|---|
| Typed URL catalog | `remix/route-pattern` | Live in `lib/routes.ts` |
| JSX runtime | `@remix-run/ui` (auto) | Live everywhere |
| CSS-in-JSX | `@remix-run/ui#css` | Live everywhere via `mix={css({...})}` |
| Event mixins | `@remix-run/ui#on` | Reserved for per-element handlers when needed; currently using global click delegation in `main.tsx` |
| Future API server | `remix/fetch-router` + `remix/node-fetch-server` | Reserved for `factstack ui` server |
| Future cookies | `remix/cookie` | Reserved for theme + session persistence |
| Future config validation | `remix/data-schema` | Reserved; pairs with @factstack/spec's Zod schemas |

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
and serves `apps/ui-remix/dist/`. NODE_VERSION pinned to 24
(Remix v3 requires ≥24.3.0).

## Component pattern cheatsheet

```tsx
import type { Handle } from '@remix-run/ui';
import { css } from '@remix-run/ui';

interface MyProps { count: number; }

// Stateless: setup is empty, render fn just returns JSX.
export function StatelessOne(_h: Handle<MyProps>) {
  return ({ count }: MyProps) => (
    <div mix={css({ padding: '16px' })}>Count: {count}</div>
  );
}

// Stateful: state lives in the setup closure between renders.
// handle.update() schedules a re-render. handle.signal aborts on
// unmount — useful for clearing intervals/listeners.
export function Clock(handle: Handle) {
  let seconds = 0;
  const id = setInterval(() => { seconds++; void handle.update(); }, 1000);
  handle.signal.addEventListener('abort', () => clearInterval(id));
  return () => <span class="mono">{seconds}s</span>;
}
```

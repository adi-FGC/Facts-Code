# FACTS — AI Coding Tracker Stack *(working name, final pick pending)*

**CXO-Grade Static Code Analyzer — Product & Engineering Plan (v0.1)**

FACTS produces two artifacts from one analysis pass: an AI-agent-optimized codebase map and a CXO-readable executive dashboard. v0.1 ships a Node/Deno CLI + local Remix 3 UI; surfaces #2–#6 (npm global, VS Code/Antigravity extension, Chrome extension, web app + cloud + MCP server, MCP app with skills) are architecturally reserved as stubs so they require no rewrites later.

### Naming — decision needed before W1

The earlier "FERN" working name collided with an existing ORM/design-system, so FACTS is the leading candidate. Still needs availability checks. Candidates, ordered by fit:

| Name | Read | Notes to verify on exit |
|---|---|---|
| **FACTS** (recommended) | "File Analysis & Context Tracking Stack" — acronym earns it, evidence-first ethos embedded in the name | `facts` abandoned since 2015 on npm; use `factstack` scope (✅ clean). `facts.dev` taken; target `factstack.dev` |
| **De-Facts** | Wordplay on *de facto*; memorable; slight risk of negative "de-" read | Domain + trademark check |
| **Destiny Engine** | Strong CXO/investor register; evokes forward-looking vision | Possible game-industry collision (Bungie "Destiny"); legal review advisable |
| **Axiom** | Short, elegant, "self-evident truth" — mirrors evidence-first UX | Taken actively on npm (AI SDK v0.52) |
| **Meridian** | Elegant, fast, orientation metaphor (where your codebase stands) | Abandoned npm since 2016 |
| **Lattice** | Structural; maps to graph-first mental model | Taken (OpenLattice SDK) |
| **Fathom** | "To understand deeply" — one-word mission statement | Abandoned npm since 2014 |
| **Cadence** | Movement + consistency, fits watch-mode feel | Actively taken on npm |

**Decision locked:** brand = **FACTS**, npm/CLI = `factstack`, domain target = `factstack.dev`.

---

## 1. Context

You are building an analyzer that bridges a gap confirmed by competitive research: **no tool today emits both an AI-agent-optimized codebase map and a CXO-readable dashboard from a single analysis pass**. Cursor, Aider, repomix, and gitingest target developers; CodeScene and SonarQube produce executive dashboards but focus on code-quality metrics, not architecture topology. Claude Code and Cursor will eventually move into the CXO space — so the competitive window is real but finite.

The product must feel trustworthy enough for a CTO or investor to open without a developer present, yet expose enough structure for an AI coding agent to operate on a large codebase without re-reading every file. The same analysis feeds both.

Primary constraints you set:
- **Runtime**: Node/Deno-first TypeScript stack, structured so that the same core powers a CLI, npm global, VS Code/Antigravity extension, Chrome extension, web app with cloud sync, and an MCP app with skills.
- **MVP scope (v0.1)**: points 1–7 and 10 of your brief — scan, gitignore-aware walk, emit dual artifacts, local WebUI with file tree + Redux-DevTools-style graph + per-file outline. No emulation, no test generation, no code-review engine in v0.1.
- **UI**: Local Remix 3 modules + Vite + React 19 + React Router v7 (see §10 risk #5 for the reality-check — Remix 3 is a library, not a framework CLI).
- **Languages at v0.1**: JavaScript/TypeScript + Python, deep analysis. Broader tree-sitter coverage in v0.2+.

---

## 2. Product Pillars

1. **One analysis → two artifacts**: `.facts/agent.json` (machine) and `.facts/human.json` (dashboard data). Both derived from the same in-memory graph so they can't drift.
2. **Works on any codebase, any OS**: Mac + Windows, Node 20+, gitignore-aware, no native compiler toolchain required at install. SQLite via `node:sqlite` (Node 22+ built-in) — no native `better-sqlite3` compile.
3. **Zero-friction CXO entry**: `npx factstack .` in a project folder → browser opens a dashboard that a non-coder can navigate.
4. **Respects privacy by default**: artifacts are local files. Cloud sync is opt-in. Secrets are detected and redacted before any remote transport.
5. **Progressive depth**: top-level project brief → routes/entry points → per-file outline → per-symbol metadata. Each layer unlocked by a click.

---

## 2.5 Locked architectural constraints (day one, even though v0.1 is CLI-only)

Three future surfaces are now binding constraints. If v0.1 violates any of these, later surfaces require painful rewrites.

**C1 — Chrome extension / WASM-only analyzer ⇒ isomorphic core.**
- `packages/core` and every package it transitively depends on (`spec`, `graph`, `extractors`, `scanners`) **must not import Node built-ins** (`fs`, `path`, `os`, `worker_threads`, `child_process`) directly.
- All I/O is injected via an abstract interface (see `packages/spec/src/fs.ts` — the `FactsFS` interface).
- Two implementations from v0.1: `packages/fs-node` (Node fs) and `packages/fs-memory` (in-memory, used by tests). v0.4 adds `packages/fs-browser` (File System Access API + GitHub REST) with zero changes to core.
- Parsers use `web-tree-sitter` (WASM) exclusively — no native bindings even on Node, so the same code runs in a browser.
- Enforced via ESLint `no-restricted-imports` rule banning `node:*` and Node built-ins from `packages/core/**` and its dependency closure. CI fails on violation. See `eslint.config.mjs`.

**C2 — Web app + MCP server + cloud sync ⇒ artifact discipline.**
- `spec` schemas are **versioned** (`$schema`, `factsVersion`) and backward-compatible via additive-only changes within a major. Breaking changes bump the major and ship a migration tool.
- Artifacts are **size-bounded**: `agent.json` default cap 5 MB, `human.json` default cap 2 MB. Overflow gets split into `agent.chunks/` with an index — keeps cloud uploads predictable.
- Artifacts **never contain raw secrets**. Secrets scanner runs before serialization; findings carry redacted previews + file/line references only.
- MCP server's tool/resource shape is **sketched in the spec package today** (`packages/spec/src/mcp.ts`), even though implemented in v0.5:
  - Resources: `facts://project`, `facts://file/{path}`, `facts://graph`, `facts://routes`, `facts://risks`.
  - Tools: `analyze`, `reanalyze_file`, `query_graph`, `get_outline`, `list_risks`.
  - Sketching the surface now forces the CLI's command vocabulary to match, so the MCP server is a thin wrapper in v0.5 instead of a re-design.
- CLI has a machine-invocable mode from day one: `factstack analyze --json` streams progress + final artifact to stdout with no TTY prompts.

**C3 — VS Code / Antigravity extension ⇒ webview-ready UI.**
- `apps/ui-remix` has two Vite build targets:
  1. **Dev / server mode** (`vite --port 3000`): full app with live re-analyze endpoint. Used by the CLI when it opens the browser.
  2. **Static mode** (`vite build --mode static`): emits a **pure client-side SPA bundle** — no server required, data hydrated from embedded `human.json` + `agent.json`. Used by `factstack export` and by VS Code webviews.
- Static mode is enforced by keeping all data-fetching in a single `loadArtifacts()` function with two implementations: `fetch-from-server` and `read-from-embedded-json`. Everything else — routes, components, graph, outline — is shared.
- UI never uses APIs blocked by VS Code webview CSP: no inline scripts, no `eval`, no WebSocket to arbitrary origins, no `unsafe-inline` styles. Vite config locks this down at build time.

**Package dependency rules** (enforced via `eslint-plugin-boundaries` + CI):

| Layer | May import from |
|---|---|
| `spec` | nothing |
| `fs-*` | `spec` |
| `parsers` | `spec` |
| `extractors` | `spec`, `parsers` |
| `graph`, `scanners` | `spec`, `extractors` |
| `core` | `spec`, `graph`, `scanners`, `extractors` (not `fs-*`) |
| `emit` | everything above + Node built-ins allowed |
| `apps/cli` | `emit`, `fs-node`, `core` |
| `apps/ui-remix` | `spec`, `ui-theme` only |

These rules are the insurance policy. With them in place, surfaces #2–#6 are additive.

---

## 3. Repository Layout (monorepo, pnpm + Turborepo)

```
factstack/
├── packages/
│   ├── spec/              # Zod schemas + TS types for agent.json & human.json. Single source of truth.
│   ├── core/              # Pure analysis engine. No I/O side effects. Isomorphic.
│   ├── walker/            # Filesystem walker (gitignore-aware, symlink-safe, cross-platform paths). Takes a FactsFS interface.
│   ├── fs-node/           # Node fs implementation of FactsFS (used by CLI).
│   ├── fs-memory/         # In-memory FactsFS for tests and fixture-driven CI.
│   ├── fs-browser/        # v0.4 stub. File System Access API + GitHub REST implementation of FactsFS.
│   ├── parsers/           # web-tree-sitter (WASM) grammar registry + language adapters. No native bindings.
│   ├── extractors/        # Per-language symbol/route/dependency extractors. Pure; no I/O.
│   ├── graph/             # Dependency + outline graph builders.
│   ├── emit/              # Serializers: agent.json, human.json, static HTML export, SQLite index via node:sqlite. Node-only allowed here.
│   ├── scanners/          # Cross-cutting: secrets, licenses, framework detection, TODO/FIXME harvest, bundle-size + token-cost. Pure.
│   └── ui-theme/          # Shared design tokens (Tailwind + CSS vars) + liquid-glass primitives + language-icon mapper.
├── apps/
│   ├── cli/               # `factstack` binary. Node 20+ & Deno compatible. Spawns ui-remix dev server.
│   ├── ui-remix/          # Vite + React 19 + React Router v7 + Remix 3 modules. Consumes human.json.
│   ├── vscode-ext/        # v0.3 stub.
│   ├── chrome-ext/        # v0.4 stub.
│   ├── webapp/            # v0.5 stub.
│   └── mcp-server/        # v0.5 stub.
├── plugins/
│   └── mcp-app/           # v0.6 stub.
├── prototype/             # v0.1 HTML prototype (Tailwind v4 CDN). Disposable; proves the UI direction before real build-out.
├── examples/              # Fixture projects (React app, Express API, FastAPI service, Django monolith).
├── .changeset/            # Independent semver per package.
├── app_spec.md            # "What does FACTS do?"
├── design_spec.md         # "What does FACTS look and feel like?"
├── animations_spec.md     # "How does motion work?"
├── app_plan_spec.md       # This file.
├── eslint.config.mjs      # Boundaries + no-restricted-imports.
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## 4. Core Analyzer Design

### 4.1 Pipeline (deterministic, pure where possible)

```
walker ─► parsers ─► extractors ─► graph ─► scanners ─► emit
   │           │            │          │         │          │
 (paths)   (AST nodes)  (symbols)  (nodes+edges) (findings) (artifacts)
```

Each stage is a TypeScript function taking the previous stage's output. Easy to unit-test with fixtures and easy to cache incrementally by file hash.

### 4.2 Walker (`packages/walker`)

- Accepts a `FactsFS` interface (constraint C1). Does not import Node `fs` directly.
- `ignore` npm package stacked with `.factsignore`.
- Always-exclude regardless of gitignore: `node_modules`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `__pycache__`, `.venv`, `.git`, `vendor`, `target`.
- Reads `.gitignore`, `.dockerignore`, `.cursorignore`, `.aiignore`, `.factsignore` hierarchically.
- Symlink loop detection; POSIX path normalization.
- File size cap default 1 MB; larger files flagged, not parsed.
- Binary detection via null-byte sniff in first 8 KB.

### 4.3 Parsers (`packages/parsers`)

- `web-tree-sitter` (WASM) — cross-platform, no native compilation.
- Lazy grammar load per file extension.
- v0.1 grammars: TypeScript, TSX, JavaScript, JSX, Python, JSON, YAML, TOML, Markdown.
- v0.2: Go, Rust, Java, Kotlin, Swift, C#, PHP, Ruby.

### 4.4 Extractors (`packages/extractors`)

One adapter per language. Each emits a normalized `FileOutline` (schema in `packages/spec/src/agent.ts`).

Routes detection: Next.js `app/` + `pages/`, Remix `routes/`, Express `app.get/post`, FastAPI decorators, Flask/Django URL patterns. Components: React (function + class), JSX/TSX default/named exports.

### 4.5 Graph (`packages/graph`)

1. **Dependency graph**: nodes = files/modules/packages, edges = imports. Cycles flagged.
2. **Outline graph**: hierarchical — project ▸ package ▸ file ▸ symbol.

Both persisted in `.facts/index.db` via **`node:sqlite`** (built into Node 22+ — no `better-sqlite3` native compile, no `node-gyp`, no prebuild-install fragility). JSON artifacts are generated views on top.

### 4.6 Scanners (`packages/scanners`)

- **Secrets**: regex + entropy (gitleaks-style rules). Redacted previews only.
- **Licenses**: SPDX detection from `package.json`, `pyproject.toml`, and headers.
- **Framework detection**: manifest files + import signatures.
- **TODO/FIXME/HACK/XXX** harvesting with git blame-lite.
- **Git history mining**: per-file last-modified, churn, author count.
- **Bundle-size estimator**: parsed/minified/gzipped byte counts (JS/TS); LOC + transitive-import proxy for Python.
- **Token-cost estimator**: `tiktoken` `cl100k_base` per file, rolled up.

### 4.7 Status inference

- `parse_error`: extractor failed.
- `broken`: unresolved imports, missing env references, failing type check.
- `stale`: not touched in > threshold (default 180 days) with `TODO`/`FIXME`.
- `ok`: default.

Derived, not stored. Every status maps to a concrete detectable signal the user can audit.

---

## 5. Dual Artifacts

### 5.1 `agent.json` (AI-agent-optimized)

Schema in `packages/spec/src/agent.ts`. Path-addressable, dense, versioned. Streamable companion: `agent.jsonl`.

### 5.2 `human.json` (CXO-readable, feeds the dashboard)

Schema in `packages/spec/src/human.ts`. Narrative-shaped. Every field maps to a UI block. Glossary for jargon translation.

---

## 6. WebUI (apps/ui-remix)

### 6.1 Global layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Top nav (glass) — logo · GLOBAL TABS · search · theme · re-analyze       │  56 px
├──────────────────────┬────────────────────────────────────────────────────┤
│                      │  Local tab bar (glass)                             │  44 px
│   LHS panel (glass)  ├────────────────────────────────────────────────────┤
│   Tree/Graph/Split   │                                                    │
│   toggle + metadata  │   RHS content pane                                 │
│   (22 dvw default,   │   (scrolls independently; View Transition-         │
│    resizable,        │    animated navigations)                           │
│    mobile drawer)    │                                                    │
├──────────────────────┴────────────────────────────────────────────────────┤
│  Status bar — parse state · last analysis · git branch · health summary   │  28 px
└───────────────────────────────────────────────────────────────────────────┘
```

- **LHS Desktop (≥ 900 px)**: resizable, `clamp(20dvw, 22dvw, 25dvw)` initial, collapsible to 40 px rail.
- **LHS Mobile (< 900 px)**: sliding drawer, 82 vw, hamburger trigger, scrim + blur.
- **LHS view modes**: Tree / Graph / Split, auto-suggest based on project shape.
- **Per-node metadata**: language icon, status chip, bundle-size badge, token-cost badge, last-modified.
- **Global tabs**: Overview, Graph, Files, Routes, Risks, History.
- **Local tabs**: content-specific per view.

### 6.2 Light / Dark mode

- Three-state toggle: Light / Dark / System.
- Default System (`prefers-color-scheme`); override in `localStorage` + mirrored to `.facts/config.json`.
- No flash: CSS-first via `color-scheme` + `light-dark()` + theme cookie, with 800-byte inline-script fallback.
- Theme swap uses View Transition circular reveal; graph/tree re-paint with dark-native tokens.

### 6.3 View Transition API

Primary moments: LHS file select, graph node click, tab switch, theme swap, outline expand/collapse, tree↔graph morph, mobile drawer open/close, re-analyze complete. See `animations_spec.md` §2 catalogue.

Fallback: feature-detect + instant-swap on unsupported browsers.

### 6.4 Static export (constraint C3)

`factstack export` invokes `vite build --mode static` → self-contained `./dist/facts-report.zip`. Re-analysis hidden. Same bundle hosted by v0.3 VS Code webview.

### 6.5 Graph rendering

`@xyflow/react` for dependency graph. `react-arborist` for file tree. Shiki for syntax highlighting. `framer-motion` for non-View-Transition motion.

---

## 7. CLI (apps/cli)

### 7.1 Commands

```
factstack                           # analyze cwd, emit artifacts, open UI
factstack analyze [path]            # analyze without opening UI
factstack analyze --json            # machine-invocable, JSON to stdout
factstack ui                        # open UI against existing artifacts
factstack export [path]             # emit static HTML bundle
factstack doctor                    # sanity-check artifacts + grammar availability
factstack watch                     # incremental re-analysis on file changes
```

### 7.2 Output layout

```
.facts/
├── agent.json          # machine-readable artifact
├── agent.jsonl         # streamable companion
├── human.json          # dashboard data
├── index.db            # node:sqlite query index
├── snapshots/          # prior analyses (date-stamped, tiny diffs)
└── config.json         # user preferences
```

### 7.3 `.factsignore`

Stacked on gitignore. For cases where a repo commits generated files it wants FACTS to skip.

---

## 8. Performance & incremental analysis

- Parse is the bottleneck. Cache AST + extractor output keyed by `(filePath, sha256(contents))` in `index.db`.
- Parallelism: `worker_threads` pool sized to `os.cpus().length - 1` (in CLI layer only; isomorphic core stays pure).
- Target: 100k-LOC TypeScript monorepo analyzed in < 30 s cold, < 3 s warm.
- Watch mode uses `chokidar`, affected-subgraph re-runs only.

---

## 9. Roadmap — six surfaces, additive

| Version | Surface | Reuses | New work | Target |
|---|---|---|---|---|
| v0.1 | CLI + local UI | core, spec, emit, ui-theme | pipeline + UI screens | Weeks 1–10 |
| v0.2 | npm global install | apps/cli | npm publish workflow, bin shim | Weeks 11–12 |
| v0.3 | VS Code / Antigravity | core, spec, emit | Extension manifest, webview hosting static bundle | Weeks 13–18 |
| v0.4 | Chrome extension | core (WASM build), spec | MV3 manifest, GitHub injection, WASM analyzer | Weeks 19–24 |
| v0.5 | Web app + cloud + MCP server | spec, emit | File System Access API, Supabase/Postgres, MCP server | Weeks 25–36 |
| v0.6 | MCP app + skills bundle | all above | MCP app packaging, auto-open-UI skill | Weeks 37–42 |

---

## 10. Gaps and risks

1. **Secrets in artifacts.** `.facts/*.json` will sit in the project directory. Redact pre-emission, auto-add `.facts/` to `.gitignore`.
2. **Privacy for CXO audience.** Default local-only; cloud opt-in with granular scopes (metadata, not source).
3. **License & IP scanning.** For investor due-diligence this is *the* headline feature. SPDX + copyleft flagging in v0.1.
4. **Supply-chain risk.** Dependency-age / maintainer-status signals. npm + PyPI metadata fetches at analyze time.
5. **Remix 3 reality (verified April 2026).** Remix 3 is published as a single bare `remix` npm package (`remix@3.0.0-alpha.4`, `next` dist-tag) — NOT the familiar `@remix-run/*` scoped packages. Remix 3 is a **library, not a framework CLI**: no `remix-serve`, no `remix vite:dev`, no file-based routing. Ships ~60 utility modules (`fetch-router`, `auth-middleware`, `data-schema`, `file-storage`, `compress-middleware`, etc.) composed by the user, web-standards-first, no React peer. For the React UI: **Vite 8 + @vitejs/plugin-react + React 19 + React Router v7.14.1** (Remix team's React-side successor) + **Remix 3 modules as utilities** where they fit. Business logic in `packages/*` stays framework-free.
6. **"Trust" gap for non-technical audience.** Every chip/badge clickable → source evidence. No unfalsifiable claims.
7. **Monorepo-aware analysis.** pnpm workspaces, Nx, Turborepo, Lerna, Go modules, Cargo workspaces.
8. **AI hallucination in `summary.oneLiner`.** v0.1: deterministic from README + package.json + routes. LLM polish later, always flagged "AI-generated."
9. **Moat vs. incumbents.** Cursor/Claude Code will build codebase maps in-agent. Our moat: (a) dual artifact (theirs is agent-only), (b) CXO-readable UI (they target devs), (c) agent-agnostic `agent.json` (any tool can consume).
10. **Telemetry.** Privacy-preserving anonymous opt-in.
11. **Accessibility.** WCAG AA from day one.
12. **Testing the analyzer.** Fixture projects in `examples/` as golden masters. Every PR re-runs analysis and diffs artifacts.
13. **Point 13 — test generation & healthchecks:** defer to v0.7+. LLM-heavy, trust-fragile.
14. **Native builds on Windows/Node 25.** `better-sqlite3` fails to install without `node-gyp` + Visual Studio Build Tools. Solution: **switched to `node:sqlite`** (built into Node 22+) — no native compile at all. Also eliminates the prebuild-install fragility on fast-moving Node versions.

---

## 11. Build order for v0.1 (weeks)

1. **W1–W2**: Scaffold monorepo, write specs, seed `@factstack/spec` schemas, set up ESLint boundaries + CI matrix, HTML prototype at `prototype/index.html` to prove UI direction.
2. **W3–W4**: `parsers` (web-tree-sitter WASM registry). `extractors` for TS + Python. Fixture suite with golden-master diffs.
3. **W5**: `graph` (dependency + outline). `emit` for `agent.json`, `human.json`, `index.db` via `node:sqlite`.
4. **W6**: `scanners` — secrets, licenses, TODOs, framework detection, git history, bundle-size, token-cost.
5. **W7**: `apps/cli` — commands, watch mode, local-server bootstrap.
6. **W8–W9**: `apps/ui-remix` — six global tabs, Tree/Graph/Split views, LHS drawer, re-run hook, static export. View Transition catalogue implemented end-to-end. Each view through at least one `critique` + one `polish` pass via Claude Design skills.
7. **W10**: Accessibility + reduced-motion acceptance, docs site, changeset publish dry-run, CXO usability test with 2–3 non-developers.

---

## 12. Critical files for v0.1

- `packages/spec/src/{agent,human,fs,mcp,index}.ts` — schemas + interfaces.
- `packages/fs-node/src/index.ts`, `packages/fs-memory/src/index.ts` — FactsFS impls.
- `packages/walker/src/walk.ts` — gitignore-aware iterator.
- `packages/parsers/src/registry.ts` — lazy WASM grammar loader.
- `packages/extractors/src/{typescript,python}.ts` — per-language extractors.
- `packages/graph/src/{dependency,outline}.ts` — graph builders.
- `packages/scanners/src/{secrets,licenses,frameworks,todos,git,bundle-size,token-cost}.ts`.
- `packages/emit/src/{agent,human,static,sqlite}.ts` — serializers (sqlite via `node:sqlite`).
- `apps/cli/src/cli.ts` — Commander entrypoint.
- `app_spec.md`, `design_spec.md`, `animations_spec.md`, `app_plan_spec.md` — root specs.
- `apps/ui-remix/app/root.tsx`, `routes/_app.{_index,graph,files.$,routes,risks,history}.tsx`, `routes/api.reanalyze.ts`, `lib/{theme,view-transition,breakpoints}.ts`, `components/{TreePanel,GraphCanvas,ViewModeToggle,MobileDrawer,GlobalTabs,LocalTabs,StatusBar,ThemeToggle,ReanalyzeButton,FontSizeSlider,GlassSurface}.tsx`.
- `packages/ui-theme/src/{tokens.css,motion.ts,language-icons.ts,themes/{light,dark}.css,glass.css}`.
- `prototype/index.html` — v0.1 UI prototype (Tailwind v4 CDN).
- `examples/react-fastapi-booking/` — golden-master fixture.

---

## 13. Verification (end-to-end)

1. `pnpm -F @factstack/cli build && pnpm -F @factstack/cli link` — expose `factstack`.
2. Run against `examples/react-fastapi-booking`: `.facts/agent.json`, `human.json`, `index.db`, `snapshots/` populated and schema-valid.
3. `factstack ui` opens browser at `http://localhost:3000`.
4. Manual smoke: Overview shows inferred intent + routes + stack badges; Graph clicks open outline; Files tree→outline→preview chain works via deep link; Re-analyze hydrates without page reload.
5. `factstack export` produces `./dist/facts-report.zip`. Unzip, open `index.html` in fresh browser profile: all views work without a server.
6. Cross-platform CI matrix: `macos-14`, `windows-latest`, `ubuntu-latest`.
7. Responsive visual-regression via Playwright at 340 / 390 / 768 / 1024 / 1440 / 1920 / 2560 / 3840 / 7680 px for light + dark.
8. Font-size slider 0.85× → 1.35×: no layout clipping at any breakpoint.
9. Reduced-motion + reduced-transparency: glass surfaces solid, no blur animations.
10. Bundle-size + token-cost accuracy on fixtures: ≤5 % delta vs `rollup-plugin-visualizer`; exact match vs direct `tiktoken`.
11. CXO usability: non-developer correctly answers "what does this project do and is anything broken?" within 2 minutes.

---

## 14. Open questions (revisit post-v0.1)

- MCP transport: stdio vs HTTP vs both for local dev?
- Cloud data model (v0.5): per-repo snapshots vs continuous git-hooked indexing?
- Pricing: free local + per-seat cloud, or free-forever local + usage-based AI features?
- AI-powered `summary.oneLiner` polish: which model, what guardrails?
- v0.7+ emulation integration: Expo, StackBlitz WebContainers, local emulators?
- Remix 3 version pin: lock to `remix@3.0.0-alpha.4` today; audit release notes every upgrade.

---

## 15. Spec deliverables

Three dedicated spec files at repo root; each surface (CLI, UI, extensions) references them as source of truth:

- **`app_spec.md`** — product + functional (mission, features, artifacts, CLI, roadmap, privacy).
- **`design_spec.md`** — visual + interaction (layout 340 px → 8 K, liquid glass, tokens, typography, font-size slider, components, accessibility).
- **`animations_spec.md`** — motion + View Transitions (catalogue, fallbacks, suspense wrapper, reduced-motion).
- **`app_plan_spec.md`** — this file, the engineering plan.

---

## 16. Resolved gaps (summary)

1. View Transition cross-browser → **Fallback is primary path**; both code paths tested.
2. Resizable LHS vs mobile → **Resizable desktop + sliding drawer mobile**.
3. Tree vs Graph → **Ship both + split mode + auto-suggest**.
4. Dark-mode data viz → **Dark-native palette + re-paint on theme swap**.
5. View Transitions + Remix 3 streaming → **`waitForSuspense()` wrapper**.
6. Theme flash → **CSS-first `color-scheme` + `light-dark()` + cookie**, inline-script fallback.
7. Focus management across transitions → **Accessibility acceptance gate**.
8. i18n → **Deferred to v0.2+**; strings through `t()` so retrofit is a library swap.
9. `dvw` polyfill → **Lightning CSS** in Vite build pipeline.
10. Branding collision → **Locked: FACTS brand + `factstack` npm**.
11. Evidence link density → **Language icons + axe-core focus-order testing + tooltips where dense**.
12. Snapshot/history diff UX → **History tab v0.1 scoped**: trend sparkline + per-file side-by-side on click; full tree diff in v0.2.
13. `better-sqlite3` Windows/Node-25 native-build failure → **Switched to `node:sqlite`**; zero native compile.

---

## 17. Enhancements captured from review

- **Bundle-size + AI-token cost** per file/dir as first-class CXO signal.
- **Liquid-glass aesthetic** on chrome surfaces only (never content/code/graph).
- **Responsive 340 px → 8 K** with content-column caps on 8K.
- **Font-size slider** 0.85× – 1.35× in settings + ⌘;.
- **Tree ↔ Graph morph** in View Transitions catalogue.
- **Graph re-paint on theme swap** — explicit animation step.
- **Claude Design iteration loop**: `frontend-design`, `arrange`, `colorize`, `typeset`, `animate`, `polish`, `critique` through W6–W9.
- **Lightning CSS** for modern-CSS polyfills (`dvw`, `light-dark()`, nesting, `color-mix`).
- **oxlint + oxfmt** for fast JS/TS linting + formatting (replacing Prettier/ESLint where rule coverage is equal).

---

## 18. Tooling choices (locked)

| Concern | Choice | Why |
|---|---|---|
| Package manager | pnpm 10 | Workspace support, strict peer deps, fast installs |
| Task runner | Turborepo | Incremental, cacheable, monorepo-native |
| Linter | **oxlint** | 50-100× faster than ESLint; growing rule coverage |
| Formatter | **oxfmt** | Same codebase as oxlint; Prettier-compatible output |
| Boundaries | `eslint-plugin-boundaries` (thin ESLint layer) | Kept for layer enforcement oxlint doesn't yet cover |
| Parser (analyzer) | web-tree-sitter (WASM) | Isomorphic, cross-platform, no native compile |
| SQLite | `node:sqlite` (Node 22+ built-in) | Zero native compile; no node-gyp; no prebuild-install fragility |
| Bundler (UI) | Vite 8 | React 19 + plugin-react 6 + Lightning CSS |
| CSS polyfills | Lightning CSS (via Vite) | `dvw`, `light-dark()`, nesting, `color-mix` |
| UI framework | React 19 + React Router v7.14.1 | Remix team's React-side continuation |
| Remix 3 | `remix@3.0.0-alpha.4` as utility modules | Web-standards helpers used alongside the React stack |
| Animation | Framer Motion + native View Transition API | Non-transition motion via Framer; navigations via VT API |
| Graph viz | `@xyflow/react` | MIT, battle-tested, good aesthetics |
| Tree viz | `react-arborist` | Virtualized, dynamic row heights |
| Code highlight | Shiki | TextMate grammars, themeable |
| Icons (UI) | lucide-react | MIT, tree-shakeable |
| Icons (lang) | simple-icons + vscode-icons | Language badges |
| Token cost | tiktoken (cl100k_base) | Proxy for Claude/GPT/Gemini, within ~10% |
| Testing | Playwright + axe-core | Browser + accessibility + reduced-motion gate |
| Releases | Changesets | Independent per-package semver |

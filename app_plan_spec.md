# FACTS — AI Coding Tracker Stack

**CXO-Grade Static Code Analyzer — Product & Engineering Plan (v0.1.0-alpha)**

FACTS produces two artifacts from one analysis pass: an AI-agent-optimized codebase map and a CXO-readable executive dashboard. v0.1 ships a Node CLI today and a Vite + React 19 + React Router v7 UI next; surfaces #2–#6 (npm global, VS Code/Antigravity extension, Chrome extension, web app + cloud + MCP server, MCP app with skills) are architecturally reserved as stubs so they require no rewrites later.

**Name / domain**: brand = **FACTS**, npm scope + CLI = `factstack`, domain target = `factstack.dev`.

---

## 0. Current state (as of 2026-04-19)

### Shipped

| Component | Status | Evidence |
|---|---|---|
| Monorepo scaffold | ✅ | pnpm + Turborepo, 13 packages + 6 apps + 1 plugin, ESLint boundaries enforced |
| `@factstack/spec` | ✅ | Real Zod schemas for `agent.json` / `human.json`, `FactsFS` interface, MCP resource/tool surface |
| `@factstack/fs-node` | ✅ | Node `FactsFS` implementation |
| `@factstack/fs-memory` | ✅ | In-memory `FactsFS` for tests |
| `@factstack/walker` | ✅ | gitignore-aware + `.factsignore/.cursorignore` stacked, symlink loop detection, binary sniff, 1 MB cap |
| `@factstack/scanners` | ✅ | languages (23 ext→lang), TODO/FIXME harvester (kind + line + text), secrets (9 rules + entropy gate + redacted previews), frameworks (≈ 45 dep→framework), tiktoken approximation |
| `@factstack/emit` | ✅ | Artifact writer with Zod validation, gzip helper, auto-add `.facts/` to `.gitignore` |
| `@factstack/core` | ✅ | Pipeline orchestration (isomorphic) + tree rollup |
| `apps/cli` (`factstack`) | ✅ | Commander binary, `--json` machine mode, progress bar, `doctor` subcommand, pretty TTY summary |
| HTML prototype | ✅ | Standalone `prototype/index.html` w/ inline JSON; editorial aesthetic landed (see §6) |

### Deferred to v0.2

| Component | Why it moved |
|---|---|
| `@factstack/parsers` (tree-sitter WASM) | v0.1 pipeline emits valid `FileOutline` without AST — good enough to ship the CLI now; parsers unlock `imports`, `exports`, `declarations`, `routes` |
| `@factstack/extractors` | Downstream of parsers |
| `@factstack/graph` | Needs extractor output to build real import edges; icicle view works with folder rollup alone |
| `.facts/index.db` via `node:sqlite` | JSON artifacts cover the v0.1 surface; SQLite unlocks fast incremental queries in `watch` mode |
| `apps/ui-remix` | Prototype proved the design; the React/Vite port is the next surface |
| `factstack ui / export / watch` | CLI verbs pending the UI app and incremental scanner |

### Verified against this repo (2026-04-19)

```
FACTS · analyzing D:\dev\ai agents\claude\factstack
  files        103
  LOC          18.7K
  tokens       206.7K (cl100k approx)
  risks        0
  frameworks   Framer Motion, Prettier, React, React Router, Remix, Tailwind CSS,
               Turborepo, TypeScript, Vite, Zod, oxfmt, oxlint, xyflow
  Artifacts    ✓ .facts/agent.json  ✓ .facts/human.json  ✓ .facts/agent.jsonl
  Done in 146 ms. Total 164.5 KB written.
```

Git: `27e3da5 feat: v0.1 analyzer pipeline + factstack CLI` on top of `614ec69 chore: initial scaffold`.

---

## 1. Context

You are building an analyzer that bridges a gap confirmed by competitive research: **no tool today emits both an AI-agent-optimized codebase map and a CXO-readable dashboard from a single analysis pass**. Cursor, Aider, repomix, and gitingest target developers; CodeScene and SonarQube produce executive dashboards focused on code-quality metrics, not architecture topology. Claude Code and Cursor will eventually move into the CXO space — so the competitive window is real but finite.

The product must feel trustworthy enough for a CTO or investor to open without a developer present, yet expose enough structure for an AI coding agent to operate on a large codebase without re-reading every file. The same analysis feeds both.

Primary constraints:
- **Runtime**: Node-first TypeScript stack, structured so that the same core powers a CLI, npm global, VS Code/Antigravity extension, Chrome extension, web app with cloud sync, and an MCP app with skills.
- **MVP scope (v0.1)**: scan, gitignore-aware walk, emit dual artifacts, local WebUI with file tree + icicle graph + per-file outline. No emulation, no test generation, no code-review engine in v0.1.
- **UI**: Vite 8 + React 19 + React Router v7 + Remix 3 utility modules. See §10 risk #5 for the Remix 3 reality-check.
- **Languages at v0.1**: JavaScript/TypeScript + Python with metadata + TODO/secrets/frameworks. AST extractors land in v0.2.

---

## 2. Product Pillars

1. **One analysis → two artifacts**: `.facts/agent.json` (machine) and `.facts/human.json` (dashboard data). Both derived from the same in-memory graph so they can't drift. ✅ Shipped.
2. **Works on any codebase, any OS**: Mac + Windows, Node 20+, gitignore-aware, no native compiler toolchain required at install. SQLite via `node:sqlite` (Node 22+ built-in) — no native `better-sqlite3` compile. ✅ CLI works on Windows + Node 25.
3. **Zero-friction CXO entry**: `npx factstack .` in a project folder → artifacts emitted today; browser-opening UI lands with `apps/ui-remix`.
4. **Respects privacy by default**: artifacts are local files. Cloud sync is opt-in. Secrets are detected and redacted before any remote transport. ✅ Shipped — redacted previews only, `.facts/` auto-gitignored.
5. **Progressive depth**: top-level project brief → routes/entry points → per-file outline → per-symbol metadata. Each layer unlocked by a click. ✅ In prototype.

---

## 2.5 Locked architectural constraints (enforced in CI)

**C1 — Chrome extension / WASM-only analyzer ⇒ isomorphic core.** ✅ Upheld.
- `packages/core` and every package it transitively depends on (`spec`, `walker`, `scanners`, `graph`, `extractors`, `parsers`) must not import Node built-ins (`fs`, `path`, `os`, `worker_threads`, `child_process`) directly.
- All I/O is injected via `FactsFS`. Same for gzip (core takes a `gzip?: (text: string) => number` callback; CLI passes `node:zlib`).
- `packages/fs-node` + `packages/fs-memory` ship today; `packages/fs-browser` (File System Access API + GitHub REST) is reserved for v0.4 with zero changes to core.
- Parsers will use `web-tree-sitter` (WASM) exclusively — no native bindings even on Node, so the same code runs in a browser.
- Enforced via `eslint.config.mjs` with `eslint-plugin-boundaries` + a `no-restricted-imports` rule banning `node:*` from core's dependency closure. CI fails on violation.

**C2 — Web app + MCP server + cloud sync ⇒ artifact discipline.** ✅ Upheld.
- `spec` schemas are versioned (`$schema`, `factsVersion`) and backward-compatible via additive-only changes within a major.
- `@factstack/emit` runs every artifact through `AgentArtifactSchema.parse` + `HumanArtifactSchema.parse` before disk write. Shipped.
- Artifacts are size-bounded conceptually (cap + chunked overflow) — enforcement lands when artifacts exceed 5 MB in a real project.
- Artifacts never contain raw secrets — only `{ ruleId, ruleLabel, file, line, preview, entropy }`. Enforced at the TypeScript type level: `SecretFinding` has no `raw` field.
- MCP server tool/resource shape sketched in `packages/spec/src/mcp.ts` today (`facts://project|file|graph|routes|risks` + `analyze | reanalyze_file | query_graph | get_outline | list_risks`). Lands in v0.5 as a thin adapter.
- CLI machine-invocable mode (`factstack --json`) ✅ shipped.

**C3 — VS Code / Antigravity extension ⇒ webview-ready UI.** Pending `apps/ui-remix`.
- Two Vite build targets:
  1. **Dev / server mode** (`vite --port 3000`): full app with live re-analyze endpoint.
  2. **Static mode** (`vite build --mode static`): pure client-side SPA, data hydrated from embedded `human.json` + `agent.json`. Used by `factstack export` and by VS Code webviews.
- All data-fetching flows through `loadArtifacts()` with two implementations: `fetch-from-server` and `read-from-embedded-json`.
- UI never uses APIs blocked by VS Code webview CSP: no inline scripts, no `eval`, no WebSocket to arbitrary origins, no `unsafe-inline` styles.
- **Proof-of-concept**: the current `prototype/index.html` already works as a standalone file via inline JSON — the static-mode pattern is validated.

**Package dependency rules** (enforced):

| Layer | May import from |
|---|---|
| `spec` | nothing |
| `fs-*` | `spec` |
| `parsers` | `spec` |
| `extractors` | `spec`, `parsers` |
| `graph`, `scanners` | `spec`, `extractors` |
| `core` | `spec`, `graph`, `scanners`, `extractors`, `walker` (not `fs-*`) |
| `emit` | everything above + Node built-ins allowed |
| `apps/cli` | `emit`, `fs-node`, `core` |
| `apps/ui-remix` | `spec`, `ui-theme` only |

---

## 3. Repository Layout (monorepo, pnpm + Turborepo)

```
factstack/
├── packages/
│   ├── spec/              ✅  Zod schemas + TS types + FactsFS interface + MCP surface
│   ├── core/              ✅  Pipeline orchestration (isomorphic)
│   ├── walker/            ✅  Gitignore-aware walker, symlink-safe, takes a FactsFS
│   ├── fs-node/           ✅  Node FactsFS
│   ├── fs-memory/         ✅  In-memory FactsFS
│   ├── fs-browser/        📍 v0.4 stub — File System Access API + GitHub REST
│   ├── parsers/           📍 v0.2 — web-tree-sitter WASM grammar registry
│   ├── extractors/        📍 v0.2 — per-language extractors
│   ├── graph/             📍 v0.2 — dependency + outline graph builders
│   ├── emit/              ✅  Artifact writers w/ Zod validation + gzip
│   ├── scanners/          ✅  languages, todos, secrets, frameworks, tokencost
│   └── ui-theme/          📍 v0.1 UI — tokens, motion, language-icons (prototype has these inline today)
├── apps/
│   ├── cli/               ✅  `factstack` binary (Commander) — analyze + doctor today; ui/export/watch in v0.2
│   ├── ui-remix/          📍 Next surface — Vite + React 19 + React Router v7 + Remix 3 modules. Consumes human.json.
│   ├── vscode-ext/        📍 v0.3 stub
│   ├── chrome-ext/        📍 v0.4 stub
│   ├── webapp/            📍 v0.5 stub
│   └── mcp-server/        📍 v0.5 stub
├── plugins/
│   └── mcp-app/           📍 v0.6 stub
├── prototype/             ✅  Standalone HTML prototype (Tailwind v4 CDN + inline JSON). Proves the UI direction.
├── examples/              📍 Fixture projects (W10)
├── app_spec.md            ✅  "What does FACTS do?"
├── design_spec.md         ✅  "What does FACTS look and feel like?"
├── animations_spec.md     ✅  "How does motion work?"
├── app_plan_spec.md       ✅  This file.
├── eslint.config.mjs      ✅  Boundaries + no-restricted-imports
├── turbo.json             ✅
├── pnpm-workspace.yaml    ✅
└── package.json           ✅
```

---

## 4. Core Analyzer Design

### 4.1 Pipeline (deterministic, pure where possible)

```
walker ─► parsers ─► extractors ─► graph ─► scanners ─► emit
   │           │            │          │         │          │
 (paths)   (AST nodes)  (symbols)  (nodes+edges) (findings) (artifacts)
  ✅         📍 v0.2       📍 v0.2    📍 v0.2      ✅          ✅
```

Each stage is a TypeScript function taking the previous stage's output. Easy to unit-test with fixtures and easy to cache incrementally by file hash.

**Today** the pipeline skips the parsers/extractors/graph hops: walker → scanners → emit. `FileOutline` emits with populated `path`, `language`, `loc`, `bytes`, `bundleSize`, `tokenCost`, `todos`, `status`, `lastModifiedMs` — and empty `imports`, `exports`, `declarations`, `routes`, `components`. v0.2 backfills the empty arrays without touching the orchestrator.

### 4.2 Walker (`packages/walker`) ✅

- Accepts `FactsFS` (constraint C1). No direct Node `fs` imports.
- `ignore` npm package stacked with `.gitignore`, `.dockerignore`, `.cursorignore`, `.aiignore`, `.factsignore` (hierarchical).
- Always-exclude regardless of ignore: `node_modules`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `__pycache__`, `.venv`, `.git`, `vendor`, `target`, `coverage`, `.pnpm-store`, `.vscode`, `.idea`.
- Symlink loop detection via visited-set; POSIX path normalization.
- File size cap 1 MB (configurable); oversize files yield with `skippedReason: 'too_large'` and surface as a low-severity risk.
- Binary detection via null-byte sniff in first 8 KB.

### 4.3 Parsers (`packages/parsers`) 📍 v0.2

- `web-tree-sitter` (WASM) — cross-platform, no native compilation.
- Lazy grammar load per file extension.
- v0.2 grammars: TypeScript, TSX, JavaScript, JSX, Python, JSON, YAML, TOML, Markdown.
- v0.3+: Go, Rust, Java, Kotlin, Swift, C#, PHP, Ruby.

### 4.4 Extractors (`packages/extractors`) 📍 v0.2

One adapter per language. Each emits `imports`, `exports`, `declarations`, `routes`, `components`, `tests` into the existing `FileOutline` shape.

Routes detection v0.2 scope: Next.js `app/` + `pages/`, Remix `routes/`, Express `app.get/post`, FastAPI decorators, Flask/Django URL patterns. Components: React (function + class), JSX/TSX default/named exports.

### 4.5 Graph (`packages/graph`) 📍 v0.2

1. **Dependency graph**: nodes = files/modules/packages, edges = imports. Cycles flagged.
2. **Outline graph**: hierarchical — project ▸ package ▸ file ▸ symbol.

**Prototype graph today** is a **token-distribution icicle** built from folder rollup, *not* a force-directed node-link — because without real import edges, a force graph would be fiction. The icicle surfaces "where does our token budget go?" which the real dependency graph can layer on top of in v0.2.

Both persisted in `.facts/index.db` via **`node:sqlite`** (Node 22+ built-in) once v0.2 lands. JSON artifacts are generated views on top.

### 4.6 Scanners (`packages/scanners`) ✅ (partial)

- **Secrets** ✅: 9 curated rules (AWS access/secret keys, Google API key, Stripe sk_live/sk_test, Slack xox*, GitHub gh*, OpenAI sk-, Anthropic sk-ant-, private-key headers) + Shannon entropy gate + redacted previews only.
- **TODO/FIXME/HACK/XXX/NOTE** ✅: regex harvester with kind + line + text.
- **Framework detection** ✅: ≈ 45 dep→framework mappings from `package.json` + `requirements.txt`.
- **Token-cost estimator** ✅: `chars / 3.5` approximation (≈ cl100k within 8% on source). v0.2 swaps in real `tiktoken` at the CLI layer.
- **Bundle-size estimator** ✅: gzip bytes for JS/TS/HTML/CSS/SCSS/JSON via `node:zlib` injected from the CLI. Raw/minified columns populated; real minifier in v0.2.
- **Licenses** 📍 v0.2: SPDX detection from manifests + headers.
- **Git history** 📍 v0.2: per-file last-modified, churn, author count. Blocked on `child_process` access, which means a Node-only adapter layer (scanners stay isomorphic).

### 4.7 Status inference

- `parse_error`: extractor failed (v0.2).
- `broken`: unresolved imports / missing env / failing type check (v0.2).
- `stale`: not touched in > threshold (default 180 days) with `TODO`/`FIXME` (v0.2 once git history lands).
- `ok`: default. All current outputs emit `ok` because the deeper checks aren't wired yet.

---

## 5. Dual Artifacts

### 5.1 `agent.json` (AI-agent-optimized) ✅

Schema in `packages/spec/src/agent.ts`. Path-addressable, dense, versioned. Streamable companion `agent.jsonl` (one `FileOutline` per line) is emitted today.

### 5.2 `human.json` (CXO-readable, feeds the dashboard) ✅

Schema in `packages/spec/src/human.ts`. Narrative-shaped: `summary`, `stack`, `tree` (rolled-up), `graph`, `activity` (most-recently-modified files), `risks`, `glossary`. Every field maps to a UI block.

---

## 6. WebUI — prototype landed, `apps/ui-remix` next

### 6.1 Aesthetic direction (committed post-audit)

The original plan specified "liquid-glass everywhere." Two audit rounds flagged that as an AI-slop fingerprint. The committed direction is now **editorial analyst brief**:

- **Serif display** (Fraunces variable, OFL) for H1 and italic standfirst. This is the distinguishing mark.
- **Urbanist** for nav, chips, tabs, big numbers.
- **Inter** body (with a **Google Sans** opt-in via Config — noted as proprietary).
- **JetBrains Mono** for paths, line numbers, tabular data.
- **Prose with data inline** instead of hero-metric cards: *"The codebase is 103.2K tokens across 49 files, fitting within 200K agent context (52% full). Roughly 32% of that budget lives in YAML..."*
- **Hairline rules** (1 px `--hairline`) as section breaks instead of card borders.
- **Glass reserved for chrome only**: top nav, LHS tree panel, RHS local-tab bar, status bar, mobile drawer. Content sits on a flat `.surface` class (solid tinted bg + subtle border).
- **Warm paper base** `oklch(99% 0.005 95)` light / `oklch(13% 0.02 250)` midnight dark. Pure white/black eliminated.
- **Token colors** per language (`--lang-typescript`, `--lang-yaml`, …) in both themes. Dark palette retuned, not inverted.

### 6.2 Global layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Top nav (glass) — logo · GLOBAL TABS · search · theme · re-analyze       │  56 px
├──────────────────────┬────────────────────────────────────────────────────┤
│                      │  Local tab bar (glass)                             │  44 px
│   LHS tree (glass)   ├────────────────────────────────────────────────────┤
│   ≤900 px: drawer    │                                                    │
│   ≥900 px: resizable │   RHS content pane (flat .surface)                 │
│   project name +     │   View Transition-animated navigations             │
│   file-count chip    │                                                    │
│   + bundle/fits-ctx  │                                                    │
├──────────────────────┴────────────────────────────────────────────────────┤
│  Status bar — parse · last analysis · branch · health                     │  28 px
└───────────────────────────────────────────────────────────────────────────┘
```

- **LHS Desktop (≥ 900 px)**: `clamp(18rem, 22dvw, 25rem)`, collapsible.
- **LHS Mobile (< 900 px)**: sliding drawer, 82 vw, hamburger trigger, scrim + blur.
- **LHS view-mode toggle**: **removed** — the prototype had a Tree/Graph/Split toggle that wasn't wired. Graph lives in its own global tab. Less to promise, less to fix.
- **Global tabs (7)**: Overview, Graph, Files, Routes, Risks, History, **Config**.
- **Local tabs** (Files): Outline / Preview / Imports / Callers / TODOs / Tests.

### 6.3 Light / Dark mode ✅ (prototype)

- Two-state toggle (Light / Dark); system pref honored on first boot.
- Pre-paint `<script>` applies saved theme — no FOUC.
- Theme swap uses View Transition circular reveal (click origin captured to CSS vars).
- Dark palette retuned post-audit: `--hairline`, `--lang-*`, `--fg-subtle` all hit AA on midnight.

### 6.4 View Transition API ✅ (prototype)

- `smoothSwap(fn)` wrapper: feature-detects, try/catches, 800 ms safety timeout calls `vt.skipTransition()` if a transition hangs.
- Tab click + file-select + theme swap all ride the same helper.
- Reduced-motion short-circuits to instant swap.

### 6.5 Static export (constraint C3)

`factstack export` (v0.2 CLI command) → `vite build --mode static` → `./dist/facts-report.zip`. Same bundle hosted by v0.3 VS Code webview. **Standalone pattern already proven** in `prototype/index.html` via inline JSON.

### 6.6 Graph view — **decision change: icicle, not force-directed** (for v0.1)

Rationale: without real import edges (v0.2), a "dependency graph" would be decorative. The icicle shows exactly the data we have: folder/file containment weighted by token cost. Sharp SVG (no glass wrapper), hover highlights the hovered cell and dims 28 siblings, breadcrumb rail updates to `▸ (root files) · 57.2K tok · 18 files`. Mobile (≤640 px) swaps to a vertical top-8 list with proportional bars.

v0.2 adds a second tab view within `/graph` — force-directed node-link — once extractors produce imports.

### 6.7 Libraries

`@xyflow/react` reserved for v0.2 force graph. `react-arborist` for v0.2 virtualized tree (prototype uses hand-rolled). `Shiki` for v0.2 Preview tab. `framer-motion` for non-View-Transition motion.

---

## 7. CLI (apps/cli)

### 7.1 Commands

```
factstack [path]                    ✅ analyze <path> (default cwd) + emit artifacts
factstack analyze [path]            ✅ alias
factstack analyze --json            ✅ machine-invocable, JSON to stdout
factstack doctor                    ✅ Node version + node:sqlite availability
factstack ui                        📍 v0.2 — open UI against existing artifacts
factstack export [path]             📍 v0.2 — emit static HTML bundle
factstack watch                     📍 v0.2 — incremental re-analysis on file changes
```

### 7.2 Output layout

```
.facts/
├── agent.json          ✅ machine-readable artifact
├── agent.jsonl         ✅ streamable companion (one FileOutline per line)
├── human.json          ✅ dashboard data
├── index.db            📍 v0.2 — node:sqlite query index
├── snapshots/          📍 v0.2 — prior analyses (date-stamped, tiny diffs)
└── config.json         📍 v0.2 — user preferences
```

### 7.3 `.factsignore` ✅

Stacked on gitignore. Supported by the walker today.

---

## 8. Performance & incremental analysis

- Parse is the (coming) bottleneck. v0.2 caches AST + extractor output keyed by `(filePath, sha256(contents))` in `index.db`.
- Parallelism (v0.2): `worker_threads` pool sized to `os.cpus().length - 1` (in CLI layer only; isomorphic core stays pure).
- **Current performance** on this repo (103 files, 18.7 K LOC): **146 ms** cold.
- Target: 100 k-LOC TypeScript monorepo in < 30 s cold, < 3 s warm.
- Watch mode (v0.2) uses `chokidar`, affected-subgraph re-runs only.

---

## 9. Roadmap — six surfaces, additive

| Version | Surface | Status | Target |
|---|---|---|---|
| v0.1.0-alpha | CLI (analyze + doctor) + prototype UI | ✅ landed | now |
| v0.1.0 | `apps/ui-remix` (Vite + React 19 + React Router v7) | 📍 next | +1–2 wk |
| v0.1.1 | Parsers (web-tree-sitter) + extractors (TS/Python) + real dependency graph | 📍 | +2 wk |
| v0.1.2 | SQLite index, licenses, git-history scanner, watch mode, `ui`/`export` CLI | 📍 | +1 wk |
| v0.2 | npm global publish w/ changesets | 📍 | +1 wk |
| v0.3 | VS Code / Antigravity extension | 📍 | 6 wk |
| v0.4 | Chrome extension (WASM analyzer) | 📍 | 6 wk |
| v0.5 | Web app + cloud + MCP server | 📍 | 12 wk |
| v0.6 | MCP app + skills bundle | 📍 | 6 wk |

---

## 10. Gaps and risks

1. **Secrets in artifacts** ✅ — redacted previews only, `.facts/` auto-gitignored.
2. **Privacy for CXO audience** — default local-only; cloud opt-in with granular scopes (metadata, not source). Lands in v0.5.
3. **License & IP scanning** 📍 v0.2 — SPDX + copyleft flagging is *the* headline feature for investor due-diligence.
4. **Supply-chain risk** 📍 v0.2+ — dependency-age + maintainer-status via npm/PyPI metadata fetches.
5. **Remix 3 reality (verified April 2026)** — Remix 3 is published as a single bare `remix` npm package (`remix@3.0.0-alpha.4`, `next` dist-tag), NOT as `@remix-run/*` scoped packages. Remix 3 is a **library, not a framework CLI**: no `remix-serve`, no `remix vite:dev`, no file-based routing. Ships ~60 utility modules (`fetch-router`, `auth-middleware`, `data-schema`, `file-storage`, `compress-middleware`). For the React UI: **Vite 8 + @vitejs/plugin-react + React 19 + React Router v7.14.1** (Remix team's React-side successor) + **Remix 3 modules as utilities** where they fit. Business logic in `packages/*` stays framework-free.
6. **"Trust" gap for non-technical audience** ✅ — every chip/badge clickable → source evidence.
7. **Monorepo-aware analysis** ✅ — detects `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`.
8. **AI hallucination in `summary.oneLiner`** ✅ — deterministic: `"A ${top3Frameworks.join(' + ')} project."`
9. **Moat vs. incumbents** — Cursor/Claude Code will build codebase maps in-agent. Our moat: (a) dual artifact (theirs is agent-only), (b) CXO-readable UI, (c) agent-agnostic `agent.json`.
10. **Telemetry** — privacy-preserving anonymous opt-in (post-v0.2).
11. **Accessibility** ✅ WCAG AA across all color tokens both themes (post-audit round 2); touch targets 44 px; arrow-key tablist; ARIA tree complete; skip-to-content link; focus ring via `box-shadow` so `contain: paint` can't clip it.
12. **Testing the analyzer** 📍 v0.2 — fixture projects in `examples/` as golden masters.
13. **Test generation & healthchecks** — defer to v0.7+.
14. **Native builds on Windows/Node 25** ✅ resolved — switched to `node:sqlite`; no `better-sqlite3`, no `node-gyp`.
15. **AI-slop aesthetic** ✅ resolved — editorial pivot: serif display + prose-with-inline-data + hairlines instead of glass/cards/hero-metrics everywhere.

---

## 11. Build order — revised with reality

**Original plan assumed W3–W4 would bring parsers/extractors before scanners + CLI.** Reality: the prototype proved the UI direction on mock data, scanner coverage turned out to be more unlock-per-hour than AST extraction, and the CLI is more valuable shipped early (even without ASTs) than held back. Revised:

1. **W1–W2** ✅ — Monorepo + specs + `@factstack/spec` + ESLint boundaries + prototype.
2. **W3** ✅ — `walker` + `fs-node` + `fs-memory`.
3. **W4** ✅ — `scanners` (languages, todos, secrets, frameworks, tokencost) + `emit`.
4. **W5** ✅ — `core` pipeline + `apps/cli` (`analyze`, `doctor`, `--json`).
5. **W6 (current)** — `apps/ui-remix` port of the prototype: Vite + React 19 + React Router v7 + Remix 3 utility modules. Consumes real `.facts/*.json`. Editorial design landed; Vite translation is mostly routing + layout, because all the visual language is already proven.
6. **W7** — `parsers` (web-tree-sitter WASM) + `extractors` for TS + Python. Fixtures.
7. **W8** — `graph` (dependency + outline). Force-directed view inside `/graph` tab (alongside the icicle).
8. **W9** — SQLite index, licenses, git-history, bundle-size minifier, `watch` mode, `ui` + `export` CLI verbs.
9. **W10** — Accessibility acceptance (axe-core + Playwright at 340/768/1440/2560/3840/7680 px, light + dark), docs site, changeset publish dry-run, CXO usability test.

---

## 12. Critical files for v0.1

- `packages/spec/src/{agent,human,fs,mcp,index}.ts` — schemas + interfaces. ✅
- `packages/fs-node/src/index.ts`, `packages/fs-memory/src/index.ts` — FactsFS impls. ✅
- `packages/walker/src/index.ts` — gitignore-aware iterator. ✅
- `packages/scanners/src/{languages,todos,secrets,frameworks,tokencost,index}.ts`. ✅
- `packages/emit/src/{gzip,write,index}.ts` — artifact writers + Zod validation + `.gitignore` auto-add. ✅
- `packages/core/src/index.ts` — pipeline orchestrator + tree rollup + project meta synthesis. ✅
- `apps/cli/src/cli.ts` — Commander entrypoint. ✅
- `packages/parsers/src/registry.ts` — lazy WASM grammar loader. 📍 v0.2
- `packages/extractors/src/{typescript,python}.ts` — per-language extractors. 📍 v0.2
- `packages/graph/src/{dependency,outline}.ts` — graph builders. 📍 v0.2
- `packages/emit/src/{sqlite,static}.ts` — SQLite index + static-mode bundle. 📍 v0.2
- `app_spec.md`, `design_spec.md`, `animations_spec.md`, `app_plan_spec.md` — root specs. ✅
- `apps/ui-remix/app/root.tsx`, `routes/_app.{_index,graph,files.$,routes,risks,history,config}.tsx`, `routes/api.reanalyze.ts`, `lib/{theme,view-transition,breakpoints}.ts`. 📍 v0.1 final
- `packages/ui-theme/src/{tokens.css,motion.ts,language-icons.ts,themes/{light,dark}.css}`. 📍 v0.1 final (prototype inlines these today)
- `prototype/index.html` — standalone HTML prototype w/ inline JSON. ✅ (reference for the port)
- `examples/react-fastapi-booking/` — golden-master fixture. 📍 v0.2

---

## 13. Verification (end-to-end)

### ✅ Verified this session

- `pnpm --filter @factstack/cli exec tsx src/cli.ts <path>` produces `.facts/agent.json` + `.facts/human.json` + `.facts/agent.jsonl`.
- Both artifacts validate against their Zod schemas (write throws on drift).
- `.facts/` is auto-added to target-project `.gitignore` if missing.
- Framework detection picks up 13/13 known frameworks in this repo.
- Secret scanner + entropy gate: 0 false positives on this repo (correct, since no secrets).
- Cross-platform: works on Windows + Node 25 (prior `better-sqlite3` Windows failure mode is solved by switching to JSON-only v0.1 + planned `node:sqlite` for v0.2).
- Prototype standalone via `file://` — validated via local `serve`; inline JSON pattern works without a server.
- Accessibility (prototype): axe-core clean; touch targets 44 px; arrow-key tablist; ARIA tree complete; skip-to-content link; focus ring via box-shadow.

### 📍 Pending (tied to surfaces below)

- `pnpm -F @factstack/cli build && pnpm -F @factstack/cli link` — needs `tsc` emit + bin shim for `npx factstack`.
- `factstack ui` opens browser at `http://localhost:3000`. Needs `apps/ui-remix`.
- `factstack export` produces `./dist/facts-report.zip`. Needs static-mode Vite build.
- Responsive visual-regression via Playwright at 340 / 390 / 768 / 1024 / 1440 / 1920 / 2560 / 3840 / 7680 px for light + dark. Needs `apps/ui-remix` + Playwright config.
- CXO usability: non-developer answers "what does this project do?" within 2 minutes. Needs the shipped UI.
- Bundle-size + token-cost accuracy on fixtures: ≤ 5% delta vs `rollup-plugin-visualizer`; exact match vs direct `tiktoken`. Needs fixtures.

---

## 14. Open questions (revisit post-v0.1)

- MCP transport: stdio vs HTTP vs both for local dev?
- Cloud data model (v0.5): per-repo snapshots vs continuous git-hooked indexing?
- Pricing: free local + per-seat cloud, or free-forever local + usage-based AI features?
- AI-powered `summary.oneLiner` polish: which model, what guardrails?
- v0.7+ emulation integration: Expo, StackBlitz WebContainers, local emulators?
- Remix 3 version pin: lock to `remix@3.0.0-alpha.4`; audit release notes every upgrade.

---

## 15. Spec deliverables

- **`app_spec.md`** ✅ — product + functional (mission, features, artifacts, CLI, roadmap, privacy).
- **`design_spec.md`** ✅ — visual + interaction (layout 340 px → 8 K, editorial aesthetic, tokens, typography, accessibility).
- **`animations_spec.md`** ✅ — motion + View Transitions (catalogue, fallbacks, suspense wrapper, reduced-motion).
- **`app_plan_spec.md`** ✅ — this file, the engineering plan.

---

## 16. Resolved gaps (running list)

1. View Transition cross-browser → **Fallback is primary path**; 800ms safety timeout forces `skipTransition` on hang. ✅
2. Resizable LHS vs mobile → **Resizable desktop + sliding drawer mobile**. ✅
3. Tree vs Graph → **Ship Tree (LHS) + icicle Graph (tab)**. Force-directed node-link deferred to v0.2 behind real import data. ✅ revised
4. Dark-mode data viz → **Dark-native palette + re-paint on theme swap**. ✅
5. View Transitions + Remix 3 streaming → **`smoothSwap()` with 800ms safety**. ✅
6. Theme flash → **CSS-first `color-scheme` + `light-dark()` + pre-paint inline script**. ✅
7. Focus management across transitions → **focus moves to new content's H1 after swap**. ✅
8. i18n → **English-only v0.1**; strings through `t()` so retrofit is a library swap.
9. `dvw` polyfill → **Lightning CSS** in Vite build pipeline (v0.1 final).
10. Branding collision → **Locked: FACTS brand + `factstack` npm**. ✅
11. Evidence link density → **Language icons + axe-core focus-order + tooltips where dense**. ✅
12. Snapshot/history diff UX → **History tab: empty state + prose explanation** (prototype); real trend chart + per-file diff in v0.2.
13. `better-sqlite3` Windows/Node-25 native-build failure → **Switched to `node:sqlite`** for v0.2; JSON-only v0.1. ✅
14. **Audit round 2 findings** ✅:
    - Pure white eliminated → `oklch(99% 0.005 95)` paper off-white.
    - `--fg-subtle` contrast 4.03 → 5.8:1 (AA headroom).
    - `--accent` 4.93 → 5.82:1, `--ok` 4.89 → 5.98:1.
    - Glass surfaces reduced from ~25 to 4 (chrome only).
    - Hero-metric Health block → sentence assertion.
    - Capabilities card grid → inline prose.
    - Stack card grid → single stacked bar + legend.
    - History sparklines → editorial empty state.
    - Inter for display → Fraunces serif for H1/dek; Inter demoted to body.
    - Dark mode fully retuned (hairlines, lang-tokens, shadows).
    - Touch targets 44 px, icon buttons 40 px.
    - Focus ring survives `contain: paint`.
    - ARIA tree `aria-level/posinset/setsize` complete.
    - Arrow-key tablist navigation (←/→/↑/↓ + Home/End).
    - Skip-to-content link.
    - rAF backdrop pauses on `visibilitychange`.
    - Fraunces axes trimmed (SOFT/WONK dropped).
    - LHS Graph/Split false-affordance buttons removed.
    - Token count redundancy resolved (lives in lead paragraph only).
    - Tree SVG fills tokenised via `var(--lang-*)`.

---

## 17. Enhancements captured from review

- **Bundle-size + AI-token cost** per file/dir as first-class CXO signal. ✅ (token-cost ✅; bundle-size gzip ✅; minified/raw in v0.2)
- **Liquid-glass aesthetic** on **chrome surfaces only** (never content/code/graph). ✅
- **Responsive 340 px → 8 K** with content-column caps on 8K. ✅ (prototype)
- **Font-size slider** 0.85× – 1.35× in settings + ⌘;. ✅ (prototype)
- **Icicle graph morph** in View Transitions catalogue. ✅ (prototype)
- **Graph re-paint on theme swap** — explicit animation step. ✅ (prototype)
- **Claude Design iteration loop**: `frontend-design`, `distill`, `normalize`, `arrange`, `colorize`, `typeset`, `animate`, `polish`, `critique`, `audit` run multiple times through the prototype. ✅
- **Lightning CSS** for modern-CSS polyfills. 📍 v0.1 final (Vite config).
- **oxlint + oxfmt** for fast lint + format. ✅
- **Editorial aesthetic**: Fraunces serif + italic dek + mono dateline + prose with inline data + hairline rules. ✅
- **Google Sans** opt-in via Config with proprietary-licence note pointing at Lexend / Public Sans as commercial-safe alternatives. ✅
- **Config tab** in global nav (7 tabs): Body font toggle + Font-size slider + Theme radio. ✅
- **Standalone-HTML pattern**: prototype proves static mode via inline `<script type="application/json">`. ✅

---

## 18. Tooling choices (locked)

| Concern | Choice | Why |
|---|---|---|
| Package manager | pnpm 10 | ✅ Workspace support, strict peer deps |
| Task runner | Turborepo | ✅ Incremental, cacheable |
| Linter | **oxlint** | ✅ 50–100× faster than ESLint |
| Formatter | **oxfmt** | ✅ Same codebase as oxlint |
| Boundaries | `eslint-plugin-boundaries` (thin ESLint layer) | ✅ Enforces C1 + package layers |
| Parser (analyzer) | web-tree-sitter (WASM) | 📍 v0.2 — isomorphic, cross-platform, no native compile |
| SQLite | `node:sqlite` (Node 22+ built-in) | 📍 v0.2 — zero native compile, no node-gyp |
| Bundler (UI) | Vite 8 | 📍 React 19 + plugin-react 6 + Lightning CSS |
| CSS polyfills | Lightning CSS (via Vite) | 📍 `dvw`, `light-dark()`, nesting, `color-mix` |
| UI framework | React 19 + React Router v7.14.1 | 📍 Remix team's React-side continuation |
| Remix 3 | `remix@3.0.0-alpha.4` as utility modules | 📍 Web-standards helpers alongside React stack |
| Animation | Framer Motion + native View Transition API | ✅ Prototype; carries to ui-remix |
| Graph viz | `@xyflow/react` | 📍 v0.2 (force-directed layer atop icicle) |
| Tree viz | `react-arborist` | 📍 v0.2 (prototype is hand-rolled) |
| Code highlight | Shiki | 📍 v0.2 (Files Preview tab) |
| Icons (UI) | lucide-react | ✅ |
| Display serif | **Fraunces** (variable, OFL, opsz + ital) | ✅ H1 + italic dek |
| Display sans | Urbanist (variable, OFL) | ✅ Nav, chips, tabs, numerics |
| Body sans | Inter (OFL) default / Google Sans opt-in (proprietary; noted) | ✅ |
| Code mono | JetBrains Mono (OFL, tabular) | ✅ |
| Token cost | tiktoken (cl100k_base) | 📍 v0.2 — swap from `/3.5` approx |
| Testing | Playwright + axe-core | 📍 v0.1 final |
| Releases | Changesets | 📍 v0.2 — publish workflow |

---

## 19. Next-pass priority order

1. **`apps/ui-remix`** port the editorial prototype. Vite + React 19 + React Router v7 routes matching the prototype's 7 tabs. `loadArtifacts()` abstraction for server vs static modes. Reuses: prototype CSS/tokens/motion lifted into `@factstack/ui-theme`; event-delegated click handler lifted into `@factstack/ui-theme/events`.
2. **Parsers + extractors (TS/Python)** via web-tree-sitter — backfills the empty `imports/exports/declarations/routes/components` in `FileOutline`.
3. **Real dependency graph** on top of extractor output — force-directed view inside the existing `/graph` tab, toggle with the icicle.
4. **SQLite index + `watch` mode** — unlocks incremental re-analysis, prepares `factstack ui` and `factstack export` CLI verbs.
5. **Publish** via Changesets: `@factstack/cli`, `@factstack/core`, `@factstack/spec`, `@factstack/walker`, `@factstack/scanners`, `@factstack/emit`, `@factstack/fs-node`, `@factstack/fs-memory`.

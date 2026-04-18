# FACTS — App Spec

**Version**: v0.1 draft · **Status**: Pre-scaffold · **Owner**: founding team

This document answers **"what does FACTS do?"** `design_spec.md` answers "what does it look and feel like?" `animations_spec.md` answers "how does motion work?" The three files are peers at the repo root — every surface (CLI, UI, VS Code ext, Chrome ext, web app, MCP server, MCP app) treats them as source of truth.

---

## 1. Mission

FACTS (File Analysis & Context Tracking Stack) produces two artifacts from one analysis pass of any code project:

1. An **AI-agent-optimized codebase map** (`agent.json` / `agent.jsonl` / `index.db`) so coding agents can reason about the repo without re-reading every file.
2. A **CXO-readable executive dashboard** (`human.json` + WebUI) so CTOs, CPOs, investors, and other non-coding stakeholders can understand what a codebase does, what it's made of, and where its risks sit — without a developer walking them through it.

One analysis. Two audiences. Same truth.

---

## 2. Audiences

| Primary | Needs |
|---|---|
| AI coding agents (Claude, GPT, Cursor, Aider, etc.) | Dense, path-addressable, versioned map of the codebase |
| Developers | Rich outline/graph + ability to integrate FACTS into their toolchain |
| CXOs / investors | Trustworthy overview of an unfamiliar codebase in < 2 minutes |

Non-audience (v0.1): end-users of the analyzed app, product managers without technical context, legal teams doing granular IP review (coverage comes in v0.3+ via supply-chain + license scanning).

---

## 3. v0.1 scope

### 3.1 Surfaces shipped
- **Node/Deno CLI** (`factstack`) — primary surface.
- **Local Remix 3 UI** launched by the CLI.
- **Static HTML export** of the UI for offline sharing.

### 3.2 Future surfaces reserved (stubs present, not built in v0.1)
- v0.2: npm global package.
- v0.3: VS Code + Antigravity extension.
- v0.4: Chrome extension (browser/WASM-only analyzer).
- v0.5: Web app + cloud sync + MCP server.
- v0.6: MCP app with skills.

Architectural constraints enforcing this are in `README.md` §Locked constraints and in `.eslintrc` boundaries.

### 3.3 v0.1 feature list with acceptance criteria

**F1. Project walking (gitignore-aware)**
- Given any directory, FACTS walks all files respecting: `.gitignore`, `.dockerignore`, `.cursorignore`, `.aiignore`, and `.factsignore` (ours), stacked hierarchically.
- Always-excludes regardless of gitignore: `node_modules`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `__pycache__`, `.venv`, `.git`, `vendor`, `target`.
- Symlink loop detection; cross-platform paths normalized to POSIX.
- File size cap default 1 MB; larger files flagged, not parsed.
- Accept: no file in an ignored directory appears in artifacts; symlink loops do not crash; Windows and macOS produce identical artifacts for the same repo.

**F2. Cross-platform parser**
- `web-tree-sitter` WASM grammars for TypeScript, TSX, JavaScript, JSX, Python, JSON, YAML, TOML, Markdown.
- No native compilation on install.
- Accept: `pnpm install` on a fresh Mac and a fresh Windows machine both succeed without a C/Rust toolchain.

**F3. Symbol / route / component extraction**
- Per-language extractor emits a `FileOutline` with imports, exports, declarations, routes, components, tests, TODOs, complexity, status.
- Route detection for v0.1: Next.js `app/` + `pages/`, Remix `routes/`, Express `app.get/post`, FastAPI decorators, Flask/Django URL patterns.
- Component detection for v0.1: React (function + class), JSX/TSX default/named exports.
- Accept: on fixture `examples/react-fastapi-booking`, all declared routes surface in the output.

**F4. Graph construction**
- **Dependency graph**: nodes = files/modules/packages; edges = imports. Cycles flagged.
- **Outline graph**: hierarchical project ▸ package ▸ file ▸ symbol.
- Monorepo-aware: reads `pnpm-workspace.yaml`, `turbo.json`, Nx, Lerna configs.
- Accept: in a pnpm workspace, package boundaries reflect in the graph; cross-package imports appear as edges between workspace clusters.

**F5. Bundle-size + AI-token cost per node**
- **Bundle size**: for JS/TS, parsed + minified + gzipped byte count; rolled up per directory. For Python, LOC + transitive-import count as proxy.
- **AI-token cost**: `tiktoken` `cl100k_base` count per file, rolled up per directory. Rendered as K/M.
- Accept: reported JS bundle size matches `rollup-plugin-visualizer` within 5%; token count is exact.

**F6. Scanners (cross-cutting)**
- **Secrets**: regex + entropy rules (gitleaks-style). Findings include redacted previews + file/line.
- **Licenses**: SPDX detection from manifests + headers.
- **Frameworks**: manifest + import-signature detection. Produces `capabilities[]`.
- **TODOs/FIXMEs**: harvested with git blame for "when created."
- **Git history**: per-file last-modified + churn + author count.
- Accept: on a known seeded secret fixture, the scanner flags the line but the artifact on disk does not contain the raw secret.

**F7. Dual artifact emission**
- `.facts/agent.json`: versioned, path-addressable, < 5 MB (chunked if overflow).
- `.facts/agent.jsonl`: streamable companion, one file per line.
- `.facts/human.json`: dashboard data, < 2 MB, narrative-shaped.
- `.facts/index.db`: SQLite query index.
- `.facts/snapshots/YYYY-MM-DD/`: prior analyses for history diff.
- `.facts/config.json`: user preferences.
- `.gitignore` auto-augmented with `.facts/` the first run.
- Accept: both JSON artifacts validate against their Zod schemas in `packages/spec`.

**F8. CLI commands**
- `factstack` — analyze cwd, emit artifacts, open UI.
- `factstack analyze [path]` — analyze without opening UI.
- `factstack analyze --json` — machine-invocable mode: JSON to stdout, no TTY prompts.
- `factstack ui` — open UI against existing artifacts.
- `factstack export [path]` — emit `./dist/facts-report.zip` static bundle.
- `factstack watch` — incremental re-analysis on file changes.
- `factstack doctor` — sanity-check artifacts + grammar availability.
- Accept: `factstack analyze --json` can be piped to `jq` with no stderr noise.

**F9. Local WebUI (see `design_spec.md` for visual)**
- Six global tabs: Overview, Graph, Files, Routes, Risks, History.
- Tree / Graph / Split view mode toggle (with auto-suggest based on project shape).
- LHS panel: resizable desktop / sliding drawer mobile.
- Light / Dark / System theme with CSS-first no-flash approach.
- View Transition API used for navigations (see `animations_spec.md`).
- Responsive 340 px → 8 K.
- Re-analyze button (server mode only).
- Font-size slider 0.85× – 1.35×.
- Accept: a non-developer given `factstack` in a demo repo can correctly answer "what does this project do and is anything broken?" within 2 minutes without help.

**F10. Static export**
- `factstack export` emits a self-contained `./dist/facts-report.zip` with a pure client-side SPA bundle. No server required.
- The same static bundle is what the future VS Code extension will host inside its webview.
- Accept: unzip, open `index.html` in a fresh browser profile; all views except Re-analyze work.

### 3.4 Non-functional requirements

| Category | Target |
|---|---|
| Cold analysis (100 k LOC TS monorepo) | ≤ 30 s on a modern laptop |
| Warm analysis (same repo, cache hit) | ≤ 3 s |
| Install | `pnpm add -g @factstack/cli` or `npx @factstack/cli`, zero native build |
| OS matrix | macOS 13+, Windows 10+, Ubuntu 22.04+ (CI only) |
| Node | Node 20+ and Deno 2+ both supported |
| Browser support (UI) | Last 2 versions of Chrome, Safari, Firefox, Edge |
| Accessibility | WCAG AA minimum; AAA for body text |
| Responsive | 340 px → 8 K |
| Language (UI) | English only in v0.1; i18n strings routed through `t()` for v0.2+ retrofit |

---

## 4. Artifact specifications

Canonical shape lives in `packages/spec`. This document describes intent; TypeScript is truth.

### 4.1 `agent.json` — AI-agent-optimized
- Versioned (`$schema`, `factsVersion`).
- Path-addressable.
- Dense, not verbose.
- Streamable companion `agent.jsonl`.
- Top-level keys: `project`, `files[]`, `graph`, `routes[]`, `scripts`, `capabilities[]`, `risks[]`, `stats`.

### 4.2 `human.json` — CXO-readable
- Top-level: `summary`, `stack`, `tree`, `graph`, `activity`, `risks`, `glossary`.
- Every field maps to a UI block. No field without a screen.
- `glossary` translates jargon into plain English for non-coders.

### 4.3 `index.db` — queryable index
- Single SQLite file via `better-sqlite3`.
- Tables: `files`, `symbols`, `imports`, `exports`, `routes`, `risks`, `snapshots`.
- The JSON artifacts are views on top; the DB is the source of truth at runtime.

---

## 5. MCP server sketch (implemented in v0.5, shape locked in v0.1)

The spec package exports the resource + tool surface so v0.1 CLI commands already align with what the MCP server will expose.

**Resources** (read-only):
- `facts://project` — top-level summary.
- `facts://file/{path}` — per-file outline.
- `facts://graph` — dependency graph.
- `facts://routes` — entry-point list.
- `facts://risks` — secrets, licenses, broken, stale, supply-chain findings.

**Tools** (agent-invocable):
- `analyze(path?)` — run full analysis.
- `reanalyze_file(path)` — incremental per-file.
- `query_graph(filter)` — subgraph queries.
- `get_outline(path)` — file outline.
- `list_risks(severity?)` — risk rows.

Rate-limit, auth, and transport details live in a future `mcp_spec.md`.

---

## 6. Privacy & secrets policy

1. Artifacts are **local files by default**. Nothing leaves the developer machine unless they opt in.
2. Cloud sync (v0.5) is **opt-in and granular**: choose what syncs (metadata only, full tree, etc.).
3. Detected secrets are **redacted before serialization**. Raw secret values never enter any artifact file on disk. Only file + line + rule match + a masked preview.
4. `.facts/` is auto-added to `.gitignore` on first run (with user consent prompt).
5. Telemetry is **opt-in, anonymous, aggregate-only**; opt-out persists.

---

## 7. Competitive positioning

**The gap**: no existing tool emits both an AI-agent map and a CXO dashboard from one analysis pass.
- Aider, Cursor, Sourcegraph Cody, repomix, gitingest → dev-only.
- CodeScene, SonarQube → exec-only, code-quality-focused, not architecture-first.

**FACTS moat**:
1. **Dual artifact** — agent-readable + human-readable, same truth.
2. **Agent-agnostic** — every coding agent can consume `agent.json`; they're locked to their own.
3. **CXO-first UI** — evidence-first, progressive depth, no jargon without a glossary.
4. **Bundle-size + token-cost per node** — signals no other tool surfaces for executives.

**Top 3 threats to watch**:
1. Cursor / Claude Code adding CXO dashboards.
2. CodeScene pivoting to architecture visualization.
3. GitHub / Copilot Workspace emitting their own agent context format as a de-facto standard.

---

## 8. Roadmap

| Version | Surface added | Target |
|---|---|---|
| v0.1 | CLI + Remix 3 UI | Weeks 1–10 |
| v0.2 | npm global install | Weeks 11–12 |
| v0.3 | VS Code / Antigravity extension | Weeks 13–18 |
| v0.4 | Chrome extension (WASM analyzer) | Weeks 19–24 |
| v0.5 | Web app + cloud + MCP server | Weeks 25–36 |
| v0.6 | MCP app + skills bundle | Weeks 37–42 |
| v0.7+ | Preview/emulation, test generation, code-review engine | post-42 |

Each surface reuses `packages/*`. No rewrites.

---

## 9. Success metrics (tracked from v0.1)

| Metric | Why it matters |
|---|---|
| Time-to-first-artifact | Install friction check |
| CXO comprehension rate | 2-min usability test on fixtures — did they get it right? |
| Weekly-active re-analyses per repo | Stickiness |
| `agent.json` consumed by external agents | Agent-agnosticism working |
| Secret-redaction false negatives | Privacy posture — must be zero |
| Analysis time p95 on 100 k LOC | Performance budget |

Collection details in a future `telemetry_spec.md`; for v0.1 we track locally via opt-in.

---

## 10. Open questions (revisit post-v0.1)

- MCP transport: stdio vs HTTP vs both for local dev use?
- Cloud data model (v0.5): per-repo snapshots vs continuous git-hooked indexing?
- Pricing: free local + per-seat cloud, or free-forever local + usage-based AI features?
- AI-powered `summary.oneLiner` polish: which model, what guardrails?
- v0.7+ emulation integration: Expo, StackBlitz WebContainers, local emulator install?

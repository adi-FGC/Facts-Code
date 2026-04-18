# FACTS — AI Coding Tracker Stack

> **File Analysis & Context Tracking Stack.** One analysis pass → two artifacts: an AI-agent-optimized codebase map and a CXO-readable executive dashboard.

**Status**: v0.1 scaffold · pre-release

---

## What is this?

FACTS walks any code project on macOS or Windows and produces:

1. **`.facts/agent.json`** — a path-addressable, dense, versioned map of the codebase for AI coding agents (Claude, Cursor, Aider, etc.).
2. **`.facts/human.json`** + a local WebUI — a CXO-readable dashboard that a non-developer can navigate to understand what a codebase does, what it's made of, and where its risks are.

Same analysis. Two audiences. Same truth.

## Specs

Read these in order:

1. [`app_spec.md`](./app_spec.md) — **what** FACTS does (features, artifacts, CLI, roadmap).
2. [`design_spec.md`](./design_spec.md) — **how** FACTS looks and feels (layout, typography, color, accessibility, liquid-glass aesthetic, responsive 340 px → 8 K).
3. [`animations_spec.md`](./animations_spec.md) — **how** motion works (View Transition API, fallbacks, reduced-motion).

## Repository layout

```
factstack/
├── packages/                  # Shared core — consumed by every surface
│   ├── spec/                  # Zod schemas, MCP resource/tool sketch, FactsFS interface
│   ├── walker/                # Gitignore-aware walker, takes a FactsFS
│   ├── fs-node/               # Node fs implementation of FactsFS (for CLI)
│   ├── fs-memory/             # In-memory FactsFS (for tests)
│   ├── fs-browser/            # v0.4 stub — browser FactsFS (File System Access API)
│   ├── parsers/               # web-tree-sitter WASM registry
│   ├── extractors/            # Per-language symbol/route extractors (pure)
│   ├── graph/                 # Dependency + outline graph builders
│   ├── scanners/              # Secrets, licenses, frameworks, TODOs, git history
│   ├── emit/                  # Serializers: agent.json, human.json, SQLite, static export
│   ├── core/                  # Analyzer orchestration (isomorphic)
│   └── ui-theme/              # Shared design tokens, motion presets, language-icon mapper
├── apps/
│   ├── cli/                   # factstack binary — primary v0.1 surface
│   ├── ui-remix/              # Local Remix 3 WebUI + static export target
│   ├── vscode-ext/            # v0.3 stub
│   ├── chrome-ext/            # v0.4 stub
│   ├── webapp/                # v0.5 stub
│   └── mcp-server/            # v0.5 stub
├── plugins/
│   └── mcp-app/               # v0.6 stub
├── examples/                  # Fixture projects for golden-master testing
├── app_spec.md
├── design_spec.md
└── animations_spec.md
```

## Locked architectural constraints

These are enforced in CI via ESLint boundary rules (`.eslintrc`). Violations fail the build.

### C1 — Isomorphic core (for future Chrome extension / WASM analyzer)

`packages/core` and every package it transitively depends on (`spec`, `graph`, `extractors`, `scanners`, `parsers`, `walker`) **must not import Node built-ins** (`fs`, `path`, `os`, `worker_threads`, `child_process`).

All I/O is injected via the `FactsFS` interface (`packages/spec/src/fs.ts`). `packages/fs-node` is the Node implementation; `packages/fs-browser` (v0.4) will be the browser one. No changes to core are needed when a new filesystem backend lands.

Parsers use `web-tree-sitter` (WASM) exclusively — no native bindings.

### C2 — Artifact discipline (for future web app + MCP server + cloud sync)

- Schemas in `packages/spec` are **versioned** (`$schema`, `factsVersion`) and additive-only within a major.
- Artifacts are **size-bounded** (`agent.json` ≤ 5 MB, `human.json` ≤ 2 MB; overflow chunked).
- Artifacts **never contain raw secrets** — scanners redact before serialization.
- MCP resource/tool surface is sketched in `packages/spec` today so v0.5 server code is a thin adapter.
- CLI has a machine-invocable mode (`factstack analyze --json`) from day one.

### C3 — Webview-ready UI (for future VS Code / Antigravity extension)

`apps/ui-remix` builds to two targets:

1. **Server mode** — full Remix 3 with loaders/actions, server-side re-analysis endpoint.
2. **Static mode** — pure client-side SPA, no server, data hydrated from embedded `human.json` + `agent.json`. Used by `factstack export` and hosted inside VS Code webviews.

Static mode is enforced via a single `loadArtifacts()` abstraction with two implementations. UI never uses APIs blocked by VS Code webview CSP.

## Quick start (once scaffold is complete)

```bash
pnpm install
pnpm build
pnpm --filter @factstack/cli link   # expose `factstack` locally
cd ../my-project
factstack                            # analyzes, emits .facts/, opens UI
```

## Package dependency rules

Enforced via `eslint-plugin-boundaries`:

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
| `apps/ui-remix` | `spec` only (schemas for data types) |

## Roadmap

| Version | Surface | Target |
|---|---|---|
| v0.1 | CLI + local Remix 3 UI | Weeks 1–10 |
| v0.2 | npm global install | Weeks 11–12 |
| v0.3 | VS Code / Antigravity extension | Weeks 13–18 |
| v0.4 | Chrome extension (WASM analyzer) | Weeks 19–24 |
| v0.5 | Web app + cloud + MCP server | Weeks 25–36 |
| v0.6 | MCP app + skills bundle | Weeks 37–42 |
| v0.7+ | Preview/emulation, test generation, code-review engine | post-42 |

## License

UNLICENSED — pre-release. License to be selected before v0.1 ships.

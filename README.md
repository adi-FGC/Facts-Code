# FACTS — Fun AI Coding Tools

> One analysis pass → two artifacts (an AI-agent-readable codebase map and a CXO-readable executive dashboard) plus a live MCP surface for AI coding agents.

**Status:** v0.2 (analyzer + UI + MCP server + watch + diff + query)

## Positioning

FACTS is built on one principle: **make codebase analysis useful and not scary for new
programmers — and legible to CXOs, new CTOs, and investors** at the same time. One pass
produces both views: the agent map for the people (and agents) writing code, the
executive dashboard for the people deciding about it.

It is **free so far**, and deliberately focused: a helper and a **token saver** for
programming and testing — agents read the cached map instead of re-reading your tree.
A **premium SaaS tier is planned**: prompts, skills, and MCPs that drop FACTS into any
coding-agent workflow.

Sibling products (parallel, not parents): **facts-open** — the free, open-source
drop-in codebase viewer (formerly facts-tree) — and **facts+** — the premium cited
UI/UX/accessibility audit grader for anyone building and maintaining apps and websites.
The token-compressed **`.pack` artifact is a cornerstone FACTS shares with facts+**;
the facts-open line never used it — its agent surface is plain JSON.

---

## What ships today

| Surface | Command | What it does |
|---|---|---|
| **Analyze** | `factstack analyze [path]` | Walks the project, extracts JS/TS imports + symbols + routes + license headers + secrets, builds the dependency graph, mines git history, writes `.facts/agent.json` + `.facts/human.json` + a snapshot. |
| **WebUI** | `factstack ui [path]` | Serves the editorial dashboard at `http://localhost:4747`. Re-analyze button, live source preview, graph view, file outline. |
| **Watch** | `factstack watch [path]` | UI + chokidar file-watcher + Server-Sent Events. Edits trigger re-analysis (500ms debounce); UI tree rows pulse. |
| **Diff** | `factstack diff [snapA] [snapB]` | Compare two analyses. Zero args = current vs latest snapshot. One arg = current vs named snapshot. Two args = explicit snapshots. |
| **Query** | `factstack query <verb> [target]` | Structured graph queries: `callers <path>`, `imports <path>`, `cycles`, `orphans`. |
| **Export** | `factstack export [path]` | Self-contained HTML report (no server needed). |
| **Doctor** | `factstack doctor` | Verifies Node version + `node:sqlite` availability. |
| **MCP server** | `factstack-mcp --root <path>` | stdio MCP server exposing 5 tools + 5 resources for AI agents. |

All commands accept `--json` for machine-invocable output. `--json` is also a top-level flag (`factstack --json analyze .`).

---

## Quick start

```bash
# 1. Install
pnpm install

# 2. Analyze any project (no global install needed in dev — use the workspace tsx)
pnpm --filter @factstack/cli exec tsx src/cli.ts analyze /path/to/your/project

# 3. Open the dashboard
pnpm --filter @factstack/cli exec tsx src/cli.ts ui /path/to/your/project
# → http://localhost:4747 opens in your default browser

# 4. (Optional) Live-update mode
pnpm --filter @factstack/cli exec tsx src/cli.ts watch /path/to/your/project
```

For repeated use, link the binary globally:

```bash
cd apps/cli
pnpm link --global       # exposes `factstack` on PATH
factstack analyze /path/to/your/project
factstack ui /path/to/your/project
```

> **Note**: `pnpm build` currently has unresolved type errors in a few packages (tracked in `app_plan_spec.md`). The CLI works via `tsx` regardless — TypeScript runtime, no build step needed for development. Production binary builds land with v0.3.

---

## MCP server — Claude Desktop / Cursor / Claude Code config

The MCP server runs over stdio and exposes the cached analysis to any compliant client:

```jsonc
// claude_desktop_config.json (or .cursor/mcp.json or any MCP client)
{
  "mcpServers": {
    "factstack": {
      "command": "node",
      "args": [
        "/abs/path/to/factstack/apps/mcp-server/dist/server.js",
        "--root",
        "/abs/path/to/the/project/you/want/analyzed"
      ]
    }
  }
}
```

For dev (no build step):

```jsonc
{
  "mcpServers": {
    "factstack": {
      "command": "node",
      "args": [
        "--import", "tsx",
        "/abs/path/to/factstack/apps/mcp-server/src/server.ts",
        "--root",
        "/abs/path/to/the/project"
      ]
    }
  }
}
```

The server caches the analysis at boot. **Tools**: `read_memory` (v0.3.1 — read FIRST when joining a project), `analyze`, `query_graph` (verbs: callers, imports, cycles, orphans), `get_outline`, `list_risks`, `reanalyze_file` (deprecated stub). **Resources**: `facts://project`, `facts://graph`, `facts://routes`, `facts://risks`, `facts://file/{path}`.

### `.facts/MEMORY.md` — agent brief (v0.3.1)

Every `factstack analyze` writes a 2-10 KB markdown digest to `.facts/MEMORY.md`. AI agents joining the project should read this FIRST — it replaces a 40-200 KB cold-read of `agent.json` for the orient-myself case.

The brief is **deterministic** (same input → byte-identical output) and **section-ordered** so agents can rely on the layout:

```
# {project}
> {one-liner}

## At a glance        languages, frameworks, stats, health
## Capabilities       inferred from frameworks + routes
## Entry points       npm scripts, CLI commands, exposed URLs
## Routes             grouped by framework, alphabetical
## Key files          highest in-degree (most-imported = hubs)
## Open risks         severity high/critical only
## Recently active    top 5 from git mtime
## How to read this codebase   5-step deterministic tour
```

Sections with no content are omitted entirely (keeps the artifact small). Caps applied per section: 8 frameworks, 8 risks, 5 active files, 6 routes per framework, 6 capabilities, 3 languages.

Read it via the MCP `read_memory` tool, the file directly, or paste it into an agent prompt. Schema version: `factstack-memory.v1`.

---

## Open from GitHub (browser-only · no install)

The static demo at [factstack-demo.netlify.app](https://factstack-demo.netlify.app) can analyze any public GitHub repo without a clone:

1. Click **GitHub** in the toolbar.
2. Paste `owner/repo`, `owner/repo@branch`, or any `https://github.com/...` URL.
3. (Optional) Drop in a Personal Access Token to raise the rate limit from 60 → 5000/hr.
4. The browser fetches the repo zip via `api.github.com/repos/{o}/{r}/zipball`, unpacks with JSZip, and runs the same scanner the local-folder flow uses.

Deep links work too:

```
https://factstack-demo.netlify.app/?gh=vercel/next.js
https://factstack-demo.netlify.app/?gh=vercel/next.js@canary
```

When a Supabase bucket is configured (see below), deep links replay cached analyses instantly — no GitHub API hit, no scan time. First visitor pays the cost; everyone after is free.

### Supabase persistence (optional, deploy-time)

To save GitHub-repo analyses so visitors share a cache instead of each re-scanning:

1. **Create a Supabase project** at [supabase.com](https://supabase.com). Free tier is plenty — analyses are ~50 KB each.
2. **Create a public storage bucket** named `factstack-analyses` (Storage → New bucket → toggle "Public bucket").
3. **Add an RLS insert policy** so the anon role can write but not delete:
   ```sql
   create policy "anon insert"   on storage.objects for insert to anon
     with check (bucket_id = 'factstack-analyses');
   create policy "anon read"     on storage.objects for select to anon
     using       (bucket_id = 'factstack-analyses');
   create policy "anon overwrite latest" on storage.objects for update to anon
     using       (bucket_id = 'factstack-analyses' and name like '%/latest.json')
     with check  (bucket_id = 'factstack-analyses' and name like '%/latest.json');
   ```
4. **Inject your project URL + anon key** into `prototype/index.html`. Two options:
   - **Manual** (pre-deploy): edit the `<script id="factstack-supa-config">` block to add `data-url` and `data-anon-key` attributes:
     ```html
     <script id="factstack-supa-config"
             data-url="https://YOUR_PROJECT.supabase.co"
             data-anon-key="eyJhbGciOi...">
     ```
   - **Build-time** (Netlify): use a `[build]` `command` that substitutes from env vars before publishing:
     ```toml
     # netlify.toml
     [build]
       command = "sed -i \"s|data-url=\\\"\\\"|data-url=\\\"$SUPABASE_URL\\\"|; s|data-anon-key=\\\"\\\"|data-anon-key=\\\"$SUPABASE_ANON_KEY\\\"|\" prototype/index.html"
       publish = "prototype"
     ```
     Set `SUPABASE_URL` + `SUPABASE_ANON_KEY` in Netlify's environment settings.

The anon key is **publishable by design** — Supabase's RLS controls write access. No secrets land in the browser.

Storage layout:
```
factstack-analyses/
  vercel/next.js/
    2026-04-30T12-34-56-789Z.json    ← immutable snapshot
    latest.json                       ← upserted pointer
  vercel/next.js@canary/
    ...
```

---

## Specs

Read these in order:

1. [`app_spec.md`](./app_spec.md) — what FACTS does (functional spec)
2. [`app_plan_spec.md`](./app_plan_spec.md) — engineering plan, constraints, roadmap
3. [`design_spec.md`](./design_spec.md) — UI design system
4. [`animations_spec.md`](./animations_spec.md) — motion catalogue + reduced-motion rules

---

## Repository layout

```
factstack/
├── packages/
│   ├── spec/          # Zod schemas, MCP tool/resource catalog, FactsFS interface
│   ├── walker/        # Gitignore-aware walker, takes a FactsFS
│   ├── fs-node/       # Node fs implementation + git history miner
│   ├── fs-memory/     # In-memory FactsFS (for tests)
│   ├── fs-browser/    # v0.4 stub (browser FactsFS via File System Access API)
│   ├── parsers/       # web-tree-sitter WASM grammar registry (v0.3)
│   ├── extractors/    # JS/TS imports + symbols + routes; Python imports; outline
│   ├── graph/         # Dependency graph + Tarjan cycles + caller index + module resolver
│   ├── scanners/      # Secrets, licenses, frameworks, TODOs, languages, token cost
│   ├── emit/          # agent.json + human.json + snapshots + viz transformer + gzip
│   ├── core/          # Pipeline orchestrator + diff + query
│   └── ui-theme/      # CSS tokens, motion presets, language icons (v0.3)
├── apps/
│   ├── cli/           # `factstack` binary — primary v0.2 surface
│   ├── ui-remix/      # React 19 + React Router v7 — full dashboard (alongside the prototype)
│   ├── mcp-server/    # `factstack-mcp` binary — MCP stdio server (v0.2)
│   ├── vscode-ext/    # v0.3 stub (will host the static-mode UI)
│   ├── chrome-ext/    # v0.4 stub
│   └── webapp/        # v0.5 stub
├── plugins/
│   └── mcp-app/       # v0.6 stub
├── prototype/         # Standalone editorial UI (open via file:// or factstack ui)
├── examples/
│   └── tiny-ts-app/   # Minimal SPDX-MIT fixture
└── *spec*.md          # Living specs
```

---

## Architectural constraints (enforced via ESLint boundaries)

### C1 · Isomorphic core
Everything from `packages/core` down (`spec`, `walker`, `parsers`, `extractors`, `graph`, `scanners`) imports zero Node built-ins. I/O flows through the `FactsFS` interface. The Chrome extension (v0.4) will inject a browser FactsFS without touching core.

### C2 · Artifact discipline
- Schemas in `packages/spec` are versioned (`$schema`, `factsVersion`) and additive-only within a major.
- Artifacts target ≤ 5 MB (agent.json) / ≤ 2 MB (human.json) — overflow chunking lands with the SQLite index in v0.3.
- Artifacts never contain raw secrets — scanners redact before serialization.
- The MCP tool/resource catalog (`packages/spec/src/mcp.ts`) is the single source of truth shared by CLI + MCP server.

### C3 · Webview-ready UI
`apps/ui-remix` builds two targets: a Vite-served dev server (with live re-analyze) and a static SPA (no server, data hydrated from embedded JSON). Used by `factstack export` and the future VS Code webview. CSP-clean — no inline scripts, no third-party CDN runtime deps.

---

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
| `apps/cli` | `spec`, `core`, `emit`, `fs-node`, `extractors` |
| `apps/mcp-server` | `spec`, `core`, `emit`, `fs-node`, `extractors` |
| `apps/ui-remix` | `spec`, `ui-theme` only |

---

## Roadmap

| Version | Surface | Status |
|---|---|---|
| v0.1 | CLI + emit + JS/TS imports + WebUI prototype | **shipped** |
| v0.2 | Symbols + call graph + MCP server + watch + diff + query | **shipped** |
| v0.3 | VS Code / Antigravity extension + SQLite index + tree-sitter Python + per-TODO git blame + per-file incremental re-analyze | next |
| v0.4 | Chrome extension (WASM analyzer) | planned |
| v0.5 | Web app + cloud + MCP HTTP/SSE transport | planned |
| v0.6 | MCP app + skills bundle | planned |

---

## Tests

```bash
pnpm turbo test                         # 19 vitest specs across extractors + scanners
pnpm --filter @factstack/cli exec tsx src/cli.ts analyze .
pnpm --filter @factstack/cli exec tsx src/cli.ts query callers packages/spec/src/index.ts
```

CI runs typecheck + tests + a smoke `analyze .` on Ubuntu/macOS/Windows × Node 22.

---

## License

UNLICENSED — pre-release. License decision lands before v0.3 ships. (See `app_plan_spec.md` §10 risk #3 for the trade-off discussion.)

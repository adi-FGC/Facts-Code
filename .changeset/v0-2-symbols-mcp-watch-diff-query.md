---
"@factstack/cli": minor
"@factstack/core": minor
"@factstack/emit": minor
"@factstack/extractors": minor
"@factstack/fs-node": minor
"@factstack/graph": minor
"@factstack/mcp-server": minor
"@factstack/scanners": minor
"@factstack/spec": minor
---

v0.2 — symbols, call graph, MCP server, watch, diff, query.

**New analyzer surface**:
- JS/TS symbol extraction populates `FileOutline.declarations` (functions, classes, methods, types, interfaces, enums, hooks, components). Single Babel parse shared across imports + symbols + outline via `parseJS()`.
- Caller index — every `GraphNode` in `agent.json.graph.nodes` carries an optional `callers: string[]`.
- Snapshot files now include `broken / stale / secrets` headline counts; retention capped at 50 (configurable via `WriteOptions.snapshotRetention`); millisecond-resolution filenames + exclusive-create retry prevent silent overwrites.

**New CLI commands**:
- `factstack watch [path]` — UI + chokidar + SSE live-update with 500ms debounce.
- `factstack diff [a] [b]` — zero-arg compares against the previous snapshot; one-arg or two-arg picks explicit snapshots.
- `factstack query <verb> [target]` — verbs: `callers`, `imports`, `cycles`, `orphans`. Shares the verb engine with the MCP `query_graph` tool.

**MCP server (`apps/mcp-server`)**:
- stdio transport over `@modelcontextprotocol/sdk@^1.0.0`.
- 5 tools: `analyze`, `query_graph` (with conditional-required `path`), `get_outline`, `list_risks`, `reanalyze_file` (deprecated stub).
- 5 resources + 1 resource template (`facts://file/{path}`).

**New schemas in `@factstack/spec`**:
- `DiffArtifactSchema` (additive, separate `./diff` subpath export).
- `QUERY_VERBS` + `QueryVerbSchema` shared by CLI + MCP.
- `McpResourceCatalog` enriched with mimeType + descriptions.

**Hardening + correctness**:
- AST-mutation bug fixed via per-call `WeakSet<object>` instead of `__fromExport` flag.
- BFS frontier in `query imports --depth N` rebuilds adjacency once and replaces frontier each pass (was O(depth × V × E)).
- Path-traversal guard works on Windows drive-letter casing via `path.relative` + `isInside()`.
- `@babel/parser`-backed Python imports; structured route extractor for Next.js + Astro + Remix + Express + FastAPI + Flask + Django.
- License scanner accepts the legacy `{ "license": { "type": "MIT" } }` form.
- Git history miner uses ASCII US (\x1f) field separator + 1 GiB buffer + structured fallback.
- Walker drops `*.tsbuildinfo` artifacts; route extractor skips test/spec/fixture paths; activity feed filters lockfiles + build caches.
- Diff against snapshot endpoints sets `files.incomplete: true` instead of reporting every file as "added".
- Exported HTML strips CDN-loaded scripts/stylesheets/dynamic-imports for self-contained `file://` viewing (full Vite static build lands v0.3).

**Onboarding**:
- README rewritten for v0.2 (commands, MCP client config snippet, tested quickstart).
- `apps/mcp-server/README.md` rewritten as user-facing docs (was "v0.5 stub").

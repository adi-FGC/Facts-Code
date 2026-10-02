# FACTS MCP server (`factstack-mcp`)

stdio Model Context Protocol server. Exposes the FACTS analyzer's artifacts as tools + resources for AI coding agents (Claude Desktop, Cursor, Claude Code, Continue, etc.).

One project per process. The server answers the client's `initialize` at once and starts analyzing in the background only after the handshake; tools called before that first analysis finishes wait for it. A failing analysis is reported by each tool (`isError`), never a crash. Analyses are serialized, so concurrent calls can't tear `.facts/`.

**Sign-in is optional.** Every tool and resource works signed out, fully offline. Signing in (below) only mirrors learnings to your private per-account cloud store.

## Run it

<!-- repo-only:start -->

<!-- The npm package ships this file minus the repo-only blocks, with the
     npm-only comments unwrapped (npmReadme in scripts/assemble-publish.mjs). -->

`factstack-mcp` is **not on npm yet**. Once published: `npx -y factstack-mcp --root /abs/path/to/project`.

Today, from a clone of this repo:

```bash
npx tsx apps/mcp-server/src/server.ts --root /abs/path/to/project
```

Or build the single-file bundle once and run it with plain Node (24.3+):

```bash
pnpm --filter @factstack/mcp-server build          # → apps/mcp-server/dist/server.js
node apps/mcp-server/dist/server.js --root /abs/path/to/project
```

How the npm package is assembled and published (owner only): [PUBLISHING.md](PUBLISHING.md).

<!-- repo-only:end -->

<!-- npm-only:start
Needs Node 24.3 or newer.

```bash
npx -y factstack-mcp --root /abs/path/to/project
```

npm-only:end -->

The server logs status to stderr; the JSON-RPC protocol runs on stdin/stdout. `--version` and `--help` print and exit.

### Project root

Pass `--root <dir>` (or `-r`, `--root=<dir>`, or the `FACTS_ROOT` env var). Without one, the server walks up from its working directory to the repo (`.git`), else the nearest `package.json`. It refuses when it finds no project, or when the inferred project is your home directory or a filesystem root: nothing is written, and tools return an error saying to pass `--root`. `.facts/` is added to `.gitignore` only inside a git repo.

### Optional sign-in (cloud sync of learnings)

<!-- repo-only:start -->

```bash
npx -y factstack-mcp login                         # once published
npx tsx apps/mcp-server/src/server.ts login        # today, from a clone
```

<!-- repo-only:end -->

<!-- npm-only:start
```bash
npx -y factstack-mcp login
```

npm-only:end -->

Opens a Google sign-in page and stores the session in `~/.factstack/auth.json` (override the folder with `FACTS_HOME`). `log_learning` then reports `cloudSync: "synced"`. Signed out it reports `"off"`. Signed in but the session cannot be refreshed (offline, or the sign-in expired or was revoked: run `login` again) it reports `"paused"`. Signed in but the cloud write did not go through it reports `"failed"`. The local `.facts/learnings.jsonl` is always the record.

## Tools

17 tools; `llms-full.txt` on the [FACTS site](https://factstack.pages.dev) documents each one: `analyze`, `query_graph`, `query`, `get_diagram`, `get_outline`, `list_risks`, `list_credentials`, `list_vulnerabilities`, `read_memory`, `since`, `log_learning`, `query_learnings`, `get_config`, `review_change`, `count_tokens`, `get_context`, `sync_pack`.

<!-- repo-only:start -->

The catalog in `@factstack/spec` (`MCP_TOOL_CATALOG`) is the source of truth.

<!-- repo-only:end -->

Notes:

- `analyze` takes `symbols` (build the symbol graph, like the CLI's `--symbols`; default: whatever the existing artifact has) and `useCache` (`false` forces a full re-parse).
- `review_change` and `since` compare the current analysis against the explicit analysis before it (an `analyze` tool call or `factstack analyze`). Each explicit analyze parks the previous one in `.facts/baseline/agent.json`. The analyze a session runs on start-up (or on a first tool call) is not explicit: like the per-edit `--minimal` hook, it refreshes `agent.pack`, `human.json` and `MEMORY.md` but leaves `.facts/agent.json` (the last explicit analysis) as it is, marked stale. A review in the meantime compares against that analysis, and the next `analyze` parks it. A `list_vulnerabilities` `refresh: true` saves the analysis it scanned into `agent.json`; during a hold it parks the held analysis first. `since` uses the newest of these that predates the timestamp; otherwise it reports mtime-only changes (`hasBaseline: false`).
- A start-up analyze never writes over a newer analysis on disk (a hook run meanwhile, or a clock behind the one that wrote it): it answers from memory and logs why. The `analyze` tool always writes.
- A re-analyze carries the last CVE scan forward. Rows that fail the current schema are dropped, and so is a scan whose metadata or row list does. A row count that does not match the scan's recorded findings is carried with a warning. When any of this happens, `analyze` returns `warnings` and `list_vulnerabilities` returns `warning` until the next analyze or `refresh: true`.
- Paths may be spelled `src\a.ts`, `./src/a.ts` or absolute-inside-the-root. An unknown `query_graph` target, or a `get_outline` / `count_tokens` path that is neither analyzed nor on disk, is an `isError` result with `didYouMean`, not an empty answer. A free-text `query` with no confident match returns `{ ok: false, reason, candidates }`. An unknown `facts://file/{path}` names close matches in its error.
- Every tool failure is an `isError` result with `{ ok: false, error, issues? }` (`sync_pack` keeps its own `{ status: "error", error }`); only an unknown tool name is a JSON-RPC error.

## Resources

| URI                     | mimeType         | Contents                                                                  |
| ----------------------- | ---------------- | ------------------------------------------------------------------------- |
| `facts://project`       | application/json | Project meta + stats + health.                                            |
| `facts://graph`         | application/json | Full dependency graph (nodes, edges, cycles, callers).                    |
| `facts://routes`        | application/json | Detected routes (Next.js, Remix, Express, FastAPI, Flask, Django).        |
| `facts://risks`         | application/json | All scanner findings.                                                     |
| `facts://file/{path}`   | application/json | Per-file `FileOutline`. URI-encode the path; `./` and `\` are normalized. |
| `facts://schema/{kind}` | application/json | JSON Schema for the `agent` or `human` artifact.                          |

The parametric resources are advertised via `resources/templates/list`.

## MCP client config

### Claude Desktop / Cursor / Claude Code

<!-- repo-only:start -->

```jsonc
{
  "mcpServers": {
    "factstack": {
      // Once published: "command": "npx", "args": ["-y", "factstack-mcp", "--root", "/abs/path/to/project"]
      "command": "npx",
      "args": [
        "tsx",
        "/abs/path/to/factstack/apps/mcp-server/src/server.ts",
        "--root",
        "/abs/path/to/project"
      ]
    }
  }
}
```

<!-- repo-only:end -->

<!-- npm-only:start
```jsonc
{
  "mcpServers": {
    "factstack": {
      "command": "npx",
      "args": ["-y", "factstack-mcp", "--root", "/abs/path/to/project"]
    }
  }
}
```

npm-only:end -->

## Limits + future work

- **Single project per process** — restart the server to point at a different repo.
- **No cross-project queries** — by design.

<!-- npm-only:start
## Licenses

`dist/server.js` is a single-file bundle. The npm packages inlined in it keep their own licenses, listed in `THIRD_PARTY_NOTICES.md` in this package.

npm-only:end -->

<!-- repo-only:start -->

## Architecture notes

- `src/create-server.ts` holds every handler behind `createFactsMcpServer({ root, ... })` (no transport, injectable analyzer / OSV client / cloud mirror), so tests drive it in-process over the SDK's in-memory transport. `src/server.ts` is only the stdio bin.
- Each tool is one named handler (`handleListVulnerabilities`, …) in a dispatch table typed on spec's tool-name union: a catalog tool with no handler fails the type check.
- `executeQuery` lives in `@factstack/core` and is shared with the `factstack query` CLI subcommand. Same verb set, same result shape.
- Everything that writes `.facts/` (analyze, the CVE refresh) or needs a consistent read of it (`sync_pack`) runs through one fence.

<!-- repo-only:end -->

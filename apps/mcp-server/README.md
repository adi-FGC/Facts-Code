# @factstack/mcp-server *(v0.2)*

stdio Model Context Protocol server. Exposes the FACTS analyzer's artifacts as tools + resources for AI coding agents (Claude Desktop, Cursor, Claude Code, Continue, etc.).

Pinned to `@modelcontextprotocol/sdk@^1.0.0`. Single project per process — point at the project root via `--root <path>` or `FACTS_ROOT` env var. The server caches the analyzer output at boot and refreshes on `analyze` / `reanalyze_file` tool calls; serial mutex prevents concurrent re-analysis from tearing `.facts/agent.json`.

## Quick start (stdio)

```bash
# From the workspace
pnpm --filter @factstack/mcp-server exec tsx src/server.ts --root /abs/path/to/project

# Or after build
node apps/mcp-server/dist/server.js --root /abs/path/to/project
```

The server logs status to stderr; the JSON-RPC protocol runs on stdin/stdout.

## Tools

| Name | Input | What it does |
|---|---|---|
| `analyze` | `{}` | Run a full analysis; refresh the in-memory cache + write `.facts/`. |
| `query_graph` | `{ verb, path?, filter?, limit?, depth? }` | Verbs: `callers` (path required), `imports` (path required, optional `depth`), `cycles`, `orphans`. Returns `{ verb, target?, count, results }`. Returns a structured `{ ok: false, issues: [...] }` for missing required args. |
| `get_outline` | `{ path }` | Return the symbol outline for a single file. Pre-extracted declarations from the cache when present, falls back to live extraction. |
| `list_risks` | `{ severity?, category? }` | Filter scanner findings by severity (`info|low|medium|high|critical`) or category (`secret|license|broken-import|cycle|stale|...`). |
| `reanalyze_file` | `{ path? }` | **DEPRECATED v0.2.** Stubs to a full analyze. True per-file incremental lands with v0.3 SQLite index. |

## Resources

| URI | mimeType | Contents |
|---|---|---|
| `facts://project` | application/json | Project meta + stats + health. |
| `facts://graph` | application/json | Full dependency graph (nodes, edges, cycles, callers). |
| `facts://routes` | application/json | Detected routes (Next.js, Remix, Express, FastAPI, Flask, Django). |
| `facts://risks` | application/json | All scanner findings. |
| `facts://file/{path}` | application/json | Per-file `FileOutline`. URI-encode the path; `./` and `\` are normalized. |

The parametric file resource is advertised via the `resources/templates/list` extension (resourceTemplates capability).

## MCP client config

### Claude Desktop / Cursor / Claude Code

```jsonc
{
  "mcpServers": {
    "factstack": {
      "command": "node",
      "args": [
        "/abs/path/to/factstack/apps/mcp-server/dist/server.js",
        "--root",
        "/abs/path/to/project"
      ]
    }
  }
}
```

### Dev (no build step)

```jsonc
{
  "mcpServers": {
    "factstack": {
      "command": "node",
      "args": [
        "--import", "tsx",
        "/abs/path/to/factstack/apps/mcp-server/src/server.ts"
      ],
      "env": {
        "FACTS_ROOT": "/abs/path/to/project"
      }
    }
  }
}
```

## Limits + future work

- **Single-project per process** — restart the server to point at a different repo. SSE/HTTP transport with multi-tenancy lands in v0.5.
- **Path arg on `analyze` / `reanalyze_file` is ignored** — the server's root is fixed at boot.
- **Incremental re-analysis is a stub** — `reanalyze_file` triggers a full analyze. SQLite index in v0.3 unlocks real per-file deltas.
- **No cross-project queries** — by design; v0.5 web app handles that.

## Architecture notes

- `executeQuery` lives in `@factstack/core` and is shared with the `factstack query` CLI subcommand. Same verb set, same result shape — surfaces can't drift.
- Tools that mutate (`analyze`, `reanalyze_file`) chain through a single promise so concurrent calls serialize.
- Errors bubble with structured content blocks (`{ ok: false, error, issues? }`) instead of throwing — keeps the MCP wire-format clean for clients that don't unwrap exceptions.

See [`app_plan_spec.md` §2.5 (C2)](../../app_plan_spec.md) for the schema-versioning + secrets-redaction guarantees that the MCP surface inherits.

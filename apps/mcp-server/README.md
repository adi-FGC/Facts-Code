# @factstack/mcp-server *(v0.5 stub)*

**Not built in v0.1.** Reserved for the MCP server surface that exposes FACTS artifacts to AI coding agents.

## Design

The resource + tool surface is **already sketched** in `@factstack/spec/src/mcp.ts` during v0.1, so this package will be a thin adapter over `@factstack/core` + artifact readers.

### Resources (read-only)
- `facts://project`
- `facts://file/{path}`
- `facts://graph`
- `facts://routes`
- `facts://risks`

### Tools (agent-invocable)
- `analyze(path?)`
- `reanalyze_file(path)`
- `query_graph(filter)`
- `get_outline(path)`
- `list_risks(severity?)`

## Transport

- stdio for local dev.
- HTTP/SSE for cloud deployment (v0.5 webapp surface).

## Blocked on

- Rate-limit + auth strategy for the tool surface.
- `@factstack/spec/mcp.ts` implementation (part of v0.1 scope in `packages/spec`).
- MCP SDK version pin aligned with the 2026 protocol revision.

# @factstack/cli

**FACTS — Fun AI Coding Tools.** The `factstack` command-line interface.

One analysis pass turns any codebase into two artifacts — an AI-agent-readable
map (`.facts/agent.pack`) and a CXO-readable dashboard — plus a live MCP surface
for coding agents.

## Quick start

```bash
npx -y @factstack/cli analyze .     # analyze this project → writes .facts/
npx -y @factstack/cli ui .          # serve the dashboard at http://localhost:4747
npx -y @factstack/cli query callers src/foo.ts
npx -y @factstack/cli install .     # wire FACTS into your coding agent (Claude / Cursor / Copilot)
```

> Note: `@factstack/cli` isn't published to npm yet — the `npx` commands above are
> the intended install flow once it ships. For now, use the live demo at
> https://factstack.pages.dev or run from a source checkout.

Run `factstack --help` for the full command set (`analyze`, `ui`, `watch`,
`query`, `diff`, `review`, `scan-vulns`, `export`, `install`, `doctor`, …).
Every command accepts `--json` for machine-invocable output.

## Companion

`@factstack/mcp-server` (`factstack-mcp`) exposes the same analyzer artifacts to
agents over an MCP stdio server.

Homepage + live demo: https://factstack.pages.dev

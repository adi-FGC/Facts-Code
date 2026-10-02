# factstack — the FACTS CLI

**FACTS — Fun AI Coding Tools.** The `factstack` command-line interface.

One analysis pass turns any codebase into two artifacts — an AI-agent-readable
map (`.facts/agent.pack`) and a CXO-readable dashboard — plus a live MCP surface
for coding agents. `analyze` never touches the network.

Requires **Node ≥ 24.3**.

## Quick start (from a source checkout — works today)

```bash
pnpm install
pnpm --filter @factstack/cli exec tsx src/cli.ts analyze /path/to/project   # writes .facts/
pnpm --filter @factstack/cli exec tsx src/cli.ts ui /path/to/project        # dashboard on http://localhost:4747
```

Or build the standalone CLI — a self-contained folder, `apps/cli/publish/` — and run it
with plain Node:

```bash
pnpm --filter @factstack/cli bundle          # → apps/cli/publish/ (entry: dist/cli.js)
node apps/cli/publish/dist/cli.js analyze /path/to/project
```

Copy the whole folder, not just `dist/cli.js`: `ui` and `export` load the UI and
vendored files beside it.

## Quick start (npm)

```bash
npx factstack analyze .            # analyze this project → writes .facts/
npx factstack ui .                 # serve the dashboard at http://localhost:4747
npx factstack query callers src/foo.ts
npx factstack install .            # wire FACTS into your coding agent (Claude / Cursor / Copilot)
```

> Note: the `factstack` package is **not published to npm yet** — the commands
> above are the install flow once it ships. Until then use a source checkout
> (above) or the live demo at https://factstack.pages.dev.

Run `factstack --help` for the full command set (`analyze`, `ui`, `watch`,
`query`, `diff`, `review`, `scan-vulns`, `export`, `install`, `doctor`, …).
Every command accepts `--json` for machine-invocable output.

## Companion

`factstack-mcp` exposes the same analyzer artifacts to agents over an MCP
stdio server: `npx -y factstack-mcp` once published (not on npm yet).
`factstack install` registers it in your agent's MCP config, pinned to the
project with `--root <absolute project path>`; until the package is
published, pass `--server-command` to point it at a local build.

The pinned path is this machine's (often under your home directory). If you
commit `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json`, each teammate
re-runs `factstack install`, which rewrites the path for their machine. For
Cursor and VS Code, `--server-command '<command> --root ${workspaceFolder}'`
keeps the file portable. The editor expands the variable, and install keeps a
`--root` you give it as is.

Homepage + live demo: https://factstack.pages.dev

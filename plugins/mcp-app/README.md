# @factstack/mcp-app *(v0.6 stub)*

**Not built in v0.1.** Reserved for the MCP App surface — a bundled MCP app + skills package that a good AI agent can enable via plugin/skill to get full FACTS functionality.

## Design

- Ships as an MCP app bundle consumable by Claude (and other MCP-compatible agents).
- Associated skills:
  - `analyze-project` — trigger a FACTS analysis of the user's current project.
  - `explain-codebase` — generate a plain-English walkthrough from `human.json`.
  - `find-in-codebase` — semantic search via `agent.json` + the SQLite index.
  - `show-me` — open the local UI automatically for the user while the agent consumes the machine artifacts for itself.

The underlying analyzer and artifacts are what give this surface its value — it's a thin packaging layer over everything else.

## Blocked on

- v0.5 MCP server surface.
- MCP App packaging conventions circa 2026.
- Skill discovery/documentation approach.

# @factstack/webapp *(v0.5 stub)*

**Not built in v0.1.** Reserved for the cloud-hosted web app surface.

## Design

- Gives users local-directory access via the File System Access API.
- Syncs analysis artifacts to a personal cloud account (opt-in, granular: metadata only vs full tree).
- Prompts the user to download the JSON artifacts to their local `.facts/` directory — the source of truth always stays local; cloud is a cache + share surface.
- Deployed on whatever cloud the v0.5 decision lands on (current leads: Cloudflare Workers + D1, or Fly.io + Postgres).
- Shares artifacts via a companion MCP server (see `apps/mcp-server`) so connected AI agents can consume them.

## Blocked on

- Pricing / plan structure decision (app_spec.md §10).
- Cloud provider decision.
- Auth approach (GitHub OAuth most likely).
- Secret-redaction verification — never send raw secrets to cloud, even with opt-in.

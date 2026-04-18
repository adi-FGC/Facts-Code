# @factstack/vscode-ext *(v0.3 stub)*

**Not built in v0.1.** Reserved for the VS Code / Antigravity extension surface.

## Design

- Imports `@factstack/core`, `@factstack/spec`, `@factstack/emit`, `@factstack/fs-node`.
- Hosts the static-mode build output of `@factstack/ui-remix` inside a webview (constraint C3).
- Webview content runs in a restricted CSP — no inline scripts, no `eval`, no unsafe-inline styles.
- Commands:
  - `FACTS: Analyze Workspace`
  - `FACTS: Open Dashboard`
  - `FACTS: Re-analyze`
  - `FACTS: Export Static Report`
- Status-bar item shows last-analysis time + health headline.
- Extension activation triggers off `workspaceContains:**/.facts/*` so it lights up automatically in a FACTS-analyzed repo.

## Blocked on

- Finalized Remix 3 static build target (v0.1 W8–W9).
- VS Code 1.95+ webview `localResourceRoots` pattern verified.

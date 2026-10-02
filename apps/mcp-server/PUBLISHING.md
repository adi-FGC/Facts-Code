# Publishing `factstack-mcp` (owner only)

Nothing in this repo publishes. Agents and CI stop at a green `smoke:bundle`. Every step below is the owner's.

## What gets published

`node scripts/assemble-publish.mjs` builds `apps/mcp-server/publish/` (gitignored):

| File                     | What it is                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`           | name `factstack-mcp`, bin `factstack-mcp` → `dist/server.js`, `engines.node >=24.3.0`, license copied from `apps/mcp-server/package.json`, no runtime dependencies, `"private": true` unless `--release` |
| `dist/server.js`         | One ESM file (esbuild, `scripts/bundle.mjs`): the server, every `@factstack/*` package it uses, and their npm dependencies. Only Node built-ins stay external.                                           |
| `README.md`              | This package's README without its `repo-only` blocks (clone commands, this file, source layout), with its `npm-only` blocks (the npx commands) shown                                                     |
| `THIRD_PARTY_NOTICES.md` | License texts of the npm packages inlined in the bundle (all MIT, BSD-3-Clause or ISC today)                                                                                                             |
| `LICENSE`                | Copied from `apps/mcp-server/LICENSE` once you add one                                                                                                                                                   |

`pnpm --filter @factstack/mcp-server build` writes the same bundle to `apps/mcp-server/dist/server.js`, so `node apps/mcp-server/dist/server.js --root <project>` works from a clone.

## Steps

1. **Reserve the names** on npm: `factstack-mcp` and `factstack` (the CLI), plus the `@factstack` scope. Both names return 404 today, so anyone could claim them.
2. **Settle the license.** `apps/mcp-server/package.json` says `UNLICENSED` (the repo default), and the publish folder copies it. Put the chosen SPDX id there and the license text in `apps/mcp-server/LICENSE`. `assemble-publish.mjs --release` refuses (and writes nothing) until both are in place.
3. **Set the version** in one place: `version` in `apps/mcp-server/package.json` (`changeset version` bumps it). `src/about.ts` imports it, so `--version`, the MCP `serverInfo` and the published `package.json` all print the same number.
4. **Flip the published flag** in the same change: `MCP_PUBLISHED = true` in `packages/spec/src/launch.ts`. That turns on the MCP's npx call-to-action everywhere (the login hint, the `.well-known/mcp.json` launch, the MCP line of `llms.txt`). The CLI keeps its own flag, `CLI_PUBLISHED`: flip it only when `factstack` is on npm too. The MCP, registry and site-kit tests follow the flags. Two tests outside this package pinned the unpublished state when this was written, `packages/spec/test/agent-additive.test.ts` (the flags themselves) and `apps/cli/test/cli-e2e.test.ts` (the installer's server note): if they still do, update them in the same change. Also update the "not on npm yet" lines in `README.md` (inside its `repo-only` blocks).
5. **Build and prove it** (from the repo root; nothing is published):

   ```bash
   node apps/mcp-server/scripts/assemble-publish.mjs --release
   node apps/mcp-server/scripts/smoke-bundle.mjs --pack
   ```

   The smoke copies the folder to a temp dir and, with plain `node`, runs `--version`, `--help`, a real stdio session (initialize, 17 tools, analyze a fixture, read a resource, query the graph) and `npm pack --dry-run`, then deletes the temp dir (`--keep` leaves it). **Check the last lines:** the first command must end with `assemble ok` and the second with `smoke ok`. No output means a script did not run; do not publish.

6. **Publish:** `cd apps/mcp-server/publish && npm publish` (with 2FA).
7. **Check it:** in an empty folder, `npx -y factstack-mcp --version`.

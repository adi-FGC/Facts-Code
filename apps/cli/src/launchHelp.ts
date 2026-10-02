/**
 * Option help that names an npx launch command. Whether it adds "not on npm
 * until it is published" follows the owner's publish flags in @factstack/spec
 * (MCP_PUBLISHED / CLI_PUBLISHED), like install's runtime mcpServerNote, so
 * flipping a flag on publish updates `--help` too (cli-r3-4). Each builder
 * takes the flag as a parameter so both branches are testable.
 */

import { CLI_PUBLISHED, MCP_NPX, MCP_PUBLISHED } from '@factstack/spec';
import { FRESHNESS_HOOK_COMMAND } from './agentHook.js';
import { GIT_HOOK_COMMAND } from './gitHook.js';

/** Why a hook command may need overriding while the CLI is unpublished. */
const CLI_UNPUBLISHED_HINT =
  '; the factstack package is not on npm until it is published, so self-hosting repos and local builds point this at their CLI';

/** `install --server-command`. */
export function serverCommandHelp(published: boolean = MCP_PUBLISHED): string {
  const unpublished = published
    ? ''
    : " — not on npm until the package is published; until then point it at a local build, e.g. 'node <repo>/apps/mcp-server/dist/server.js'";
  return `Override the MCP stdio launch command (default: \`${MCP_NPX}\`${unpublished}). First token is the command; quote any path containing spaces (e.g. 'node "C:\\Program Files\\factstack\\server.js"'). install appends \`--root <project>\` (absolute) so the server serves this project whatever directory the agent launches it from; a --root you give yourself must be absolute or a client variable such as \${workspaceFolder}.`;
}

/** `setup-agents --hook-command`. */
export function freshnessHookCommandHelp(published: boolean = CLI_PUBLISHED): string {
  return `Command the freshness hook runs after each edit (default \`${FRESHNESS_HOOK_COMMAND}\`, or FACTSTACK_HOOK_COMMAND${published ? '' : CLI_UNPUBLISHED_HINT}). Given, it replaces an earlier FACTS hook command; without it, a FACTS hook command you set up yourself is kept. A command that chains other logic (&&, ;, |) is never rewritten.`;
}

/** `hook --command`. */
export function gitHookCommandHelp(published: boolean = CLI_PUBLISHED): string {
  return `Analyze command the hook runs (default \`${GIT_HOOK_COMMAND}\`, or FACTSTACK_HOOK_COMMAND${published ? '' : CLI_UNPUBLISHED_HINT})`;
}

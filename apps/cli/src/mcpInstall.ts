/**
 * The MCP launch command `factstack install` registers, and what install says
 * about it. Split out of cli.ts so both sides of the owner's publish flag can
 * be tested without flipping it.
 */

import { DEFAULT_MCP_COMMAND, type McpServerCommand } from '@factstack/skills';
import {
  MCP_NPM_PACKAGE,
  MCP_NPX,
  MCP_PUBLISHED,
  rootArgOf,
  withoutRootArgs,
} from '@factstack/spec';

/** Honest flag while the MCP package name is unclaimed on npm. */
export const MCP_NOT_PUBLISHED_NOTE = `\`${MCP_NPX}\` needs the ${MCP_NPM_PACKAGE} package, which is not on npm yet — until it is published, pass --server-command 'node <repo>/apps/mcp-server/dist/server.js' (a local build: pnpm --filter @factstack/mcp-server build).`;

/**
 * Said beside the server command when the configs pin an absolute --root
 * (cli-r3-1): that path is this machine's — often under the user's home — so
 * a committed .mcp.json / .vscode/mcp.json points a teammate at a directory
 * they may not have, and each developer's install rewrites it. Undefined
 * when nothing was registered, or the root is a client variable such as
 * `${workspaceFolder}` (given through --server-command), which travels.
 */
export function mcpPortabilityNote(
  registered: McpServerCommand,
  configs: readonly string[],
): string | undefined {
  const root = rootArgOf(registered.args);
  if (!configs.length || root === undefined || root.startsWith('${')) return undefined;
  const one = configs.length === 1;
  return `${configs.join(', ')} ${one ? 'pins' : 'pin'} --root to this machine's path — if you commit ${one ? 'it' : 'them'}, each teammate re-runs \`factstack install\` (Cursor and VS Code configs can take \`--root \${workspaceFolder}\` through --server-command instead).`;
}

/** True for the default `npx -y factstack-mcp` launch, pinned or not: the
 *  `server command:` line install prints (with `--root <project>`) pasted
 *  back into --server-command is still the unpublished npx launch (cli-r3-3).
 *  Root args are stripped with @factstack/spec's grammar, the one the MCP
 *  server reads. */
export function isDefaultMcpCommand(server: McpServerCommand): boolean {
  const args = withoutRootArgs(server.args);
  return (
    server.command === DEFAULT_MCP_COMMAND.command &&
    args.length === DEFAULT_MCP_COMMAND.args.length &&
    args.every((a, i) => a === DEFAULT_MCP_COMMAND.args[i])
  );
}

/**
 * The note printed beside the server command: the not-on-npm flag while the
 * default npx launch cannot resolve yet, nothing once the owner flips
 * MCP_PUBLISHED on publish, and nothing for a `--server-command` override.
 */
export function mcpServerNote(
  server: McpServerCommand,
  published: boolean = MCP_PUBLISHED,
): string | undefined {
  return !published && isDefaultMcpCommand(server) ? MCP_NOT_PUBLISHED_NOTE : undefined;
}

/** One argument as parseServerCommand reads it back: bare when it has no
 *  whitespace or quotes, else quoted (single quotes when it holds a `"`). */
function quoteArg(a: string): string {
  if (a !== '' && !/[\s"']/.test(a)) return a;
  return a.includes('"') ? `'${a}'` : `"${a}"`;
}

/** A launch command as one line a user can paste into --server-command —
 *  the pinned `--root` is often a path with spaces. */
export function formatServerCommand(server: McpServerCommand): string {
  return [server.command, ...server.args].map(quoteArg).join(' ');
}

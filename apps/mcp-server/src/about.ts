/**
 * What the bin prints for `--version` and `--help`. Pure, so it is testable
 * without spawning the server.
 *
 * `MCP_PACKAGE_VERSION` IS `version` in apps/mcp-server/package.json, the one
 * number (`changeset version` bumps it): `--version`, the MCP serverInfo and
 * the published manifest (scripts/assemble-publish.mjs) all read it. esbuild
 * inlines the JSON into the bundle, so nothing is read from disk at runtime.
 */
import { MCP_NPM_PACKAGE } from '@factstack/spec';
import pkg from '../package.json' with { type: 'json' };

export const MCP_PACKAGE_VERSION: string = pkg.version;

export function usageText(): string {
  const bin = MCP_NPM_PACKAGE;
  return [
    `${bin} ${MCP_PACKAGE_VERSION}: the FACTS Model Context Protocol server (stdio)`,
    '',
    'An MCP client (Claude Code, Cursor, Codex, ...) starts this program and talks',
    'JSON-RPC to it over stdin/stdout.',
    '',
    'Usage:',
    `  ${bin} [--root <dir>]   serve one project over stdio`,
    `  ${bin} login            optional Google sign-in (cloud sync of learnings only)`,
    `  ${bin} --version        print the version`,
    `  ${bin} --help           print this help`,
    '',
    'Options:',
    '  -r, --root <dir>   the project to analyze. Default: the nearest folder with',
    '                     .git (else package.json) at or above the working',
    '                     directory. A home directory or filesystem root is refused.',
    '',
    'Environment:',
    '  FACTS_ROOT       same as --root',
    '  FACTS_HOME       where the optional sign-in is kept (default ~/.factstack)',
    '  FACTS_AUTH_URL   override the sign-in page',
    '',
    'Every tool works signed out. The network is used only by the optional cloud',
    'sync and by list_vulnerabilities with refresh:true (OSV.dev).',
  ].join('\n');
}

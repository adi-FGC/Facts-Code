#!/usr/bin/env node
/**
 * FACTS Model Context Protocol server — the stdio bin.
 *
 * All resources + tools live in `create-server.ts` (testable in-process);
 * this file only resolves the project root, handles `login`, and connects
 * stdio. Nothing is analyzed before the handshake, so the client's
 * `initialize` is answered at once on any repo size; the boot analyze starts
 * after `initialized`, in the background, and a failing one is logged, never fatal.
 *
 *   factstack-mcp [--root <dir>]     serve the project over stdio
 *   factstack-mcp login              optional Google sign-in (cloud sync of learnings)
 *   factstack-mcp --version | --help print and exit (never starts the server)
 *
 * Published as ONE bundled file (scripts/bundle.mjs, see PUBLISHING.md), so
 * nothing here may read files that sit next to the source at runtime.
 *
 * Removed in v0.3.9: `reanalyze_file` — a deprecated stub that silently ran a
 * full re-analyze regardless of `path`. Use `analyze`.
 */

import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFactsMcpServer } from './create-server.js';
import { loadSession, login, loginHint } from './auth.js';
import { parseServerArgs, resolveProjectRoot } from './paths.js';
import { MCP_PACKAGE_VERSION, usageText } from './about.js';

const log = (line: string) => process.stderr.write(`[factstack-mcp] ${line}\n`);

async function main() {
  const args = parseServerArgs(process.argv.slice(2));

  // stdout is the JSON-RPC channel only when serving; these print and return.
  if (args.help) {
    process.stdout.write(`${usageText()}\n`);
    return;
  }
  if (args.version) {
    process.stdout.write(`${MCP_PACKAGE_VERSION}\n`);
    return;
  }

  // `factstack-mcp login` — optional one-time Google sign-in (loopback), then exit.
  if (args.login) {
    try {
      const s = await login();
      log(`signed in as ${s.email ?? s.uid}. Learnings now also sync to your private account.`);
      process.exit(0);
    } catch (e) {
      log(`login failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  const resolved = resolveProjectRoot({
    argRoot: args.root,
    envRoot: process.env.FACTS_ROOT,
    cwd: process.cwd(),
    home: homedir(),
  });
  if (resolved.error) log(resolved.error);
  else log(`project root: ${resolved.root}`);
  // Local file check only — no network at boot.
  if (!loadSession()) log(`cloud sync: off. ${loginHint()}`);

  const facts = createFactsMcpServer({
    root: resolved.root,
    rootError: resolved.error,
    log,
  });
  await facts.connect(new StdioServerTransport());
  log('listening on stdio');
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

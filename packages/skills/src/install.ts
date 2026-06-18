/**
 * F12 — distribution: the PURE half of `factstack install`.
 *
 * One command wires FACTS into a coding agent: instruction files (the existing
 * renderers) + MCP server registration in the agent's config file. This module
 * builds the CONTENT — which skill formats each agent needs, which config file
 * to touch, and the merged JSON — while the CLI does the I/O (read existing
 * file → merge here → write back). Keeping the merge pure makes idempotency
 * and preservation testable without a filesystem.
 *
 * Design rules:
 *   - NEVER clobber: merges preserve every unrelated key in an existing config
 *     (a user's other MCP servers, editor settings, comments are the one thing
 *     we can't keep — JSON has none).
 *   - IDEMPOTENT: re-installing with the same server definition reports
 *     `changed: false` so the CLI can say "already installed".
 *   - HONEST FAILURE: an unparseable existing config returns `ok: false`
 *     instead of overwriting a file the user hand-edited.
 */

import type { SkillFormatId } from './types.js';

/** Agents the installer knows how to wire end-to-end. */
export const INSTALL_AGENTS = ['claude', 'cursor', 'copilot'] as const;
export type InstallAgent = (typeof INSTALL_AGENTS)[number];

/** The stdio command an agent should launch for the FACTS MCP server. The CLI
 *  decides the concrete command (published bin vs local dist) — the pure layer
 *  only shapes it into each agent's config format. */
export interface McpServerCommand {
  command: string;
  args: string[];
}

/** Default for a published install: `npx -y factstack-mcp` resolves the bin
 *  shipped by the mcp-server package. The CLI may override (e.g. a local
 *  `node <repo>/apps/mcp-server/dist/server.js` during development). */
export const DEFAULT_MCP_COMMAND: McpServerCommand = {
  command: 'npx',
  args: ['-y', 'factstack-mcp'],
};

/** Key under which FACTS registers in every agent's MCP config. */
export const MCP_SERVER_KEY = 'factstack';

export interface InstallTarget {
  agent: InstallAgent;
  /** Skill formats the agent reads (paths come from each renderer). */
  skillFormats: SkillFormatId[];
  /** Project-relative path of the agent's MCP config file. */
  mcpConfigPath: string;
  /** Human-readable note about where the instruction files land. */
  instructionNote: string;
  /** True when the agent supports FACTS's hook-based freshness/nudge layer
   *  (only Claude Code today); others rely on the instruction file alone. */
  supportsHooks: boolean;
}

/** What `install --agent X` touches, per agent. The `agents` format (AGENTS.md)
 *  rides along with claude — it's the cross-agent fallback file that Claude
 *  Code, Codex, and others all read. */
export const INSTALL_TARGETS: Record<InstallAgent, InstallTarget> = {
  claude: {
    agent: 'claude',
    skillFormats: ['claude', 'agents'],
    mcpConfigPath: '.mcp.json',
    instructionNote: '.claude/skills/factstack-project/SKILL.md + AGENTS.md',
    supportsHooks: true,
  },
  cursor: {
    agent: 'cursor',
    skillFormats: ['cursor'],
    mcpConfigPath: '.cursor/mcp.json',
    instructionNote: '.cursorrules',
    supportsHooks: false,
  },
  copilot: {
    agent: 'copilot',
    skillFormats: ['copilot'],
    mcpConfigPath: '.vscode/mcp.json',
    instructionNote: '.github/copilot-instructions.md',
    supportsHooks: false,
  },
};

export type MergeResult =
  | { ok: true; content: string; changed: boolean }
  | { ok: false; reason: string };

/**
 * Tokenize a `--server-command` string into command + args, honoring single
 * and double quotes so paths with spaces survive intact:
 * `node "C:\Program Files\factstack\server.js"` → command `node`, one arg.
 * A naive whitespace split would shred that path into broken tokens. Returns
 * null on an empty string or an unterminated quote (caller errors out).
 */
export function parseServerCommand(raw: string): McpServerCommand | null {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let quoted = false; // a quoted-empty token ("") still counts as a token
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || quoted) { tokens.push(cur); cur = ''; quoted = false; }
      continue;
    }
    cur += ch;
  }
  if (quote) return null; // unterminated quote
  if (cur || quoted) tokens.push(cur);
  if (!tokens.length || !tokens[0]) return null;
  return { command: tokens[0], args: tokens.slice(1) };
}

/** Parse a config that may not exist yet; {} when absent/blank. */
function parseExisting(existing: string | null): Record<string, unknown> | null {
  if (existing === null || existing.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The server entry in each agent's native shape. Claude Code + Cursor share
 *  the `mcpServers` map; VS Code (Copilot) uses `servers` with an explicit
 *  `type: "stdio"`. */
function serverEntry(agent: InstallAgent, server: McpServerCommand): Record<string, unknown> {
  return agent === 'copilot'
    ? { type: 'stdio', command: server.command, args: server.args }
    : { command: server.command, args: server.args };
}

function configRootKey(agent: InstallAgent): string {
  return agent === 'copilot' ? 'servers' : 'mcpServers';
}

/**
 * Merge the FACTS MCP server into an agent config. Preserves every unrelated
 * key + every other registered server; idempotent (`changed: false` when the
 * entry already matches byte-for-byte after normalization).
 */
export function mergeMcpConfig(
  agent: InstallAgent,
  existing: string | null,
  server: McpServerCommand = DEFAULT_MCP_COMMAND,
): MergeResult {
  const root = parseExisting(existing);
  if (root === null) {
    return { ok: false, reason: `existing ${INSTALL_TARGETS[agent].mcpConfigPath} is not a JSON object — fix or remove it, then re-run (refusing to overwrite a hand-edited file)` };
  }
  const key = configRootKey(agent);
  // A PRESENT but non-object "${key}" (array, string, …) is a hand-edited file
  // we don't understand — refusing beats silently replacing it (never clobber).
  if (root[key] !== undefined && (typeof root[key] !== 'object' || root[key] === null || Array.isArray(root[key]))) {
    return { ok: false, reason: `existing ${INSTALL_TARGETS[agent].mcpConfigPath} has a non-object "${key}" — fix it manually, then re-run (refusing to overwrite)` };
  }
  const servers = (root[key] as Record<string, unknown> | undefined) ?? {};
  const next = serverEntry(agent, server);
  const changed = JSON.stringify(servers[MCP_SERVER_KEY]) !== JSON.stringify(next);
  const merged = { ...root, [key]: { ...servers, [MCP_SERVER_KEY]: next } };
  return { ok: true, content: JSON.stringify(merged, null, 2) + '\n', changed };
}

/**
 * Remove the FACTS server entry from an agent config (the uninstall path).
 * Leaves everything else untouched; `changed: false` when FACTS wasn't
 * registered. A config that becomes `{ mcpServers: {} }` is left as such —
 * deleting the user's file outright is the CLI's call, not the merger's.
 */
export function removeMcpConfig(agent: InstallAgent, existing: string | null): MergeResult {
  const root = parseExisting(existing);
  if (root === null) {
    return { ok: false, reason: `existing ${INSTALL_TARGETS[agent].mcpConfigPath} is not a JSON object — nothing removed` };
  }
  const key = configRootKey(agent);
  if (root[key] !== undefined && (typeof root[key] !== 'object' || root[key] === null || Array.isArray(root[key]))) {
    return { ok: false, reason: `existing ${INSTALL_TARGETS[agent].mcpConfigPath} has a non-object "${key}" — nothing removed` };
  }
  const servers = { ...((root[key] as Record<string, unknown> | undefined) ?? {}) };
  if (!(MCP_SERVER_KEY in servers)) {
    return { ok: true, content: JSON.stringify(root, null, 2) + '\n', changed: false };
  }
  delete servers[MCP_SERVER_KEY];
  const merged = { ...root, [key]: servers };
  return { ok: true, content: JSON.stringify(merged, null, 2) + '\n', changed: true };
}

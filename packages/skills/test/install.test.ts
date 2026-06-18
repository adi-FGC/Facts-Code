import { describe, expect, it } from 'vitest';
import {
  mergeMcpConfig,
  removeMcpConfig,
  parseServerCommand,
  INSTALL_TARGETS,
  INSTALL_AGENTS,
  DEFAULT_MCP_COMMAND,
} from '../src/install.js';

/**
 * F12 — the pure MCP-config merger behind `factstack install`. The contract:
 * never clobber unrelated config, idempotent re-install, honest failure on a
 * hand-edited file we can't parse.
 */

describe('mergeMcpConfig (F12)', () => {
  it('creates a fresh config in each agent\'s native shape', () => {
    const claude = mergeMcpConfig('claude', null);
    expect(claude.ok && JSON.parse(claude.content)).toEqual({
      mcpServers: { factstack: { command: 'npx', args: ['-y', 'factstack-mcp'] } },
    });
    const copilot = mergeMcpConfig('copilot', null);
    expect(copilot.ok && JSON.parse(copilot.content)).toEqual({
      servers: { factstack: { type: 'stdio', command: 'npx', args: ['-y', 'factstack-mcp'] } },
    });
  });

  it('preserves other servers + unrelated keys', () => {
    const existing = JSON.stringify({
      mcpServers: { github: { command: 'gh-mcp', args: [] } },
      somethingElse: { keep: true },
    });
    const r = mergeMcpConfig('claude', existing);
    if (!r.ok) throw new Error(r.reason);
    const parsed = JSON.parse(r.content);
    expect(parsed.mcpServers.github).toEqual({ command: 'gh-mcp', args: [] });
    expect(parsed.somethingElse).toEqual({ keep: true });
    expect(parsed.mcpServers.factstack).toBeDefined();
  });

  it('is idempotent — re-merging the same server reports changed:false', () => {
    const first = mergeMcpConfig('cursor', null);
    if (!first.ok) throw new Error(first.reason);
    expect(first.changed).toBe(true);
    const second = mergeMcpConfig('cursor', first.content);
    if (!second.ok) throw new Error(second.reason);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('updates an existing entry when the command changes (changed:true)', () => {
    const first = mergeMcpConfig('claude', null);
    if (!first.ok) throw new Error(first.reason);
    const r = mergeMcpConfig('claude', first.content, { command: 'node', args: ['dist/server.js'] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.changed).toBe(true);
    expect(JSON.parse(r.content).mcpServers.factstack.command).toBe('node');
  });

  it('refuses to overwrite an unparseable file (honest failure)', () => {
    const r = mergeMcpConfig('claude', '{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('.mcp.json');
  });

  it('treats a blank/whitespace file as fresh', () => {
    const r = mergeMcpConfig('claude', '  \n');
    expect(r.ok && JSON.parse(r.content).mcpServers.factstack).toBeTruthy();
  });

  it('refuses a non-object mcpServers instead of clobbering it (review fix)', () => {
    // An array-valued mcpServers is a hand-edited shape we don't understand —
    // overwriting it would silently destroy the user's servers.
    const r = mergeMcpConfig('claude', JSON.stringify({ mcpServers: [{ name: 'github' }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('mcpServers');
    const remove = removeMcpConfig('claude', JSON.stringify({ mcpServers: 'oops' }));
    expect(remove.ok).toBe(false);
  });
});

describe('parseServerCommand (F12 — review fix)', () => {
  it('splits plain commands on whitespace', () => {
    expect(parseServerCommand('npx -y factstack-mcp')).toEqual({ command: 'npx', args: ['-y', 'factstack-mcp'] });
  });

  it('preserves quoted paths containing spaces', () => {
    expect(parseServerCommand('node "C:\\Program Files\\factstack\\server.js" --flag')).toEqual({
      command: 'node',
      args: ['C:\\Program Files\\factstack\\server.js', '--flag'],
    });
  });

  it('handles single quotes too', () => {
    expect(parseServerCommand("node '/home/u/my tools/server.js'")).toEqual({
      command: 'node',
      args: ['/home/u/my tools/server.js'],
    });
  });

  it('returns null on an unterminated quote or empty input', () => {
    expect(parseServerCommand('node "broken')).toBeNull();
    expect(parseServerCommand('   ')).toBeNull();
  });
});

describe('removeMcpConfig (F12 uninstall)', () => {
  it('removes only the factstack entry', () => {
    const installed = mergeMcpConfig('claude', JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: [] } } }));
    if (!installed.ok) throw new Error(installed.reason);
    const r = removeMcpConfig('claude', installed.content);
    if (!r.ok) throw new Error(r.reason);
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.mcpServers.factstack).toBeUndefined();
    expect(parsed.mcpServers.github).toBeDefined();
  });

  it('reports changed:false when factstack was never registered', () => {
    const r = removeMcpConfig('cursor', JSON.stringify({ mcpServers: {} }));
    expect(r.ok && !r.changed).toBe(true);
  });
});

describe('install targets (F12)', () => {
  it('every agent maps to skill formats + a config path', () => {
    for (const a of INSTALL_AGENTS) {
      const t = INSTALL_TARGETS[a];
      expect(t.skillFormats.length).toBeGreaterThan(0);
      expect(t.mcpConfigPath.endsWith('.json')).toBe(true);
    }
  });

  it('default command targets the published mcp-server bin', () => {
    expect(DEFAULT_MCP_COMMAND.args).toContain('factstack-mcp');
  });
});

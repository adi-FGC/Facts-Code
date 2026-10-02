import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_NPM_PACKAGE, MCP_NPX, rootArgOf } from '@factstack/spec';
import {
  mergeMcpConfig,
  removeMcpConfig,
  parseServerCommand,
  INSTALL_TARGETS,
  INSTALL_AGENTS,
  DEFAULT_MCP_COMMAND,
  withProjectRoot,
} from '../src/install.js';

/**
 * F12 — the pure MCP-config merger behind `factstack install`. The contract:
 * never clobber unrelated config, idempotent re-install, honest failure on a
 * hand-edited file we can't parse.
 */

describe('mergeMcpConfig (F12)', () => {
  it("creates a fresh config in each agent's native shape", () => {
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
    const r = mergeMcpConfig('claude', first.content, {
      command: 'node',
      args: ['dist/server.js'],
    });
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
    expect(parseServerCommand('npx -y factstack-mcp')).toEqual({
      command: 'npx',
      args: ['-y', 'factstack-mcp'],
    });
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
    const installed = mergeMcpConfig(
      'claude',
      JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: [] } } }),
    );
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

describe('project root pinning (ux#8)', () => {
  /* The MCP server no longer analyzes an arbitrary client cwd, so an
     installed config names its project with --root. */
  const win = 'D:\\work\\my project\\proj';

  it('appends --root <abs root> after the MCP_NPX args, in every agent shape', () => {
    const claude = mergeMcpConfig('claude', null, DEFAULT_MCP_COMMAND, '/home/u/proj');
    expect(claude.ok && JSON.parse(claude.content).mcpServers.factstack).toEqual({
      command: 'npx',
      args: ['-y', 'factstack-mcp', '--root', '/home/u/proj'],
    });
    const copilot = mergeMcpConfig('copilot', null, DEFAULT_MCP_COMMAND, win);
    expect(copilot.ok && JSON.parse(copilot.content).servers.factstack).toEqual({
      type: 'stdio',
      command: 'npx',
      // A path with spaces stays ONE arg (no shell in between).
      args: ['-y', 'factstack-mcp', '--root', win],
    });
  });

  it('is idempotent with a root, and upgrades a config written before --root', () => {
    const before = mergeMcpConfig('cursor', null);
    if (!before.ok) throw new Error(before.reason);
    const pinned = mergeMcpConfig('cursor', before.content, DEFAULT_MCP_COMMAND, win);
    if (!pinned.ok) throw new Error(pinned.reason);
    expect(pinned.changed).toBe(true);
    const again = mergeMcpConfig('cursor', pinned.content, DEFAULT_MCP_COMMAND, win);
    expect(again.ok && again.changed).toBe(false);
  });

  it('keeps a root the --server-command already names', () => {
    for (const cmd of [
      'node dist/server.js --root /x',
      'node dist/server.js -r /x',
      'node dist/server.js --root=/x',
    ]) {
      const server = parseServerCommand(cmd)!;
      expect(withProjectRoot(server, '/y'), cmd).toEqual(server);
    }
    // A dangling flag names nothing (the server ignores it), so the root is added.
    expect(withProjectRoot({ command: 'node', args: ['s.js', '--root='] }, '/y')?.args).toEqual([
      's.js',
      '--root=',
      '--root',
      '/y',
    ]);
  });

  it('a trailing --root / -r with no value does not swallow the pinned root (mcp-1)', () => {
    /* Appended after a bare trailing flag, `--root /y` would be read as the
       flag's value: the server would get the root "--root". */
    for (const flag of ['--root', '-r']) {
      const pinned = withProjectRoot({ command: 'node', args: ['s.js', flag] }, '/y');
      expect(pinned?.args, flag).toEqual(['s.js', '--root', '/y']);
      expect(rootArgOf(pinned!.args), flag).toBe('/y');
    }
  });

  it('the root it pins is the one the MCP server reads (shared @factstack/spec grammar)', () => {
    for (const cmd of ['node s.js', 'node s.js --root=', 'node s.js -v', 'npx -y factstack-mcp']) {
      const pinned = withProjectRoot(parseServerCommand(cmd)!, '/y')!;
      expect(rootArgOf(pinned.args), cmd).toBe('/y');
    }
  });

  it('refuses a relative root instead of writing one the client would resolve', () => {
    const r = mergeMcpConfig('claude', null, DEFAULT_MCP_COMMAND, 'proj');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/);
    expect(withProjectRoot(DEFAULT_MCP_COMMAND, './proj')).toBeNull();
    for (const abs of ['/p', 'C:\\p', 'c:/p', '\\\\host\\share\\p']) {
      expect(withProjectRoot(DEFAULT_MCP_COMMAND, abs), abs).not.toBeNull();
    }
  });

  it('refuses a relative --root the --server-command names, as it does a relative root (BFS2-5)', () => {
    for (const cmd of [
      'node s.js --root .',
      'node s.js -r ../x',
      'node s.js --root=proj',
      'node s.js --root C:proj', // drive-relative: still the client's cwd on that drive
      // The server reads the LAST root, so a relative one after an absolute one wins.
      'node s.js --root /abs --root .',
    ]) {
      const server = parseServerCommand(cmd)!;
      expect(withProjectRoot(server, '/y'), cmd).toBeNull();
      const r = mergeMcpConfig('claude', null, server, '/y');
      expect(r.ok, cmd).toBe(false);
      if (!r.ok) expect(r.reason, cmd).toMatch(/--root ".*" is not an absolute path/);
    }
  });

  it('keeps an absolute last --root or a client variable, and pins when the last --root= is empty', () => {
    for (const cmd of [
      'node s.js --root . --root /abs', // the server reads /abs
      'node s.js --root ${workspaceFolder}', // VS Code / Cursor expand it before launch
    ]) {
      const server = parseServerCommand(cmd)!;
      expect(withProjectRoot(server, '/y'), cmd).toEqual(server);
    }
    // `--root=` after a root clears it at the server, so install still pins one.
    expect(
      withProjectRoot({ command: 'node', args: ['s.js', '--root', '/x', '--root='] }, '/y')?.args,
    ).toEqual(['s.js', '--root', '/x', '--root=', '--root', '/y']);
  });

  it('writes a --server-command as given when no project root is passed (no pinning)', () => {
    const server = parseServerCommand('node s.js --root .')!;
    const r = mergeMcpConfig('claude', null, server);
    expect(r.ok && JSON.parse(r.content).mcpServers.factstack.args).toEqual([
      's.js',
      '--root',
      '.',
    ]);
  });
});

describe('launch name (ux#6 — owner decision 2026-09-24)', () => {
  it('the default MCP command IS MCP_NPX from @factstack/spec', () => {
    expect([DEFAULT_MCP_COMMAND.command, ...DEFAULT_MCP_COMMAND.args].join(' ')).toBe(MCP_NPX);
    expect(DEFAULT_MCP_COMMAND.args).toContain(MCP_NPM_PACKAGE);
  });

  /* The "not on npm yet" note is gated on MCP_PUBLISHED in one place, the
     CLI's mcpServerNote (apps/cli/test/modules.test.ts) — skills keeps no
     second copy of that gate (BFS3-R2). */
  it('exports no second MCP_PUBLISHED gate', async () => {
    const mod: Record<string, unknown> = await import('../src/index.js');
    expect(mod).not.toHaveProperty('isUnpublishedDefaultMcp');
  });

  it('no skills source spells a package name of its own', () => {
    /* Three spellings had drifted apart (factstack-mcp, @factstack/mcp-server,
       @factstack/cli). Every command must derive from the spec constants. */
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    expect(sources.length).toBeGreaterThan(5);
    for (const f of sources) {
      const code = readFileSync(join(dir, f), 'utf8');
      expect(code, f).not.toMatch(/['"`]factstack-mcp['"`]/);
      expect(code, f).not.toMatch(/@factstack\/(mcp-server|cli)\b/);
    }
  });
});

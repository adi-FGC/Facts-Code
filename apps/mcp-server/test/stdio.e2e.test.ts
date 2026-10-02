/**
 * End-to-end over real stdio: spawns `src/server.ts` (via tsx) exactly as an
 * MCP client would, with an EMPTY sign-in home. Covers the bin wiring the
 * in-process tests can't: argv/root resolution, default auth, default
 * analyzer (git mining + parse cache), connect-before-analyze.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveProjectRoot } from '../src/paths.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PKG, 'src', 'server.ts');
// Absolute loader URL: `--import tsx` would resolve from the spawned cwd.
const TSX = pathToFileURL(path.join(PKG, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

async function spawnServer(cwd: string, extraArgs: string[]) {
  const home = mkdtempSync(path.join(tmpdir(), 'facts-e2e-home-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX, SERVER, ...extraArgs],
    cwd,
    env: {
      ...(process.env as Record<string, string>),
      FACTS_HOME: path.join(home, '.factstack'), // no auth.json → signed out
      FACTS_ROOT: '',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
  return client;
}

type ToolReply = Awaited<ReturnType<Client['callTool']>>;
const text = (r: ToolReply) => (r.content as Array<{ text: string }>)[0]!.text;

describe('stdio bin', () => {
  it('signed out, --root given: analyze and resources work', { timeout: 90_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'facts-e2e-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'package.json'), '{"name":"e2e"}');
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const client = await spawnServer(PKG, ['--root', root]);
    try {
      const r = await client.callTool({ name: 'analyze', arguments: {} });
      expect(r.isError, text(r)).toBeFalsy();
      expect(JSON.parse(text(r)).ok).toBe(true);
      const res = await client.readResource({ uri: 'facts://project' });
      expect((res.contents[0] as { text: string }).text).toContain('"fileCount"');
      expect(existsSync(path.join(root, '.facts', 'agent.json'))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it(
    'no --root from a non-project cwd: no writes there, tools explain',
    { timeout: 90_000 },
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'facts-e2e-cwd-'));
      writeFileSync(path.join(cwd, 'notes.ts'), 'export const x = 1;\n');
      const client = await spawnServer(cwd, []);
      try {
        const tools = await client.listTools();
        expect(tools.tools.length).toBe(17);
        // Only call analyze when the server must refuse: on a machine whose temp
        // dir sits under some project, that project would be analyzed instead.
        if (resolveProjectRoot({ cwd, home: homedir() }).error) {
          const r = await client.callTool({ name: 'analyze', arguments: {} });
          expect(r.isError).toBe(true);
          expect(text(r)).toMatch(/--root/);
        }
        expect(existsSync(path.join(cwd, '.facts'))).toBe(false);
        expect(existsSync(path.join(cwd, '.gitignore'))).toBe(false);
      } finally {
        await client.close();
      }
    },
  );
});

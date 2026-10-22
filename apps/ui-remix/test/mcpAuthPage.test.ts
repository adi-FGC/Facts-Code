/**
 * SEC-1 — the public /mcp-auth page is the one site surface that names a
 * command for a visitor to run. It told them `npx -y factstack-mcp login`
 * while that npm name was unclaimed (spec's MCP_PUBLISHED is false), and
 * `npx -y` on an unclaimed name runs whatever package claims it, unprompted
 * (MCP-R4). The page is a plain public script, so it can't import the flag;
 * this guard holds it to the flag instead: the clone launch (the registry's
 * `mcp.cloneLaunchCommand` + `login`, same as the MCP's own SIGN_IN_COMMAND)
 * until publish, and the npx form only after it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSiteRegistry } from '@factstack/registry';
import { MCP_NPM_PACKAGE, MCP_NPX, MCP_PUBLISHED } from '@factstack/spec';

const PAGE = readFileSync(fileURLToPath(new URL('../public/mcp-auth.js', import.meta.url)), 'utf8');
const { cloneLaunchCommand } = buildSiteRegistry({
  version: '0.0.0',
  generatedAt: '2026-01-01T00:00:00.000Z',
}).mcp;
const CLONE_SIGN_IN = [cloneLaunchCommand.command, ...cloneLaunchCommand.args, 'login'].join(' ');
const NPX_SIGN_IN = `${MCP_NPX} login`;

describe('/mcp-auth sign-in hint', () => {
  it('offers the sign-in command that runs today', () => {
    const today = MCP_PUBLISHED ? NPX_SIGN_IN : CLONE_SIGN_IN;
    expect(PAGE).toContain(`const SIGN_IN_COMMAND = '${today}';`);
  });

  it.runIf(!MCP_PUBLISHED)('never offers npx on the unpublished package name', () => {
    expect(PAGE).not.toContain(MCP_NPX);
    expect(PAGE).not.toMatch(new RegExp(`npx\\s+(?:-y\\s+|--yes\\s+)?${MCP_NPM_PACKAGE}\\b`));
  });
});

/* The sign-in hands a long-lived refresh token to the local MCP. getAuth()
   also persisted it in this origin's IndexedDB, readable by any script on
   the site long after the tab closed. */
describe('/mcp-auth keeps the Firebase session in memory', () => {
  const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('initializes auth with in-memory persistence, never getAuth', () => {
    expect(CODE).toMatch(/initializeAuth\([\s\S]{0,80}?\{\s*persistence:\s*inMemoryPersistence,/);
    expect(CODE).toMatch(/popupRedirectResolver:\s*browserPopupRedirectResolver/);
    expect(CODE).not.toMatch(/\bgetAuth\b/);
    expect(CODE).not.toMatch(/\b(?:browserLocal|indexedDBLocal|browserSession)Persistence\b/);
  });

  it('deletes the session an earlier version persisted', () => {
    expect(CODE).toContain("indexedDB.deleteDatabase('firebaseLocalStorageDb')");
    expect(CODE).toMatch(/key\.startsWith\('firebase:'\)\)\s*localStorage\.removeItem\(key\)/);
  });
});

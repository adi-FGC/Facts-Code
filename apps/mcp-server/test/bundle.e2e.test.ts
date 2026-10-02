/**
 * The npm package folder (deploy-infra#7). Assembles it into a temp dir, then
 * runs the single-file bundle with plain `node` from ANOTHER temp dir (no
 * workspace package can resolve there): --version, --help, a real stdio MCP
 * session, and `npm pack --dry-run`. Nothing is ever published.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MCP_NPM_PACKAGE } from '@factstack/spec';
import { MCP_PACKAGE_VERSION } from '../src/about.js';
import {
  BIN_PATH,
  PUBLISH_NAME,
  assemble,
  npmReadme,
  publishManifest,
} from '../scripts/assemble-publish.mjs';
import { smokeBundle } from '../scripts/smoke-bundle.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));

/** The report smokeBundle returns. The script fills it in field by field, so
 *  its JS-inferred type is only `{ tempDir }`. version, helpFirstLine and
 *  session are always set on return (every failed check throws first);
 *  `pack` only when called with pack: true. */
interface SmokeReport {
  tempDir: string;
  version: string;
  helpFirstLine: string;
  session: { tools: number; files: number; callersOfB: number };
  pack?: { name: string; version: string; files: string[]; unpackedSize: number };
}

/* Every temp dir this file makes is removed (each run is ~3.7 MB). */
const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe('publish manifest', () => {
  it('is the one npx name, with the bin, Node floor and license the owner set', () => {
    const m = publishManifest(pkg);
    expect(PUBLISH_NAME).toBe(MCP_NPM_PACKAGE);
    expect(m.name).toBe(MCP_NPM_PACKAGE);
    expect(m.bin).toEqual({ [MCP_NPM_PACKAGE]: BIN_PATH });
    expect(m.engines).toEqual({ node: '>=24.3.0' });
    expect(m.license).toBe(pkg.license);
    expect(m.dependencies).toBeUndefined(); // everything is inlined
    // Guarded until the owner assembles a release on purpose.
    expect(m.private).toBe(true);
    expect(publishManifest(pkg, { release: true }).private).toBeUndefined();
    // The workspace bin (`node apps/mcp-server/dist/server.js`) is the same file.
    expect(pkg.bin[MCP_NPM_PACKAGE]).toBe(`./${BIN_PATH}`);
  });

  it('--version prints the package.json version', () => {
    // src/about.ts imports it: one number, so `changeset version` can't split it.
    expect(MCP_PACKAGE_VERSION).toBe(pkg.version);
    expect(publishManifest(pkg).version).toBe(pkg.version);
  });
});

describe('the bundle (deploy-infra#7)', () => {
  it(
    'runs on plain node from a temp dir: --version, --help, a stdio session, npm pack',
    { timeout: 180_000 },
    async () => {
      const out = mkdtempSync(path.join(tmpdir(), 'factstack-mcp-publish-'));
      made.push(out);
      const r = await assemble({ outDir: out });
      expect(r.bundle.external.filter((id: string) => !isBuiltin(id))).toEqual([]);
      const code = readFileSync(path.join(out, BIN_PATH), 'utf8');
      expect(code.startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect(code.match(/^#!/gm)).toHaveLength(1);
      // about.ts's package.json import inlines the version only, not the workspace manifest.
      expect(code).toContain(`var package_default = { version: "${pkg.version}" };`);
      expect(code).not.toContain('"@factstack/mcp-server"');
      expect(readFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain(
        '## @modelcontextprotocol/sdk@',
      );
      // The npm README, not the repo one (mcp-pkg-7).
      expect(readFileSync(path.join(out, 'README.md'), 'utf8')).toBe(
        npmReadme(readFileSync(path.join(PKG, 'README.md'), 'utf8')),
      );

      const report = (await smokeBundle({
        publishDir: out,
        pack: true,
        log: () => undefined,
      })) as SmokeReport;
      made.push(report.tempDir);
      // The smoke cleans up after itself (mcp-pkg-6).
      expect(existsSync(report.tempDir)).toBe(false);
      expect(report.version).toBe(MCP_PACKAGE_VERSION);
      expect(report.helpFirstLine).toMatch(/^factstack-mcp /);
      expect(report.session).toMatchObject({ tools: 17, callersOfB: 1 });
      expect(report.session.files).toBeGreaterThanOrEqual(3);
      // Only the bundle, the docs and the manifest (+ LICENSE once the owner adds one).
      expect(r.manifest.files).toEqual(
        expect.arrayContaining([BIN_PATH, 'README.md', 'THIRD_PARTY_NOTICES.md']),
      );
      expect(report.pack?.files).toEqual(['package.json', ...r.manifest.files].sort());
    },
  );
});

/**
 * scripts/lib/third-party-licenses.mjs — the one license policy for the two
 * single-file npm bundles (mcp-3). The CLI (THIRD_PARTY_LICENSES.md) and the
 * MCP server (THIRD_PARTY_NOTICES.md) used to carry their own copies, and the
 * MCP one had drifted: a package with no license file got a placeholder
 * instead of its text or a failed build.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import * as cliBundle from '../apps/cli/scripts/bundle.mjs';
import * as mcpAssemble from '../apps/mcp-server/scripts/assemble-publish.mjs';
import {
  bundledPackages,
  licenseTextFor,
  thirdPartyMarkdown,
} from '../scripts/lib/third-party-licenses.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'fx-third-party-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Write `files` (relative path → body) under a fresh folder in tmp. */
function tree(files) {
  const root = mkdtempSync(join(tmp, 't-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

describe('one policy for both publish bundles', () => {
  it('the CLI bundle and the MCP assemble use this module, not copies', () => {
    expect(cliBundle.licenseTextFor).toBe(licenseTextFor);
    expect(mcpAssemble.licenseTextFor).toBe(licenseTextFor);
  });

  it('the MCP notices file has the layout the CLI licenses file has', () => {
    const root = tree({
      'node_modules/a/package.json': { name: 'a', version: '1.0.0', license: 'MIT' },
      'node_modules/a/LICENSE': 'a text',
    });
    const dir = join(root, 'node_modules', 'a');
    const viaMcp = mcpAssemble.notices([{ name: 'a', version: '1.0.0', license: 'MIT', dir }]);
    const direct = thirdPartyMarkdown(
      bundledPackages({ inputs: { 'node_modules/a/i.js': {} } }, root),
      {
        bundleFile: 'dist/server.js',
      },
    ).markdown;
    expect(viaMcp).toBe(direct);
  });
});

describe('bundledPackages', () => {
  it('maps metafile inputs to package roots, once per name@version, sorted', () => {
    const root = tree({
      'node_modules/zed/package.json': { name: 'zed', version: '2.0.0' },
      'node_modules/zed/lib/package.json': { type: 'module' }, // no name: keep walking
      'node_modules/zed/lib/x.js': '',
      'node_modules/@s/b/package.json': { name: '@s/b', version: '1.0.0' },
      'node_modules/@s/b/i.js': '',
      'node_modules/.pnpm/zed@2.0.0_peer/node_modules/zed/package.json': {
        name: 'zed',
        version: '2.0.0',
      },
      'node_modules/.pnpm/zed@2.0.0_peer/node_modules/zed/y.js': '',
      'src/own.ts': '',
    });
    const metafile = {
      inputs: {
        'node_modules/zed/lib/x.js': {},
        'src/own.ts': {},
        'node_modules/@s/b/i.js': {},
        'node_modules/.pnpm/zed@2.0.0_peer/node_modules/zed/y.js': {},
      },
    };
    const found = bundledPackages(metafile, root);
    expect(found.map((p) => `${p.pkg.name}@${p.pkg.version}`)).toEqual(['@s/b@1.0.0', 'zed@2.0.0']);
    // The first one seen wins, and its root is the named package.json's folder.
    expect(found[1].dir).toBe(join(root, 'node_modules', 'zed'));
  });
});

describe('licenseTextFor', () => {
  it('prefers the package file; generates MIT / ISC; else names this module in the error', () => {
    const withFile = tree({ 'LICENSE-MIT': ' kept \n' });
    expect(
      licenseTextFor({ dir: withFile, pkg: { name: 'x', version: '1', license: 'MIT' } }),
    ).toEqual({
      text: 'kept',
      generated: false,
    });
    const empty = tree({ 'README.md': '' });
    const isc = licenseTextFor({
      dir: empty,
      pkg: { name: 'y', version: '1', license: 'ISC', author: { name: 'Y Dev' } },
    });
    expect(isc.generated).toBe(true);
    expect(isc.text).toMatch(/^ISC License\n\nCopyright \(c\) Y Dev\n/);
    expect(() =>
      licenseTextFor({
        dir: empty,
        pkg: { name: 'z', version: '3.0.0', license: '(MIT OR Apache-2.0)' },
      }),
    ).toThrow(/z@3\.0\.0 ships no license file .* scripts\/lib\/third-party-licenses\.mjs/);
  });
});

describe('thirdPartyMarkdown', () => {
  it('one section per package, the generated caveat, a non-string license as (see text)', () => {
    const a = tree({ LICENSE: 'a text' });
    const b = tree({});
    const c = tree({ COPYING: 'c text' });
    const { markdown, packages } = thirdPartyMarkdown(
      [
        { dir: c, pkg: { name: 'c', version: '1.0.0', license: { type: 'BSD' } } },
        { dir: b, pkg: { name: 'b', version: '1.0.0', license: 'MIT' } },
        { dir: a, pkg: { name: 'a', version: '1.0.0', license: 'ISC' } },
        { dir: a, pkg: { name: 'a', version: '1.0.0', license: 'ISC' } },
      ],
      { bundleFile: 'dist/cli.js' },
    );
    expect(packages).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0']);
    expect(
      markdown.startsWith('# Third-party licenses\n\n`dist/cli.js` is a single-file bundle.'),
    ).toBe(true);
    const sections = markdown.split(/^## /m).slice(1);
    expect(sections.map((s) => s.split('\n', 1)[0])).toEqual([
      'a@1.0.0 — ISC',
      'b@1.0.0 — MIT',
      'c@1.0.0 — (see text)',
    ]);
    expect(sections[0]).toBe('a@1.0.0 — ISC\n\n```text\na text\n```\n\n');
    expect(sections[1]).toContain('_The package ships no license file;');
    expect(sections[1]).toContain('Copyright (c) the b authors');
    expect(sections[2]).not.toContain('_The package ships no license file;');
  });

  it('throws before returning anything when one package has no text', () => {
    const ok = tree({ LICENSE: 'ok' });
    const bad = tree({});
    expect(() =>
      thirdPartyMarkdown(
        [
          { dir: ok, pkg: { name: 'ok', version: '1.0.0', license: 'MIT' } },
          { dir: bad, pkg: { name: 'bad', version: '1.0.0' } },
        ],
        { bundleFile: 'dist/cli.js' },
      ),
    ).toThrow(/bad@1\.0\.0 ships no license file/);
  });
});

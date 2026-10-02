/**
 * The publish scripts' own guards (mcp-pkg review): they must actually run
 * when started through a symlink or junction, refuse a release with no
 * license, and ship a README that makes sense on npmjs.com. Nothing is ever
 * published.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '@factstack/spec';
import {
  assemble,
  licenseTextFor,
  notices,
  npmReadme,
  ownLicenseFile,
  releaseBlockers,
} from '../scripts/assemble-publish.mjs';
import { smokeBundle } from '../scripts/smoke-bundle.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'factstack-mcp-scripts-'));
});
// Removes the junction/symlink below, never its target (rm does not follow links).
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the scripts run through a symlinked or junction path (mcp-pkg-1)', () => {
  /* Node realpaths import.meta.url but not argv[1]: the old
     `import.meta.url === pathToFileURL(argv[1])` guard made all three exit 0
     having done nothing, so a release could ship a stale bundle. */
  let link: string;
  beforeAll(() => {
    link = path.join(tmp, 'linked-mcp-server');
    symlinkSync(PKG, link, 'junction'); // a junction on Windows (no admin needed), else a symlink
  });
  const run = (script: string, ...args: string[]) =>
    spawnSync(process.execPath, [path.join(link, 'scripts', script), ...args], {
      cwd: tmp,
      encoding: 'utf8',
    });

  it('bundle.mjs writes the bundle', { timeout: 120_000 }, () => {
    const out = path.join(tmp, 'bundled', 'server.js');
    const r = run('bundle.mjs', out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^bundled /);
    expect(readFileSync(out, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('assemble-publish.mjs runs: it refuses a folder it did not make, loudly', () => {
    const foreign = path.join(tmp, 'foreign');
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, 'keep.txt'), 'x');
    const r = run('assemble-publish.mjs', '--out', foreign);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not empty and was not assembled by this script/);
    expect(existsSync(path.join(foreign, 'keep.txt'))).toBe(true);
  });

  it('smoke-bundle.mjs runs: a missing publish folder fails, not a silent pass', () => {
    const r = run('smoke-bundle.mjs', path.join(tmp, 'no-such-publish-dir'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ENOENT/);
    expect(r.stdout).not.toMatch(/smoke ok/);
  });
});

describe('the smoke removes its temp dir (mcp-pkg-6)', () => {
  /** A publish folder whose bin fails at once: the smoke stops at --version. */
  const brokenPublish = () => {
    const dir = path.join(tmp, `broken-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'factstack-mcp', version: '0.0.0', bin: { 'factstack-mcp': 'x.js' } }),
    );
    writeFileSync(path.join(dir, 'x.js'), 'process.exit(3);\n');
    return dir;
  };

  it('on failure too; --keep leaves it and says where', async () => {
    const root = mkdtempSync(path.join(tmp, 'smoke-root-'));
    const quiet = () => undefined;
    await expect(
      smokeBundle({ publishDir: brokenPublish(), tempRoot: root, log: quiet }),
    ).rejects.toThrow(/--version exited 3/);
    expect(readdirSync(root)).toEqual([]);

    const logs: string[] = [];
    await expect(
      smokeBundle({
        publishDir: brokenPublish(),
        tempRoot: root,
        keep: true,
        log: (l: string) => logs.push(l),
      }),
    ).rejects.toThrow(/--version exited 3/);
    const kept = readdirSync(root);
    expect(kept).toHaveLength(1);
    expect(logs).toContain(`kept       ${path.join(root, kept[0]!)}`);
  });
});

describe('--release needs a settled license (mcp-pkg-5)', () => {
  it('names each missing piece; none once both are set', () => {
    expect(releaseBlockers({ license: 'UNLICENSED' }, null)).toEqual([
      expect.stringMatching(/"license" is UNLICENSED/),
      expect.stringMatching(/LICENSE is missing/),
    ]);
    expect(releaseBlockers({}, 'LICENSE')).toEqual([expect.stringMatching(/"license" is missing/)]);
    expect(releaseBlockers({ license: 'MIT' }, null)).toEqual([
      expect.stringMatching(/LICENSE is missing/),
    ]);
    expect(releaseBlockers({ license: 'MIT' }, 'LICENSE')).toEqual([]);
  });

  const blocked = releaseBlockers(pkg, ownLicenseFile()).length > 0;
  it.skipIf(!blocked)(
    'this checkout (license unsettled): assemble --release is refused before anything is written',
    async () => {
      const out = path.join(tmp, 'release');
      await expect(assemble({ outDir: out, release: true })).rejects.toThrow(
        /refusing to assemble a release/,
      );
      expect(existsSync(out)).toBe(false);
    },
  );
});

describe('third-party notices: the policy the CLI bundle uses (mcp-3)', () => {
  /** A fake inlined npm package folder holding `files` (and `dirs`). */
  const pkgDir = (files: Record<string, string>, dirs: string[] = []) => {
    const dir = mkdtempSync(path.join(tmp, 'dep-'));
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(dir, f), body);
    for (const d of dirs) mkdirSync(path.join(dir, d));
    return dir;
  };
  /** A bundle() thirdParty entry. */
  const dep = (dir: string, license: string | null = 'MIT') => ({
    name: 'dep',
    version: '1.0.0',
    license,
    dir,
  });
  const text = (dir: string) =>
    licenseTextFor({ dir, pkg: { name: 'dep', version: '1.0.0', license: 'MIT' } }).text;

  it('reads the spellings the CLI bundle reads: LICENSE*, LICENCE*, COPYING', () => {
    expect(text(pkgDir({ 'LICENSE-MIT': ' mit text \n' }))).toBe('mit text');
    expect(text(pkgDir({ 'licence.md': 'british' }))).toBe('british');
    expect(text(pkgDir({ COPYING: 'gpl text' }))).toBe('gpl text');
    // A folder named LICENSE is skipped; the pick among files is sorted, so stable.
    expect(text(pkgDir({ 'LICENSE.txt': 'file' }, ['LICENSE']))).toBe('file');
    expect(text(pkgDir({ 'LICENSE.md': 'md', LICENSE: 'plain' }))).toBe('plain');
  });

  it('an MIT package with no license file gets the standard text, holder from its package.json', () => {
    const dir = pkgDir({
      'package.json': JSON.stringify({
        name: 'dep',
        version: '1.0.0',
        license: 'MIT',
        author: 'Dep Dev <dev@example.invalid>',
      }),
    });
    const md = notices([dep(dir)]);
    expect(md).toMatch(/^# Third-party licenses\n\n`dist\/server\.js` is a single-file bundle\./);
    expect(md).toContain('## dep@1.0.0 — MIT\n\n_The package ships no license file;');
    expect(md).toContain('```text\nMIT License\n\nCopyright (c) Dep Dev\n');
    expect(md).not.toContain('example.invalid'); // the holder, not the e-mail
  });

  it('throws for a package with no license file and no standard text (it used to write a placeholder)', () => {
    const none = pkgDir({ 'README.md': '' });
    expect(() => notices([dep(none, 'Apache-2.0')])).toThrow(
      /dep@1\.0\.0 ships no license file and its license \("Apache-2\.0"\) has no standard text/,
    );
    expect(() => notices([dep(none, null)])).toThrow(/license \(null\)/);
  });

  it('assemble stops before package.json and leaves no half-built folder', async () => {
    const out = path.join(tmp, 'notice-missing');
    const noLicense = pkgDir({ 'README.md': '' });
    const fakeBundle = async ({ outfile = '' }: { outfile?: string | undefined } = {}) => {
      writeFileSync(outfile, '#!/usr/bin/env node\n');
      return {
        outfile,
        bytes: 20,
        inputs: 1,
        external: [],
        thirdParty: [dep(noLicense, 'Apache-2.0')],
      };
    };
    await expect(assemble({ outDir: out, bundler: fakeBundle })).rejects.toThrow(
      /ships no license file/,
    );
    expect(existsSync(out)).toBe(false);
  });
});

describe('the npm README (mcp-pkg-7)', () => {
  it('drops repo-only blocks and unwraps npm-only comments', () => {
    const src = [
      '# T',
      '',
      '<!-- repo-only:start -->',
      '',
      'clone [doc](PUBLISHING.md)',
      '',
      '<!-- repo-only:end -->',
      '',
      '<!-- npm-only:start',
      'npx it',
      '',
      'npm-only:end -->',
      '',
      'shared',
      '',
    ].join('\r\n');
    expect(npmReadme(src)).toBe('# T\n\nnpx it\n\nshared\n');
  });

  it('refuses an unbalanced marker instead of shipping it', () => {
    expect(() => npmReadme('a\n<!-- repo-only:start -->\nb\n')).toThrow(/unbalanced/);
    expect(() => npmReadme('a\n<!-- npm-only:start\nb\n')).toThrow(/unbalanced/);
  });

  it("this package's README: no repo links, no source tree, no owner steps; npx + every tool", () => {
    const repo = readFileSync(path.join(PKG, 'README.md'), 'utf8');
    const npm = npmReadme(repo);
    // Relative links break on npmjs.com; only absolute ones may ship.
    expect(npm.match(/\]\((?!https?:\/\/)[^)]*\)/g)).toBeNull();
    // (`src/a.ts` in the path-spelling note is an example, not this repo's source.)
    expect(npm).not.toMatch(/PUBLISHING|not on npm yet|apps\/|create-server|server\.ts|tsx /);
    expect(npm).toContain('npx -y factstack-mcp --root /abs/path/to/project');
    expect(npm).toContain('npx -y factstack-mcp login');
    expect(npm).toContain('"args": ["-y", "factstack-mcp", "--root", "/abs/path/to/project"]');
    for (const tool of MCP_TOOL_NAMES) expect(npm).toContain(`\`${tool}\``);
    // The repo copy keeps what a contributor needs.
    expect(repo).toContain('[PUBLISHING.md](PUBLISHING.md)');
    expect(repo).toContain('npx tsx apps/mcp-server/src/server.ts');
  });
});

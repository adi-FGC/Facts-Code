/**
 * scripts/bundle.mjs safety + license notices, without building the bundle:
 *
 *   - R4: the build starts with a recursive delete of --out, so a mistyped
 *     `--out .` removed apps/cli and `--out ../..` the repo. Only a new, an
 *     empty or an earlier publish folder may be (re)built.
 *   - R10: THIRD_PARTY_LICENSES.md carried no text for ignore@6 (its file is
 *     LICENSE-MIT); a package with no file at all gets its license's standard
 *     text, or the build fails.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLI_ROOT,
  PUBLISH_FILES,
  REPO_ROOT,
  assertSafeOutDir,
  bundleCli,
  cliReleaseBlockers,
  licenseTextFor,
  publishManifest,
} from '../bundle.mjs';
import { ownLicenseFile } from '../lib/release-guard.mjs';

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'facts-bundle-guard-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bundle --out guard (R4)', () => {
  it.each([
    ['apps/cli itself', () => CLI_ROOT],
    ['the repo root', () => REPO_ROOT],
    ['a parent of the repo', () => path.dirname(REPO_ROOT)],
    ['apps/', () => path.join(CLI_ROOT, '..')],
  ])('refuses %s', (_label, dir) => {
    expect(() => assertSafeOutDir(dir(), { cwd: tmpdir() })).toThrow(/is or contains/);
  });

  it('refuses the current directory and anything above it', () => {
    const cwd = path.join(tempDir(), 'work');
    mkdirSync(cwd);
    expect(() => assertSafeOutDir(cwd, { cwd })).toThrow(/current directory/);
    expect(() => assertSafeOutDir(path.dirname(cwd), { cwd })).toThrow(/current directory/);
  });

  it('refuses a folder with other content, even one whose package.json is named factstack', () => {
    const d = tempDir();
    writeFileSync(path.join(d, 'notes.txt'), 'keep me');
    expect(() => assertSafeOutDir(d, { cwd: tmpdir() })).toThrow(/not an earlier publish folder/);

    const clone = tempDir(); // e.g. another checkout of this repo
    writeFileSync(path.join(clone, 'package.json'), '{"name":"factstack"}');
    mkdirSync(path.join(clone, '.git'));
    mkdirSync(path.join(clone, 'apps'));
    expect(() => assertSafeOutDir(clone, { cwd: tmpdir() })).toThrow(/holds .git, apps/);

    const file = path.join(tempDir(), 'out.txt');
    writeFileSync(file, '');
    expect(() => assertSafeOutDir(file, { cwd: tmpdir() })).toThrow(/not a directory/);
  });

  it('accepts a new folder, an empty one, and an earlier publish folder', () => {
    const base = tempDir();
    expect(() => assertSafeOutDir(path.join(base, 'new'), { cwd: tmpdir() })).not.toThrow();
    const empty = path.join(base, 'empty');
    mkdirSync(empty);
    expect(() => assertSafeOutDir(empty, { cwd: tmpdir() })).not.toThrow();
    const prev = path.join(base, 'publish');
    mkdirSync(path.join(prev, 'dist'), { recursive: true });
    for (const f of ['README.md', 'THIRD_PARTY_LICENSES.md', 'factstack-0.1.0.tgz']) {
      writeFileSync(path.join(prev, f), '');
    }
    writeFileSync(path.join(prev, 'package.json'), '{"name":"factstack","version":"0.1.0"}');
    expect(() => assertSafeOutDir(prev, { cwd: tmpdir() })).not.toThrow();
  });

  it('bundleCli refuses before deleting anything', async () => {
    await expect(bundleCli({ outDir: CLI_ROOT })).rejects.toThrow(/is or contains apps\/cli/);
    expect(existsSync(path.join(CLI_ROOT, 'package.json'))).toBe(true);
    expect(existsSync(path.join(CLI_ROOT, 'src', 'cli.ts'))).toBe(true);
  });
});

/* deploy-infra#8: apps/cli/publish/package.json had no `private` and an
   UNLICENSED license with publishConfig public, so a stray `npm publish` in
   it shipped unlicensed code. Same guard as factstack-mcp's folder now. */
describe('release guard (deploy-infra#8)', () => {
  const pkg = {
    name: '@factstack/cli',
    version: '1.2.3',
    license: 'UNLICENSED',
    engines: { node: '>=24.3.0' },
    homepage: 'https://factstack.pages.dev',
  };

  it('the folder is private until a release; only a release gets publishConfig', () => {
    const guarded = publishManifest(pkg);
    expect(guarded.private).toBe(true);
    expect(guarded).not.toHaveProperty('publishConfig');
    expect(guarded.files).toEqual(PUBLISH_FILES);
    expect(guarded.license).toBe('UNLICENSED');

    const release = publishManifest(
      { ...pkg, license: 'AGPL-3.0-only' },
      {
        release: true,
        licenseFile: 'LICENSE',
      },
    );
    expect(release).not.toHaveProperty('private');
    expect(release.publishConfig).toEqual({ access: 'public' });
    expect(release.files).toEqual([...PUBLISH_FILES, 'LICENSE']);
    expect(() => publishManifest({ ...pkg, engines: {} })).toThrow(/no engines\.node/);
  });

  it('a release needs a real license id AND the license text', () => {
    expect(cliReleaseBlockers(pkg, null)).toEqual([
      'apps/cli/package.json "license" is UNLICENSED: set the chosen SPDX id',
      'apps/cli/LICENSE is missing: add the license text',
    ]);
    expect(cliReleaseBlockers({ ...pkg, license: undefined }, 'LICENSE')).toEqual([
      'apps/cli/package.json "license" is missing: set the chosen SPDX id',
    ]);
    expect(cliReleaseBlockers({ ...pkg, license: 'AGPL-3.0-only' }, 'LICENSE')).toEqual([]);
  });

  it('ownLicenseFile finds LICENSE / LICENCE.md / license.txt, never a directory', () => {
    const d = tempDir();
    expect(ownLicenseFile(d)).toBeNull();
    mkdirSync(path.join(d, 'LICENSE'));
    expect(ownLicenseFile(d)).toBeNull();
    writeFileSync(path.join(d, 'LICENCE.md'), 'text');
    expect(ownLicenseFile(d)).toBe('LICENCE.md');
  });

  it('bundleCli --release refuses before deleting or writing anything', async () => {
    const cliPkg = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'));
    if (cliReleaseBlockers(cliPkg, ownLicenseFile(CLI_ROOT)).length === 0) return; // licensed
    const out = path.join(tempDir(), 'publish');
    mkdirSync(out);
    writeFileSync(path.join(out, 'package.json'), '{"name":"factstack","version":"0.0.1"}');
    await expect(bundleCli({ outDir: out, release: true })).rejects.toThrow(
      /refusing to bundle a release \(nothing written\):\n {2}- apps\/cli\/package\.json "license"/,
    );
    expect(readFileSync(path.join(out, 'package.json'), 'utf8')).toBe(
      '{"name":"factstack","version":"0.0.1"}',
    );
  });
});

describe('third-party license text (R10)', () => {
  const pkgDir = (files: Record<string, string>): string => {
    const d = tempDir();
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(d, f), body);
    return d;
  };

  it('reads a LICENSE-MIT file (ignore@6 ships its notice under that name)', () => {
    const dir = pkgDir({
      'LICENSE-MIT': 'Copyright (c) 2013 kael\n\nPermission is hereby granted',
    });
    const r = licenseTextFor({ dir, pkg: { name: 'ignore', version: '6.0.2', license: 'MIT' } });
    expect(r.generated).toBe(false);
    expect(r.text).toContain('Copyright (c) 2013 kael');
  });

  it('generates the standard MIT / ISC text with the holder when no file ships', () => {
    const mit = licenseTextFor({
      dir: pkgDir({}),
      pkg: { name: 'x', version: '1.0.0', license: 'MIT', author: 'Kael Z <k@example.invalid>' },
    });
    expect(mit.generated).toBe(true);
    expect(mit.text).toMatch(/^MIT License\n\nCopyright \(c\) Kael Z\n/);
    expect(mit.text).toContain('The above copyright notice and this permission notice');
    const isc = licenseTextFor({
      dir: pkgDir({}),
      pkg: { name: 'y', version: '1.0.0', license: 'ISC', author: { name: 'Y Dev' } },
    });
    expect(isc.text).toMatch(/^ISC License\n\nCopyright \(c\) Y Dev\n/);
    const anon = licenseTextFor({
      dir: pkgDir({}),
      pkg: { name: 'z', version: '1.0.0', license: 'MIT' },
    });
    expect(anon.text).toContain('Copyright (c) the z authors');
  });

  it('fails the build for a package with neither a file nor a known license', () => {
    expect(() =>
      licenseTextFor({
        dir: pkgDir({ 'README.md': '' }),
        pkg: { name: 'w', version: '2.0.0', license: 'Apache-2.0' },
      }),
    ).toThrow(/w@2\.0\.0 ships no license file/);
  });
});

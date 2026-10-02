/**
 * security#8 / correctness#3 — lockfile parsing. The CVE scan must ask OSV about
 * the INSTALLED version, so every supported lockfile shape has to yield: the
 * direct deps each importer resolved (alias keys mapped to the real package),
 * and every installed registry package (for transitive scanning). Non-registry
 * installs (workspace links, git, file:) must never surface as packages.
 */
import { describe, expect, it } from 'vitest';
import {
  attachResolvedVersions,
  isLockfilePath,
  LOCKFILE_NAMES,
  lockfileCandidates,
  parseLockfile,
  parseNpmAlias,
  resolveInstalled,
  type ParsedLockfile,
} from '../src/lockfiles.js';
import { LOCKFILE_NAMES as SPEC_LOCKFILE_NAMES, type DependencyManifest } from '@factstack/spec';
import { PNPM_V9 } from './lockfile-fixtures.js';
// Vite `?raw` import: the repo's real lockfile as text, no node:* (C1 covers tests too).
import REPO_PNPM_LOCK from '../../../pnpm-lock.yaml?raw';

const has = (lock: ParsedLockfile, name: string, version: string) =>
  lock.packages.some((p) => p.name === name && p.version === version);

describe('parseLockfile — pnpm', () => {
  it('v9: importers resolve direct deps (alias → real package, peers stripped, links dropped)', () => {
    const lock = parseLockfile('pnpm-lock.yaml', PNPM_V9)!;
    expect(lock.kind).toBe('pnpm');
    const root = lock.importers.get('')!;
    expect(root.get('lodash')).toEqual({ name: 'lodash', version: '4.17.21' });
    expect(root.get('string-width-cjs')).toEqual({ name: 'string-width', version: '4.2.3' });
    expect(root.get('@scope/ui')).toEqual({ name: '@scope/ui', version: '1.4.0' });
    expect(root.get('vitest')).toEqual({ name: 'vitest', version: '2.1.9' });
    const web = lock.importers.get('apps/web')!;
    expect(web.get('ws')).toEqual({ name: 'ws', version: '8.16.0' });
    expect(web.has('@acme/core')).toBe(false); // workspace link, not a registry install
  });

  it('v9: packages lists every registry install, skipping git/tarball entries', () => {
    const lock = parseLockfile('pnpm-lock.yaml', PNPM_V9)!;
    expect(has(lock, 'minimist', '1.2.5')).toBe(true);
    expect(has(lock, '@scope/ui', '1.4.0')).toBe(true);
    expect(lock.packages.some((p) => p.name === 'git-dep')).toBe(false);
  });

  it('v6: single-project top-level deps, `/name@ver` alias refs, dev flags', () => {
    const lock = parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: '6.0'

dependencies:
  lodash:
    specifier: ^4.17.0
    version: 4.17.21
  wrap:
    specifier: npm:wrap-ansi@^7.0.0
    version: /wrap-ansi@7.0.0

devDependencies:
  typescript:
    specifier: ^5.0.0
    version: 5.4.5

packages:

  /lodash@4.17.21:
    resolution: {integrity: sha512-x}
    dev: false

  /wrap-ansi@7.0.0:
    resolution: {integrity: sha512-y}
    dev: false

  /typescript@5.4.5:
    resolution: {integrity: sha512-z}
    engines: {node: '>=14.17'}
    hasBin: true
    dev: true

  /@babel/core@7.24.0(supports-color@8.1.1):
    resolution: {integrity: sha512-w}
    dev: true
`,
    )!;
    const root = lock.importers.get('')!;
    expect(root.get('wrap')).toEqual({ name: 'wrap-ansi', version: '7.0.0' });
    expect(root.get('typescript')).toEqual({ name: 'typescript', version: '5.4.5' });
    expect(lock.packages).toContainEqual({ name: '@babel/core', version: '7.24.0', dev: true });
    expect(lock.packages).toContainEqual({ name: 'lodash', version: '4.17.21', dev: false });
  });

  it('v5.4: `specifiers` importers, `/name/ver_peer` keys', () => {
    const lock = parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: 5.4

importers:

  .:
    specifiers:
      lodash: ^4.17.0
    dependencies:
      lodash: 4.17.20

  packages/a:
    specifiers:
      react-dom: ^18.0.0
    dependencies:
      react-dom: 18.2.0_react@18.2.0

packages:

  /lodash/4.17.20:
    resolution: {integrity: sha512-x}
    dev: false

  /react-dom/18.2.0_react@18.2.0:
    resolution: {integrity: sha512-y}
    dev: false

  /@types/node/20.1.0:
    resolution: {integrity: sha512-z}
    dev: true
`,
    )!;
    expect(lock.importers.get('')!.get('lodash')).toEqual({ name: 'lodash', version: '4.17.20' });
    expect(lock.importers.get('packages/a')!.get('react-dom')).toEqual({
      name: 'react-dom',
      version: '18.2.0',
    });
    expect(lock.packages).toContainEqual({ name: '@types/node', version: '20.1.0', dev: true });
  });

  it('a hostile `__proto__` key stays data (no prototype pollution from an untrusted repo)', () => {
    const lock = parseLockfile(
      'pnpm-lock.yaml',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '__proto__':\n        specifier: ^1.0.0\n        version: 1.0.0\n",
    )!;
    expect(lock.importers.get('')!.get('__proto__')).toEqual({
      name: '__proto__',
      version: '1.0.0',
    });
    expect(({} as Record<string, unknown>)['specifier']).toBeUndefined();
  });

  it("parses this repo's real pnpm-lock.yaml (smoke)", () => {
    const lock = parseLockfile('pnpm-lock.yaml', REPO_PNPM_LOCK)!;
    expect(lock.importers.get('')!.get('vitest')?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(lock.importers.get('packages/scanners')!.get('tiktoken')?.version).toMatch(/^\d+\./);
    expect(lock.packages.length).toBeGreaterThan(100);
    expect(lock.packages.every((p) => /^\d+\.\d+\.\d+/.test(p.version))).toBe(true);
  });
});

describe('parseLockfile — npm', () => {
  it('v3: node-resolution per importer (nested beats hoisted), aliases, links, git', () => {
    const lock = parseLockfile(
      'package-lock.json',
      JSON.stringify({
        name: 'root',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'root',
            workspaces: ['packages/a'],
            dependencies: { lodash: '^4.17.0', sw: 'npm:string-width@^4.2.0' },
            devDependencies: { jest: '^29.0.0' },
          },
          'node_modules/lodash': { version: '4.17.21' },
          'node_modules/sw': { name: 'string-width', version: '4.2.3' },
          'node_modules/jest': { version: '29.7.0', dev: true },
          'node_modules/a': { resolved: 'packages/a', link: true },
          'node_modules/minimist': { version: '1.2.5', dev: true },
          'node_modules/gitdep': {
            version: '1.0.0',
            resolved: 'git+ssh://git@github.com/acme/gitdep.git#abc',
          },
          'packages/a': {
            name: 'a',
            version: '1.0.0',
            dependencies: { lodash: '^4.0.0', ws: '^8' },
          },
          'packages/a/node_modules/lodash': { version: '4.17.15' },
          'node_modules/ws': { version: '8.16.0' },
        },
      }),
    )!;
    expect(lock.kind).toBe('npm');
    const root = lock.importers.get('')!;
    expect(root.get('lodash')).toEqual({ name: 'lodash', version: '4.17.21' });
    expect(root.get('sw')).toEqual({ name: 'string-width', version: '4.2.3' });
    expect(root.get('jest')).toEqual({ name: 'jest', version: '29.7.0', dev: true });
    const a = lock.importers.get('packages/a')!;
    expect(a.get('lodash')?.version).toBe('4.17.15');
    expect(a.get('ws')?.version).toBe('8.16.0');
    expect(has(lock, 'minimist', '1.2.5')).toBe(true);
    expect(lock.packages.some((p) => p.name === 'gitdep' || p.name === 'a')).toBe(false);
  });

  it('v1: nested `dependencies` tree, `npm:` alias versions, file: skipped', () => {
    const lock = parseLockfile(
      'npm-shrinkwrap.json',
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          lodash: { version: '4.17.19', dependencies: { minimist: { version: '0.0.8' } } },
          sw: { version: 'npm:string-width@4.2.3' },
          local: { version: 'file:../local' },
        },
      }),
    )!;
    const root = lock.importers.get('')!;
    expect(root.get('lodash')?.version).toBe('4.17.19');
    expect(root.get('sw')).toEqual({ name: 'string-width', version: '4.2.3' });
    expect(root.has('local')).toBe(false);
    expect(has(lock, 'minimist', '0.0.8')).toBe(true);
  });

  it('returns null for malformed JSON instead of throwing', () => {
    expect(parseLockfile('package-lock.json', '{ nope')).toBeNull();
  });
});

describe('parseLockfile — yarn', () => {
  it('v1: multi-descriptor headers, aliases, git deps skipped', () => {
    const lock = parseLockfile(
      'yarn.lock',
      `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
  version "7.12.13"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.13.tgz#abc"
  integrity sha512-x
  dependencies:
    "@babel/highlight" "^7.12.13"

lodash@^4.17.0:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#def"

"string-width-cjs@npm:string-width@^4.2.0":
  version "4.2.3"

"gitdep@github:acme/gitdep":
  version "1.0.0"
  resolved "https://codeload.github.com/acme/gitdep/tar.gz/abc"
`,
    )!;
    expect(lock.kind).toBe('yarn-v1');
    expect(lock.descriptors.get('lodash@^4.17.0')).toEqual({ name: 'lodash', version: '4.17.21' });
    expect(lock.descriptors.get('@babel/code-frame@^7.10.4')?.version).toBe('7.12.13');
    expect(lock.descriptors.get('string-width-cjs@npm:string-width@^4.2.0')).toEqual({
      name: 'string-width',
      version: '4.2.3',
    });
    expect(lock.packages.some((p) => p.name === 'gitdep')).toBe(false);
  });

  it('berry: workspace importers, npm: descriptors, aliases', () => {
    const lock = parseLockfile(
      'yarn.lock',
      `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10c0

"lodash@npm:^4.17.0":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  checksum: 10c0/abc
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  dependencies:
    lodash: "npm:^4.17.0"
    string-width-cjs: "npm:string-width@^4.2.0"
    web: "workspace:packages/web"
  languageName: unknown
  linkType: soft

"string-width-cjs@npm:string-width@^4.2.0, string-width@npm:^4.2.0":
  version: 4.2.3
  resolution: "string-width@npm:4.2.3"
  languageName: node
  linkType: hard

"web@workspace:packages/web":
  version: 0.0.0-use.local
  resolution: "web@workspace:packages/web"
  dependencies:
    ws: "npm:^8.0.0"
  languageName: unknown
  linkType: soft

"ws@npm:^8.0.0":
  version: 8.16.0
  resolution: "ws@npm:8.16.0"
  languageName: node
  linkType: hard
`,
    )!;
    expect(lock.kind).toBe('yarn-berry');
    const root = lock.importers.get('')!;
    expect(root.get('lodash')).toEqual({ name: 'lodash', version: '4.17.21' });
    expect(root.get('string-width-cjs')).toEqual({ name: 'string-width', version: '4.2.3' });
    expect(root.has('web')).toBe(false);
    expect(lock.importers.get('packages/web')!.get('ws')?.version).toBe('8.16.0');
    expect(lock.packages.some((p) => p.name === 'root' || p.name === 'web')).toBe(false);
  });
});

describe('resolveInstalled — which lockfile governs a manifest', () => {
  const lock = parseLockfile('pnpm-lock.yaml', PNPM_V9)!;

  it('resolves a workspace manifest through its importer', () => {
    expect(resolveInstalled([lock], 'apps/web/package.json', 'ws', '^8.0.0')?.version).toBe(
      '8.16.0',
    );
  });

  it('does not resolve a manifest the lockfile does not install (fixture dirs)', () => {
    expect(resolveInstalled([lock], 'test/fixtures/x/package.json', 'ws', '^8.0.0')).toBeNull();
  });

  it('the nearest lockfile wins over an ancestor one', () => {
    const nested = parseLockfile(
      'apps/web/package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { dependencies: { ws: '^8' } }, 'node_modules/ws': { version: '8.17.1' } },
      }),
    )!;
    expect(resolveInstalled([lock, nested], 'apps/web/package.json', 'ws', '^8.0.0')?.version).toBe(
      '8.17.1',
    );
  });

  it('yarn v1 resolves by descriptor', () => {
    const y = parseLockfile('yarn.lock', 'lodash@^4.17.0:\n  version "4.17.21"\n')!;
    expect(resolveInstalled([y], 'package.json', 'lodash', '^4.17.0')?.version).toBe('4.17.21');
  });
});

describe('lockfile helpers', () => {
  it('isLockfilePath recognizes every supported basename', () => {
    for (const p of ['pnpm-lock.yaml', 'a/package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock'])
      expect(isLockfilePath(p)).toBe(true);
    expect(isLockfilePath('package.json')).toBe(false);
  });

  // INV7: one list in @factstack/spec, which the browser GitHub scan fetches too.
  it('LOCKFILE_NAMES is the spec list itself, and every name parses', () => {
    expect(LOCKFILE_NAMES).toBe(SPEC_LOCKFILE_NAMES);
    for (const n of LOCKFILE_NAMES) expect(isLockfilePath(`a/${n}`)).toBe(true);
    expect(parseLockfile('pnpm-lock.yaml', PNPM_V9)).not.toBeNull();
  });

  it('lockfileCandidates lists each manifest dir and its ancestors', () => {
    const c = lockfileCandidates(['apps/web/package.json', 'package.json']);
    expect(c).toContain('pnpm-lock.yaml');
    expect(c).toContain('apps/package-lock.json');
    expect(c).toContain('apps/web/yarn.lock');
  });

  it('parseNpmAlias splits alias specs and rejects protocol-qualified ranges', () => {
    expect(parseNpmAlias('npm:lodash@4.17.15')).toEqual({ name: 'lodash', range: '4.17.15' });
    expect(parseNpmAlias('npm:@scope/pkg@^1.0.0')).toEqual({ name: '@scope/pkg', range: '^1.0.0' });
    expect(parseNpmAlias('npm:lodash')).toEqual({ name: 'lodash', range: '' });
    expect(parseNpmAlias('npm:vue')).toEqual({ name: 'vue', range: '' }); // leading v ≠ version
    expect(parseNpmAlias('npm:^4.17.0')).toBeNull(); // berry's `npm:<range>`, not an alias
    expect(parseNpmAlias('^4.17.0')).toBeNull();
  });

  it('attachResolvedVersions records installed versions of direct deps only', () => {
    const lock = parseLockfile('pnpm-lock.yaml', PNPM_V9)!;
    const m: DependencyManifest = {
      path: 'package.json',
      ecosystem: 'npm',
      name: 'root',
      version: null,
      dependencies: { lodash: '^4.17.0', local: 'workspace:*' },
      devDependencies: { vitest: '^2.0.0' },
    };
    const [out] = attachResolvedVersions([m], [lock]);
    expect(out!.resolved).toEqual({ lodash: '4.17.21', vitest: '2.1.9' });
  });

  it('CVE-R7: attachResolvedVersions tolerates a raw manifest missing a dependency map', () => {
    const lock = parseLockfile('pnpm-lock.yaml', PNPM_V9)!;
    const raw = { path: 'package.json', ecosystem: 'npm', dependencies: { lodash: '^4' } } as never;
    expect(attachResolvedVersions([raw], [lock])[0]).toMatchObject({
      resolved: { lodash: '4.17.21' },
    });
  });
});

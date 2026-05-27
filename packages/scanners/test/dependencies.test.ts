/**
 * Tests for the dependency-manifest scanner.
 *
 * Coverage:
 *   - npm: realistic package.json with deps + devDeps + peer + optional
 *   - npm: edge cases — empty manifests, no name/version, malformed JSON
 *   - npm: protocol filtering (workspace:, file:, git+, link:, github:)
 *     stays IN the manifest map (raw strings); normalization happens at
 *     the OSV-query layer, not the scanner layer
 *   - detectManifestEcosystem dispatch correctness across basenames
 *   - non-npm ecosystems detected but emit empty deps (MVP scope)
 *   - flattenManifests dedupe + provenance preservation
 */

import { describe, expect, it } from 'vitest';
import {
  scanDependencyManifest,
  detectManifestEcosystem,
  flattenManifests,
} from '../src/dependencies.js';

describe('detectManifestEcosystem', () => {
  it('maps known basenames to ecosystems', () => {
    expect(detectManifestEcosystem('package.json')).toBe('npm');
    expect(detectManifestEcosystem('apps/cli/package.json')).toBe('npm');
    expect(detectManifestEcosystem('pyproject.toml')).toBe('pypi');
    expect(detectManifestEcosystem('setup.py')).toBe('pypi');
    expect(detectManifestEcosystem('requirements.txt')).toBe('pypi');
    expect(detectManifestEcosystem('Cargo.toml')).toBe('cargo');
    expect(detectManifestEcosystem('go.mod')).toBe('go');
    expect(detectManifestEcosystem('pom.xml')).toBe('maven');
    expect(detectManifestEcosystem('Gemfile')).toBe('rubygems');
  });

  it('returns null for non-manifest paths', () => {
    expect(detectManifestEcosystem('src/index.ts')).toBeNull();
    expect(detectManifestEcosystem('README.md')).toBeNull();
    /* Case-sensitivity check — "package.JSON" is NOT a real manifest. */
    expect(detectManifestEcosystem('package.JSON')).toBeNull();
  });
});

describe('scanDependencyManifest — npm (package.json)', () => {
  it('parses a realistic package.json with deps + devDeps', () => {
    const text = JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: {
        express: '^4.17.21',
        lodash: '4.17.21',
      },
      devDependencies: {
        vitest: '^4.1.7',
      },
    });
    const m = scanDependencyManifest('package.json', text);
    expect(m).not.toBeNull();
    expect(m!.ecosystem).toBe('npm');
    expect(m!.name).toBe('my-app');
    expect(m!.version).toBe('1.0.0');
    expect(m!.dependencies).toEqual({ express: '^4.17.21', lodash: '4.17.21' });
    expect(m!.devDependencies).toEqual({ vitest: '^4.1.7' });
  });

  it('merges peer + optional deps into runtime deps map', () => {
    /* Most security tooling treats these uniformly with runtime deps
       — peer deps end up installed; optional deps may install. The OSV
       query layer applies the same severity gates regardless. */
    const text = JSON.stringify({
      name: 'plugin',
      dependencies: { core: '^1.0.0' },
      peerDependencies: { react: '^18.0.0' },
      optionalDependencies: { fsevents: '^2.0.0' },
    });
    const m = scanDependencyManifest('package.json', text);
    expect(m!.dependencies).toEqual({
      core: '^1.0.0',
      react: '^18.0.0',
      fsevents: '^2.0.0',
    });
  });

  it('returns nulls for missing name/version (root workspaces)', () => {
    /* Top-level pnpm workspace package.jsons frequently omit name+version.
       These are still valid manifests — the deps matter, the root identity
       doesn't. */
    const text = JSON.stringify({
      private: true,
      dependencies: { foo: '1.0.0' },
    });
    const m = scanDependencyManifest('package.json', text);
    expect(m!.name).toBeNull();
    expect(m!.version).toBeNull();
    expect(m!.dependencies).toEqual({ foo: '1.0.0' });
  });

  it('preserves protocol specifiers verbatim (filtering happens at OSV layer)', () => {
    /* The scanner doesn't decide what to query; it just records what's
       declared. Filtering workspace:/file:/git: happens downstream in
       normalizeNpmVersion at OSV-query time. */
    const text = JSON.stringify({
      name: 'root',
      dependencies: {
        sibling: 'workspace:*',
        localFork: 'file:../my-pkg',
        gitDep: 'git+https://github.com/foo/bar.git',
        npmAlias: 'npm:lodash@^4.0.0',
        registered: '^1.2.3',
      },
    });
    const m = scanDependencyManifest('package.json', text);
    expect(m!.dependencies).toEqual({
      sibling: 'workspace:*',
      localFork: 'file:../my-pkg',
      gitDep: 'git+https://github.com/foo/bar.git',
      npmAlias: 'npm:lodash@^4.0.0',
      registered: '^1.2.3',
    });
  });

  it('returns empty deps maps when manifest declares no deps', () => {
    const text = JSON.stringify({ name: 'empty', version: '0.0.0' });
    const m = scanDependencyManifest('package.json', text);
    expect(m!.dependencies).toEqual({});
    expect(m!.devDependencies).toEqual({});
  });

  it('returns null (not throws) on malformed JSON', () => {
    const m = scanDependencyManifest('package.json', '{ not really json }');
    expect(m).toBeNull();
  });

  it('returns null when JSON parses but root is not an object', () => {
    /* package.json must be a JSON object. Arrays, primitives, null all
       fail validation. We return null rather than emit garbage. */
    expect(scanDependencyManifest('package.json', '[]')).toBeNull();
    expect(scanDependencyManifest('package.json', 'null')).toBeNull();
    expect(scanDependencyManifest('package.json', '"a string"')).toBeNull();
    expect(scanDependencyManifest('package.json', '42')).toBeNull();
  });

  it('strips non-string dep values without crashing', () => {
    /* Defensive — a malformed manifest with non-string version values
       (e.g., null, number) shouldn't crash the analyzer. The scanner
       silently drops them. */
    const text = '{"name":"x","dependencies":{"foo":null,"bar":42,"baz":"1.0.0"}}';
    const m = scanDependencyManifest('package.json', text);
    expect(m!.dependencies).toEqual({ baz: '1.0.0' });
  });

  it('strips empty-string dep versions', () => {
    /* `"foo": ""` is meaningless — OSV can't query an empty version
       and the manifest is likely malformed. Drop silently. */
    const text = '{"name":"x","dependencies":{"foo":"","bar":"1.0.0"}}';
    const m = scanDependencyManifest('package.json', text);
    expect(m!.dependencies).toEqual({ bar: '1.0.0' });
  });
});

describe('scanDependencyManifest — non-npm ecosystems', () => {
  it('detects pyproject.toml and emits empty deps (MVP scope)', () => {
    /* The MVP detects all known manifest types but only fully parses
       npm. Other ecosystems get a record with the right shape and empty
       deps maps — the Vulnerabilities UI shows them as "detected, parser
       coming" rather than silently ignoring them. */
    const m = scanDependencyManifest('pyproject.toml', '[project]\nname = "x"');
    expect(m!.ecosystem).toBe('pypi');
    expect(m!.name).toBeNull();
    expect(m!.dependencies).toEqual({});
    expect(m!.devDependencies).toEqual({});
  });

  it('detects every supported non-npm ecosystem', () => {
    for (const [path, ecosystem] of [
      ['Cargo.toml', 'cargo'],
      ['go.mod', 'go'],
      ['pom.xml', 'maven'],
      ['Gemfile', 'rubygems'],
      ['setup.py', 'pypi'],
      ['requirements.txt', 'pypi'],
    ] as const) {
      const m = scanDependencyManifest(path, '');
      expect(m, `expected ${path} → ${ecosystem}`).not.toBeNull();
      expect(m!.ecosystem).toBe(ecosystem);
    }
  });

  it('returns null for unknown file types', () => {
    expect(scanDependencyManifest('LICENSE', 'MIT')).toBeNull();
    expect(scanDependencyManifest('src/index.ts', 'export {}')).toBeNull();
  });
});

describe('flattenManifests — dedupe + provenance', () => {
  it('emits one entry per (ecosystem, name, version) across manifests', () => {
    /* In a monorepo with consistent versioning, the same dep shows up
       in every workspace package's manifest. flattenManifests collapses
       these to a single OSV query while preserving which manifests
       declared it. */
    const manifests = [
      {
        path: 'package.json',
        ecosystem: 'npm' as const,
        name: null,
        version: null,
        dependencies: { lodash: '4.17.21' },
        devDependencies: {},
      },
      {
        path: 'apps/cli/package.json',
        ecosystem: 'npm' as const,
        name: '@x/cli',
        version: '1.0.0',
        dependencies: { lodash: '4.17.21' },
        devDependencies: {},
      },
    ];
    const flat = flattenManifests(manifests);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.name).toBe('lodash');
    expect(flat[0]!.version).toBe('4.17.21');
    expect(flat[0]!.manifestPaths).toEqual(['package.json', 'apps/cli/package.json']);
  });

  it('emits separate entries for different versions of the same package', () => {
    /* This is the OSV-relevant case — `react@17` and `react@18` are
       distinct queries. Provenance still tracked per-version. */
    const manifests = [
      {
        path: 'a/package.json',
        ecosystem: 'npm' as const,
        name: null, version: null,
        dependencies: { react: '17.0.0' },
        devDependencies: {},
      },
      {
        path: 'b/package.json',
        ecosystem: 'npm' as const,
        name: null, version: null,
        dependencies: { react: '18.0.0' },
        devDependencies: {},
      },
    ];
    const flat = flattenManifests(manifests);
    expect(flat).toHaveLength(2);
    const versions = flat.map((e) => e.version).sort();
    expect(versions).toEqual(['17.0.0', '18.0.0']);
  });

  it('walks both deps and devDeps', () => {
    const manifests = [{
      path: 'package.json',
      ecosystem: 'npm' as const,
      name: null, version: null,
      dependencies: { express: '4.0.0' },
      devDependencies: { vitest: '4.0.0' },
    }];
    const flat = flattenManifests(manifests);
    expect(flat.map((e) => e.name).sort()).toEqual(['express', 'vitest']);
  });

  it('returns empty array for empty input', () => {
    expect(flattenManifests([])).toEqual([]);
  });
});

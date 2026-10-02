import { describe, expect, it } from 'vitest';
import {
  buildOsvQueries,
  carryVulnerabilityScan,
  isGradedVulnerability,
  normalizeNpmVersion,
  reconcileVulnerabilities,
  vulnerabilityLabels,
  VULN_LABEL_TEXT,
  type OsvQuery,
} from '../src/vulnerabilities.js';
import { parseLockfile } from '../src/lockfiles.js';
import type { DependencyManifest, Vulnerability } from '@factstack/spec';
import { PNPM_V9 } from './lockfile-fixtures.js';

/**
 * v0.11 — reconcileVulnerabilities: the carry-forward filter that lets a CVE
 * scan survive a re-analyze WITHOUT going zombie. A finding survives only when
 * its exact (ecosystem, package, installedVersion) is still installed.
 */

function manifest(
  deps: Record<string, string>,
  devDeps: Record<string, string> = {},
): DependencyManifest {
  return {
    path: 'package.json',
    ecosystem: 'npm',
    name: 'fixture',
    version: '1.0.0',
    dependencies: deps,
    devDependencies: devDeps,
  } as DependencyManifest;
}

function vuln(pkg: string, installedVersion: string): Vulnerability {
  return {
    id: `GHSA-test-${pkg}`,
    severity: 'high',
    ecosystem: 'npm',
    package: pkg,
    installedVersion,
    fixedVersion: null,
    advisoryUrl: `https://osv.dev/vulnerability/GHSA-test-${pkg}`,
    lastChecked: 1_700_000_000_000,
    manifestPath: 'package.json',
  };
}

/* The ONE carry rule the CLI carry-forward and the MCP restore share.
   A scan whose rows are not an array used to carry (CLI side) as "scanned
   and clean", findings 0, with no warning. */
describe('carryVulnerabilityScan', () => {
  const SCAN = {
    scannedAt: '2026-09-20T00:00:00.000Z',
    source: 'osv.dev',
    packagesQueried: 4,
    packagesSkipped: 0,
    findings: 1,
  };
  const deps = [manifest({ lodash: '^4.17.21' })];
  const noLocks = () => [];
  const HINT = 'rescan';

  it('nothing to carry → silent', () => {
    expect(carryVulnerabilityScan(null, deps, noLocks, HINT)).toEqual({ carried: false });
    expect(carryVulnerabilityScan({}, deps, noLocks, HINT)).toEqual({ carried: false });
  });

  it.each([
    ['null', null],
    ['an object', {}],
    ['a string', 'x'],
    ['missing', undefined],
  ])(
    'rows that are %s drop the scan with a warning — never "scanned and clean"',
    (_label, rows) => {
      const r = carryVulnerabilityScan(
        { vulnerabilityScan: { ...SCAN, findings: 3 }, vulnerabilities: rows },
        deps,
        noLocks,
        HINT,
      );
      expect(r).toEqual({
        carried: false,
        warning: expect.stringMatching(/unexpected shape.*rescan$/),
      });
    },
  );

  it('scan metadata that fails the schema is dropped with a warning', () => {
    const r = carryVulnerabilityScan(
      { vulnerabilityScan: { scannedAt: 'x' }, vulnerabilities: [] },
      deps,
      noLocks,
      HINT,
    );
    expect(r.carried).toBe(false);
    expect(r.warning).toMatch(/unexpected shape/);
  });

  it('carries reconciled rows; findings mirrors them; the rest of the scan is kept', () => {
    const r = carryVulnerabilityScan(
      {
        vulnerabilityScan: { ...SCAN, findings: 2, unscanned: 1, lockfiles: ['pnpm-lock.yaml'] },
        vulnerabilities: [vuln('lodash', '4.17.21'), vuln('left-pad', '1.0.0')],
      },
      deps,
      noLocks,
      HINT,
    );
    if (!r.carried) throw new Error('expected a carried scan');
    expect(r.vulnerabilities.map((v) => v.package)).toEqual(['lodash']);
    expect(r.scan).toEqual({
      ...SCAN,
      findings: 1,
      unscanned: 1,
      lockfiles: ['pnpm-lock.yaml'],
    });
    expect(r.warning).toBeUndefined();
  });

  it('reports malformed rows and a findings/rows mismatch, never silently', () => {
    const r = carryVulnerabilityScan(
      {
        vulnerabilityScan: { ...SCAN, findings: 5 },
        vulnerabilities: [vuln('lodash', '4.17.21'), { id: 'broken' }],
      },
      deps,
      noLocks,
      HINT,
    );
    expect(r.carried).toBe(true);
    expect(r.warning).toBe(
      '1 malformed vulnerability row in the previous scan dropped; ' +
        'the previous scan recorded 5 findings but held 2 rows; rescan',
    );
  });

  it('a failing reconcile drops the scan with the reason', () => {
    const r = carryVulnerabilityScan(
      { vulnerabilityScan: SCAN, vulnerabilities: [vuln('lodash', '4.17.21')] },
      deps,
      () => {
        throw new Error('lockfile unreadable');
      },
      HINT,
    );
    expect(r).toEqual({
      carried: false,
      warning: 'could not reconcile the previous vulnerability scan (lockfile unreadable); rescan',
    });
  });
});

describe('reconcileVulnerabilities (v0.11)', () => {
  it('keeps a finding whose dep is still installed at the same version', () => {
    // The scan stored the NORMALIZED version ("^4.17.21" was queried as 4.17.21).
    const prev = [vuln('lodash', '4.17.21')];
    const out = reconcileVulnerabilities(prev, [manifest({ lodash: '^4.17.21' })]);
    expect(out).toEqual(prev);
  });

  it('drops a finding for a REMOVED dep — no zombie CVEs', () => {
    const prev = [vuln('lodash', '4.17.21'), vuln('left-pad', '1.0.0')];
    const out = reconcileVulnerabilities(prev, [manifest({ lodash: '^4.17.21' })]);
    expect(out.map((v) => v.package)).toEqual(['lodash']);
  });

  it('drops a finding for an UPGRADED dep — the old advisory may not apply', () => {
    const prev = [vuln('lodash', '4.17.20')];
    const out = reconcileVulnerabilities(prev, [manifest({ lodash: '^4.17.21' })]);
    expect(out).toEqual([]);
  });

  it('matches devDependencies too (default scan covers everything that ships)', () => {
    const prev = [vuln('vitest', '2.1.9')];
    expect(reconcileVulnerabilities(prev, [manifest({}, { vitest: '~2.1.9' })])).toEqual(prev);
  });

  it('empty previous list stays empty regardless of manifests', () => {
    expect(reconcileVulnerabilities([], [manifest({ lodash: '4.17.21' })])).toEqual([]);
  });

  it('non-registry specs (workspace:) cannot anchor a finding', () => {
    // normalizeNpmVersion turns workspace:* into null — it was never queried,
    // so a (bogus) finding claiming that version must not survive.
    expect(normalizeNpmVersion('workspace:*')).toBeNull();
    const prev = [vuln('internal-pkg', '1.0.0')];
    expect(reconcileVulnerabilities(prev, [manifest({ 'internal-pkg': 'workspace:*' })])).toEqual(
      [],
    );
  });

  it('security#8: with a lockfile, a finding survives only at the INSTALLED version', () => {
    const lock = parseLockfile('pnpm-lock.yaml', PNPM_V9)!;
    const m = manifest({ lodash: '^4.17.0' });
    const labelled = (source: 'lockfile' | 'declared-range') => ({
      ...vuln('lodash', '4.17.0'),
      versionSource: source,
    });
    // Installed per the lockfile → kept; a labelled declared-lower-bound row → dropped.
    expect(reconcileVulnerabilities([vuln('lodash', '4.17.21')], [m], [lock])).toHaveLength(1);
    expect(reconcileVulnerabilities([labelled('declared-range')], [m], [lock])).toEqual([]);
    expect(reconcileVulnerabilities([labelled('lockfile')], [m], [lock])).toEqual([]);
    // Transitive finding survives while the lockfile still installs it.
    expect(reconcileVulnerabilities([vuln('minimist', '1.2.5')], [m], [lock])).toHaveLength(1);
    expect(reconcileVulnerabilities([vuln('minimist', '1.2.5')], [m])).toEqual([]);
  });

  it('CVE-R3: a legacy UNLABELLED row at the declared lower bound survives resolved/lockfile reconcile', () => {
    // Legacy query builders (no versionSource) queried ^4.17.0 as 4.17.0; a
    // manifest that now carries the installed version must not drop that hit
    // and turn the scan into "scanned, 0 findings".
    const prev = [vuln('lodash', '4.17.0')];
    const carried = { ...manifest({ lodash: '^4.17.0' }), resolved: { lodash: '4.17.21' } };
    expect(reconcileVulnerabilities(prev, [carried])).toEqual(prev);
    const lock = parseLockfile('pnpm-lock.yaml', PNPM_V9)!;
    expect(reconcileVulnerabilities(prev, [manifest({ lodash: '^4.17.0' })], [lock])).toEqual(prev);
    // Still drops when the declared range itself moved (dep upgraded).
    expect(
      reconcileVulnerabilities(prev, [{ ...carried, dependencies: { lodash: '^4.17.21' } }]),
    ).toEqual([]);
  });

  it('correctness#3: an npm alias finding (real package name) survives reconcile', () => {
    const prev = [vuln('lodash', '4.17.15')];
    expect(
      reconcileVulnerabilities(prev, [manifest({ 'lodash-legacy': 'npm:lodash@4.17.15' })]),
    ).toEqual(prev);
  });

  /* audit correctness#3 / #48 — a carried-forward row must take its labels
     from the CURRENT manifests, not the scan that wrote it: a dev dep moved
     into `dependencies` is graded at once, without waiting for a rescan. */
  describe('re-derives scope / versionSource from the current manifests', () => {
    const labelled = (
      pkg: string,
      version: string,
      scope: 'direct' | 'dev' | 'transitive',
      versionSource: 'lockfile' | 'declared-range' = 'declared-range',
    ): Vulnerability => ({ ...vuln(pkg, version), scope, versionSource });

    it('a dev row whose dep moved to dependencies comes back direct (and graded)', () => {
      const prev = [labelled('x', '1.0.0', 'dev')];
      const out = reconcileVulnerabilities(prev, [manifest({ x: '^1.0.0' })]);
      expect(out).toHaveLength(1);
      expect(out[0]?.scope).toBe('direct');
      expect(isGradedVulnerability(out[0]!)).toBe(true);
      // The input row is not mutated.
      expect(prev[0]?.scope).toBe('dev');
    });

    it('a direct row whose dep moved to devDependencies comes back dev (not graded)', () => {
      const out = reconcileVulnerabilities(
        [labelled('x', '1.0.0', 'direct')],
        [manifest({}, { x: '^1.0.0' })],
      );
      expect(out.map((v) => v.scope)).toEqual(['dev']);
      expect(isGradedVulnerability(out[0]!)).toBe(false);
    });

    it('a transitive row the manifest now declares directly comes back direct + lockfile', () => {
      const lock = parseLockfile('pnpm-lock.yaml', PNPM_V9)!;
      const prev = [labelled('minimist', '1.2.5', 'transitive', 'lockfile')];
      const out = reconcileVulnerabilities(prev, [manifest({ minimist: '^1.2.5' })], [lock]);
      expect(out.map((v) => [v.scope, v.versionSource])).toEqual([['direct', 'lockfile']]);
    });

    it('versionSource follows the current resolution (declared range -> lockfile)', () => {
      const carried = { ...manifest({ lodash: '^4.17.21' }), resolved: { lodash: '4.17.21' } };
      const out = reconcileVulnerabilities([labelled('lodash', '4.17.21', 'direct')], [carried]);
      expect(out.map((v) => v.versionSource)).toEqual(['lockfile']);
    });

    it('a scope-only row kept by the legacy fallback takes the current scope, no versionSource', () => {
      const prev = [{ ...vuln('lodash', '4.17.0'), scope: 'dev' as const }];
      const carried = { ...manifest({ lodash: '^4.17.0' }), resolved: { lodash: '4.17.21' } };
      const out = reconcileVulnerabilities(prev, [carried]);
      expect(out).toHaveLength(1);
      expect(out[0]?.scope).toBe('direct');
      expect(out[0]?.versionSource).toBeUndefined();
    });

    it('a legacy UNLABELLED row stays unlabelled (graded, CVE-R3 fallback kept)', () => {
      const prev = [vuln('vitest', '2.1.9')];
      const out = reconcileVulnerabilities(prev, [manifest({}, { vitest: '~2.1.9' })]);
      expect(out).toEqual(prev);
      expect(out[0]).not.toHaveProperty('scope');
      expect(out[0]).not.toHaveProperty('versionSource');
    });
  });
});

describe('normalizeNpmVersion — correctness#3', () => {
  it.each([
    ['^1.2.3', '1.2.3'],
    ['~1.0', '1.0.0'],
    ['1.x', '1.0.0'],
    ['1.2.X', '1.2.0'],
    ['1.*', '1.0.0'],
    ['1', '1.0.0'],
    ['v1.2.3', '1.2.3'],
    ['=v2.0.0', '2.0.0'],
    ['>=1.0.0 <2', '1.0.0'],
    ['1.2.3 - 2.0.0', '1.2.3'],
    ['1.2.3 || 2.0.0', '1.2.3'],
    ['1.2.3-beta.1', '1.2.3-beta.1'],
    ['1.2.3+build.5', '1.2.3'],
    // CVE-R6: `<=X` includes X; a union's floor may sit in a later `||` set.
    ['<=1.2.3', '1.2.3'],
    ['<1.0.0 || >=2.0.0', '2.0.0'],
    // SCN-P2-06: a strict `>X` excludes X — the floor is the next version up.
    ['>1.2.3', '1.2.4'],
    ['> 1.2.3 <2.0.0', '1.2.4'],
    ['>1.2', '1.3.0'],
    ['>1.2.x', '1.3.0'],
    ['>1', '2.0.0'],
    ['>1.x', '2.0.0'],
    ['>1.2.3-rc.1', '1.2.3'],
    ['<1.0.0 || >2.0.0', '2.0.1'],
    ['>=1.2.3', '1.2.3'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeNpmVersion(raw)).toBe(want);
  });

  it.each([
    'workspace:*',
    'file:../x',
    'link:../x',
    'catalog:',
    'git+https://github.com/a/b.git',
    'github:a/b',
    'a/b',
    'https://example.com/x.tgz',
    '*',
    'latest',
    '<2.0.0',
    'npm:lodash',
    '',
  ])('%s → null (not a concrete registry version)', (raw) => {
    expect(normalizeNpmVersion(raw)).toBeNull();
  });

  /* CVE-R2: normalizeNpmVersion alone sees only the spec, not the real package
     name, so a caller pairing it with the manifest KEY would send OSV/the
     registry the alias name. Aliases stay unqueryable here; buildOsvQueries
     resolves them to the real package. */
  it.each(['npm:lodash@4.17.15', 'npm:string-width@^4.2.0', 'npm:@scope/pkg@~1.2'])(
    'CVE-R2: alias %s → null (legacy contract)',
    (raw) => {
      expect(normalizeNpmVersion(raw)).toBeNull();
    },
  );
});

describe('buildOsvQueries — lockfile resolution + scope tagging', () => {
  const lock = () => parseLockfile('pnpm-lock.yaml', PNPM_V9)!;
  const root: DependencyManifest = {
    path: 'package.json',
    ecosystem: 'npm',
    name: 'root',
    version: null,
    dependencies: { lodash: '^4.17.0', 'string-width-cjs': 'npm:string-width@^4.2.0' },
    devDependencies: { vitest: '^2.0.0' },
  };
  const web: DependencyManifest = {
    path: 'apps/web/package.json',
    ecosystem: 'npm',
    name: 'web',
    version: null,
    dependencies: { ws: '^8.0.0', '@acme/core': 'workspace:*' },
    devDependencies: {},
  };
  const find = (qs: OsvQuery[], name: string) => qs.find((q) => q.name === name);

  it('correctness#3: without a lockfile an alias is queried under its REAL name, labelled declared-range', () => {
    const { queries } = buildOsvQueries([root]);
    expect(find(queries, 'string-width')).toMatchObject({
      version: '4.2.0',
      scope: 'direct',
      versionSource: 'declared-range',
    });
    expect(find(queries, 'string-width-cjs')).toBeUndefined();
    const scoped = buildOsvQueries([{ ...root, dependencies: { x: 'npm:@scope/pkg@~1.2' } }]);
    expect(find(scoped.queries, '@scope/pkg')).toMatchObject({ version: '1.2.0' });
    expect(find(queries, 'lodash')).toMatchObject({
      version: '4.17.0',
      versionSource: 'declared-range',
    });
  });

  it('security#8: with a lockfile, direct deps query the installed version', () => {
    const { queries, skipped } = buildOsvQueries([root, web], [lock()]);
    expect(find(queries, 'lodash')).toMatchObject({
      version: '4.17.21',
      scope: 'direct',
      versionSource: 'lockfile',
      manifestPath: 'package.json',
    });
    expect(find(queries, 'string-width')).toMatchObject({ version: '4.2.3', scope: 'direct' });
    expect(find(queries, 'vitest')).toMatchObject({ version: '2.1.9', scope: 'dev' });
    expect(find(queries, 'ws')).toMatchObject({
      version: '8.16.0',
      scope: 'direct',
      manifestPath: 'apps/web/package.json',
    });
    expect(skipped).toBe(1); // @acme/core workspace:* only
  });

  it('security#8: transitive packages are queried, tagged transitive, attributed to the lockfile', () => {
    const { queries } = buildOsvQueries([root, web], [lock()]);
    expect(find(queries, 'minimist')).toMatchObject({
      version: '1.2.5',
      scope: 'transitive',
      versionSource: 'lockfile',
      manifestPath: 'pnpm-lock.yaml',
    });
    // A package that is ALSO a direct dep keeps its direct tag (no duplicate query).
    expect(queries.filter((q) => q.name === 'lodash')).toHaveLength(1);
    expect(find(queries, 'lodash')!.scope).toBe('direct');
  });

  it('honours lockfile versions carried on the manifest (attachResolvedVersions) without the lockfile', () => {
    const { queries } = buildOsvQueries([{ ...root, resolved: { lodash: '4.17.21' } }]);
    expect(find(queries, 'lodash')).toMatchObject({
      version: '4.17.21',
      versionSource: 'lockfile',
    });
  });

  it('tolerates raw dataset manifests that omit a dependency map', () => {
    const raw = { path: 'package.json', ecosystem: 'npm', name: null, version: null } as never;
    expect(buildOsvQueries([raw])).toEqual({
      queries: [],
      skipped: 0,
      labels: {
        scope: { direct: 0, dev: 0, transitive: 0 },
        versionSource: { lockfile: 0, 'declared-range': 0 },
      },
    });
  });

  it('labels: counts the deduped queries by scope and versionSource (the scan-vulns / MCP summary)', () => {
    const plan = buildOsvQueries([root, web], [lock()]);
    const count = (key: 'scope' | 'versionSource', value: string) =>
      plan.queries.filter((q) => q[key] === value).length;
    expect(plan.labels.scope).toEqual({
      direct: count('scope', 'direct'),
      dev: count('scope', 'dev'),
      transitive: count('scope', 'transitive'),
    });
    expect(plan.labels.versionSource).toEqual({
      lockfile: count('versionSource', 'lockfile'),
      'declared-range': count('versionSource', 'declared-range'),
    });
    // lodash, ws, string-width are direct; lodash is also locked but counted once.
    expect(plan.labels.scope.direct).toBe(3);
    expect(plan.labels.scope.dev).toBe(1);
    expect(plan.labels.versionSource['declared-range']).toBe(0);
    const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
    expect(sum(plan.labels.scope)).toBe(plan.queries.length);
    expect(sum(plan.labels.versionSource)).toBe(plan.queries.length);
    // Without a lockfile every query is on a declared range.
    const bare = buildOsvQueries([root]);
    expect(bare.labels.versionSource).toEqual({ lockfile: 0, 'declared-range': 3 });
    expect(bare.labels.scope).toEqual({ direct: 2, dev: 1, transitive: 0 });
  });

  it('counts a non-registry dep declared in many manifests once (matches the old skipped count)', () => {
    const a = { ...web, path: 'a/package.json' };
    expect(buildOsvQueries([web, a]).skipped).toBe(1);
  });
});

describe('isGradedVulnerability — transitive/dev are shown, not graded', () => {
  it('grades direct (and legacy untagged) findings only', () => {
    expect(isGradedVulnerability(vuln('a', '1.0.0'))).toBe(true);
    expect(isGradedVulnerability({ scope: 'direct' })).toBe(true);
    expect(isGradedVulnerability({ scope: 'dev' })).toBe(false);
    expect(isGradedVulnerability({ scope: 'transitive' })).toBe(false);
  });
});

describe('vulnerabilityLabels — one wording for CLI, MCP and dashboard (INV7)', () => {
  it('says "declared range" for range-derived versions and "shown, not graded" for dev/transitive', () => {
    expect(vulnerabilityLabels({ scope: 'direct', versionSource: 'lockfile' })).toEqual([]);
    expect(vulnerabilityLabels(vuln('a', '1.0.0'))).toEqual([]); // legacy unlabelled row
    expect(vulnerabilityLabels({ scope: 'direct', versionSource: 'declared-range' })).toEqual([
      VULN_LABEL_TEXT.declaredRange,
    ]);
    expect(vulnerabilityLabels({ scope: 'dev', versionSource: 'declared-range' })).toEqual([
      VULN_LABEL_TEXT.declaredRange,
      'dev: shown, not graded',
    ]);
    expect(vulnerabilityLabels({ scope: 'transitive', versionSource: 'lockfile' })).toEqual([
      'transitive: shown, not graded',
    ]);
    expect(VULN_LABEL_TEXT.declaredRange).toMatch(/^declared range/);
  });

  it('SCN-P2-04: the declared-range caveat covers stale lockfiles and both error directions', () => {
    // Also emitted when a lockfile exists but doesn't lock the dep, and the
    // lower bound can MISS a vuln as well as flag a patched version.
    expect(VULN_LABEL_TEXT.declaredRange).toBe(
      'declared range (not resolved from a lockfile — installed version may differ)',
    );
    expect(VULN_LABEL_TEXT.declaredRange).not.toMatch(/no lockfile|may be patched/);
  });
});

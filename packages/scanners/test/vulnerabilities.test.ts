import { describe, expect, it } from 'vitest';
import { reconcileVulnerabilities, normalizeNpmVersion } from '../src/vulnerabilities.js';
import type { DependencyManifest, Vulnerability } from '@factstack/spec';

/**
 * v0.11 — reconcileVulnerabilities: the carry-forward filter that lets a CVE
 * scan survive a re-analyze WITHOUT going zombie. A finding survives only when
 * its exact (ecosystem, package, installedVersion) is still installed.
 */

function manifest(deps: Record<string, string>, devDeps: Record<string, string> = {}): DependencyManifest {
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
    expect(reconcileVulnerabilities(prev, [manifest({ 'internal-pkg': 'workspace:*' })])).toEqual([]);
  });
});

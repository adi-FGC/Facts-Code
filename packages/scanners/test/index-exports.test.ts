import { describe, expect, it } from 'vitest';
import * as scanners from '../src/index.js';
import type { DeriveLicenseOptions } from '../src/index.js';

/**
 * The package entry is a contract: core imports the license helpers
 * (HUNT-CORE-10) and the CLI + MCP server build CVE queries from the same
 * lockfile-aware API (INV7). Renaming or dropping any of these breaks a
 * consumer's typecheck, so pin them here.
 */
describe('@factstack/scanners entry exports', () => {
  it.each([
    // core — LICENSE file detection (HUNT-CORE-10 / SCN-04)
    'isLicenseFileName',
    'detectLicenseText',
    'deriveLicenseRisks',
    // CLI scan-vulns + MCP list_vulnerabilities{refresh} — one query builder
    'buildOsvQueries',
    'reconcileVulnerabilities',
    // The CLI carry-forward and the MCP restore share one carry rule
    'carryVulnerabilityScan',
    'isGradedVulnerability',
    'vulnerabilityLabels',
    'parseLockfile',
    'lockfileCandidates',
    'isLockfilePath',
    'attachResolvedVersions',
  ])('exports %s', (name) => {
    expect(typeof (scanners as Record<string, unknown>)[name]).toBe('function');
  });

  /* SCN-1: the manifest-only, scope-less flattenManifests aggregator is gone.
     A consumer building OSV queries must use buildOsvQueries (lockfile +
     direct/transitive/dev scope), so the old path must not come back. */
  it.each(['flattenManifests'])('no longer exports %s', (name) => {
    expect(name in scanners).toBe(false);
  });

  it('exports the shared label wording and the hasLicenseFile option', () => {
    expect(scanners.VULN_LABEL_TEXT.notGraded).toBe('shown, not graded');
    const opts: DeriveLicenseOptions = { hasLicenseFile: true };
    expect(scanners.deriveLicenseRisks(null, new Map(), opts)).toEqual([]);
  });
});

/**
 * Additive (INV4) agent-schema fields and the shared launch/limit constants.
 *
 * The CVE labels (scope, versionSource, resolved, lockfiles) are produced by
 * @factstack/scanners and read by CLI / MCP / UI. Without schema fields they
 * could not be read type-safely and were at risk of being dropped by a schema
 * parse, so "declared range" and "not graded" could not be shown. Old
 * artifacts without them must still validate.
 */

import { describe, expect, it } from 'vitest';
import {
  AgentArtifactSchema,
  DependencyManifestSchema,
  DependencyScopeSchema,
  RiskSchema,
  VersionSourceSchema,
  VulnerabilitySchema,
  VulnerabilityScanSchema,
} from '../src/agent.js';
import { DiffArtifactSchema, VulnDiffSchema } from '../src/diff.js';
import { LOCKFILE_NAMES, NEVER_TEXT_EXTENSIONS, SECRET_SCAN_MAX_BYTES } from '../src/fs.js';
import {
  CLI_NPM_PACKAGE,
  CLI_NPX,
  CLI_PUBLISHED,
  MCP_NPM_PACKAGE,
  MCP_NPX,
  MCP_PUBLISHED,
} from '../src/index.js';

const vuln = {
  id: 'GHSA-xxxx-yyyy-zzzz',
  severity: 'high',
  ecosystem: 'npm',
  package: 'lodash',
  installedVersion: '4.17.20',
  fixedVersion: '4.17.21',
  advisoryUrl: 'https://osv.dev/vulnerability/GHSA-xxxx-yyyy-zzzz',
  lastChecked: 1_758_700_000_000,
  manifestPath: 'package.json',
};

describe('CVE labels are schema fields (INV4: additive + optional)', () => {
  it('keeps scope + versionSource through a parse instead of stripping them', () => {
    const parsed = VulnerabilitySchema.parse({
      ...vuln,
      scope: 'transitive',
      versionSource: 'declared-range',
    });
    expect(parsed.scope).toBe('transitive');
    expect(parsed.versionSource).toBe('declared-range');
  });

  it('uses the scanners literals exactly', () => {
    expect(DependencyScopeSchema.options).toEqual(['direct', 'dev', 'transitive']);
    expect(VersionSourceSchema.options).toEqual(['lockfile', 'declared-range']);
    expect(VulnerabilitySchema.safeParse({ ...vuln, scope: 'indirect' }).success).toBe(false);
  });

  it('still accepts an unlabelled row from an older artifact', () => {
    const parsed = VulnerabilitySchema.parse(vuln);
    expect(parsed.scope).toBeUndefined();
    expect(parsed.versionSource).toBeUndefined();
  });

  it('carries lockfile-installed versions on the manifest and lockfiles on the scan', () => {
    const m = DependencyManifestSchema.parse({
      path: 'package.json',
      ecosystem: 'npm',
      name: null,
      version: null,
      dependencies: { lodash: '^4.17.0' },
      resolved: { lodash: '4.17.20' },
    });
    expect(m.resolved).toEqual({ lodash: '4.17.20' });
    const scan = VulnerabilityScanSchema.parse({
      scannedAt: '2026-09-24T00:00:00.000Z',
      packagesQueried: 1,
      packagesSkipped: 0,
      findings: 1,
      lockfiles: ['pnpm-lock.yaml'],
    });
    expect(scan.lockfiles).toEqual(['pnpm-lock.yaml']);
  });

  it('lets a project record whole-scan warnings, and omits them by default', () => {
    const base = {
      generatedAt: '2026-09-24T00:00:00.000Z',
      project: {
        name: 'p',
        root: '.',
        languages: [],
        frameworks: [],
        entryPoints: [],
        monorepo: null,
      },
      files: [],
      graph: { nodes: [], edges: [], cycles: [] },
      routes: [],
      scripts: {},
      capabilities: [],
      risks: [],
      stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
    };
    expect(AgentArtifactSchema.parse(base).project.scanWarnings).toBeUndefined();
    const warned = { ...base, project: { ...base.project, scanWarnings: ['tree truncated'] } };
    expect(AgentArtifactSchema.parse(warned).project.scanWarnings).toEqual(['tree truncated']);
  });
});

describe('diff vulns.incomplete (INV4: additive + optional)', () => {
  const diff = {
    generatedAt: '2026-09-24T00:00:00.000Z',
    from: { at: '2026-09-23T00:00:00.000Z', snapshotFile: '.facts/snapshots/a.json' },
    to: { at: '2026-09-24T00:00:00.000Z' },
    stats: {
      loc: { before: 0, after: 0, delta: 0 },
      tokens: { before: 0, after: 0, delta: 0 },
      files: { before: 0, after: 0, delta: 0 },
      risks: { before: 0, after: 0, delta: 0 },
      todos: { before: 0, after: 0, delta: 0 },
      secrets: { before: 0, after: 0, delta: 0 },
    },
    files: { added: [], removed: [], changed: [], incomplete: true },
  };

  it('keeps the flag a snapshot base sets, instead of stripping it', () => {
    const parsed = DiffArtifactSchema.parse({
      ...diff,
      vulns: { new: [], fixed: [], severityShift: 0, incomplete: true },
    });
    expect(parsed.vulns.incomplete).toBe(true);
  });

  it('still accepts diff JSON written before the flag, and only `true` is allowed', () => {
    expect(DiffArtifactSchema.parse(diff).vulns.incomplete).toBeUndefined();
    expect(
      DiffArtifactSchema.parse({ ...diff, vulns: { new: ['GHSA-1'], fixed: [], severityShift: 3 } })
        .vulns.incomplete,
    ).toBeUndefined();
    expect(VulnDiffSchema.safeParse({ incomplete: false }).success).toBe(false);
  });
});

describe('shared launch + limit constants', () => {
  it('keeps ONE npx pair; the publish flags are booleans the owner flips', () => {
    expect(CLI_NPX).toBe(`npx ${CLI_NPM_PACKAGE}`);
    expect(MCP_NPX).toBe(`npx -y ${MCP_NPM_PACKAGE}`);
    // Only the owner flips these, on publish (apps/mcp-server/PUBLISHING.md).
    // Pin the type, not the value, so the publish change lands on a green suite.
    expect(typeof CLI_PUBLISHED).toBe('boolean');
    expect(typeof MCP_PUBLISHED).toBe('boolean');
  });

  it('exports the one secret-scan ceiling both hosts use', () => {
    expect(SECRET_SCAN_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(NEVER_TEXT_EXTENSIONS.has('.png')).toBe(true);
  });

  it('exports the one lockfile list scanners and the browser scan share', () => {
    expect([...LOCKFILE_NAMES]).toEqual([
      'pnpm-lock.yaml',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
    ]);
  });
});

/* correctness#1 / data-model#1 — the secret fingerprint and the rules
   revision survive a schema parse (a stripped field would silently turn every
   review back into the preview-keyed comparison). */
describe('secret fingerprint + rules revision (INV4: additive + optional)', () => {
  const risk = {
    severity: 'high',
    category: 'secret',
    rule: 'private-key-header',
    file: 'deploy/id_rsa',
    line: 1,
    message: 'Private key block detected (entropy 3.38). Rotate and remove from source.',
    preview: '----***--',
  };
  const artifact = {
    generatedAt: '2026-09-24T00:00:00.000Z',
    project: {
      name: 'p',
      root: '.',
      languages: [],
      frameworks: [],
      entryPoints: [],
      monorepo: null,
    },
    files: [],
    graph: { nodes: [], edges: [], cycles: [] },
    routes: [],
    scripts: {},
    capabilities: [],
    risks: [risk],
    stats: { loc: 0, fileCount: 0, packageCount: 0, totalTokenCost: 0 },
  };

  it('keeps a risk fingerprint and the artifact rules revision through a parse', () => {
    const parsed = AgentArtifactSchema.parse({
      ...artifact,
      secretRulesRev: '0123456789ab',
      risks: [{ ...risk, fingerprint: 'abcdef012345' }],
    });
    expect(parsed.secretRulesRev).toBe('0123456789ab');
    expect(parsed.risks[0]!.fingerprint).toBe('abcdef012345');
  });

  it('still accepts an artifact written before fingerprints', () => {
    const parsed = AgentArtifactSchema.parse(artifact);
    expect(parsed.secretRulesRev).toBeUndefined();
    expect(parsed.risks[0]!.fingerprint).toBeUndefined();
  });

  it('accepts only a lowercase hex digest, so the field can never carry a value', () => {
    for (const bad of ['ghp_abcdef0123456789', 'ABCDEF012345', 'abc', 'abcdef01234 ']) {
      expect(RiskSchema.safeParse({ ...risk, fingerprint: bad }).success, bad).toBe(false);
    }
  });
});

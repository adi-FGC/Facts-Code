/**
 * Unit tests for the CLI modules split out of cli.ts so they can be tested
 * without spawning the binary: target normalization (CLI-06), the Node floor
 * (tech-debt#1), the lockfile-aware CVE plumbing + scan carry-forward
 * (security#8 / correctness#3 / data-model#46 / emit request), the diff
 * endpoints + default review base (correctness#2 / data-model#4), ci-report's
 * graded shift (cli-r3-2), the MCP command `install` registers (mcp-pkg-3 /
 * ux#6 / ux#8 / cli-r3-1 / cli-r3-3) and the publish-flag help (cli-r3-4).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentArtifact,
  DependencyManifest,
  HumanArtifact,
  Risk,
  Vulnerability,
} from '@factstack/spec';
import { BASELINE_AGENT_FILE, MCP_NPM_PACKAGE, MCP_NPX, rootArgOf } from '@factstack/spec';
import ts from 'typescript';
import { parseLockfile, VULN_LABEL_TEXT } from '@factstack/scanners';
import { DEFAULT_MCP_COMMAND, parseServerCommand, withProjectRoot } from '@factstack/skills';
import { analyze, diffArtifacts, isRollupEndpoint } from '@factstack/core';
import { StaleResaveError, writeArtifacts } from '@factstack/emit';
import { nodeFS } from '@factstack/fs-node';
import { isPathLike, normalizeTarget } from '../src/targets.js';
import { NODE_ENGINES, NODE_FLOOR, nodeAtLeast } from '../src/runtime.js';
import {
  declaredRangeNote,
  describePlan,
  labelVulnerabilities,
  planOsvQueries,
  planOutdatedQueries,
  readLockfiles,
  restoreVulnScan,
  saveScannedArtifacts,
  scanTarget,
} from '../src/vulns.js';
import * as endpoints from '../src/endpoints.js';
import { renderCiReport } from '../src/emitters/ci-report.js';
import {
  defaultBaseEndpoint,
  defaultHeadEndpoint,
  gradedSeverityShift,
  loadDiffEndpoint,
  notGradedVulnNotes,
  reportFindings,
  resolveEndpointPair,
} from '../src/endpoints.js';
import {
  formatServerCommand,
  isDefaultMcpCommand,
  MCP_NOT_PUBLISHED_NOTE,
  mcpPortabilityNote,
  mcpServerNote,
} from '../src/mcpInstall.js';
import {
  freshnessHookCommandHelp,
  gitHookCommandHelp,
  serverCommandHelp,
} from '../src/launchHelp.js';
import { installRoot, mcpStatusLine } from '../src/commands/install.js';
import { writeQuickReport } from '../src/commands/quick.js';
import { FRESHNESS_HOOK_COMMAND } from '../src/agentHook.js';
import { GIT_HOOK_COMMAND } from '../src/gitHook.js';
import kleur from 'kleur';
import { stripVTControlCharacters } from 'node:util';

const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'facts-cli-mod-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('normalizeTarget (CLI-06)', () => {
  const root = path.resolve(tmpdir(), 'proj');
  it.each([
    ['src\\a.ts', 'src/a.ts'],
    ['.\\src\\a.ts', 'src/a.ts'],
    ['./src/a.ts', 'src/a.ts'],
    ['././src/a.ts', 'src/a.ts'],
    ['  src/a.ts ', 'src/a.ts'],
    [path.join(root, 'src', 'a.ts'), 'src/a.ts'],
    [root, '.'],
    ['buildMemory', 'buildMemory'],
    ['src/a.ts#fn', 'src/a.ts#fn'],
  ])('%s → %s', (input, want) => {
    expect(normalizeTarget(root, input)).toBe(want);
  });

  it('leaves an absolute path outside the root absolute', () => {
    const outside = path.resolve(tmpdir(), 'elsewhere', 'x.ts');
    expect(normalizeTarget(root, outside)).toBe(outside.replaceAll('\\', '/'));
  });

  it('tells paths from symbol names', () => {
    expect(isPathLike('src/a.ts')).toBe(true);
    expect(isPathLike('a.ts')).toBe(true);
    expect(isPathLike('buildMemory')).toBe(false);
  });
});

describe('Node floor (tech-debt#1)', () => {
  it('is 24.3 and matches package.json engines', () => {
    expect(NODE_FLOOR).toEqual([24, 3, 0]);
    const pkg = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { engines: { node: string }; description: string };
    expect(pkg.engines.node).toBe(NODE_ENGINES);
    expect(pkg.description).not.toMatch(/Node 20|ui-remix server/);
  });

  it.each([
    ['24.3.0', true],
    ['v24.3.0', true],
    ['24.10.1', true],
    ['26.8.1', true],
    ['24.2.9', false],
    ['22.18.0', false],
    ['20.19.0', false],
  ])('nodeAtLeast(%s) = %s', (v, ok) => {
    expect(nodeAtLeast(v)).toBe(ok);
  });
});

/* ── CVE plumbing ─────────────────────────────────────────────────────── */

const manifest = (over: Partial<DependencyManifest> = {}): DependencyManifest => ({
  path: 'package.json',
  ecosystem: 'npm',
  name: 'demo',
  version: '1.0.0',
  dependencies: { lodash: '^4.17.0', aliased: 'npm:minimist@^1.2.0', local: 'workspace:*' },
  devDependencies: { vitest: '^1.0.0' },
  ...over,
});

const PACKAGE_LOCK = JSON.stringify({
  name: 'demo',
  lockfileVersion: 3,
  packages: {
    '': {
      name: 'demo',
      dependencies: { lodash: '^4.17.0', aliased: 'npm:minimist@^1.2.0' },
      devDependencies: { vitest: '^1.0.0' },
    },
    'node_modules/lodash': { version: '4.17.21' },
    'node_modules/aliased': { name: 'minimist', version: '1.2.8' },
    'node_modules/vitest': { version: '1.6.0', dev: true },
    'node_modules/tinypool': { version: '0.8.4', dev: true },
  },
});

describe('lockfile-aware OSV queries (security#8, owner CVE decision)', () => {
  it('reads the lockfiles that cover the manifests, from disk', () => {
    const root = tempDir();
    writeFileSync(path.join(root, 'package-lock.json'), PACKAGE_LOCK);
    const locks = readLockfiles(root, [manifest()]);
    expect(locks.map((l) => l.path)).toEqual(['package-lock.json']);
    expect(readLockfiles(tempDir(), [manifest()])).toEqual([]); // none → declared ranges
  });

  it('queries INSTALLED versions, real alias names, and transitive packages', () => {
    const lock = parseLockfile('package-lock.json', PACKAGE_LOCK)!;
    const plan = planOsvQueries([manifest()], [lock]);
    const q = (name: string) => plan.queries.find((x) => x.name === name);
    expect(q('lodash')).toMatchObject({
      version: '4.17.21',
      scope: 'direct',
      versionSource: 'lockfile',
    });
    expect(q('minimist')).toMatchObject({ version: '1.2.8', scope: 'direct' });
    expect(q('aliased')).toBeUndefined(); // the alias key is not a package
    expect(q('vitest')).toMatchObject({ version: '1.6.0', scope: 'dev' });
    expect(q('tinypool')).toMatchObject({ scope: 'transitive', versionSource: 'lockfile' });
    expect(plan.skipped).toBe(1); // workspace:*
    expect(describePlan(plan).join('\n')).toMatch(/transitive.*shown, not graded/);
  });

  it('--prod-only keeps direct runtime deps only', () => {
    const lock = parseLockfile('package-lock.json', PACKAGE_LOCK)!;
    const plan = planOsvQueries([manifest()], [lock], { prodOnly: true });
    expect(plan.queries.map((x) => x.name).sort()).toEqual(['lodash', 'minimist']);
    expect(plan.labels.scope).toEqual({ direct: 2, dev: 0, transitive: 0 });
  });

  it('--prod-only counts skipped deps in its own scope only (cli-r3-5)', () => {
    const lock = parseLockfile('package-lock.json', PACKAGE_LOCK)!;
    // A dev dep with no registry version was never in a prod-only scan.
    const m = manifest({ devDependencies: { vitest: '^1.0.0', 'dev-local': 'file:../tools' } });
    expect(planOsvQueries([m], [lock]).skipped).toBe(2); // workspace:* + file:
    const prod = planOsvQueries([m], [lock], { prodOnly: true });
    expect(prod.skipped).toBe(1); // workspace:* only
    expect(describePlan(prod).join('\n')).toMatch(/^1 skipped/m);
  });

  it('labels declared-range queries when there is no lockfile', () => {
    const plan = planOsvQueries([manifest()], []);
    expect(plan.queries.find((x) => x.name === 'lodash')).toMatchObject({
      version: '4.17.0',
      versionSource: 'declared-range',
    });
    // The scanners' shared wording, not a CLI-only phrasing (INV7).
    expect(describePlan(plan).join('\n')).toContain(`on a ${VULN_LABEL_TEXT.declaredRange}`);
    expect(describePlan(plan).join('\n')).not.toMatch(/no lockfile|may be patched/);
  });

  it('describePlan counts from the plan labels, in the shared "shown, not graded" wording', () => {
    const lines = describePlan({
      queries: [],
      skipped: 0,
      labels: {
        scope: { direct: 2, dev: 3, transitive: 40 },
        versionSource: { lockfile: 44, 'declared-range': 1 },
      },
    });
    expect(lines[0]).toBe(
      `2 direct · 3 dev · 40 transitive — dev/transitive: ${VULN_LABEL_TEXT.notGraded}`,
    );
    expect(lines[1]).toBe(`1 on a ${VULN_LABEL_TEXT.declaredRange}`);
    expect(declaredRangeNote(2, 'finding')).toBe(
      `2 findings on a ${VULN_LABEL_TEXT.declaredRange}`,
    );
    expect(declaredRangeNote(1, 'finding')).toMatch(/^1 finding on a declared range/);
  });

  it('scan-vulns --json rows carry the same graded + labels shape as the MCP tool', () => {
    const rows = labelVulnerabilities([
      vuln(),
      vuln({ id: 'GHSA-dev', scope: 'dev', versionSource: 'declared-range' }),
      vuln({ id: 'GHSA-t', scope: 'transitive' }),
    ]);
    expect(rows[0]).toMatchObject({ id: 'GHSA-lodash', graded: true });
    expect(rows[0]).not.toHaveProperty('labels');
    expect(rows[1]).toMatchObject({
      graded: false,
      labels: [VULN_LABEL_TEXT.declaredRange, `dev: ${VULN_LABEL_TEXT.notGraded}`],
    });
    expect(rows[2]).toMatchObject({
      graded: false,
      labels: [`transitive: ${VULN_LABEL_TEXT.notGraded}`],
    });
  });

  it('outdated checks the project’s own deps at installed versions, not transitive ones', () => {
    const lock = parseLockfile('package-lock.json', PACKAGE_LOCK)!;
    const { queries, skipped } = planOutdatedQueries(
      [
        manifest(),
        manifest({
          path: 'py/requirements.txt',
          ecosystem: 'pypi',
          dependencies: { flask: '2.0.0' },
          devDependencies: {},
        }),
      ],
      [lock],
    );
    expect(queries).toEqual(
      expect.arrayContaining([
        { ecosystem: 'npm', name: 'lodash', current: '4.17.21' },
        { ecosystem: 'npm', name: 'minimist', current: '1.2.8' },
        { ecosystem: 'npm', name: 'vitest', current: '1.6.0' },
      ]),
    );
    expect(queries.some((x) => x.name === 'tinypool')).toBe(false);
    expect(skipped).toBe(2); // workspace:* + the non-npm flask
  });
});

/* ── scan carry-forward ───────────────────────────────────────────────── */

const vuln = (over: Partial<Vulnerability> = {}): Vulnerability => ({
  id: 'GHSA-lodash',
  severity: 'high',
  ecosystem: 'npm',
  package: 'lodash',
  installedVersion: '4.17.21',
  fixedVersion: '4.17.22',
  advisoryUrl: 'https://github.com/advisories/GHSA-lodash',
  lastChecked: 1_700_000_000_000,
  manifestPath: 'package.json',
  scope: 'direct',
  versionSource: 'lockfile',
  ...over,
});
const SCAN = {
  scannedAt: '2026-09-20T00:00:00.000Z',
  source: 'osv.dev' as const,
  packagesQueried: 5,
  packagesSkipped: 1,
  findings: 1,
};
const freshAgent = (): AgentArtifact =>
  ({ dependencyManifests: [manifest()], vulnerabilities: [] }) as unknown as AgentArtifact;

function projectWithPrior(prior: string): string {
  const root = tempDir();
  mkdirSync(path.join(root, '.facts'), { recursive: true });
  writeFileSync(path.join(root, '.facts', 'agent.json'), prior);
  writeFileSync(path.join(root, 'package-lock.json'), PACKAGE_LOCK);
  return root;
}

describe('restoreVulnScan (carry-forward hardening)', () => {
  it('no prior artifact: nothing to carry, and silent', () => {
    const agent = freshAgent();
    expect(restoreVulnScan(tempDir(), agent)).toEqual({ carried: false });
  });

  it('carries a scan forward, reconciled against the LOCKFILE installed versions', () => {
    const root = projectWithPrior(
      JSON.stringify({
        // Two rows, two recorded findings: a consistent scan.
        vulnerabilityScan: { ...SCAN, findings: 2 },
        vulnerabilities: [vuln(), vuln({ id: 'GHSA-gone', package: 'removed-dep' })],
      }),
    );
    const agent = freshAgent();
    expect(restoreVulnScan(root, agent)).toEqual({ carried: true });
    expect(agent.vulnerabilities.map((v) => v.id)).toEqual(['GHSA-lodash']);
    expect(agent.vulnerabilityScan).toMatchObject({ scannedAt: SCAN.scannedAt, findings: 1 });
  });

  /* Rows that are not an array used to default to [], so the scan
     carried as "scanned and clean", findings 0, with no warning. The MCP
     restore drops it — both now share scanners' carryVulnerabilityScan. */
  it.each([
    ['null', null],
    ['an object', {}],
    ['missing', undefined],
  ])('a scan whose vulnerabilities are %s is dropped, never carried as clean', (_label, rows) => {
    const root = projectWithPrior(
      JSON.stringify({ vulnerabilityScan: { ...SCAN, findings: 3 }, vulnerabilities: rows }),
    );
    const agent = freshAgent();
    const r = restoreVulnScan(root, agent);
    expect(r.carried).toBe(false);
    expect(r.warning).toMatch(/unexpected shape.*scan-vulns/);
    expect(agent.vulnerabilityScan).toBeUndefined();
  });

  it('a recorded findings count that the rows do not match is reported', () => {
    const root = projectWithPrior(
      JSON.stringify({ vulnerabilityScan: { ...SCAN, findings: 3 }, vulnerabilities: [vuln()] }),
    );
    const agent = freshAgent();
    const r = restoreVulnScan(root, agent);
    expect(r.carried).toBe(true);
    expect(r.warning).toMatch(/recorded 3 findings but held 1 row.*scan-vulns/);
  });

  /* A partial scan stays partial across a re-analyze. */
  it('the carried scan keeps its unscanned count', () => {
    const root = projectWithPrior(
      JSON.stringify({ vulnerabilityScan: { ...SCAN, unscanned: 2 }, vulnerabilities: [vuln()] }),
    );
    const agent = freshAgent();
    expect(restoreVulnScan(root, agent)).toEqual({ carried: true });
    expect(agent.vulnerabilityScan).toMatchObject({ unscanned: 2, findings: 1 });
  });

  it('a corrupt prior file warns (never silent) and does not throw', () => {
    const root = projectWithPrior('{"vulnerabilityScan": {"scannedAt": ');
    const agent = freshAgent();
    const r = restoreVulnScan(root, agent);
    expect(r.carried).toBe(false);
    expect(r.warning).toMatch(/not valid JSON.*scan-vulns/);
    expect(agent.vulnerabilityScan).toBeUndefined();
  });

  it('data-model#46: a scan in an older shape is dropped with a warning, not fatal', () => {
    const legacyScan: Record<string, unknown> = { ...SCAN };
    delete legacyScan.packagesSkipped;
    const root = projectWithPrior(
      JSON.stringify({ vulnerabilityScan: legacyScan, vulnerabilities: [vuln()] }),
    );
    const agent = freshAgent();
    const r = restoreVulnScan(root, agent);
    expect(r.carried).toBe(false);
    expect(r.warning).toMatch(/unexpected shape/);
    expect(agent.vulnerabilities).toEqual([]);
  });

  /* R8: scan-vulns re-saves the analysis it loaded. Without
     rotateBaseline:false, an analyze the per-edit hook wrote in between
     (newer generatedAt) was parked as the review baseline behind the older
     head — review then compared against the future. */
  it('scan-vulns write-back never rotates the review baseline', async () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'package.json'), '{"name":"p","version":"1.0.0"}');
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const analysis = async (at: string) => {
      const r = await analyze(nodeFS(root), { root: '.', projectName: 'p' });
      r.agent.generatedAt = at;
      return r;
    };
    const save = async (at: string) => {
      const r = await analysis(at);
      await writeArtifacts({ root, agent: r.agent, human: r.human, addGitignoreEntry: false });
      return r;
    };
    const baselineAt = () =>
      JSON.parse(readFileSync(path.join(root, '.facts', ...BASELINE_AGENT_FILE.split('/')), 'utf8'))
        .generatedAt as string;
    const headAt = () =>
      JSON.parse(readFileSync(path.join(root, '.facts', 'agent.json'), 'utf8')).generatedAt;

    await save('2026-09-24T10:00:01.000Z');
    const loaded = await save('2026-09-24T10:00:02.000Z'); // what scan-vulns loads
    const newest = await save('2026-09-24T10:00:03.000Z'); // the hook's analyze lands meanwhile
    expect(baselineAt()).toBe('2026-09-24T10:00:02.000Z');

    /* emit (StaleResaveError) refuses to write the stale loaded copy over
       the newer analysis — scan-vulns' scanTarget never asks it to. */
    await expect(
      saveScannedArtifacts({
        root,
        agent: { ...loaded.agent, vulnerabilities: [], vulnerabilityScan: SCAN },
        human: loaded.human,
        memoryBody: '# memory\n',
      }),
    ).rejects.toThrow(StaleResaveError);
    expect(headAt()).toBe('2026-09-24T10:00:03.000Z');

    // The scan on the newest head: re-saved, the baseline not rotated.
    await saveScannedArtifacts({
      root,
      agent: { ...newest.agent, vulnerabilities: [], vulnerabilityScan: SCAN },
      human: newest.human,
      memoryBody: '# memory\n',
    });
    expect(headAt()).toBe('2026-09-24T10:00:03.000Z');
    expect(baselineAt()).toBe('2026-09-24T10:00:02.000Z'); // not :03 parked over itself
    expect(existsSync(path.join(root, '.gitignore'))).toBe(false); // never touches .gitignore
  }, 60_000);

  /* data-model#3 / correctness#9: scanTarget picks what the write step
     applies the scan to. */
  describe('scanTarget', () => {
    const pair = (at: string) =>
      ({
        agent: { generatedAt: at, files: [], graph: {} },
        human: { generatedAt: at },
      }) as unknown as { agent: AgentArtifact; human: HumanArtifact };
    const factsWith = (agent: unknown, human?: unknown): string => {
      const root = tempDir();
      mkdirSync(path.join(root, '.facts'));
      writeFileSync(path.join(root, '.facts', 'agent.json'), JSON.stringify(agent));
      if (human !== undefined) {
        writeFileSync(path.join(root, '.facts', 'human.json'), JSON.stringify(human));
      }
      return root;
    };

    it('keeps the loaded pair unless agent.json holds a NEWER full analysis', async () => {
      const loaded = pair('2026-09-24T10:00:02.000Z');
      for (const disk of [
        { generatedAt: '2026-09-24T10:00:02.000Z', files: [], graph: {} }, // the same
        { generatedAt: '2026-09-24T10:00:01.000Z', files: [], graph: {} }, // older
        { generatedAt: '2026-09-24T10:00:03.000Z', stats: {} }, // a rollup, not an analysis
      ]) {
        const r = await scanTarget(factsWith(disk), loaded, { rereadMs: 1 });
        expect(r.adopted).toBe(false);
        expect(r.agent).toBe(loaded.agent);
      }
      const unreadable = tempDir();
      mkdirSync(path.join(unreadable, '.facts'));
      writeFileSync(path.join(unreadable, '.facts', 'agent.json'), '{ half a file');
      expect((await scanTarget(unreadable, loaded, { rereadMs: 1 })).adopted).toBe(false);
    });

    it('refuses a newer agent.json whose human.json is from another run', async () => {
      const newer = { generatedAt: '2026-09-24T10:00:03.000Z', files: [], graph: {} };
      const root = factsWith(newer, { generatedAt: '2026-09-24T10:00:02.000Z' });
      await expect(
        scanTarget(root, pair('2026-09-24T10:00:02.000Z'), { rereadMs: 1 }),
      ).rejects.toThrow(/newer analysis \(2026-09-24T10:00:03\.000Z\).*not writing the older/);
    });
  });

  it('data-model#46: one malformed row costs only itself', () => {
    const broken: Record<string, unknown> = { ...vuln({ id: 'GHSA-broken' }) };
    delete broken.installedVersion;
    const root = projectWithPrior(
      JSON.stringify({ vulnerabilityScan: SCAN, vulnerabilities: [vuln(), broken] }),
    );
    const agent = freshAgent();
    const r = restoreVulnScan(root, agent);
    expect(r.carried).toBe(true);
    expect(r.warning).toMatch(/1 malformed vulnerability row/);
    expect(agent.vulnerabilities.map((v) => v.id)).toEqual(['GHSA-lodash']);
  });
});

/* ── diff endpoints + the review baseline ─────────────────────────────── */

const risk = (over: Partial<Risk>): Risk =>
  ({ severity: 'high', category: 'secret', rule: 'aws-access-key', message: 'm', ...over }) as Risk;
const full = (at: string, risks: Risk[] = []): AgentArtifact =>
  ({
    generatedAt: at,
    files: [{ path: 'src/a.ts', loc: 1, tokenCost: 1, todos: [] }],
    risks,
    stats: { loc: 1, fileCount: 1, packageCount: 0, totalTokenCost: 1 },
    vulnerabilities: [],
  }) as unknown as AgentArtifact;

describe('diff endpoints (correctness#2 / data-model#4)', () => {
  function factsDir(): string {
    const d = path.join(tempDir(), '.facts');
    mkdirSync(path.join(d, 'snapshots'), { recursive: true });
    return d;
  }
  const snapshot = (at: string) =>
    JSON.stringify({
      at,
      stats: { loc: 1, fileCount: 1, totalTokenCost: 1 },
      risks: 2,
      secrets: 1,
    });

  it('the default base is the review baseline when it exists', () => {
    const d = factsDir();
    writeFileSync(path.join(d, 'snapshots', '2026-09-01.json'), snapshot('2026-09-01'));
    writeFileSync(path.join(d, 'snapshots', '2026-09-02.json'), snapshot('2026-09-02'));
    const baseline = path.join(d, ...BASELINE_AGENT_FILE.split('/'));
    mkdirSync(path.dirname(baseline), { recursive: true });
    writeFileSync(baseline, JSON.stringify(full('2026-09-01T12:00:00.000Z')));
    const base = defaultBaseEndpoint(d)!;
    expect(base.source).toBe('baseline');
    expect(isRollupEndpoint(base.endpoint)).toBe(false);
  });

  it('without a baseline it falls back to the PREVIOUS snapshot, marked as a rollup', () => {
    const d = factsDir();
    writeFileSync(path.join(d, 'snapshots', '2026-09-01.json'), snapshot('2026-09-01'));
    writeFileSync(path.join(d, 'snapshots', '2026-09-02.json'), snapshot('2026-09-02'));
    const base = defaultBaseEndpoint(d)!;
    expect(base.source).toBe('snapshot');
    expect(base.endpoint.artifact.generatedAt).toBe('2026-09-01');
    expect(isRollupEndpoint(base.endpoint)).toBe(true);
    expect(defaultBaseEndpoint(path.join(tempDir(), '.facts'))).toBeNull();
  });

  it('resolveEndpointPair: the 0/1/2-arg dispatch diff and review share (cli-dry-2)', () => {
    const d = factsDir();
    writeFileSync(path.join(d, 'snapshots', '2026-09-01.json'), snapshot('2026-09-01'));
    writeFileSync(path.join(d, 'snapshots', '2026-09-02.json'), snapshot('2026-09-02'));
    const at = (ep: { artifact: AgentArtifact } | null) => ep?.artifact.generatedAt ?? null;

    // No agent.json yet: a null head; the base is the previous rollup, marked as such.
    expect(resolveEndpointPair(undefined, undefined, d)).toMatchObject({
      to: null,
      baseSource: 'snapshot',
    });
    writeFileSync(path.join(d, 'agent.json'), JSON.stringify(full('2026-09-02T12:00:00.000Z')));
    const zero = resolveEndpointPair(undefined, undefined, d);
    expect([at(zero.from), at(zero.to), zero.baseSource]).toEqual([
      '2026-09-01',
      '2026-09-02T12:00:00.000Z',
      'snapshot',
    ]);

    // One arg: a bare snapshot stamp vs the head. A named base has no source.
    const one = resolveEndpointPair('2026-09-02', undefined, d);
    expect([at(one.from), at(one.to)]).toEqual(['2026-09-02', '2026-09-02T12:00:00.000Z']);
    expect(one).not.toHaveProperty('baseSource');

    // Two args: both resolved the same way (with or without .json).
    const two = resolveEndpointPair('2026-09-01', '2026-09-02.json', d);
    expect([at(two.from), at(two.to)]).toEqual(['2026-09-01', '2026-09-02']);
    expect(two).not.toHaveProperty('baseSource');
    expect(resolveEndpointPair('nope', '2026-09-02', d).from).toBeNull();

    // The review baseline wins once it exists; a lone second arg is the zero-arg path.
    const baseline = path.join(d, ...BASELINE_AGENT_FILE.split('/'));
    mkdirSync(path.dirname(baseline), { recursive: true });
    writeFileSync(baseline, JSON.stringify(full('2026-09-01T12:00:00.000Z')));
    expect(resolveEndpointPair(undefined, undefined, d).baseSource).toBe('baseline');
    expect(resolveEndpointPair(undefined, '2026-09-01', d).baseSource).toBe('baseline');

    expect(resolveEndpointPair(undefined, undefined, path.join(tempDir(), '.facts'))).toEqual({
      from: null,
      to: null,
    });
  });

  it('reportFindings: a swapped secret is 1 new + 1 fixed, paths only', () => {
    const before = { artifact: full('a', [risk({ file: 'src/config.ts', preview: 'AKIA***1' })]) };
    const after = { artifact: full('b', [risk({ file: 'src/other.ts', preview: 'AKIA***2' })]) };
    expect(reportFindings(before, after)).toEqual({
      secrets: { new: 1, fixed: 1, newFiles: ['src/other.ts'] },
      risks: { new: 0, fixed: 0, newFiles: [] },
    });
    expect(JSON.stringify(reportFindings(before, after))).not.toContain('AKIA');
  });

  /* A baseline from an older secret scanner (no secretRulesRev) and a
     head that adds a key to a file both sides have. Core moves it to
     ungradedSecrets; ci-report used to drop that bucket and say "No
     risk-surface change". */
  it('reportFindings carries the ungraded secrets and the reason into ci-report', () => {
    const before = { artifact: full('a') };
    const after = {
      artifact: {
        ...full('b', [risk({ file: 'src/a.ts', preview: 'AKIA***9' })]),
        secretRulesRev: 'rev-1',
      } as AgentArtifact,
    };
    const f = reportFindings(before, after)!;
    expect(f.secrets).toEqual({ new: 0, fixed: 0, newFiles: [] });
    expect(f.ungradedSecrets).toEqual({
      new: 1,
      fixed: 0,
      newFiles: ['src/a.ts'],
      reason: 'the baseline was made by an older secret scanner',
    });
    expect(JSON.stringify(f)).not.toContain('AKIA');
    const md = renderCiReport(diffArtifacts(before, after), { findings: f });
    expect(md).not.toContain('No risk-surface change');
    expect(md).toContain('Secrets changed in existing files — not graded');
  });

  /* The per-edit `analyze --minimal` hook marks agent.json stale; the
     default head carries that mark, a named head does not. */
  it('the default head carries its stale mark', () => {
    const d = factsDir();
    writeFileSync(path.join(d, 'agent.json'), JSON.stringify(full('2026-09-02T12:00:00.000Z')));
    const baseline = path.join(d, ...BASELINE_AGENT_FILE.split('/'));
    mkdirSync(path.dirname(baseline), { recursive: true });
    writeFileSync(baseline, JSON.stringify(full('2026-09-01T12:00:00.000Z')));
    expect(resolveEndpointPair(undefined, undefined, d)).not.toHaveProperty('headStale');
    writeFileSync(
      path.join(d, 'agent.json.stale'),
      JSON.stringify({ file: 'agent.json', staleSince: '2026-09-03T00:00:00.000Z' }),
    );
    const stale = { file: 'agent.json', staleSince: '2026-09-03T00:00:00.000Z' };
    expect(resolveEndpointPair(undefined, undefined, d).headStale).toEqual(stale);
    expect(resolveEndpointPair(baseline, undefined, d).headStale).toEqual(stale);
    expect(defaultHeadEndpoint(d).stale).toEqual(stale);
    // A head the caller names is not the hook's agent.json.
    expect(resolveEndpointPair(baseline, path.join(d, 'agent.json'), d)).not.toHaveProperty(
      'headStale',
    );
  });

  it('reportFindings is null against a rollup (only counts exist)', () => {
    const d = factsDir();
    const p = path.join(d, 'snapshots', 's.json');
    writeFileSync(p, snapshot('2026-09-01'));
    expect(reportFindings(loadDiffEndpoint(p)!, { artifact: full('b') })).toBeNull();
  });

  /* data-model#35: the CLI kept its own isRollupEndpoint, which read ANY
     snapshotFile as a rollup; core's (the verdict's) compares a full artifact
     that only records where it was loaded from. One test now, core's. */
  it('uses core’s rollup test: a full artifact with a snapshotFile origin is compared in full', () => {
    expect(endpoints).not.toHaveProperty('isRollupEndpoint');
    const base = {
      artifact: full('a', [risk({ file: 'src/config.ts', preview: 'AKIA***1' })]),
      snapshotFile: path.join('.facts', ...BASELINE_AGENT_FILE.split('/')),
    };
    const head = { artifact: full('b') };
    expect(isRollupEndpoint(base)).toBe(false);
    expect(reportFindings(base, head)).toEqual({
      secrets: { new: 0, fixed: 1, newFiles: [] },
      risks: { new: 0, fixed: 0, newFiles: [] },
    });
    expect(diffArtifacts(base, head).vulns.incomplete).toBeUndefined();
  });
});

/* Owner decision 2026-09-24: dev/transitive advisories are listed, not graded
   — and the ci-report verdict and --fail-on-shift gate follow it (cli-r3-2). */
describe('ci-report grades direct advisories only (cli-r3-2)', () => {
  const at = (when: string, vulns: Vulnerability[]) => ({
    artifact: { ...full(when), vulnerabilities: vulns } as AgentArtifact,
  });
  const transitive = vuln({ id: 'GHSA-t', scope: 'transitive', severity: 'critical' });

  it('a new transitive advisory is listed and labelled, but moves no graded shift', () => {
    const base = at('a', [vuln()]);
    const head = at('b', [vuln(), transitive]);
    const diff = diffArtifacts(base, head);
    expect(diff.vulns.new).toEqual(['GHSA-t']); // the list stays complete
    expect(gradedSeverityShift(base, head)).toBe(0);
    expect(notGradedVulnNotes(base, head, diff)).toEqual({
      'GHSA-t': `transitive: ${VULN_LABEL_TEXT.notGraded}`,
    });
  });

  it('direct advisories still count, with core’s weights; fixed ones are labelled from the base', () => {
    const legacy = vuln({ id: 'GHSA-legacy', severity: 'low' });
    delete legacy.scope; // an unlabelled (pre-lockfile) row is graded
    const base = at('a', [vuln({ id: 'GHSA-dev', scope: 'dev' })]);
    const head = at('b', [vuln({ id: 'GHSA-new', severity: 'critical' }), legacy]);
    expect(gradedSeverityShift(base, head)).toBe(5); // critical 4 + low 1
    expect(gradedSeverityShift(head, base)).toBe(-5);
    expect(notGradedVulnNotes(base, head, diffArtifacts(base, head))).toEqual({
      'GHSA-dev': `dev: ${VULN_LABEL_TEXT.notGraded}`,
    });
  });

  it('an ID graded on any row gets no note; an unknown scope is never echoed', () => {
    const hostile = '[x](https://evil.example)' as unknown as Vulnerability['scope'];
    const head = at('b', [
      vuln({ id: 'GHSA-mixed', scope: 'transitive' }),
      vuln({ id: 'GHSA-mixed', package: 'other', scope: 'direct' }),
      vuln({ id: 'GHSA-odd', scope: hostile }),
    ]);
    const base = at('a', []);
    const notes = notGradedVulnNotes(base, head, diffArtifacts(base, head));
    expect(notes).toEqual({ 'GHSA-odd': VULN_LABEL_TEXT.notGraded });
  });

  it('a rollup endpoint grades nothing (no CVE list), as in core', () => {
    const d = path.join(tempDir(), 's.json');
    writeFileSync(d, JSON.stringify({ at: '2026-09-01', stats: { fileCount: 1 }, risks: 0 }));
    expect(gradedSeverityShift(loadDiffEndpoint(d)!, at('b', [vuln()]))).toBe(0);
  });
});

/* ── the MCP command install registers (mcp-pkg-3, ux#6, ux#8) ─────────── */

describe('install’s MCP server command', () => {
  it('flags the default npx launch as unpublished only while MCP_PUBLISHED is false', () => {
    expect(isDefaultMcpCommand(DEFAULT_MCP_COMMAND)).toBe(true);
    expect(isDefaultMcpCommand(parseServerCommand(MCP_NPX)!)).toBe(true);
    expect(mcpServerNote(DEFAULT_MCP_COMMAND, false)).toBe(MCP_NOT_PUBLISHED_NOTE);
    expect(MCP_NOT_PUBLISHED_NOTE).toMatch(/not on npm yet/);
    expect(MCP_NOT_PUBLISHED_NOTE).toContain(MCP_NPX);
    // Flipped on publish: the npx launch works, so there is nothing to flag.
    expect(mcpServerNote(DEFAULT_MCP_COMMAND, true)).toBeUndefined();
    // An override is the user's working path — never flagged.
    const local = parseServerCommand('node /repo/apps/mcp-server/dist/server.js')!;
    expect(isDefaultMcpCommand(local)).toBe(false);
    expect(mcpServerNote(local, false)).toBeUndefined();
    // The default plus extra args is an override too.
    expect(
      mcpServerNote({ ...DEFAULT_MCP_COMMAND, args: [...DEFAULT_MCP_COMMAND.args, '-v'] }, false),
    ).toBeUndefined();
  });

  /* ux#3: install printed a GREEN "✓ server registered" for a launch that
     cannot resolve (factstack-mcp is not on npm), with only a dim note at the
     bottom. The registration line is now yellow and says so itself. */
  it('never shows the unpublished npx launch as a green check', () => {
    const was = kleur.enabled;
    kleur.enabled = true;
    try {
      const YELLOW = '\u001b[33m';
      const GREEN = '\u001b[32m';
      const note = mcpServerNote(DEFAULT_MCP_COMMAND, false);
      const written = mcpStatusLine({ mcpConfig: '.mcp.json', mcpStatus: 'written' }, note);
      expect(written.startsWith(YELLOW)).toBe(true);
      expect(stripVTControlCharacters(written)).toBe(
        `! .mcp.json (factstack server registered — it will not start until ${MCP_NPM_PACKAGE} is on npm; see the note below)`,
      );
      const kept = mcpStatusLine({ mcpConfig: '.mcp.json', mcpStatus: 'already-installed' }, note);
      expect(kept.startsWith(YELLOW)).toBe(true);
      expect(stripVTControlCharacters(kept)).not.toContain('✓');

      // Published, or an override: the plain check again.
      const ok = mcpStatusLine({ mcpConfig: '.mcp.json', mcpStatus: 'written' }, undefined);
      expect(ok.startsWith(GREEN)).toBe(true);
      expect(stripVTControlCharacters(ok)).toBe('✓ .mcp.json (factstack server registered)');
      expect(
        stripVTControlCharacters(
          mcpStatusLine({ mcpConfig: '.mcp.json', mcpStatus: 'failed', mcpError: 'bad' }, note),
        ),
      ).toBe('✗ .mcp.json — bad');
    } finally {
      kleur.enabled = was;
    }
  });

  /* cli-rev-5: spec's launch.ts is the one source of the npm names (three
     spellings had drifted apart), but install's status line and the
     not-on-npm note spelled `factstack-mcp` themselves. No CLI source STRING
     may: comments aside, the name comes from MCP_NPM_PACKAGE / MCP_NPX. */
  it('no CLI source string spells the MCP npm name — it comes from @factstack/spec', () => {
    const srcDir = path.join(import.meta.dirname, '..', 'src');
    const hits: string[] = [];
    const files = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) =>
      /\.ts$/.test(f),
    );
    for (const rel of files) {
      const sf = ts.createSourceFile(
        rel,
        readFileSync(path.join(srcDir, rel), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteralLike(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)) &&
          node.text.includes(MCP_NPM_PACKAGE)
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          hits.push(`${rel.split(path.sep).join('/')}:${line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(files.length).toBeGreaterThan(20);
    expect(hits).toEqual([]);
  });

  it('prints the pinned command so it pastes back into --server-command', () => {
    const root = path.join(tmpdir(), 'my project', "O'Brien");
    const pinned = withProjectRoot(DEFAULT_MCP_COMMAND, path.resolve(root))!;
    const line = formatServerCommand(pinned);
    expect(line.startsWith(`${MCP_NPX} --root "`)).toBe(true);
    expect(parseServerCommand(line)).toEqual(pinned);
    const odd = { command: 'node', args: ['a b', 'say "hi"', ''] };
    expect(parseServerCommand(formatServerCommand(odd))).toEqual(odd);
  });

  it('the printed pinned command pasted back is still the default launch (cli-r3-3)', () => {
    const abs = path.resolve(tmpdir(), 'my project', 'proj');
    const pasted = parseServerCommand(
      formatServerCommand(withProjectRoot(DEFAULT_MCP_COMMAND, abs)!),
    )!;
    expect(isDefaultMcpCommand(pasted)).toBe(true);
    expect(mcpServerNote(pasted, false)).toBe(MCP_NOT_PUBLISHED_NOTE);
    expect(mcpServerNote(pasted, true)).toBeUndefined();
    // Every --root spelling the server reads, a client variable included.
    // A valueless trailing --root names nothing, so it is stripped too.
    for (const extra of [
      ['-r', abs],
      [`--root=${abs}`],
      ['--root', '${workspaceFolder}'],
      ['--root'],
      ['--root='],
    ]) {
      const cmd = { ...DEFAULT_MCP_COMMAND, args: [...DEFAULT_MCP_COMMAND.args, ...extra] };
      expect(isDefaultMcpCommand(cmd)).toBe(true);
    }
    // Other extra args still make it an override; so does another package.
    const verbose = [...DEFAULT_MCP_COMMAND.args, '--root', abs, '-v'];
    expect(isDefaultMcpCommand({ ...DEFAULT_MCP_COMMAND, args: verbose })).toBe(false);
    expect(isDefaultMcpCommand(parseServerCommand(`npx -y other-mcp --root ${abs}`)!)).toBe(false);
  });

  it('says an absolute --root is machine-local, never a client variable (cli-r3-1)', () => {
    const abs = path.resolve(tmpdir(), 'proj');
    const pinned = withProjectRoot(DEFAULT_MCP_COMMAND, abs)!;
    expect(rootArgOf(pinned.args)).toBe(abs);
    expect(rootArgOf(['--root', 'a', `--root=b`])).toBe('b'); // the last one wins
    expect(rootArgOf(['--root'])).toBeUndefined();
    const all = mcpPortabilityNote(pinned, ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json']);
    expect(all).toMatch(
      /^\.mcp\.json, \.cursor\/mcp\.json, \.vscode\/mcp\.json pin --root to this machine's path — if you commit them, each teammate re-runs `factstack install`/,
    );
    expect(all).toContain('--root ${workspaceFolder}');
    expect(mcpPortabilityNote(pinned, ['.mcp.json'])).toMatch(/^\.mcp\.json pins .* commit it,/);
    expect(mcpPortabilityNote(pinned, [])).toBeUndefined(); // nothing registered
    const portable = parseServerCommand('npx -y factstack-mcp --root ${workspaceFolder}')!;
    expect(mcpPortabilityNote(portable, ['.cursor/mcp.json'])).toBeUndefined();
  });

  it('installRoot canonicalizes another spelling of the project path (cli-r3-1)', () => {
    const real = realpathSync.native(tempDir());
    // A junction (Windows) / directory symlink (POSIX) to the project.
    const link = path.join(tempDir(), 'proj-link');
    symlinkSync(real, link, 'junction');
    expect(installRoot(link)).toBe(real);
    // tmpdir() is an 8.3 short path on some Windows hosts (C:\PROGRA~1\…).
    const short = tempDir();
    expect(installRoot(short)).toBe(realpathSync.native(short));
    // A path that does not exist stays as given (install reports no .facts).
    const missing = path.join(real, 'nope');
    expect(installRoot(missing)).toBe(missing);
  });
});

/* `quick` wrote its unscrubbed viewer (absolute root, contributor
   emails) to a predictable `<tmp>/factstack-quick-<name>.html` with default
   permissions, which another local user could read or pre-create. */
describe('quick report file', () => {
  it('lands in a fresh private dir as a new file, never at the predictable path', () => {
    const tmp = tempDir();
    const a = writeQuickReport('demo', '<html>a</html>', tmp);
    const b = writeQuickReport('demo', '<html>b</html>', tmp);
    expect(a).not.toBe(b);
    expect(path.dirname(a)).not.toBe(tmp); // inside its own mkdtemp dir
    expect(path.basename(a)).toBe('factstack-quick-demo.html');
    expect(existsSync(path.join(tmp, 'factstack-quick-demo.html'))).toBe(false);
    expect(readFileSync(a, 'utf8')).toBe('<html>a</html>');
    expect(readFileSync(b, 'utf8')).toBe('<html>b</html>');
    if (process.platform !== 'win32') {
      expect(statSync(a).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(a)).mode & 0o777).toBe(0o700);
    }
  });
});

describe('--help follows the owner’s publish flags (cli-r3-4)', () => {
  it.each([false, true])('published = %s', (published) => {
    const helps = [
      serverCommandHelp(published),
      freshnessHookCommandHelp(published),
      gitHookCommandHelp(published),
    ];
    for (const h of helps) expect(h.includes('not on npm')).toBe(!published);
    expect(helps[0]).toContain(`(default: \`${MCP_NPX}\``);
    expect(helps[0]).toContain('install appends `--root <project>`');
    expect(helps[1]).toContain(`\`${FRESHNESS_HOOK_COMMAND}\``);
    expect(helps[2]).toContain(`Analyze command the hook runs (default \`${GIT_HOOK_COMMAND}\``);
  });
});

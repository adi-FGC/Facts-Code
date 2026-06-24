import { describe, expect, it } from 'vitest';
import { vulnSeveritySankey, type VulnFlowInput } from './vulnFlow.ts';

/** How the page groups packages for its headline counts: ecosystem|package@version. */
const pkgGroupKey = (v: VulnFlowInput) => `${v.ecosystem}|${v.package}@${v.installedVersion}`;
const distinctPackages = (vulns: VulnFlowInput[]) => new Set(vulns.map(pkgGroupKey)).size;
const pkgNodes = (vulns: VulnFlowInput[]) => vulnSeveritySankey(vulns).nodes.filter((n) => n.column === 1);

describe('vulnSeveritySankey', () => {
  it('keeps two installed versions of the same package as distinct nodes (the headline-vs-diagram invariant)', () => {
    const vulns: VulnFlowInput[] = [
      { ecosystem: 'npm', package: 'lodash', installedVersion: '4.17.20', severity: 'high' },
      { ecosystem: 'npm', package: 'lodash', installedVersion: '4.17.21', severity: 'critical' },
    ];
    // The number of right-column (package) nodes must equal the distinct
    // (package, version) groups the page counts as "N packages".
    expect(pkgNodes(vulns)).toHaveLength(distinctPackages(vulns));
    expect(pkgNodes(vulns)).toHaveLength(2);
    // Labels carry the version so the two nodes are distinguishable.
    expect(pkgNodes(vulns).map((n) => n.label).sort()).toEqual(['lodash@4.17.20', 'lodash@4.17.21']);
  });

  it('does NOT merge advisory ribbons across versions', () => {
    const vulns: VulnFlowInput[] = [
      { ecosystem: 'npm', package: 'lodash', installedVersion: '4.17.20', severity: 'high' },
      { ecosystem: 'npm', package: 'lodash', installedVersion: '4.17.20', severity: 'high' }, // same node, +1
      { ecosystem: 'npm', package: 'lodash', installedVersion: '4.17.21', severity: 'high' }, // different node
    ];
    const { links } = vulnSeveritySankey(vulns);
    // Two ribbons (high->v20 with value 2, high->v21 with value 1), not one merged ribbon of 3.
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.target.endsWith('@4.17.20'))!.value).toBe(2);
    expect(links.find((l) => l.target.endsWith('@4.17.21'))!.value).toBe(1);
  });

  it('aggregates advisories per (severity, package) into ribbon weight', () => {
    const vulns: VulnFlowInput[] = [
      { ecosystem: 'pypi', package: 'requests', installedVersion: '2.0.0', severity: 'medium' },
      { ecosystem: 'pypi', package: 'requests', installedVersion: '2.0.0', severity: 'medium' },
      { ecosystem: 'pypi', package: 'requests', installedVersion: '2.0.0', severity: 'low' },
    ];
    const { nodes, links } = vulnSeveritySankey(vulns);
    expect(nodes.filter((n) => n.column === 1)).toHaveLength(1); // one package node
    expect(nodes.filter((n) => n.column === 0).map((n) => n.label)).toEqual(['Medium', 'Low']); // present severities, in order
    expect(links).toHaveLength(2); // medium->req (2), low->req (1)
    expect(links.find((l) => l.source === 'sev:medium')!.value).toBe(2);
    expect(links.find((l) => l.source === 'sev:low')!.value).toBe(1);
  });

  it('orders severity nodes critical..unknown and drops absent severities', () => {
    const vulns: VulnFlowInput[] = [
      { ecosystem: 'npm', package: 'a', installedVersion: '1', severity: 'unknown' },
      { ecosystem: 'npm', package: 'b', installedVersion: '1', severity: 'critical' },
    ];
    const sevNodes = vulnSeveritySankey(vulns).nodes.filter((n) => n.column === 0).map((n) => n.label);
    expect(sevNodes).toEqual(['Critical', 'Unknown']); // high/medium/low absent, order preserved
  });

  it('returns empty for no vulnerabilities', () => {
    const out = vulnSeveritySankey([]);
    expect(out.nodes).toEqual([]);
    expect(out.links).toEqual([]);
  });

  it('is deterministic across runs', () => {
    const vulns: VulnFlowInput[] = [
      { ecosystem: 'npm', package: 'x', installedVersion: '1', severity: 'high' },
      { ecosystem: 'npm', package: 'y', installedVersion: '2', severity: 'low' },
    ];
    expect(JSON.stringify(vulnSeveritySankey(vulns))).toBe(JSON.stringify(vulnSeveritySankey(vulns)));
  });
});

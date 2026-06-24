/**
 * Vulnerability severity-flow adapter — pure, deterministic shaping of artifact
 * vulnerabilities into a Sankey (severity tier -> affected package).
 *
 * Kept in its own pure lib (no remix/DOM imports) so the keying invariant is
 * unit-testable: the number of package nodes the diagram draws MUST equal the
 * distinct (package, installedVersion) groups the page counts elsewhere. That
 * invariant regressed once — the adapter keyed packages by ecosystem|package
 * while the page's headline counts keyed by ecosystem|package@version, so two
 * installed versions of one package merged into a single node and summed their
 * advisory ribbons. The fix (and the reason this is a lib with a test) is to
 * key version-aware so the diagram and the "N packages" headline always agree.
 */

export type VulnSeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

/** Minimal shape the severity-flow needs from an artifact vulnerability row. */
export interface VulnFlowInput {
  ecosystem: string;
  package: string;
  installedVersion: string;
  severity: VulnSeverity;
}

/** Severity tiers in descending order (drives the left-column stacking). */
export const SEV_ORDER: readonly VulnSeverity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

/** Per-severity ribbon colour (the ribbon inherits its source severity node). */
export const SEV_FLOW_COLOR: Record<VulnSeverity, string> = {
  critical: 'var(--danger)',
  high: 'var(--warn)',
  medium: 'var(--accent)',
  low: 'var(--fg-muted)',
  unknown: 'var(--fg-faint)',
};

export interface VulnSankeyNode {
  id: string;
  label: string;
  column: number;
  color: string;
}

export interface VulnSankeyData {
  nodes: VulnSankeyNode[];
  links: Array<{ source: string; target: string; value: number }>;
}

/**
 * Severity -> package flow. Severity sits in the LEFT column so each ribbon
 * inherits its severity colour (red = critical, amber = high, ...) as it fans
 * out to the packages carrying that severity. Advisories are aggregated per
 * (severity, package@version) pair; link objects live directly in the map so
 * there's no separator that could collide with a package name.
 *
 * Package nodes are keyed by `ecosystem|package@installedVersion` — VERSION
 * AWARE — so the same package at two installed versions (the monorepo case the
 * artifact's installedVersion/manifestPath fields exist for) renders as two
 * distinct right-column nodes. The diagram's package-node count then equals the
 * distinct (package, version) groups the page reports as "N packages", and the
 * two versions' advisory totals stay on separate ribbons instead of merging.
 *
 * Severities and packages with no advisories never appear (the layout drops
 * zero-flow nodes).
 */
export function vulnSeveritySankey(vulns: ReadonlyArray<VulnFlowInput>): VulnSankeyData {
  const sevPresent = SEV_ORDER.filter((s) => vulns.some((v) => v.severity === s));
  const pkgLabel = new Map<string, string>();
  const linkByPair = new Map<string, { source: string; target: string; value: number }>();
  for (const v of vulns) {
    const pkgId = `pkg:${v.ecosystem}|${v.package}@${v.installedVersion}`;
    const sevId = `sev:${v.severity}`;
    pkgLabel.set(pkgId, `${v.package}@${v.installedVersion}`);
    const pairKey = `${sevId}>${pkgId}`;
    const existing = linkByPair.get(pairKey);
    if (existing) existing.value += 1;
    else linkByPair.set(pairKey, { source: sevId, target: pkgId, value: 1 });
  }
  const nodes: VulnSankeyNode[] = [
    ...sevPresent.map((s) => ({
      id: `sev:${s}`,
      label: s.charAt(0).toUpperCase() + s.slice(1),
      column: 0,
      color: SEV_FLOW_COLOR[s],
    })),
    ...[...pkgLabel].map(([id, label]) => ({ id, label, column: 1, color: 'var(--fg-muted)' })),
  ];
  return { nodes, links: [...linkByPair.values()] };
}

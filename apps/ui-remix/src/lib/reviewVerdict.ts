/**
 * reviewVerdict — the browser-side Change Verdict for the /review panel.
 *
 * Honest about the data it has. FACTS snapshots are stored as count-rollups
 * (no graph, no per-file detail), so a full two-artifact structural diff
 * isn't possible client-side. What IS available:
 *   - the CURRENT analysis: a full dependency graph (→ cycles + blast radius),
 *     categorized risks, and vulnerabilities;
 *   - `history[]`: rolled-up COUNTS per past snapshot (risks, todos, files,
 *     loc, tokens).
 *
 * So the verdict has two honest halves:
 *   - POSTURE  — current structural risk (secrets, CVEs, cycles, top hub),
 *                computed from the live graph;
 *   - TREND    — count deltas vs a chosen baseline snapshot.
 *
 * Severity scoring is imported from @factstack/core so this panel can never
 * drift from the CLI (`factstack review`) and MCP (`review_change`) verdict.
 */

import type { ChangeFinding, FindingSeverity, ReviewSeverity } from '@factstack/spec';
import {
  rollupSeverity,
  vulnFindingSeverity,
  SECRET_SEVERITY,
  CYCLE_SEVERITY,
  RISK_DELTA_SEVERITY,
  HOTSPOT_LOW,
  HOTSPOT_MEDIUM,
} from '@factstack/spec/review-severity'; // zod-free subpath: keeps the schemas out of first paint
import { isGradedVulnerability, VULN_LABEL_TEXT } from '@factstack/scanners';
import { tarjanSCC, findCycles } from './graphAnalysis.ts';
import type { Dataset } from './loadArtifacts.ts';
import { splitSecrets } from './secretClass.ts';

export interface Delta {
  before: number;
  after: number;
  delta: number;
}

export interface ReviewBaseline {
  at: string;
  loc: number;
  tokens: number;
  files: number;
  risks: number;
  todos: number;
}

/** A verdict finding. `graded: false` marks one that is listed but never
 *  counted toward the level (possible secrets, dev / transitive advisories): the page shows
 *  "not graded" where a graded finding shows its severity, so its `low`
 *  placeholder (the schema has no "none") never reads as a grade. UI-side
 *  until ChangeFinding itself carries the field (spec, INV4 additive). */
export type ReviewFinding = ChangeFinding & { graded?: false };

export interface ReviewVerdict {
  severity: ReviewSeverity;
  headline: string;
  generatedAt: string;
  baseline: ReviewBaseline | null;
  findings: ReviewFinding[];
  /** Current structural posture (independent of any baseline). */
  posture: {
    secrets: number;
    /** Distinct graded advisory ids (dev / transitive-only ones are listed,
     *  not counted). */
    vulnerabilities: number;
    cycles: number;
    /** Most transitively-depended-on file + its reach (blast radius). */
    topHub: { file: string; reach: number } | null;
  };
  /** Count deltas vs the chosen baseline (null when no baseline picked). */
  trend: { risks: Delta; todos: Delta; files: Delta; loc: Delta; tokens: Delta } | null;
}

const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  none: 'No risk',
  low: 'Low risk',
  medium: 'Elevated risk',
  high: 'High risk',
  critical: 'Critical risk',
};

/** Build forward + reverse adjacency from the dataset edges. Type-only edges
 *  are excluded from the cycle graph (not runtime cycles) but kept in the
 *  reverse map for blast radius (a type reference is still a dependency). */
function buildAdjacency(edges: Dataset['edges']): {
  forward: Map<string, string[]>;
  reverse: Map<string, string[]>;
  nodes: string[];
} {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
    const rev = reverse.get(e.to);
    if (rev) rev.push(e.from);
    else reverse.set(e.to, [e.from]);
    if (e.kind === 'type-import') continue;
    const fwd = forward.get(e.from);
    if (fwd) fwd.push(e.to);
    else forward.set(e.from, [e.to]);
  }
  return { forward, reverse, nodes: [...nodes] };
}

/** Transitive dependents of `file` over the reverse graph (BFS, cycle-safe). */
function transitiveReach(file: string, reverse: Map<string, string[]>): number {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const caller of reverse.get(node) ?? []) {
      if (!seen.has(caller) && caller !== file) {
        seen.add(caller);
        queue.push(caller);
      }
    }
  }
  return seen.size;
}

/** Compute the file with the largest blast radius (most transitive dependents). */
function topHub(reverse: Map<string, string[]>): { file: string; reach: number } | null {
  let best: { file: string; reach: number } | null = null;
  // Only files that are imported by something can be a hub.
  for (const file of reverse.keys()) {
    const reach = transitiveReach(file, reverse);
    if (!best || reach > best.reach) best = { file, reach };
  }
  return best && best.reach > 0 ? best : null;
}

const delta = (before: number, after: number): Delta => ({ before, after, delta: after - before });

/**
 * Build the review verdict from the current dataset and an optional baseline
 * snapshot. Pure — no DOM, no fetch. Severity comes from @factstack/core.
 */
export function buildReviewVerdict(data: Dataset, baseline: ReviewBaseline | null): ReviewVerdict {
  const { forward, reverse, nodes } = buildAdjacency(data.edges ?? []);

  const sccs = tarjanSCC(nodes, forward);
  const cycles = findCycles(sccs, forward);
  const hub = topHub(reverse);

  /* analyze() emits secrets in test/fixture paths at `low` and generic
     "possible secret" hits at `info`, and keeps both out of the grade; mirror
     that here so neither reads as "exposed — rotate before shipping", while
     each still surfaces as its own finding. */
  const split = splitSecrets(data.risks);
  const secrets = split.exposed.length;
  const fixtureSecrets = split.fixture.length;
  const possibleSecrets = split.possible.length;
  /* Owner call (2026-09-24), the rule core review.ts applies: only direct
     runtime advisories are graded (the shared isGradedVulnerability; a legacy
     row with no scope is direct). An id with ANY graded row is graded, at the
     worst severity among those rows — one advisory can hit a direct dep in
     one manifest and a dev dep in another. An advisory reached only through
     dev or transitive dependencies is listed in its own finding, added after
     the roll-up so it never sets the verdict level. */
  const gradedSev = new Map<string, FindingSeverity>();
  for (const v of data.vulnerabilities ?? []) {
    if (!isGradedVulnerability(v)) continue;
    const s = vulnFindingSeverity(String(v.severity));
    const prev = gradedSev.get(v.id);
    if (!prev || rank(s) > rank(prev)) gradedSev.set(v.id, s);
  }
  const vulnIds = [...new Set((data.vulnerabilities ?? []).map((v) => v.id))];
  const gradedIds = vulnIds.filter((id) => gradedSev.has(id));
  const ungradedIds = vulnIds.filter((id) => !gradedSev.has(id));
  const risksNow = data.risks.length;
  const todosNow = data.summary.health.todos;

  const findings: ReviewFinding[] = [];

  if (secrets > 0) {
    findings.push({
      kind: 'secret',
      severity: SECRET_SEVERITY,
      title: `${secrets} exposed secret${secrets === 1 ? '' : 's'}`,
      detail: `The secret scanner flagged ${secrets} leaked-credential finding(s) in the current analysis. Rotate before shipping.`,
      evidence: { count: secrets },
    });
  }
  if (fixtureSecrets > 0) {
    findings.push({
      kind: 'secret',
      severity: 'low',
      title: `${fixtureSecrets} secret${fixtureSecrets === 1 ? '' : 's'} in test/fixture files`,
      detail: `${fixtureSecrets} token-shaped value(s) sit in test or fixture paths — listed with exact paths under Security → Secrets, not counted as exposed. Confirm each is a fixture.`,
      evidence: { count: fixtureSecrets },
    });
  }

  if (gradedIds.length > 0) {
    let worst: FindingSeverity = 'low';
    for (const id of gradedIds) {
      const s = gradedSev.get(id) ?? 'low';
      if (rank(s) > rank(worst)) worst = s;
    }
    const n = gradedIds.length;
    findings.push({
      kind: 'vulnerability',
      severity: worst,
      title: `${n} known vulnerabilit${n === 1 ? 'y' : 'ies'}`,
      detail: `Dependency advisories matched against the project manifests (worst severity: ${worst}).`,
      evidence: { count: n, ids: gradedIds.slice(0, 8) },
    });
  }

  if (cycles.length > 0) {
    const sample = cycles[0] ?? [];
    findings.push({
      kind: 'cycle',
      severity: CYCLE_SEVERITY,
      title: `${cycles.length} dependency cycle${cycles.length === 1 ? '' : 's'}`,
      detail: `Strongly-connected component(s) in the import graph${sample.length ? `, e.g. ${sample.slice(0, 3).join(' → ')}${sample.length > 3 ? ' → …' : ''}` : ''}.`,
      evidence: { files: sample.slice(0, 6), count: cycles.length },
    });
  }

  if (hub && hub.reach >= HOTSPOT_LOW) {
    findings.push({
      kind: 'hotspot',
      severity: hub.reach >= HOTSPOT_MEDIUM ? 'medium' : 'low',
      title: `Hub: ${hub.reach} modules depend on one file`,
      detail: `${hub.file} is transitively imported by ${hub.reach} other module(s); a regression there has a wide blast radius.`,
      evidence: { files: [hub.file], count: hub.reach },
    });
  }

  const trend = baseline
    ? {
        risks: delta(baseline.risks, risksNow),
        todos: delta(baseline.todos, todosNow),
        files: delta(baseline.files, data.stats.files),
        loc: delta(baseline.loc, data.stats.loc),
        tokens: delta(baseline.tokens, data.stats.tokens),
      }
    : null;

  if (trend && trend.risks.delta > 0) {
    findings.push({
      kind: 'risk',
      severity: RISK_DELTA_SEVERITY,
      title: `Risk findings up ${trend.risks.delta} since baseline`,
      detail: `Scanner findings rose from ${trend.risks.before} to ${trend.risks.after} since ${formatAt(baseline!.at)}.`,
      evidence: { count: trend.risks.delta },
    });
  }

  const severity = rollupSeverity(findings);
  /* Listed after the roll-up, at the lowest finding severity (the schema has
     no "none") and marked `graded: false`: shown, never counted toward the
     level, and never displayed as a LOW grade. Possible secrets are "shown
     but never graded" (secretClass.ts), as are dev/transitive advisories. */
  if (possibleSecrets > 0) {
    findings.push({
      kind: 'secret',
      severity: 'low',
      graded: false,
      title: `${possibleSecrets} possible secret${possibleSecrets === 1 ? '' : 's'}, not graded`,
      detail: `${possibleSecrets} generic match(es) (a password=, a connection URL, a secret-named field) — listed under Security → Secrets, not counted as exposed. Check whether each is a real credential.`,
      evidence: { count: possibleSecrets },
    });
  }
  if (ungradedIds.length > 0) {
    const m = ungradedIds.length;
    findings.push({
      kind: 'vulnerability',
      severity: 'low',
      graded: false,
      title: `${m} dev/transitive advisor${m === 1 ? 'y' : 'ies'} (${VULN_LABEL_TEXT.notGraded})`,
      detail: `Advisories reached only through dev or transitive dependencies — listed under Security → Vulnerabilities; they do not raise the verdict.`,
      evidence: { count: m, ids: ungradedIds.slice(0, 8) },
    });
  }

  return {
    severity,
    headline: buildHeadline(severity, findings, trend),
    generatedAt: data.generatedAt,
    baseline,
    findings,
    posture: {
      secrets,
      vulnerabilities: gradedIds.length,
      cycles: cycles.length,
      topHub: hub,
    },
    trend,
  };
}

const RANK: Record<ReviewSeverity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
function rank(s: ReviewSeverity): number {
  return RANK[s];
}

function formatAt(at: string): string {
  try {
    return new Date(at).toISOString().slice(0, 10);
  } catch {
    return at;
  }
}

function buildHeadline(
  severity: ReviewSeverity,
  findings: ReviewFinding[],
  trend: ReviewVerdict['trend'],
): string {
  if (findings.length === 0) {
    const trendBit =
      trend && trend.risks.delta < 0
        ? ` Risks down ${Math.abs(trend.risks.delta)} since baseline.`
        : '';
    return `${SEVERITY_LABEL.none}: nothing risk-relevant in the current analysis.${trendBit}`;
  }
  const ranked = [...findings].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const lead = ranked
    .slice(0, 2)
    .map((f) => f.title.charAt(0).toLowerCase() + f.title.slice(1))
    .join('; ');
  return `${SEVERITY_LABEL[severity]}: ${lead}.`;
}

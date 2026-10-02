/**
 * @factstack/core — buildChangeVerdict: the "Change Verdict" composition.
 *
 * Pure. Takes two AgentArtifacts (base = `from`, head = `to`) and fuses:
 *   - the structured diff (secrets / vulnerabilities / risk-count deltas),
 *   - new dependency cycles (set-diff of head vs base graph cycles),
 *   - blast radius (how many modules transitively depend on each changed file),
 * into a single severity headline + a list of grounded findings.
 *
 * This is a composition layer over primitives that already ship:
 *   diffArtifacts() (this package) + the head artifact's graph.{edges,cycles}.
 * No new analysis — just judgement.
 */

import type {
  AgentArtifact,
  ChangeFinding,
  ChangeVerdict,
  FindingSeverity,
  ReviewSeverity,
  Risk,
} from '@factstack/spec';
import {
  SECRET_SEVERITY,
  CYCLE_SEVERITY,
  RISK_DELTA_SEVERITY,
  HOTSPOT_LOW,
  HOTSPOT_MEDIUM,
  SEVERITY_RANK,
  vulnFindingSeverity,
  rollupSeverity,
} from '@factstack/spec';
import { isGradedVulnerability, VULN_LABEL_TEXT } from '@factstack/scanners';
import {
  diffArtifacts,
  diffFindings,
  isExposedSecret,
  isRollupEndpoint,
  secretGrading,
  type Endpoint,
  type SecretGrading,
  type SecretGradingReason,
} from './diff.js';

const SEVERITY_EMOJI: Record<ReviewSeverity, string> = {
  none: '✅',
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴',
};

const FINDING_EMOJI: Record<FindingSeverity, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴',
};

/**
 * Render a verdict as PR-comment-ready Markdown. Pure + deterministic so it
 * can be posted by the CLI, a CI step, or any consumer. Never includes raw
 * secret values (the verdict only ever carries counts + redacted evidence).
 */
export function renderVerdictMarkdown(v: ChangeVerdict): string {
  const out: string[] = [];
  out.push(`### ${SEVERITY_EMOJI[v.severity]} FACTS Change Verdict — ${v.severity.toUpperCase()}`);
  out.push('');
  out.push(v.headline);
  out.push('');

  if (v.findings.length > 0) {
    out.push('#### Findings');
    for (const f of v.findings) {
      out.push(`- ${FINDING_EMOJI[f.severity]} **${f.title}** — ${f.detail}`);
    }
    out.push('');
  }

  const b = v.blastRadius;
  if (b.topFile && b.maxReach > 0) {
    out.push(
      `**Blast radius:** \`${b.topFile}\` is depended on by ${b.maxReach} module(s) (${b.changedFiles} changed file(s) examined).`,
    );
    out.push('');
  }

  const s = v.summary;
  const cell = (n: number) => (n > 0 ? `+${n}` : String(n));
  out.push('| files | secrets | vulns (new/fixed) | cycles | risks |');
  out.push('|---|---|---|---|---|');
  out.push(
    `| +${s.filesAdded} ~${s.filesChanged} -${s.filesRemoved} | ${cell(s.secretsAdded)} | ${cell(s.vulnsNew)} / -${s.vulnsFixed} | ${cell(s.cyclesNew)} | ${cell(s.risksDelta)} |`,
  );
  out.push('');
  out.push(`_FACTS · severity shift ${s.severityShift >= 0 ? '+' : ''}${s.severityShift}_`);
  return out.join('\n');
}

// ───────────────────────── SEVERITY MODEL (tune here) ─────────────────────────
//
// One isolated place defines how the verdict scores. Everything else is
// mechanical. Change these to retune what counts as risky for your team.
//
//   - A leaked secret is the single worst thing a PR can add → `high`.
//   - A new vulnerability inherits the advisory's own severity.
//   - A new advisory reached only through dev or transitive dependencies is
//     LISTED (a `low` finding, kept last) but never sets the verdict level:
//     shown, not graded, the rule health.ts applies (owner decision
//     2026-09-24). A known advisory that moves from dev/transitive-only to a
//     direct runtime dep enters that graded scope and is graded like a new one.
//   - A new dependency cycle is a structural regression → `medium`.
//   - A widely-depended-on changed file (big blast radius) is a `medium`
//     caution at HOTSPOT_MEDIUM transitive dependents, a `low` note at
//     HOTSPOT_LOW. Below HOTSPOT_LOW it is not worth a finding.
//   - Any other net-new risk finding (lint/broken/stale) → `low`.
//
// The rolled-up verdict severity is simply the MAX graded finding severity.

// The severity model now lives in @factstack/spec (imported above) so the web
// /review panel reuses it WITHOUT pulling the analyzer into the browser bundle.
// SECRET_SEVERITY / CYCLE_SEVERITY / RISK_DELTA_SEVERITY / HOTSPOT_* /
// vulnFindingSeverity / rollupSeverity are all imported. Local alias for the
// rank table used by buildChangeVerdict + buildHeadline below.
const RANK = SEVERITY_RANK;
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Split head cycles by how they relate to the base's, by MEMBER SET (an SCC
 * is a set; order is meaningless):
 *   - covered by a base cycle (same set, or it shrank) → not a regression;
 *   - overlapping a base cycle it outgrew → `grown`;
 *   - touching no base cycle at all → `fresh`.
 * An exact-set match alone made a shrunk cycle read as a brand-new one.
 */
function classifyCycles(
  base: string[][],
  head: string[][],
): { fresh: string[][]; grown: string[][] } {
  const baseSets = base.map((c) => new Set(c));
  const fresh: string[][] = [];
  const grown: string[][] = [];
  for (const c of head) {
    if (baseSets.some((b) => c.every((m) => b.has(m)))) continue;
    if (baseSets.some((b) => c.some((m) => b.has(m)))) grown.push(c);
    else fresh.push(c);
  }
  return { fresh, grown };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Why a secret delta was not graded, as a clause for the headline + finding. */
const UNGRADED_SECRETS_WHY: Record<SecretGradingReason, string> = {
  'base-older': 'the baseline was made by an older secret scanner',
  'head-older': 'the head was made by an older secret scanner than the baseline',
  'rules-changed': 'the secret rules changed between the baseline and the head',
};
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Advisory ids a finding names in its detail and evidence. One lockfile
 *  refresh can add dozens of dev/transitive advisories, and the detail goes
 *  verbatim into a PR comment; `count` keeps the full number. Same cap as the
 *  dashboard's /review mirror (INV7). */
const MAX_LISTED_IDS = 8;

function listIds(ids: string[]): { shown: string[]; text: string } {
  const shown = ids.slice(0, MAX_LISTED_IDS);
  const rest = ids.length - shown.length;
  return { shown, text: `${shown.join(', ')}${rest > 0 ? ` … and ${rest} more` : ''}` };
}

/** Distinct, sorted file paths of some findings — paths only, never values. */
function filesOf(risks: Risk[]): string[] {
  return [...new Set(risks.flatMap((r) => (r.file ? [r.file] : [])))].sort();
}

/**
 * Transitive dependents ("callers") of `file` over the head graph, via a BFS
 * on reverse edges. Returns the count of distinct other files that reach
 * `file` through import chains. Visited-set guards cycles.
 */
function transitiveReach(file: string, reverse: Map<string, string[]>): number {
  const seen = new Set<string>();
  const queue: string[] = [file];
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

/**
 * Build a Change Verdict from a base (`from`) and head (`to`) artifact.
 * Pure: callers supply both artifacts; this never touches the filesystem.
 * Either side may be a diff Endpoint (artifact + snapshot overrides): a
 * stats-only rollup endpoint is compared by its counts only, and the
 * headline says what could not be compared.
 */
export function buildChangeVerdict(
  fromInput: AgentArtifact | Endpoint,
  toInput: AgentArtifact | Endpoint,
  /** INV1 — injected by the adapter so the verdict is reproducible; falls back
   *  to the clock for callers that don't supply one. */
  generatedAt?: string,
): ChangeVerdict {
  const fromEp: Endpoint = 'artifact' in fromInput ? fromInput : { artifact: fromInput };
  const toEp: Endpoint = 'artifact' in toInput ? toInput : { artifact: toInput };
  const from = fromEp.artifact;
  const to = toEp.artifact;
  const diff = diffArtifacts(fromEp, toEp);
  // A stats-only snapshot rollup (see isRollupEndpoint in diff.ts), either side.
  const fromRollup = isRollupEndpoint(fromEp);
  const toRollup = isRollupEndpoint(toEp);
  const rollup = fromRollup || toRollup;
  // Per-finding set-diffs need full risks[] on both sides; a rollup only has
  // counts, so it falls back to the net deltas below.
  const sets = rollup ? null : diffFindings(from, to);
  /* data-model#1 — secrets are graded only between artifacts scanned under
     the same graded rules. A stats-only rollup records no revision (it would
     read as "older" even when written by this version), so its counts are
     compared as before unless both sides do carry one. */
  const grading: SecretGrading = sets
    ? sets.secretGrading
    : from.secretRulesRev != null && to.secretRulesRev != null
      ? secretGrading(from, to)
      : { graded: true };

  // Reverse adjacency over the HEAD graph: for each file, who imports it.
  // Type-only edges are included — they still mean "this file is referenced
  // from there", which is what a blast-radius / refactoring question wants.
  const reverse = new Map<string, string[]>();
  for (const e of to.graph.edges) {
    const bucket = reverse.get(e.to);
    if (bucket) bucket.push(e.from);
    else reverse.set(e.to, [e.from]);
  }

  // Cycle regressions by member set. A rollup base carries no cycles, so
  // every head cycle would read as new: not compared.
  const { fresh: newCycles, grown: grownCycles } = rollup
    ? { fresh: [] as string[][], grown: [] as string[][] }
    : classifyCycles(from.graph.cycles, to.graph.cycles);

  // Blast radius over the changed set (added + content-changed files).
  const changedPaths = [...diff.files.added, ...diff.files.changed.map((c) => c.path)];
  let maxReach = 0;
  let topFile: string | undefined;
  for (const path of changedPaths) {
    const reach = transitiveReach(path, reverse);
    if (reach > maxReach) {
      maxReach = reach;
      topFile = path;
    }
  }

  // ── assemble findings ──
  const findings: ChangeFinding[] = [];

  /* Secrets are matched one by one (rule + file + the value's one-way
     fingerprint): swapping one leaked key for another is a NEW secret even
     though the count held, while the same key moved to another line or file
     is not. Scanned under different rules, a secret in a file the base did
     not have is still graded (new under any rules, SV-2); the rest of the
     delta is listed after the roll-up and never graded: a key the newer rules
     can see, committed long ago, would otherwise read as "new" (data-model#1). */
  const netNew = Math.max(0, diff.stats.secrets.delta);
  const gradedNew = sets ? sets.secrets.new.length : grading.graded ? netNew : 0;
  const ungradedNew = sets ? sets.ungradedSecrets.new.length : grading.graded ? 0 : netNew;
  const secretsAdded = gradedNew + ungradedNew;
  let ungradedSecrets: ChangeFinding | null = null;
  if (ungradedNew > 0 && !grading.graded) {
    const files = sets ? filesOf(sets.ungradedSecrets.new) : [];
    ungradedSecrets = {
      kind: 'secret',
      severity: 'low',
      title: `Lists ${ungradedNew} ${plural(ungradedNew, 'secret', 'secrets')} not matched in the baseline (not graded)`,
      detail: `${sentenceCase(UNGRADED_SECRETS_WHY[grading.reason])}, so these were compared by rule, file and redacted preview and do not raise the verdict${files.length ? ` (${files.join(', ')})` : ''}. Rotate any that are real.`,
      evidence: { count: ungradedNew, ...(files.length ? { files } : {}) },
    };
  }
  if (gradedNew > 0) {
    const files = sets ? filesOf(sets.secrets.new) : [];
    findings.push({
      kind: 'secret',
      severity: SECRET_SEVERITY,
      title: `Introduces ${gradedNew} new ${plural(gradedNew, 'secret', 'secrets')}`,
      detail: sets
        ? `The head has ${gradedNew} leaked-credential finding(s) the base did not${grading.graded ? '' : ', in files the base did not have'}${files.length ? ` (${files.join(', ')})` : ''}. Rotate before merge.`
        : `The secret scanner found ${gradedNew} more leaked-credential finding(s) in the head than the base. Rotate before merge.`,
      evidence: { count: gradedNew, ...(files.length ? { files } : {}) },
    });
  }

  /* Owner decision 2026-09-24: only direct runtime advisories are graded (the
     rule health.ts applies). An advisory the head reaches only through dev or
     transitive dependencies is listed in its own finding, pushed after the
     level is rolled up, so it never raises the verdict. An id with ANY graded
     head row is graded, at the worst severity among those rows (one advisory
     can hit a direct dep in one manifest and a dev dep in another). */
  let ungradedVulns: ChangeFinding | null = null;
  if (!rollup) {
    const gradedSev = new Map<string, FindingSeverity>();
    for (const v of to.vulnerabilities ?? []) {
      if (!isGradedVulnerability(v)) continue;
      const s = vulnFindingSeverity(v.severity);
      const prev = gradedSev.get(v.id);
      if (!prev || RANK[s] > RANK[prev]) gradedSev.set(v.id, s);
    }
    // Inherit the worst severity among the given graded advisories.
    const worstOf = (ids: string[]): FindingSeverity => {
      let worst: FindingSeverity = 'low';
      for (const id of ids) {
        const s = gradedSev.get(id) ?? 'low';
        if (RANK[s] > RANK[worst]) worst = s;
      }
      return worst;
    };
    const graded = diff.vulns.new.filter((id) => gradedSev.has(id));
    const ungraded = diff.vulns.new.filter((id) => !gradedSev.has(id));
    /* The id diff misses an advisory the base already listed, but only
       through dev or transitive deps, that the head now reaches through a
       direct runtime dep: not new by id, yet it enters the graded scope, so
       it is graded like an addition. (A legacy unlabelled base row was
       already graded, so it is never "promoted".) */
    const baseVulns = from.vulnerabilities ?? [];
    const baseIds = new Set(baseVulns.map((v) => v.id));
    const baseGraded = new Set(baseVulns.filter((v) => isGradedVulnerability(v)).map((v) => v.id));
    const promoted = [...gradedSev.keys()]
      .filter((id) => baseIds.has(id) && !baseGraded.has(id))
      .sort();
    if (graded.length > 0) {
      const n = graded.length;
      const list = listIds(graded);
      findings.push({
        kind: 'vulnerability',
        severity: worstOf(graded),
        title: `Adds ${n} new known vulnerabilit${n === 1 ? 'y' : 'ies'}`,
        detail: `New advisories matched against dependency manifests: ${list.text}.`,
        evidence: { ids: list.shown, count: n },
      });
    }
    if (promoted.length > 0) {
      const k = promoted.length;
      const list = listIds(promoted);
      findings.push({
        kind: 'vulnerability',
        severity: worstOf(promoted),
        title: `Promotes ${k} dev/transitive advisor${k === 1 ? 'y' : 'ies'} to a direct runtime dependency`,
        detail: `Known advisories the base reached only through dev or transitive dependencies now reach a direct runtime dependency, so they are graded: ${list.text}.`,
        evidence: { ids: list.shown, count: k },
      });
    }
    if (ungraded.length > 0) {
      const m = ungraded.length;
      const list = listIds(ungraded);
      ungradedVulns = {
        kind: 'vulnerability',
        severity: 'low',
        title: `Lists ${m} new dev/transitive advisor${m === 1 ? 'y' : 'ies'} (${VULN_LABEL_TEXT.notGraded})`,
        detail: `New advisories reached only through dev or transitive dependencies; they do not raise the verdict: ${list.text}.`,
        evidence: { ids: list.shown, count: m },
      };
    }
  }

  if (newCycles.length > 0) {
    const sample = newCycles[0] ?? [];
    findings.push({
      kind: 'cycle',
      severity: CYCLE_SEVERITY,
      title: `Introduces ${newCycles.length} new dependency cycle${newCycles.length === 1 ? '' : 's'}`,
      detail: `New strongly-connected component(s) in the import graph, e.g. ${sample.join(' → ')}${sample.length > 1 ? ' → …' : ''}.`,
      evidence: { files: sample, count: newCycles.length },
    });
  }
  if (grownCycles.length > 0) {
    const sample = grownCycles[0] ?? [];
    findings.push({
      kind: 'cycle',
      severity: CYCLE_SEVERITY,
      title: `Grows ${grownCycles.length} existing dependency ${plural(grownCycles.length, 'cycle', 'cycles')}`,
      detail: `An existing import cycle pulled in more files, now ${sample.length}: ${sample.slice(0, 4).join(' → ')}${sample.length > 4 ? ' → …' : ''}.`,
      evidence: { files: sample, count: grownCycles.length },
    });
  }

  if (maxReach >= HOTSPOT_LOW && topFile) {
    findings.push({
      kind: 'hotspot',
      severity: maxReach >= HOTSPOT_MEDIUM ? 'medium' : 'low',
      title: `Touches a hub: ${maxReach} modules depend on a changed file`,
      detail: `${topFile} is transitively imported by ${maxReach} other module(s); a regression here has a wide blast radius.`,
      evidence: { files: [topFile], count: maxReach },
    });
  }

  /* Other new findings, matched one by one and excluding what is already
     reported above (exposed secrets; import cycles, compared structurally).
     A rollup endpoint only has counts: net delta, as before. */
  const otherNew = sets
    ? sets.risks.new.length
    : diff.stats.risks.delta - Math.max(0, diff.stats.secrets.delta);
  if (otherNew > 0) {
    const rules = sets ? [...new Set(sets.risks.new.map((r) => r.rule))].sort() : [];
    findings.push({
      kind: 'risk',
      severity: RISK_DELTA_SEVERITY,
      title: `Adds ${otherNew} new risk finding${otherNew === 1 ? '' : 's'}`,
      detail: sets
        ? `New scanner findings the base did not have: ${rules.join(', ')}.`
        : `Scanner findings (broken/stale/TODO/license) rose by ${otherNew} net of secrets.`,
      evidence: { count: otherNew, ...(sets ? { files: filesOf(sets.risks.new) } : {}) },
    });
  }

  const severity = rollupSeverity(findings);
  // Listed after the roll-up: shown, never counted toward the level.
  if (ungradedSecrets) findings.push(ungradedSecrets);
  if (ungradedVulns) findings.push(ungradedVulns);
  /* Say so whenever secrets were present but could not be graded — even with
     nothing listed, the old comparison cannot see a key swapped in place.
     With per-file data, a secret in a file only one side has was graded
     (diffFindings), so only the others call for the note. */
  let secretsNote = '';
  if (!grading.graded) {
    const fromPaths = new Set(from.files.map((f) => f.path));
    const toPaths = new Set(to.files.map((f) => f.path));
    const oneSided = (r: Risk) => r.file != null && fromPaths.has(r.file) !== toPaths.has(r.file);
    const ungradable = sets
      ? [...from.risks, ...to.risks].some((r) => isExposedSecret(r) && !oneSided(r))
      : diff.stats.secrets.before > 0 || diff.stats.secrets.after > 0;
    if (ungradable) {
      secretsNote = ` ${sets ? 'Secrets in files the baseline already had were' : 'Secrets were'} not graded: ${UNGRADED_SECRETS_WHY[grading.reason]}. Re-save the baseline with this version to grade them.`;
    }
  }

  return {
    $schema: 'https://factstack.dev/schema/verdict.v1.json',
    factsVersion: from.factsVersion,
    generatedAt: generatedAt ?? new Date().toISOString(),
    from: { at: from.generatedAt },
    to: { at: to.generatedAt },
    severity,
    headline:
      buildHeadline(severity, findings, {
        filesAdded: diff.files.added.length,
        filesChanged: diff.files.changed.length,
        filesRemoved: diff.files.removed.length,
      }) +
      (rollup
        ? ` ${
            fromRollup && toRollup
              ? 'Both sides are stats-only snapshots'
              : fromRollup
                ? 'Baseline is a stats-only snapshot'
                : 'Head is a stats-only snapshot'
          }: cycles, vulnerabilities and individual findings were not compared.`
        : '') +
      secretsNote,
    findings,
    blastRadius: {
      changedFiles: changedPaths.length,
      maxReach,
      ...(topFile ? { topFile } : {}),
    },
    summary: {
      filesAdded: diff.files.added.length,
      filesChanged: diff.files.changed.length,
      filesRemoved: diff.files.removed.length,
      secretsAdded,
      risksDelta: diff.stats.risks.delta,
      vulnsNew: rollup ? 0 : diff.vulns.new.length,
      vulnsFixed: rollup ? 0 : diff.vulns.fixed.length,
      severityShift: rollup ? 0 : diff.vulns.severityShift,
      cyclesNew: newCycles.length,
    },
  };
}

const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  none: 'No risk',
  low: 'Low risk',
  medium: 'Elevated risk',
  high: 'High risk',
  critical: 'Critical risk',
};

/** Deterministic one-liner: "<severity>: <top finding>; <N files changed>." */
function buildHeadline(
  severity: ReviewSeverity,
  findings: ChangeFinding[],
  files: { filesAdded: number; filesChanged: number; filesRemoved: number },
): string {
  const fileBits: string[] = [];
  if (files.filesAdded) fileBits.push(`+${files.filesAdded}`);
  if (files.filesChanged) fileBits.push(`~${files.filesChanged}`);
  if (files.filesRemoved) fileBits.push(`-${files.filesRemoved}`);
  const fileClause = fileBits.length ? `${fileBits.join(' ')} files` : 'no file changes';

  if (findings.length === 0) {
    return `${SEVERITY_LABEL.none}: ${fileClause}, nothing risk-relevant moved.`;
  }
  // Lead with the highest-severity findings' titles (already worst-first by
  // construction order: secret > vuln > cycle > hotspot > risk).
  const ranked = [...findings].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const lead = ranked
    .slice(0, 2)
    .map((f) => f.title.charAt(0).toLowerCase() + f.title.slice(1))
    .join('; ');
  return `${SEVERITY_LABEL[severity]}: ${lead}. (${fileClause})`;
}

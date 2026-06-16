/**
 * Composite project-health grade — pure + deterministic.
 *
 * Replaces the old plain-count headline ("106 TODOs.") with a 0–100 score +
 * letter grade. The score is weighted SECURITY/CORRECTNESS-FIRST: secrets,
 * vulnerabilities, and broken imports are grade-killers; cycles/stale/oversized
 * are moderate; TODO volume is a minor nudge — so a clean-but-TODO-heavy repo
 * still grades well (the whole point of the rewrite).
 *
 * Reads ONLY fields already on the AgentArtifact — no file re-reads, no
 * `Date.now()`/`Math.random()` (the old `stale` count called `Date.now()`,
 * a purity smell; here `stale` derives from `file.status`, keeping analyze()
 * byte-deterministic, INV1/INV2). Vulnerabilities are usually restored onto the
 * agent AFTER analyze(), so callers that restore them (CLI/MCP) recompute health.
 *
 * Scoring — start at 100, subtract capped penalties, clamp [0,100]:
 *   secrets exposed     −25 each   (cap 60)
 *   known vulns         by severity (cap 50): critical 20 · high 12 · medium 5 · low/unknown 2
 *   broken imports      −8 each    (cap 32)
 *   import cycles       −3 each    (cap 18)
 *   oversized files     −2 each    (cap 10)
 *   stale files         −1 each    (cap 10)
 *   TODOs               ⌊count/50⌋ (cap 6)   ← 106 TODOs ⇒ only −2
 * Letter: A≥90 · B≥80 · C≥70 · D≥60 · else F.
 */
import type { AgentArtifact, HealthFactor, HealthHeadline } from '@factstack/spec';

/** Points each vulnerability subtracts, by severity (before the category cap). */
const VULN_WEIGHT: Record<string, number> = { critical: 20, high: 12, medium: 5, low: 2, unknown: 2, info: 0 };

/** Singular form of each factor label, for grammatically-correct prose at
 *  count === 1 ("1 secret exposed", not "1 secrets exposed"). The plural
 *  label stays the stable id in `factors[]` for the ledger/columns; only the
 *  headline + banner prose pluralize. Keyed by the canonical plural label. */
const FACTOR_SINGULAR: Record<string, string> = {
  'secrets exposed': 'secret exposed',
  'known vulnerabilities': 'known vulnerability',
  'broken imports': 'broken import',
  'import cycles': 'import cycle',
  'oversized files': 'oversized file',
  'stale files': 'stale file',
  TODOs: 'TODO',
};

/** "{count} {label}" with the label de-pluralized at count === 1. Pure. */
function phrase(count: number, label: string): string {
  return `${count} ${count === 1 ? FACTOR_SINGULAR[label] ?? label : label}`;
}

const clamp = (n: number, max: number): number => Math.min(Math.max(0, Math.round(n)), max);

export function computeHealth(agent: AgentArtifact): HealthHeadline {
  const risks = agent.risks ?? [];
  const files = agent.files ?? [];
  const vulns = agent.vulnerabilities ?? [];

  // `broken` = distinct files with a broken-import / parse-error / read-error
  // risk (unscanned-import excluded — the file builds fine). Mirrors the prior
  // headline's definition so the structured count stays continuous.
  const brokenFiles = new Set<string>();
  for (const r of risks) {
    if (r.rule === 'unscanned-import') continue;
    if ((r.category === 'broken-import' || r.category === 'parse-error' || r.category === 'read-error') && r.file) {
      brokenFiles.add(r.file);
    }
  }
  const broken = brokenFiles.size;
  const secrets = risks.filter((r) => r.category === 'secret').length;
  const oversized = risks.filter((r) => r.category === 'large-file').length;
  const stale = files.filter((f) => f.status === 'stale').length;
  const todos = files.reduce((sum, f) => sum + (f.todos?.length ?? 0), 0);
  const cycles = agent.graph?.cycles?.length ?? 0;
  const vulnPenalty = vulns.reduce((sum, v) => sum + (VULN_WEIGHT[v.severity] ?? 2), 0);

  const candidates: HealthFactor[] = [
    { label: 'secrets exposed', count: secrets, penalty: clamp(secrets * 25, 60) },
    { label: 'known vulnerabilities', count: vulns.length, penalty: clamp(vulnPenalty, 50) },
    { label: 'broken imports', count: broken, penalty: clamp(broken * 8, 32) },
    { label: 'import cycles', count: cycles, penalty: clamp(cycles * 3, 18) },
    { label: 'oversized files', count: oversized, penalty: clamp(oversized * 2, 10) },
    { label: 'stale files', count: stale, penalty: clamp(stale, 10) },
    { label: 'TODOs', count: todos, penalty: clamp(Math.floor(todos / 50), 6) },
  ];

  const score = Math.max(0, 100 - candidates.reduce((sum, f) => sum + f.penalty, 0));
  const grade: NonNullable<HealthHeadline['grade']> =
    score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

  // Top deductions first; ties broken by label (deterministic). Only factors
  // that actually cost points appear.
  const factors = candidates
    .filter((f) => f.penalty > 0)
    .sort((a, b) => b.penalty - a.penalty || (a.label < b.label ? -1 : 1))
    .slice(0, 3);

  const tail =
    factors.length === 0
      ? 'clean — no blockers detected'
      : factors.map((f) => phrase(f.count, f.label)).join(', ');

  return { broken, stale, todos, secrets, score, grade, factors, headline: `${grade} · ${score} — ${tail}` };
}

/**
 * CVE plumbing shared by `scan-vulns`, `outdated`, the dashboard's
 * /api/deps-outdated and every analyze path's scan carry-forward.
 *
 * Owner decision 2026-09-24 (security#8, INV7): every surface builds its OSV
 * queries with @factstack/scanners' ONE lockfile-aware builder — installed
 * versions from the lockfiles, `declared range` labels where there is none,
 * dev/transitive findings shown but not graded — so the CLI, the MCP server
 * and the dashboard agree on the same repo. This module is the CLI's disk
 * side of it: find + parse the lockfiles, then hand text to the pure API.
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildOsvQueries,
  carryVulnerabilityScan,
  isGradedVulnerability,
  lockfileCandidates,
  parseLockfile,
  vulnerabilityLabels,
  VULN_LABEL_TEXT,
  type OsvQuery,
  type OsvQueryPlan,
  type OutdatedQuery,
  type ParsedLockfile,
} from '@factstack/scanners';
import { computeHealth } from '@factstack/core';
import { writeArtifacts } from '@factstack/emit';
import {
  AgentArtifactSchema,
  HumanArtifactSchema,
  type AgentArtifact,
  type DependencyManifest,
  type HumanArtifact,
  type Vulnerability,
} from '@factstack/spec';

/**
 * The lockfiles covering these manifests (each manifest's dir and every
 * ancestor), parsed. Local disk only — never the network. An unreadable or
 * unparseable lockfile is skipped: that manifest scans its declared ranges.
 * Mirrors apps/mcp-server's readLockfiles so both surfaces resolve alike.
 */
export function readLockfiles(
  root: string,
  manifests: readonly DependencyManifest[],
): ParsedLockfile[] {
  const out: ParsedLockfile[] = [];
  for (const rel of lockfileCandidates(manifests.map((m) => m.path))) {
    try {
      const abs = path.join(root, rel);
      if (!existsSync(abs)) continue;
      const lock = parseLockfile(rel, readFileSync(abs, 'utf8'));
      if (lock) out.push(lock);
    } catch {
      /* unreadable lockfile → declared ranges for what it covered */
    }
  }
  return out;
}

/**
 * The scan-vulns query plan. `prodOnly` keeps direct runtime deps only
 * (drops dev + transitive), which is what ships and what is graded. The full
 * plan is buildOsvQueries' own. The builder has no scope filter yet
 * (requested from scanners), so for the prod-only subset: `skipped` comes
 * from the builder run over the runtime maps alone — a dev dep with no
 * registry version was never in scope (cli-r3-5) — and the labels of the
 * kept queries are counted here.
 */
export function planOsvQueries(
  manifests: readonly DependencyManifest[],
  lockfiles: readonly ParsedLockfile[],
  opts: { prodOnly?: boolean } = {},
): OsvQueryPlan {
  const plan = buildOsvQueries(manifests, lockfiles);
  if (!opts.prodOnly) return plan;
  const queries = plan.queries.filter((q) => q.scope === 'direct');
  const runtimeOnly = manifests.map((m) => ({ ...m, devDependencies: {} }));
  const { skipped } = buildOsvQueries(runtimeOnly, lockfiles);
  return { queries, skipped, labels: labelsOf(queries) };
}

function labelsOf(queries: readonly OsvQuery[]): OsvQueryPlan['labels'] {
  const labels: OsvQueryPlan['labels'] = {
    scope: { direct: 0, dev: 0, transitive: 0 },
    versionSource: { lockfile: 0, 'declared-range': 0 },
  };
  for (const q of queries) {
    if (q.scope) labels.scope[q.scope]++;
    if (q.versionSource) labels.versionSource[q.versionSource]++;
  }
  return labels;
}

/**
 * Registry-freshness queries for `outdated` / /api/deps-outdated: the
 * project's OWN deps (direct + dev, not transitive) at the version actually
 * installed, under the real package name for an `npm:` alias — the same
 * resolution the CVE scan uses. `skipped` counts deps with no registry
 * version (workspace:/file:/git:, `*`, `latest`) plus non-npm ones.
 */
export function planOutdatedQueries(
  manifests: readonly DependencyManifest[],
  lockfiles: readonly ParsedLockfile[],
): { queries: OutdatedQuery[]; skipped: number } {
  const plan = buildOsvQueries(manifests, lockfiles);
  const seen = new Set<string>();
  const queries: OutdatedQuery[] = [];
  let nonNpm = 0;
  for (const q of plan.queries) {
    if (q.scope === 'transitive') continue;
    if (q.ecosystem !== 'npm') {
      nonNpm++;
      continue;
    }
    const key = `${q.name}@${q.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ ecosystem: 'npm', name: q.name, current: q.version });
  }
  return { queries, skipped: plan.skipped + nonNpm };
}

/** "3 findings on a declared range (not resolved from a lockfile — …)" in
 *  the scanners' shared VULN_LABEL_TEXT wording (INV7); no noun → "3 on a …". */
export function declaredRangeNote(count: number, noun = ''): string {
  const n = noun ? ` ${noun}${count === 1 ? '' : 's'}` : '';
  return `${count}${n} on a ${VULN_LABEL_TEXT.declaredRange}`;
}

/** Findings as the MCP `vulnerabilities` tool returns them: `graded`, plus
 *  `labels` (vulnerabilityLabels) when there is a provenance note — one
 *  shape and one wording on every surface (INV7). */
export function labelVulnerabilities(
  vulns: readonly Vulnerability[],
): Array<Vulnerability & { graded: boolean; labels?: string[] }> {
  return vulns.map((v) => {
    const labels = vulnerabilityLabels(v);
    return { ...v, graded: isGradedVulnerability(v), ...(labels.length ? { labels } : {}) };
  });
}

/** One human line per provenance group, e.g. "12 direct · 30 dev · 600
 *  transitive — dev/transitive: shown, not graded". Counts come from the
 *  plan's own labels; empty groups are omitted. */
export function describePlan(plan: OsvQueryPlan): string[] {
  const { scope, versionSource } = plan.labels;
  const lines: string[] = [];
  const parts = [
    scope.direct ? `${scope.direct} direct` : '',
    scope.dev ? `${scope.dev} dev` : '',
    scope.transitive ? `${scope.transitive} transitive` : '',
  ].filter(Boolean);
  if (parts.length) {
    const ungraded =
      scope.dev + scope.transitive > 0 ? ` — dev/transitive: ${VULN_LABEL_TEXT.notGraded}` : '';
    lines.push(parts.join(' · ') + ungraded);
  }
  if (versionSource['declared-range'] > 0) {
    lines.push(declaredRangeNote(versionSource['declared-range']));
  }
  if (plan.skipped > 0) {
    lines.push(
      `${plan.skipped} skipped — no registry version to query (workspace:/file:/git:, \`*\`, \`latest\`, upper-bound-only)`,
    );
  }
  return lines;
}

/** How long scanTarget waits before re-reading a newer agent.json whose
 *  human.json is not from the same run yet (a writer mid-run). */
const PAIR_REREAD_MS = 50;

const olderThan = (a: { generatedAt: string }, b: { generatedAt: string }): boolean =>
  Date.parse(a.generatedAt) < Date.parse(b.generatedAt);

/** agent.json / human.json as raw JSON; null when missing or not JSON. */
function readRaw(p: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The analysis scan-vulns writes its scan onto, chosen INSIDE the write step
 * (data-model#3 / correctness#9): the pair it loaded before querying OSV, or
 * the NEWER full analysis another writer — the per-edit hook, `ui --watch`,
 * an MCP analyze — put in .facts/ while OSV was answering. Writing the loaded
 * copy back reverted that analysis on disk. Same rule as the MCP server's
 * newestArtifacts (INV7): writeArtifacts lands agent.json before human.json,
 * so a newer agent.json whose human.json is from another run is a writer
 * mid-run — re-read once, then throw rather than write either file. An
 * unreadable or non-analysis agent.json on disk keeps the loaded pair.
 */
export async function scanTarget(
  root: string,
  loaded: { agent: AgentArtifact; human: HumanArtifact },
  opts: { rereadMs?: number } = {},
): Promise<{ agent: AgentArtifact; human: HumanArtifact; adopted: boolean }> {
  const factsDir = path.join(root, '.facts');
  for (let attempt = 0; ; attempt++) {
    const disk = readRaw(path.join(factsDir, 'agent.json'));
    const at = disk?.generatedAt;
    const full = !!disk && Array.isArray(disk.files) && !!disk.graph && typeof at === 'string';
    if (!full || !olderThan(loaded.agent, { generatedAt: at }))
      return { ...loaded, adopted: false };
    const human = readRaw(path.join(factsDir, 'human.json'));
    if (human?.generatedAt === at) {
      const agent = AgentArtifactSchema.safeParse(disk);
      const pair = HumanArtifactSchema.safeParse(human);
      if (agent.success && pair.success) {
        return {
          agent: agent.data as AgentArtifact,
          human: pair.data as HumanArtifact,
          adopted: true,
        };
      }
    }
    if (attempt > 0) {
      throw new Error(
        `.facts/agent.json now holds a newer analysis (${at}) whose human.json is missing, invalid or from another run — ` +
          'not writing the older analysis over it. Run `factstack analyze`, then scan-vulns again.',
      );
    }
    await new Promise((r) => setTimeout(r, opts.rereadMs ?? PAIR_REREAD_MS));
  }
}

/**
 * scan-vulns' write-back: the analysis on disk (scanTarget), re-saved with
 * its fresh CVE scan (the .pack/.jsonl companions refresh with it). It is not
 * a new analysis, so it never rotates the review baseline — emit's
 * `rotateBaseline: false` contract (R8) — which also skips re-reading the
 * multi-MB previous agent.json.
 */
export function saveScannedArtifacts(opts: {
  root: string;
  agent: AgentArtifact;
  human: HumanArtifact;
  memoryBody: string;
}): ReturnType<typeof writeArtifacts> {
  return writeArtifacts({ ...opts, addGitignoreEntry: false, rotateBaseline: false });
}

/** Outcome of the scan carry-forward, for the caller's one-line notice. */
export interface RestoreVulnScanResult {
  /** A prior scan was carried onto the fresh artifact. */
  carried: boolean;
  /** Set when a prior scan existed but could not be carried — never silent. */
  warning?: string;
}

/** Sleep synchronously (the carry-forward runs inside sync call chains). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * v0.11 — carry the last vulnerability scan ACROSS a re-analyze. analyze()
 * itself never touches the network (INV6) and returns an empty vulnerability
 * list, which used to WIPE previously scanned CVEs on every refresh — after a
 * re-analyze the artifact looked "never scanned". Restore the prior scan from
 * the old artifact, RECONCILED against the fresh manifests AND the lockfiles
 * (the same resolution scan-vulns used), so removed or upgraded deps drop
 * their stale findings (no zombie CVEs). `scannedAt` is kept from the
 * original scan — carrying forward never makes data look fresher than it is.
 *
 * Failure handling (emit request + data-model#46):
 *   - no prior agent.json (ENOENT) → nothing to carry, silently;
 *   - a prior file that will not parse is re-read once after ~50 ms (a
 *     writer mid-swap); still unreadable → a WARNING, not silence;
 *   - a prior scan that fails the current schema (an older FACTS, a hand
 *     edit) is dropped with a warning instead of making every later analyze
 *     fail on the final schema check. Rows are validated one by one, so one
 *     malformed finding costs only itself.
 * Always re-grades health afterwards (analyze() grades before this runs).
 */
export function restoreVulnScan(
  root: string,
  agent: AgentArtifact,
  human?: HumanArtifact,
): RestoreVulnScanResult {
  const result = carryForward(root, agent);
  /* v0.3 — re-grade health AFTER the CVE carry-forward so vulnerabilities land
     in the score/headline. Idempotent when there are no vulns. */
  if (human) human.summary.health = computeHealth(agent);
  return result;
}

const RESCAN_HINT = 're-run `factstack scan-vulns` to rebuild the vulnerability scan';

function carryForward(root: string, agent: AgentArtifact): RestoreVulnScanResult {
  const p = path.join(root, '.facts', 'agent.json');
  let prev: Partial<AgentArtifact> | null = null;
  for (let attempt = 0; attempt < 2 && prev === null; attempt++) {
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { carried: false };
      if (attempt === 0) {
        sleepSync(50);
        continue;
      }
      return {
        carried: false,
        warning: `could not read the previous .facts/agent.json (${(err as Error).message}) — its vulnerability scan was not carried forward; ${RESCAN_HINT}`,
      };
    }
    try {
      /* Raw parse, not full validation: the prior artifact may predate the
         current schema; only the two scan fields are needed (checked below). */
      const parsed = JSON.parse(text) as unknown;
      prev = parsed && typeof parsed === 'object' ? (parsed as Partial<AgentArtifact>) : {};
    } catch {
      if (attempt === 0) {
        sleepSync(50);
        continue;
      }
      return {
        carried: false,
        warning: `the previous .facts/agent.json is not valid JSON — its vulnerability scan was not carried forward; ${RESCAN_HINT}`,
      };
    }
  }
  /* The scanners' one carry rule, shared with the MCP restore — a
     scan whose rows are not an array is dropped with a warning instead of
     carrying as "scanned and clean", and a findings/rows mismatch is said. */
  const carried = carryVulnerabilityScan(
    prev,
    agent.dependencyManifests,
    () => readLockfiles(root, agent.dependencyManifests),
    RESCAN_HINT,
  );
  if (!carried.carried) return carried;
  agent.vulnerabilities = carried.vulnerabilities;
  agent.vulnerabilityScan = carried.scan;
  return carried.warning !== undefined
    ? { carried: true, warning: carried.warning }
    : { carried: true };
}

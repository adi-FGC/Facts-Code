/**
 * `factstack scan-vulns [target]`: query OSV.dev for the project's
 * dependencies (lockfile versions when there is one) and persist the
 * findings into .facts/ (network step; never auto-analyzes).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import kleur from 'kleur';
import { buildMemory, computeHealth } from '@factstack/core';
import { readStaleMark, StaleResaveError, staleHint } from '@factstack/emit';
import {
  isGradedVulnerability,
  noopCache,
  osvResultsToVulnerabilities,
  queryOsvBatch,
  reconcileVulnerabilities,
  VULN_LABEL_TEXT,
  type OsvQuery,
} from '@factstack/scanners';
import type { AgentArtifact, HumanArtifact, Vulnerability } from '@factstack/spec';
import { loadAndValidate } from '../artifacts.js';
import { ageDays } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { loadContextStore } from '../learnings.js';
import { reportDiffSkipped } from '../pipeline.js';
import {
  declaredRangeNote,
  describePlan,
  labelVulnerabilities,
  planOsvQueries,
  readLockfiles,
  saveScannedArtifacts,
  scanTarget,
} from '../vulns.js';

/** One OSV query's identity: ecosystem, package, version. */
const osvQueryKey = (q: OsvQuery): string => `${q.ecosystem}\t${q.name}\t${q.version}`;

export interface ScanVulnsOptions {
  prodOnly?: boolean;
  cache: boolean;
  json?: boolean;
}

export async function scanVulnsCommand(
  target: string | undefined,
  opts: ScanVulnsOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const agentPath = path.join(root, '.facts', 'agent.json');
  const humanPath = path.join(root, '.facts', 'human.json');

  /* Pre-flight: agent.json must exist + be valid. We deliberately
   do NOT auto-analyze here (unlike `ui` which does it) — scan-vulns
   is the network-touching step, and we want the user's "analyze
   happened" decision to be explicit. */
  if (!existsSync(agentPath)) {
    io.stderr.write(kleur.red('factstack scan-vulns: ') + 'no .facts/agent.json found.\n');
    io.stderr.write(kleur.dim('  run `factstack analyze .` first; then re-run scan-vulns.\n'));
    io.exit(1);
  }

  /* The per-edit `--minimal` hook refreshes agent.pack only and marks
   agent.json stale (emit, performance#1). A scan applied to that older
   agent.json would be refused at write time (StaleResaveError) — after
   every OSV query. Say so now, before any network. */
  const stale = readStaleMark(path.join(root, '.facts'));
  if (stale) {
    io.stderr.write(kleur.red('factstack scan-vulns: ') + staleHint(stale) + '\n');
    io.exit(1);
  }

  let agent: AgentArtifact;
  let human: HumanArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
    human = loadAndValidate<HumanArtifact>(humanPath, 'human');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack scan-vulns: ') +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    io.exit(1);
  }

  /* Build the OSV query list with the ONE shared, lockfile-aware builder
   (owner CVE decision, INV7 — the MCP refresh and the dashboard use the
   same): each direct dep at the version the lockfile says is INSTALLED
   (else its declared range's lower bound, labelled "declared range"),
   npm aliases under the real package, and every locked TRANSITIVE
   package too. One query per package@version across the workspace.
   --prod-only keeps direct runtime deps only. */
  const lockfiles = readLockfiles(root, agent.dependencyManifests);
  const plan = planOsvQueries(agent.dependencyManifests, lockfiles, {
    prodOnly: opts.prodOnly === true,
  });
  const { queries, skipped } = plan;

  if (queries.length === 0) {
    io.stderr.write(
      kleur.bold().green('FACTS') +
        kleur.dim(' · scan-vulns: ') +
        '0 queriable deps (try `factstack analyze` first?)\n',
    );
    for (const l of describePlan(plan)) io.stderr.write(kleur.dim(`  ${l}\n`));
    return;
  }

  io.stderr.write(
    kleur.bold().green('FACTS') +
      kleur.dim(' · scan-vulns: querying ') +
      kleur.cyan(String(queries.length)) +
      kleur.dim(` dep${queries.length === 1 ? '' : 's'} against OSV.dev…\n`),
  );
  if (!opts.json) {
    for (const l of describePlan(plan)) io.stderr.write(kleur.dim(`  ${l}\n`));
    if (lockfiles.length > 0) {
      io.stderr.write(
        kleur.dim(`  installed versions from ${lockfiles.map((l) => l.path).join(', ')}\n`),
      );
    }
  }

  const t0 = performance.now();
  let results;
  try {
    /* MVP cache: noopCache. A future filesystem cache at
     .facts/cache/osv/ would speed up repeated CI runs, but the
     OSV API is generous + a single run is the common case. */
    results = await queryOsvBatch(queries, {
      cache: opts.cache === false ? noopCache : noopCache,
    });
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack scan-vulns: ') +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    io.stderr.write(kleur.dim('  network error? OSV.dev unreachable? Re-run later.\n'));
    io.exit(1);
  }
  const elapsedMs = performance.now() - t0;

  /* data-model#3 / correctness#9: the analysis to write onto is chosen NOW,
   not when scan-vulns started — the per-edit hook, `ui --watch` or an MCP
   analyze may have written a newer one while OSV was answering, and writing
   the loaded copy back reverted it. Same rule as the MCP refresh (INV7). */
  let head: Awaited<ReturnType<typeof scanTarget>>;
  try {
    head = await scanTarget(root, { agent, human });
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack scan-vulns: ') +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    io.exit(1);
  }
  /* Convert OSV's raw shape into the canonical Vulnerability[] the artifact
   carries (clean packages drop out), reconciled against the head's
   manifests + lockfiles as they are now: findings for a dep removed or
   upgraded meanwhile drop, and one added meanwhile is counted as unscanned. */
  const locks = readLockfiles(root, head.agent.dependencyManifests);
  const vulnerabilities: Vulnerability[] = reconcileVulnerabilities(
    osvResultsToVulnerabilities(results),
    head.agent.dependencyManifests,
    locks,
  );
  const asked = new Set(queries.map(osvQueryKey));
  const unscanned = planOsvQueries(head.agent.dependencyManifests, locks, {
    prodOnly: opts.prodOnly === true,
  }).queries.filter((q) => !asked.has(osvQueryKey(q))).length;

  /* Persist back to agent.json. We rewrite the whole artifact via
   writeArtifacts so the .pack + .jsonl companions also refresh
   (they're regenerated from the same in-memory artifact every
   write, so stale companion files would lie about the new vulns). */
  const previousScan = head.agent.vulnerabilityScan;
  // EH-3: how many advisories degraded to id-only (detail fetch failed) so
  // readers can tell a clean scan from a degraded one. Computed once (mirrors
  // the server.ts builder) — reused by the guard + the value below.
  const detailsFailed = results.reduce((n, r) => n + (r.detailsFailed ?? 0), 0);
  const nextAgent: AgentArtifact = {
    ...head.agent,
    vulnerabilities,
    /* v0.11 — the scan metadata is the staleness anchor + the explicit
     "scanned and clean" marker (empty list + scannedAt = verified clean).
     restoreVulnScan carries it across future re-analyzes. */
    vulnerabilityScan: {
      scannedAt: new Date().toISOString(),
      source: 'osv.dev',
      packagesQueried: queries.length,
      packagesSkipped: skipped,
      findings: vulnerabilities.length,
      ...(detailsFailed > 0 ? { detailsFailed } : {}),
      /* The lockfiles the saved findings were reconciled against — the
         head's, read now — not the ones read before OSV.dev answered: an
         adopted head may have gained or lost one meanwhile (cli-rev-6). */
      ...(locks.length > 0 ? { lockfiles: locks.map((l) => l.path) } : {}),
      /* Deps added or changed while OSV.dev was answering are not in
         this scan. Persisted, so no later reader takes findings 0 for a
         verified-clean answer about them (the spec's additive field). */
      ...(unscanned > 0 ? { unscanned } : {}),
    },
  };
  /* v0.3 — re-grade health now that fresh CVEs are on the agent, so the
   score/headline reflects the scan in both human.json and MEMORY.md. */
  const nextHuman: HumanArtifact = {
    ...head.human,
    summary: { ...head.human.summary, health: computeHealth(nextAgent) },
  };
  /* Same analysis, re-saved: never rotates the review baseline (R8). emit
   refuses it (StaleResaveError, nothing written) when agent.pack already
   holds a newer analysis — the per-edit `--minimal` hook ran while OSV.dev
   was answering, and it writes no agent.json to apply the scan to. */
  let written: Awaited<ReturnType<typeof saveScannedArtifacts>>;
  try {
    written = await saveScannedArtifacts({
      root,
      agent: nextAgent,
      human: nextHuman,
      memoryBody: buildMemory(nextAgent, nextHuman, { contextStore: loadContextStore(root) }),
    });
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack scan-vulns: ') +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    if (err instanceof StaleResaveError) {
      io.stderr.write(
        kleur.dim(
          '  a newer analysis landed while OSV.dev was answering (the per-edit `analyze --minimal` hook); nothing was written.\n',
        ),
      );
    }
    io.exit(1);
  }
  reportDiffSkipped(written, io);
  if (head.adopted) {
    io.stderr.write(
      kleur.dim(
        `  applied to the newer analysis written while OSV.dev was answering (${head.agent.generatedAt}).\n`,
      ),
    );
  }
  if (unscanned > 0) {
    io.stderr.write(
      kleur.yellow(
        `  ${unscanned} dependenc${unscanned === 1 ? 'y' : 'ies'} changed while OSV.dev was answering and ${unscanned === 1 ? 'is' : 'are'} not in this scan — re-run \`factstack scan-vulns\`.\n`,
      ),
    );
  }
  if (previousScan) {
    const age = ageDays(previousScan.scannedAt);
    io.stderr.write(
      kleur.dim(
        `  refreshed — previous scan was ${age === 0 ? 'earlier today' : `${age}d old`} (${previousScan.findings} finding${previousScan.findings === 1 ? '' : 's'}).\n`,
      ),
    );
  }

  /* Explicit shape (not Record<string, number>) so noUncheckedIndexedAccess
   can prove each key exists at read time. `counts` covers the GRADED
   findings (direct runtime deps); dev/transitive ones are shown, not
   graded (owner call), and counted apart. */
  type SeverityCounts = {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  const zero = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
  const counts = zero();
  const ungradedCounts = zero();
  for (const v of vulnerabilities) {
    const bucket = isGradedVulnerability(v) ? counts : ungradedCounts;
    bucket[v.severity] = bucket[v.severity] + 1;
  }
  const ungraded = vulnerabilities.filter((v) => !isGradedVulnerability(v)).length;
  const declaredRange = vulnerabilities.filter((v) => v.versionSource === 'declared-range').length;
  const totalVulnerable = new Set(
    vulnerabilities.map((v) => `${v.ecosystem}|${v.package}@${v.installedVersion}`),
  ).size;

  if (opts.json) {
    io.stdout.write(
      JSON.stringify(
        {
          scanned: queries.length,
          /** @deprecated kept for older consumers — same value as `skipped`. */
          skippedNonRegistry: skipped,
          skipped,
          queryLabels: plan.labels,
          lockfiles: lockfiles.map((l) => l.path),
          vulnerablePackages: totalVulnerable,
          findings: vulnerabilities.length,
          counts,
          ungraded: { findings: ungraded, counts: ungradedCounts },
          declaredRangeFindings: declaredRange,
          ...(unscanned > 0 ? { unscanned } : {}),
          elapsedMs: Math.round(elapsedMs),
          // Each row as the MCP `vulnerabilities` tool returns it: `graded`
          // plus the scanners' shared provenance labels (INV7).
          vulnerabilities: labelVulnerabilities(vulnerabilities),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  /* TTY summary — clear-eyed numbers + a one-line headline. */
  const sevLine = (c: SeverityCounts): string => {
    const parts: string[] = [];
    if (c.critical > 0) parts.push(kleur.red(`${c.critical} critical`));
    if (c.high > 0) parts.push(kleur.yellow(`${c.high} high`));
    if (c.medium > 0) parts.push(kleur.cyan(`${c.medium} medium`));
    if (c.low > 0) parts.push(kleur.dim(`${c.low} low`));
    if (c.unknown > 0) parts.push(kleur.dim(`${c.unknown} unknown`));
    return parts.join(kleur.dim(' · '));
  };
  const lines: string[] = [];
  lines.push(
    kleur.bold().green('FACTS') +
      kleur.dim(
        ` · scan-vulns: ${queries.length} scanned, ${totalVulnerable} vulnerable, ${vulnerabilities.length} ${vulnerabilities.length === 1 ? 'finding' : 'findings'}`,
      ) +
      kleur.dim(` · ${Math.round(elapsedMs)}ms`),
  );
  if (vulnerabilities.length === 0) {
    lines.push(
      unscanned > 0
        ? kleur.yellow(
            `  no known vulnerabilities at queried versions — partial: ${unscanned} dependenc${unscanned === 1 ? 'y' : 'ies'} not scanned`,
          )
        : kleur.green('  ✓ no known vulnerabilities at queried versions'),
    );
  } else {
    const graded = vulnerabilities.length - ungraded;
    lines.push(
      `  graded (direct): ${graded === 0 ? kleur.green('0') : sevLine(counts)}` +
        (ungraded > 0
          ? kleur.dim(` · dev/transitive: ${ungraded} — ${VULN_LABEL_TEXT.notGraded} (`) +
            sevLine(ungradedCounts) +
            kleur.dim(')')
          : ''),
    );
    if (declaredRange > 0) {
      lines.push(kleur.yellow(`  ${declaredRangeNote(declaredRange, 'finding')}`));
    }
    lines.push(
      kleur.dim(
        '  written to .facts/agent.json — see the Vulnerabilities tab or `factstack query vulnerabilities`',
      ),
    );
  }
  io.stderr.write(lines.join('\n') + '\n');
}

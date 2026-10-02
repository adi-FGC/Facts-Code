/**
 * `factstack analyze [target]` (the default command): run the shared
 * analyze pipeline (../pipeline.ts) and print the TTY summary or, with
 * --json, the machine-readable result.
 */
import path from 'node:path';
import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import kleur from 'kleur';
import { formatLearningEvent, selfCalibrateEvent } from '@factstack/core';
import { ageDays, formatBytes, formatCount, relativize } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { analyzeProject, diffSkippedLine, reportDiffSkipped } from '../pipeline.js';
import { secretFindings, secretSummaryLines } from '../secretReport.js';
import { createTelemetry } from '../telemetry.js';

export interface AnalyzeOptions {
  json?: boolean;
  progress?: boolean;
  gitignoreEntry?: boolean;
  minimal?: boolean;
  symbols?: boolean;
  cache?: boolean;
  agentRequests?: boolean;
}

/** Days after which a vulnerability scan counts as stale — new CVEs are
 *  published daily, so a week-old scan can miss disclosures. */
export const VULN_SCAN_STALE_DAYS = 7;

export async function analyzeCommand(
  target: string | undefined,
  opts: AnalyzeOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const machine = opts.json ?? false;
  // Precondition: target must exist and be a directory. Without this
  // we run the walker, get 0 files, then crash deep inside writeArtifacts
  // with `ENOTDIR: not a directory, mkdir <root>/.facts`. Catch early.
  // (The exits stay outside the try: an in-process io.exit throws.)
  let isDirectory: boolean;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    io.stderr.write(kleur.red('factstack analyze: ') + kleur.cyan(root) + ' does not exist.\n');
    io.exit(1);
  }
  if (!isDirectory) {
    io.stderr.write(kleur.red('factstack analyze: ') + kleur.cyan(root) + ' is not a directory.\n');
    io.stderr.write(kleur.dim('  pass a project root, e.g. `factstack analyze .`\n'));
    io.exit(1);
  }
  const showProgress = !machine && (opts.progress ?? true);
  const t0 = performance.now();

  if (!machine) {
    io.stderr.write(
      kleur.bold().green('FACTS') + kleur.dim(' · analyzing ') + kleur.cyan(root) + '\n',
    );
  }

  let lastPrinted = 0;
  const minimal = opts.minimal ?? false;
  /* The shared pipeline (../pipeline.ts): F8 parse cache, host ignore rules,
     worktree topology (reused under --minimal), CVE carry-forward, and the
     artifact write — `legacy` by default so the CLI's own downstream
     commands, which read .facts/agent.json back, keep working; the lean
     set and no snapshot under --minimal. */
  const result = await analyzeProject(
    root,
    {
      cache: opts.cache !== false,
      minimal,
      symbols: opts.symbols ?? false,
      ...(opts.agentRequests !== undefined ? { agentRequests: opts.agentRequests } : {}),
      ...(showProgress
        ? {
            onProgress: (pct: number, file: string) => {
              const now = performance.now();
              // Throttle to 10 Hz for TTY friendliness.
              if (now - lastPrinted < 100 && pct < 1) return;
              lastPrinted = now;
              const width = 24;
              const filled = Math.round(pct * width);
              const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
              const label = file ? file.slice(-48).padEnd(48, ' ') : 'done'.padEnd(48, ' ');
              io.stderr.write(
                `\r  ${kleur.green(bar)} ${Math.round(pct * 100)}%  ${kleur.dim(label)}`,
              );
              if (pct >= 1) io.stderr.write('\n');
            },
          }
        : {}),
      addGitignoreEntry: opts.gitignoreEntry ?? true,
      writeSnapshot: !minimal,
    },
    io,
  );
  const { written, cacheStats, hostIgnoreRules } = result;

  const elapsed = performance.now() - t0;

  /* v0.3.4 — append a self-calibrate event to .facts/learnings.jsonl
   so the log starts accumulating from the very first analyze run.
   Best-effort; never fail an analyze just because we couldn't write
   a calibration row. */
  try {
    const ev = selfCalibrateEvent({
      fileCount: result.agent.stats.fileCount,
      totalLoc: result.agent.stats.loc,
      totalTokens: result.agent.stats.totalTokenCost,
      riskCount: result.agent.risks.length,
      durationMs: Math.round(elapsed),
    });
    const factsDir = path.join(root, '.facts');
    const fsmod = await import('node:fs');
    if (!fsmod.existsSync(factsDir)) fsmod.mkdirSync(factsDir, { recursive: true });
    fsmod.appendFileSync(path.join(factsDir, 'learnings.jsonl'), formatLearningEvent(ev), 'utf8');
  } catch {
    // Quiet — calibration is not load-bearing.
  }

  // ft-9: local-first telemetry — numbers only (duration + file count),
  // never throws, and sends nothing remote unless opted in + URL set.
  // `surface` names the entry point; `root` is hashed to a one-way rootId
  // on the way in, never stored as a path, and never sent at all. Without
  // these an analyze that surprises someone cannot be traced to a command
  // or a project — which is exactly what happened once.
  await createTelemetry().recordEvent('analyze.complete', {
    durationMs: Math.round(elapsed),
    fileCount: result.agent.stats.fileCount,
    surface: 'cli',
    root,
  });

  if (machine) {
    reportDiffSkipped(written, io); // also in the JSON below, as `diffSkipped`
    io.stdout.write(
      JSON.stringify(
        {
          ok: true,
          elapsedMs: Math.round(elapsed),
          ...written,
          stats: result.agent.stats,
          risks: result.agent.risks.length,
          /* Every secret match, with its exact path + line and a
             redacted preview (never the value). `graded: false` marks a
             test/fixture match that is listed but kept out of the grade. */
          secrets: secretFindings(result.agent.risks),
          ...(cacheStats ? { cache: cacheStats } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  // Pretty summary
  const s = result.agent.stats;
  const lines = [
    '',
    kleur.bold('  Summary'),
    kleur.dim('  ───────'),
    `  files        ${kleur.white(String(s.fileCount))}`,
    `  LOC          ${kleur.white(formatCount(s.loc))}`,
    `  tokens       ${kleur.white(formatCount(s.totalTokenCost))}${kleur.dim(' (cl100k approx)')}`,
    // F8 — incremental cache line (only when the cache ran). All-hits =
    // nothing changed; partial = only changed files re-parsed.
    ...(cacheStats && cacheStats.hits + cacheStats.misses > 0
      ? [
          `  cache        ${kleur.white(`${cacheStats.hits}/${cacheStats.hits + cacheStats.misses}`)} ${kleur.dim(
            cacheStats.hits === 0
              ? 'files parsed (cold cache)'
              : `reused · ${cacheStats.misses} re-parsed (incremental)`,
          )}`,
        ]
      : []),
    `  risks        ${result.agent.risks.length === 0 ? kleur.green('0') : kleur.yellow(String(result.agent.risks.length))}`,
    // v0.11 — vuln line only when a scan has ever run (carried forward by
    // restoreVulnScan). Staleness nudges the refresh; "never scanned" stays
    // quiet here because scan-vulns is the opt-in network step.
    ...(result.agent.vulnerabilityScan
      ? [
          (() => {
            const scan = result.agent.vulnerabilityScan!;
            const age = ageDays(scan.scannedAt);
            const count = result.agent.vulnerabilities.length;
            /* A scan that left deps unscanned is not a verified-clean
               0 — it is partial, and says so. */
            const partial = (scan.unscanned ?? 0) > 0;
            const countStr =
              count === 0 && !partial ? kleur.green('0') : kleur.yellow(String(count));
            const ageStr =
              age >= VULN_SCAN_STALE_DAYS
                ? kleur.yellow(`scanned ${age}d ago — refresh with \`factstack scan-vulns\``)
                : kleur.dim(`scanned ${age === 0 ? 'today' : `${age}d ago`}`);
            const partialStr = partial
              ? ' ' +
                kleur.yellow(
                  `· partial: ${scan.unscanned} dependenc${scan.unscanned === 1 ? 'y' : 'ies'} not scanned — re-run \`factstack scan-vulns\``,
                )
              : '';
            return `  vulns        ${countStr} ${ageStr}${partialStr}`;
          })(),
        ]
      : []),
    `  frameworks   ${kleur.white(result.agent.project.frameworks.join(', ') || '—')}`,
    /* v0.3.12 — the only input that is NOT the repository. Silence here
       made a shrinking file count unexplainable. */
    ...(hostIgnoreRules.some((r) => r.trim() && !r.trim().startsWith('#'))
      ? [
          `  host ignore  ${kleur.white(
            String(hostIgnoreRules.filter((r) => r.trim() && !r.trim().startsWith('#')).length),
          )}` + kleur.dim(' rule(s) from git global excludes / .git/info/exclude also applied'),
        ]
      : []),
    /* v0.3.11 — one line about the worktree topology, when there is one.
     Without it the whole Worktrees surface is invisible from the CLI. */
    ...(result.agent.git
      ? [
          `  worktrees    ${kleur.white(String(result.agent.git.worktrees.length))}` +
            kleur.dim(
              ` checkout${result.agent.git.worktrees.length === 1 ? '' : 's'} · ${result.agent.git.branches.length} branches`,
            ) +
            (() => {
              const dirty = result.agent.git.worktrees.filter(
                (w) => w.tree === 'dirty' || w.tree === 'conflicted',
              ).length;
              const unmerged = result.agent.git.worktrees.filter(
                (w) => w.integration === 'unmerged' || w.integration === 'merged-local',
              ).length;
              const bits: string[] = [];
              if (dirty > 0) bits.push(kleur.yellow(`${dirty} dirty`));
              if (unmerged > 0) bits.push(kleur.yellow(`${unmerged} unmerged`));
              return bits.length > 0
                ? kleur.dim(' · ') + bits.join(kleur.dim(' · '))
                : kleur.dim(' · all merged + clean');
            })(),
        ]
      : []),
    ...secretSummaryLines(secretFindings(result.agent.risks), {
      agentJsonWritten: written.agentPath !== null,
    }),
    '',
    kleur.bold('  Artifacts'),
    kleur.dim('  ─────────'),
    written.agentPath ? `  ${kleur.green('✓')} ${relativize(written.agentPath, root)}` : '',
    `  ${kleur.green('✓')} ${relativize(written.humanPath, root)}`,
    `  ${kleur.green('✓')} ${relativize(written.packPath, root)}`,
    written.diffPath ? `  ${kleur.green('✓')} ${relativize(written.diffPath, root)}` : '',
    diffSkippedLine(written),
    written.jsonlPath ? `  ${kleur.green('✓')} ${relativize(written.jsonlPath, root)}` : '',
    written.memoryPath ? `  ${kleur.green('✓')} ${relativize(written.memoryPath, root)}` : '',
    '',
    kleur.dim(
      `  Done in ${elapsed.toFixed(0)} ms. Total ${formatBytes(written.bytesWritten)} written.`,
    ),
    '',
  ];
  io.stderr.write(lines.filter(Boolean).join('\n') + '\n');
}

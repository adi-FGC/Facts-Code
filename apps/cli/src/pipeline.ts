/**
 * The ONE analyze-and-write pipeline (tech-debt#6). `analyze` and every
 * command that re-analyzes on its own — `ui` (start-up, the Re-analyze
 * button, `--watch` / `factstack watch`), `export` and `quick` — run the same
 * steps in the same order through `analyzeProject`:
 *
 *   git stats → F8 parse cache → host ignore rules + worktree topology →
 *   analyze → close the cache → carry the CVE scan forward → write .facts/
 *
 * They used to be two hand-kept copies (the analyze action and
 * analyzeAndWrite) that differed only in the options below.
 *
 * Git caches (performance#2 / data-model#5): both git miners persist their
 * last result under .facts/ (TOPOLOGY_CACHE_FILE, GIT_STATS_CACHE_FILE),
 * keyed by a fingerprint of the repo's refs. Only the per-edit `--minimal`
 * hook REUSES them while no ref has moved; every other run re-mines and
 * refreshes them, so the hook's copy stays warm.
 *
 * Review baseline (performance#5 / correctness#5): `.facts/baseline/agent.json`
 * — what `review`, MCP `review_change` and `since` compare against — is
 * always the last EXPLICIT `factstack analyze` older than the head.
 * analyzeAndWrite — `ui` start-up, the Re-analyze button, `ui --watch` /
 * `factstack watch` on every save, `export`, `quick` — is a REFRESH:
 *
 *   - the first refresh after an analyze parks that analyze as the baseline
 *     (once — the one multi-MB copy of the streak), then leaves the hold
 *     marker (BASELINE_HOLD_MARK): "agent.json is a refresh, not an analyze";
 *   - later refreshes see the marker and write with `rotateBaseline: false`:
 *     no copy, the baseline stays that analyze;
 *   - the next explicit analyze (or an MCP analyze) sees the marker, parks
 *     nothing and drops it — emit's own rule — so its baseline is the
 *     previous analyze, never the last save.
 *
 * So "previous analysis" never means "one save ago", during a watch session
 * or after it. A refresh that finds a NEWER agent.pack at write time (the
 * per-edit hook finished meanwhile: emit's StaleResaveError) re-analyzes
 * once; it never writes an older analysis over a newer one.
 */
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import kleur from 'kleur';
import { analyze, buildMemory } from '@factstack/core';
import {
  gzippedBytes,
  openExtractionCache,
  StaleResaveError,
  writeArtifacts,
  type SqliteExtractionCache,
} from '@factstack/emit';
import {
  gitGlobalExcludes,
  mineGitStats,
  mineGitTopology,
  nodeFS,
  repoDisplayName,
} from '@factstack/fs-node';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { BASELINE_AGENT_FILE, GIT_STATS_CACHE_FILE, TOPOLOGY_CACHE_FILE } from '@factstack/spec';
import { loadContextStore } from './learnings.js';
import { restoreVulnScan, type RestoreVulnScanResult } from './vulns.js';
import { processIO, type CliIO } from './io.js';

/**
 * F8 — open the content-hash extraction cache for an analyze call site.
 * Best-effort: a sqlite failure (locked db, older Node) must never fail the
 * analyze, so it degrades to a cache-less run (performance#9 — `ui`, watch,
 * `export` and `quick` used to skip the cache entirely).
 */
export function openCacheSafe(root: string): SqliteExtractionCache | undefined {
  try {
    return openExtractionCache(path.join(root, '.facts'));
  } catch {
    return undefined;
  }
}

/** The persisted git-topology cache (`.facts/topology-cache.json`). The
 *  per-edit `--minimal` hook REUSES it while no ref moved (owner decision
 *  2026-09-24); every other run refreshes it so the hook's copy stays warm. */
export function topologyCache(root: string, reuse: boolean): { file: string; reuse: boolean } {
  return { file: path.join(root, '.facts', TOPOLOGY_CACHE_FILE), reuse };
}

/** The persisted `git log` walk behind per-file churn / authors / last-commit
 *  times (`.facts/gitstats-cache.json`). Same rule as topologyCache: the
 *  `--minimal` hook reuses it while no ref moved (the walk was ~425 ms of each
 *  warm hook run); every other run re-mines and refreshes it. The `git status`
 *  pass for uncommitted edits runs either way (fs-node). */
export function gitStatsCache(root: string, reuse: boolean): { file: string; reuse: boolean } {
  return { file: path.join(root, '.facts', GIT_STATS_CACHE_FILE), reuse };
}

/** `.facts/`-relative hold marker beside the review baseline: agent.json is
 *  not an explicit analyze, so a full write must not park it. spec layout.ts
 *  documents it next to BASELINE_AGENT_FILE and emit's full write honours it
 *  (parks nothing, drops the marker); emit does not export the name, so it is
 *  spelled from BASELINE_AGENT_FILE here. */
export const BASELINE_HOLD_MARK = path.posix.join(
  path.posix.dirname(BASELINE_AGENT_FILE),
  'minimal-head',
);

/** Absolute path of BASELINE_HOLD_MARK under `root`. */
export function baselineHoldMark(root: string): string {
  return path.join(root, '.facts', ...BASELINE_HOLD_MARK.split('/'));
}

/** Leave the hold marker after a refresh wrote agent.json. Best-effort, but
 *  never silent: without it the next analyze parks this refresh. */
function holdBaseline(root: string, headAt: string, io: CliIO): void {
  const mark = baselineHoldMark(root);
  try {
    mkdirSync(path.dirname(mark), { recursive: true });
    writeFileSync(
      mark,
      JSON.stringify(
        {
          head: headAt,
          reason:
            'agent.json is a refresh (ui / watch / export / quick), not an explicit analyze: the next analyze keeps the review baseline',
        },
        null,
        2,
      ) + '\n',
    );
  } catch (err) {
    io.stderr.write(
      kleur.yellow('  baseline: ') +
        `could not hold the review baseline (${(err as Error).message}); the next \`analyze\` may compare against this refresh\n`,
    );
  }
}

/** Say — on stderr, never silently — when a prior CVE scan could not be
 *  carried across a re-analyze. */
export function reportVulnCarry(r: RestoreVulnScanResult, io: CliIO = processIO): void {
  if (r.warning) io.stderr.write(kleur.yellow('  vulns: ') + r.warning + '\n');
}

/** emit's reason for writing no F8 `agent.diff.pack` although a previous
 *  pack existed (duplicate primary key, pack schema change, unreadable
 *  previous pack). Informational — the write succeeded — but said, so a
 *  producer bug is not swallowed (data-model#3). */
export function diffSkippedLine(written: { diffSkipped?: string }): string {
  return written.diffSkipped ? kleur.dim(`  no agent.diff.pack: ${written.diffSkipped}`) : '';
}

export function reportDiffSkipped(written: { diffSkipped?: string }, io: CliIO = processIO): void {
  const line = diffSkippedLine(written);
  if (line) io.stderr.write(line + '\n');
}

export interface AnalyzeProjectOptions {
  /** F8 content-hash parse cache (.facts/cache.db). Default on; `false` is
   *  `analyze --no-cache`. Output is byte-identical either way (INV2). */
  cache?: boolean;
  /** The per-edit hook path (`analyze --minimal`): the lean artifact set
   *  (agent.pack + human.json + MEMORY.md), never reads agent session
   *  transcripts, and REUSES the cached git topology while no ref moved. */
  minimal?: boolean;
  /** F2 (beta) symbol-level call/reference graph (`analyze --symbols`). */
  symbols?: boolean;
  /** Transcript reading for the Worktrees tab. Unset falls through to the
   *  FACTSTACK_AGENT_REQUESTS / FACTSTACK_NO_AGENT_REQUESTS env switches;
   *  ignored (always off) with `minimal`. */
  agentRequests?: boolean;
  /** Percent-complete + current file, for the TTY progress bar. */
  onProgress?: (pct: number, file: string) => void;
  /** Add `.facts/` to the project .gitignore. Default true. */
  addGitignoreEntry?: boolean;
  /** Also write `.facts/snapshots/<ISO>.json` for the History tab. */
  writeSnapshot?: boolean;
  /** A refresh (ui / watch / Re-analyze / export / quick — analyzeAndWrite),
   *  not the explicit `analyze` command: parks the last analyze as the review
   *  baseline once, then holds it (see the header). Ignored with `minimal`,
   *  which never touches agent.json or the baseline. Default false. */
  refresh?: boolean;
}

export interface AnalyzeProjectResult {
  agent: AgentArtifact;
  human: HumanArtifact;
  /** What writeArtifacts wrote (paths, bytes, `diffSkipped`). */
  written: Awaited<ReturnType<typeof writeArtifacts>>;
  /** F8 cache hit/miss counts; null when the cache did not run. */
  cacheStats: { hits: number; misses: number } | null;
  /** The host ignore rules (git global excludes + .git/info/exclude) the
   *  walk applied — machine state, so `analyze` reports how many. */
  hostIgnoreRules: string[];
}

/**
 * Analyze `root` and write its `.facts/` artifacts. A failed CVE carry-over
 * is reported on `io.stderr`; a skipped `agent.diff.pack` is returned in
 * `written.diffSkipped` for the caller to print (analyze folds it into its
 * summary, the others use analyzeAndWrite below).
 */
export async function analyzeProject(
  root: string,
  opts: AnalyzeProjectOptions = {},
  io: CliIO = processIO,
): Promise<AnalyzeProjectResult> {
  const minimal = opts.minimal === true;
  const refresh = opts.refresh === true && !minimal;
  for (let attempt = 0; ; attempt++) {
    const { result, cacheStats, hostIgnoreRules } = await analyzeOnce(root, opts, minimal, io);
    /* A refresh that finds the hold marker is a later refresh of a streak:
       the baseline already is the last analyze, so nothing is parked (and
       the multi-MB previous agent.json is not even read). See the header. */
    const held = refresh && existsSync(baselineHoldMark(root));
    let written: AnalyzeProjectResult['written'];
    try {
      /* Default `legacy` so the CLI's own downstream commands (diff,
         scan-vulns, export-skills/diagram, ci-report) — which read
         .facts/agent.json back — keep working. `--minimal` is an explicit
         opt-in to the lean set. The snapshot is the caller's call: an
         explicit writeSnapshot wins over the profile, so `analyze` asks for
         one only when not minimal. */
      written = await writeArtifacts({
        root,
        agent: result.agent,
        human: result.human,
        profile: minimal ? 'minimal' : 'legacy',
        addGitignoreEntry: opts.addGitignoreEntry ?? true,
        ...(opts.writeSnapshot ? { writeSnapshot: true } : {}),
        ...(held ? { rotateBaseline: false } : {}),
        memoryBody: buildMemory(result.agent, result.human, {
          contextStore: loadContextStore(root),
        }),
      });
    } catch (err) {
      /* Only a held refresh skips emit's rotation, and so meets its re-save
         check: agent.pack holds an analysis that finished AFTER this one
         (the per-edit hook landed meanwhile). Re-analyze once so the newest
         state wins; never write the older analysis over it. */
      if (!held || !(err instanceof StaleResaveError)) throw err;
      if (attempt === 0) continue;
      throw new Error(
        `not writing this analysis (${err.resaveAt}): .facts/agent.pack holds a newer one ` +
          `(${err.packAt}), written while it ran — by the per-edit \`analyze --minimal\` hook? ` +
          'Nothing was written; run it again.',
        { cause: err },
      );
    }
    if (refresh && !held) holdBaseline(root, result.agent.generatedAt, io);
    return {
      agent: result.agent,
      human: result.human,
      written,
      cacheStats,
      hostIgnoreRules,
    };
  }
}

/** One analysis of `root` (nothing written yet), with the prior CVE scan
 *  carried onto it. */
async function analyzeOnce(
  root: string,
  opts: AnalyzeProjectOptions,
  minimal: boolean,
  io: CliIO,
): Promise<{
  result: Awaited<ReturnType<typeof analyze>>;
  cacheStats: AnalyzeProjectResult['cacheStats'];
  hostIgnoreRules: string[];
}> {
  /* v0.3.11 — the repository's name, whichever checkout we are in: a linked
     worktree used to be reported (and baked into the demo site) under the
     worktree directory's name. */
  const projectName = repoDisplayName(root);
  /* performance#2: --minimal reuses the last `git log` walk while no ref has
     moved; a full analyze re-mines and refreshes the cache. */
  const gitStats = mineGitStats(root, { cache: gitStatsCache(root, minimal) });

  /* F8 — content-hash extraction cache (default-on). Keyed by content hash,
     so a warm re-analyze re-parses only changed files; the artifact is
     byte-identical to a cache-less run (INV2). Opening it is best-effort:
     a sqlite failure (older Node, locked db) must never fail the analyze. */
  const extractionCache = opts.cache === false ? undefined : openCacheSafe(root);

  /* Rules git applies from outside the tracked tree (global excludes +
     .git/info/exclude). Computed here so the summary can report how many
     were in force: unlike everything else in the artifact, they are
     machine state, and a surprising file count must be explainable. */
  const hostIgnoreRules = gitGlobalExcludes(root);

  let result: Awaited<ReturnType<typeof analyze>>;
  /* F8 — snapshot cache hit/miss for the report, then close the db. `hits` =
     files served from cache.db (unchanged content) without re-parsing;
     `misses` = freshly parsed (new/changed/never-seen). A warm re-analyze of
     an unchanged tree is all hits — the incremental proof. */
  let cacheStats: AnalyzeProjectResult['cacheStats'] = null;
  try {
    result = await analyze(nodeFS(root), {
      root: '.',
      projectName,
      gzip: gzippedBytes,
      gitStats,
      /* v0.3.12 — git's global excludes (core.excludesFile) + .git/info/exclude
         usually hold the per-developer files a repo deliberately does not
         track, e.g. an agent's .claude/settings.local.json. Without them the
         walker would analyze one developer's machine state into a shared
         artifact. They are machine state, so the count is reported by
         `analyze`: two developers can legitimately get different file sets. */
      extraIgnore: hostIgnoreRules,
      /* v0.3.11 — worktree/branch topology. Transcript reading (request
         records) is opt-in. --minimal (the per-edit hook path) never reads
         them. Otherwise pass the option only when a flag was actually given,
         so an unset flag falls through to the FACTSTACK_AGENT_REQUESTS /
         FACTSTACK_NO_AGENT_REQUESTS env switches inside the collector.
         performance#2/#8 (owner decision): --minimal REUSES the persisted
         topology while no ref has moved (0 git spawns vs ~1-2 s per edit);
         a full analyze re-mines and refreshes the cache. */
      git: mineGitTopology(root, {
        ...(minimal
          ? { agentRequests: false }
          : opts.agentRequests !== undefined
            ? { agentRequests: opts.agentRequests }
            : {}),
        cache: topologyCache(root, minimal),
      }),
      symbols: opts.symbols ?? false,
      extractionCache,
      onProgress: opts.onProgress,
    });
  } finally {
    if (extractionCache) {
      cacheStats = { hits: extractionCache.hits, misses: extractionCache.misses };
    }
    extractionCache?.close();
  }
  reportVulnCarry(restoreVulnScan(root, result.agent, result.human), io); // v0.11 carry CVEs + v0.3 re-grade health
  return { result, cacheStats, hostIgnoreRules };
}

/**
 * One full analyze + artifact write for the non-`analyze` call sites (`ui`
 * start-up, Re-analyze and `--watch` refresh, `export`, `quick`):
 * analyzeProject with its defaults as a REFRESH — the review baseline stays
 * the last explicit analyze (see the header) — and the skipped-diff reason
 * printed on stderr.
 */
export async function analyzeAndWrite(
  root: string,
  opts: { writeSnapshot?: boolean } = {},
  io: CliIO = processIO,
): Promise<{ agent: AgentArtifact; human: HumanArtifact }> {
  const { agent, human, written } = await analyzeProject(
    root,
    { refresh: true, ...(opts.writeSnapshot ? { writeSnapshot: true } : {}) },
    io,
  );
  reportDiffSkipped(written, io);
  return { agent, human };
}

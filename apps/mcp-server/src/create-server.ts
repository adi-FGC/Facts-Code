/**
 * FACTS MCP server factory — every resource + tool handler, with no transport
 * and no process-level side effects, so tests drive it in-process over the
 * SDK's in-memory transport. `server.ts` is just the stdio bin around it.
 *
 * Surface (the catalog in @factstack/spec is the source of truth):
 *   Resources: facts://project, facts://graph, facts://routes, facts://risks,
 *              facts://file/{path}, facts://schema/{kind}
 *   Tools:     the 17 in MCP_TOOL_CATALOG.
 *
 * Every local tool and resource works signed out (owner decision 2026-09-24);
 * the optional Google sign-in only powers the Firestore mirror of learnings.
 */

import * as path from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  analyze,
  assembleContext,
  buildChangeVerdict,
  buildContextStore,
  buildMemory,
  computeHealth,
  buildDiagram,
  extractFile,
  lastServedEntities,
  recentSessionEntities,
  sessionActionEvent,
  executeQuery,
  runGraphQuery,
  planFromQuestion,
  formatLearningEvent,
  isExposedSecret,
  parseLearningsJsonl,
  proposalEvent,
  queryLearnings,
  renderVerdictMarkdown,
  selfCalibrateEvent,
  since as buildSinceReport,
  type DiagramView,
  type LearningEvent,
} from '@factstack/core';
import {
  queryGraphToPack,
  listRisksToPack,
  getOutlineToPack,
  getConfigToPack,
  queryLearningsToPack,
  subgraphToPack,
  contextToPack,
  verbResultNodes,
  packSnapshotId,
} from './pack-responses.js';
import {
  StaleResaveError,
  gzippedBytes,
  openExtractionCache,
  packGeneratedAt,
  readStaleMark,
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
import {
  approximateTokens,
  buildOsvQueries,
  carryVulnerabilityScan,
  isGradedVulnerability,
  lockfileCandidates,
  noopCache,
  osvResultsToVulnerabilities,
  parseLockfile,
  queryOsvBatch,
  reconcileVulnerabilities,
  vulnerabilityLabels,
  type OsvQuery,
  type OsvQueryLabels,
  type ParsedLockfile,
} from '@factstack/scanners';
import {
  BASELINE_AGENT_FILE,
  FACTS_MCP_URI_SCHEME,
  McpResourceCatalog,
  MCP_TOOL_CATALOG,
  QueryGraphInputSchema,
  QueryInputSchema,
  CountTokensInputSchema,
  ContextInputSchema,
  GIT_STATS_CACHE_FILE,
  SyncPackInputSchema,
  TOPOLOGY_CACHE_FILE,
  jsonSchemaByKind,
  type AgentArtifact,
  type DependencyManifest,
  type HumanArtifact,
  type ShippedMcpToolName,
} from '@factstack/spec';
import { resolveSyncPack } from './sync-pack.js';
import { MCP_PACKAGE_VERSION } from './about.js';
import { findUp, normalizeRelPath, resolveInRoot } from './paths.js';
import { globArgIssues, queryLearningsArgIssues, sinceArgIssues, type ArgIssue } from './args.js';
import { cloudSession, firestoreSet, loginHint, type CloudSession, type Session } from './auth.js';

export type AnalyzeResult = Awaited<ReturnType<typeof analyze>>;

/** What one analyze run needs from the caller. */
export interface AnalyzeRunOptions {
  /** Build the symbol graph (the CLI's `--symbols`). */
  symbols: boolean;
  /** Reuse the F8 content-hash parse cache for unchanged files. */
  useCache: boolean;
}

/** The optional cloud mirror (Google sign-in → private Firestore subtree). */
export interface CloudSync {
  session(): Promise<CloudSession>;
  set(session: Session, docPath: string, fields: Record<string, unknown>): Promise<boolean>;
}

export interface FactsMcpServerOptions {
  /** Absolute project root. */
  root: string;
  /** Set when no safe root could be resolved: the handshake still succeeds,
   *  but every tool and data resource reports this instead of analyzing (and
   *  nothing is written anywhere). */
  rootError?: string | undefined;
  /** Display name. Default: the repo's name, even from a linked worktree. */
  projectName?: string;
  /** Add `.facts/` to the root .gitignore. Default: only inside a git repo. */
  addGitignoreEntry?: boolean;
  /** Runs the analyzer. Default: `nodeAnalyzer(root, projectName)`. */
  analyzeProject?: (opts: AnalyzeRunOptions) => Promise<AnalyzeResult>;
  /** OSV.dev batch client used by list_vulnerabilities{refresh}. */
  queryOsv?: typeof queryOsvBatch;
  /** Optional cloud mirror. Default: the Google sign-in in ./auth.ts. */
  cloud?: CloudSync;
  /** Status lines (stderr in the bin). */
  log?: (line: string) => void;
}

export interface FactsMcpServer {
  server: Server;
  /** Analyze once if nothing is cached; concurrent callers share one run. */
  ensureAnalyzed(): Promise<void>;
  /** Connect with nothing analyzed — the client's `initialize` is answered at
   *  once — and warm the cache only after its `initialized` (see
   *  BOOT_ANALYZE_DELAY_MS). `warm` settles when that boot analyze ends (or
   *  the session closes first) and never rejects: a failing boot analyze is
   *  logged, and each tool call retries it and reports an isError result. */
  connect(transport: Transport): Promise<{ warm: Promise<void> }>;
}

/**
 * The default analyzer: the same call the CLI's `analyze` makes, including the
 * F8 parse cache (best-effort — a locked or damaged cache.db degrades to one
 * cache-less run instead of failing the analyze) and the symbol graph when asked.
 */
export function nodeAnalyzer(
  root: string,
  projectName: string,
): (opts: AnalyzeRunOptions) => Promise<AnalyzeResult> {
  return async ({ symbols, useCache }) => {
    // Git mining once per run, even when the cache fallback re-runs analyze.
    /* Both git miners mine fresh (a full analyze: no reuse) but refresh their
       .facts/ caches, so the next per-edit `--minimal` hook reuses this run's
       topology and `git log` walk instead of re-mining while no ref has moved
       (performance#2). */
    const base = {
      root: '.',
      projectName,
      gzip: gzippedBytes,
      gitStats: mineGitStats(root, {
        cache: { file: path.join(root, '.facts', GIT_STATS_CACHE_FILE), reuse: false },
      }),
      git: mineGitTopology(root, {
        cache: { file: path.join(root, '.facts', TOPOLOGY_CACHE_FILE), reuse: false },
      }),
      extraIgnore: gitGlobalExcludes(root),
      symbols,
    };
    const run = (extractionCache?: SqliteExtractionCache) =>
      analyze(nodeFS(root), { ...base, ...(extractionCache ? { extractionCache } : {}) });
    let cache: SqliteExtractionCache | undefined;
    if (useCache) {
      try {
        cache = openExtractionCache(path.join(root, '.facts'));
      } catch {
        cache = undefined; // node:sqlite unavailable / locked → analyze cache-less
      }
    }
    if (!cache) return run();
    try {
      return await run(cache);
    } catch {
      return run(); // the cache is an accelerator; never the reason an analyze fails
    } finally {
      try {
        cache.close();
      } catch {
        /* already closed */
      }
    }
  };
}

/** One queued analyze. `explicit`: the analyze tool asked for it — the only
 *  run that writes agent.json over an earlier analysis and so moves the
 *  review baseline. The boot warm-up and a tool's first-use analyze are not
 *  explicit: they hold agent.json like the per-edit --minimal hook does. */
interface AnalyzeRequest {
  symbols?: boolean;
  useCache?: boolean;
  explicit?: boolean;
}

type Cached = {
  agent: AgentArtifact;
  human: HumanArtifact;
  memory: string;
  /** Why the last analyze could not carry the previous CVE scan (in full),
   *  until a fresh scan or a clean carry replaces it. */
  vulnWarning?: string;
};

/** v0.3.11 AI5: version metadata so a connecting agent can version-check the
 *  artifact + the wire formats it'll consume. An agent that doesn't recognize
 *  a layer should fall back to JSON via `format: "json"` on each tool call. */
const VERSION_INFO = {
  facts: '0.1.0',
  schemas: {
    agent: 'agent-v4', // agent.pack wire format (FactsPack standard v0.2: in-band `;` legend + hot hints, sha256 trailer, leading `top` table, unified F namespace, mtime_d, chain header fields). agent.json shape is additive → `facts: '0.1.0'` above is unchanged.
    human: 'human.v1', // human.json
    memory: 'factstack-memory.v1',
    learnings: 'factstack-learnings.v1',
    pack: {
      agent: 'agent-v4',
      risks: 'risks-v1',
      envs: 'envs-v1',
      outline: 'outline-v2',
      learnings: 'learnings-v1',
      queryGraph: 'query-graph-v1',
      subgraph: 'subgraph-v1',
    },
  },
  producer: 'factstack-mcp/0.3.11',
} as const;

const VULN_SCAN_STALE_DAYS = 7;

/** How to rebuild a scan the carry-forward had to drop (in part). */
const RESCAN_HINT =
  'call list_vulnerabilities with refresh:true (or run `factstack scan-vulns`) to rebuild the vulnerability scan';

/** Grace period between the client's `initialized` and the boot analyze. The
 *  default analyzer mines git synchronously (spawnSync, ~1 s on a mid-size
 *  repo), which blocks stdin; waiting lets the listing burst clients send
 *  right after the handshake (tools/list, resources/list, …) be answered
 *  first (MCP-R1). A tool call in the meantime just analyzes on its own. */
const BOOT_ANALYZE_DELAY_MS = 100;

/** Pause before the one re-read of an unparseable prior agent.json. */
const PRIOR_REREAD_MS = 50;

/** Verbs that take one target (`path`); path-between also takes `to`. */
const TARGET_VERBS = new Set([
  'callers',
  'imports',
  'impact',
  'neighbors',
  'references',
  'implementers',
  'path-between',
]);

/** One tool's handler: its call arguments in, the tool result out. */
type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function textResult(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

function jsonResult(payload: unknown): CallToolResult {
  return textResult(JSON.stringify(payload));
}

function errorResult(payload: Record<string, unknown>, pretty = false): CallToolResult {
  return textResult(JSON.stringify({ ok: false, ...payload }, null, pretty ? 2 : undefined), true);
}

function invalidInput(tool: string, issues: ArgIssue[]): CallToolResult {
  return errorResult({ error: `invalid ${tool} input`, issues }, true);
}

function zodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): ArgIssue[] {
  return issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
}

/**
 * v0.3.10 — pull the `format` arg off a tool call. Default `'pack'` for the
 * tools that adopted PACK; anything but `'json'` falls back to `'pack'`
 * silently — the JSON Schema enum on the tool input is the validator.
 */
function pickFormat(args: Record<string, unknown>): 'pack' | 'json' {
  return args.format === 'json' ? 'json' : 'pack';
}

const queryKey = (q: OsvQuery) => `${q.ecosystem}\t${q.name}\t${q.version}`;
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** A full analysis (files + graph), not a stats-only snapshot rollup. */
const isFullAnalysis = (a: Partial<AgentArtifact> | null | undefined): a is AgentArtifact =>
  !!a && Array.isArray(a.files) && !!a.graph && typeof a.generatedAt === 'string';

const olderThan = (a: { generatedAt: string }, b: { generatedAt: string }) =>
  Date.parse(a.generatedAt) < Date.parse(b.generatedAt);

/** emit's refusal to write an analysis under a newer agent.pack. By its
 *  code, so a second copy of the emit module still matches. */
const isStaleResave = (err: unknown): err is StaleResaveError =>
  err instanceof StaleResaveError ||
  (err as { code?: unknown } | null)?.code === 'FACTS_STALE_RESAVE';

export function createFactsMcpServer(opts: FactsMcpServerOptions): FactsMcpServer {
  const { root, rootError } = opts;
  const factsDir = path.join(root, '.facts');
  const projectName = opts.projectName ?? repoDisplayName(root);
  const analyzeProject = opts.analyzeProject ?? nodeAnalyzer(root, projectName);
  const queryOsv = opts.queryOsv ?? queryOsvBatch;
  const cloud: CloudSync = opts.cloud ?? { session: cloudSession, set: firestoreSet };
  const logHook = opts.log ?? (() => undefined);
  /* Status lines are informational: a throwing log hook must never fail the
     write it reports on (leaving disk and `cached` out of step) nor the boot
     warm-up, whose `warm` promise must always settle (mcp-r3-adv-3). */
  const log = (line: string): void => {
    try {
      logHook(line);
    } catch {
      /* the line is dropped; the work it describes already succeeded */
    }
  };
  // Never create a .gitignore outside a git repo (ux#8).
  const addGitignoreEntry = opts.addGitignoreEntry ?? findUp(root, '.git') !== null;

  /**
   * Latest analyzer output. Filled by the background boot analyze and
   * replaced by every `analyze` call. Every handler reads from here — there's
   * no file watch (clients trigger updates explicitly).
   */
  let cached: Cached | null = null;
  /** The in-flight first analyze, shared by every caller that finds no cache
   *  (the boot warm-up included) so they don't queue duplicate runs. */
  let initial: Promise<void> | null = null;

  /* One fence for everything that writes `.facts/` or needs a consistent
     read of it (analyze, the CVE refresh write, sync_pack's pack+diff read),
     so two of them can never interleave. */
  let fence: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const next = fence.then(work);
    fence = next.catch(() => undefined);
    return next;
  }

  function readPriorAgent(): Partial<AgentArtifact> | null {
    return readFactsJson('agent.json');
  }

  /** The previous agent.json, for the CVE carry-forward. Only a MISSING file
   *  means "no prior scan". An unreadable or unparseable one is re-read once
   *  (a writer outside this process may be mid-swap), then the analyze fails
   *  loudly: writing over it would silently drop the last CVE scan
   *  (correctness#15, the same rule as the CLI's restoreVulnScan). */
  async function readPriorAgentForCarry(): Promise<Partial<AgentArtifact> | null> {
    const p = path.join(factsDir, 'agent.json');
    for (let attempt = 0; ; attempt++) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as Partial<AgentArtifact> | null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        if (attempt > 0) {
          throw new Error(
            `.facts/agent.json could not be read (${(err as Error).message}); not overwriting it, ` +
              'so its last vulnerability scan is kept. Fix or delete .facts/agent.json, then analyze again.',
            { cause: err },
          );
        }
        await new Promise((r) => setTimeout(r, PRIOR_REREAD_MS));
      }
    }
  }

  const hasSymbols = (a: Partial<AgentArtifact> | null | undefined) =>
    (a?.graph?.symbolNodes?.length ?? 0) > 0;

  /** The lockfiles covering these manifests — what is INSTALLED — so the CVE
   *  refresh and its carry-forward resolve versions exactly as scan-vulns does
   *  (owner CVE decision, INV7). Local disk only; unreadable → declared ranges. */
  function readLockfiles(manifests: readonly DependencyManifest[]): ParsedLockfile[] {
    const out: ParsedLockfile[] = [];
    for (const rel of lockfileCandidates(manifests.map((m) => m.path))) {
      try {
        const abs = path.join(root, rel);
        if (!existsSync(abs)) continue;
        const lock = parseLockfile(rel, readFileSync(abs, 'utf8'));
        if (lock) out.push(lock);
      } catch {
        /* unreadable lockfile → that manifest scans its declared ranges */
      }
    }
    return out;
  }

  /** Why the write left no agent.diff.pack (sync_pack then serves the full
   *  master). Informational, so a status line only — never stdout, which is
   *  the MCP transport; the write itself succeeded. */
  function logDiffSkipped(reason: string | undefined): void {
    if (reason !== undefined) log(`no agent.diff.pack: ${reason}`); // the CLI's wording
  }

  async function runAnalyze(req: AnalyzeRequest): Promise<{
    stats: AgentArtifact['stats'];
    symbols: boolean;
    vulnWarning: string | undefined;
  }> {
    if (rootError) throw new Error(rootError);
    const startedAt = Date.now();
    const prior = await readPriorAgentForCarry();
    /* Keep the artifact's mode unless asked: a CLI `analyze --symbols` must
       not be downgraded by the next MCP analyze (correctness#13). */
    const symbols = req.symbols ?? (cached ? hasSymbols(cached.agent) : hasSymbols(prior));
    const result = await analyzeProject({ symbols, useCache: req.useCache ?? true });
    // v0.11 — a re-analyze must not wipe the last CVE scan (analyze itself is
    // network-free per INV6 and returns an empty list). Mirrors the CLI.
    const vulnWarning = restoreVulnScanInto(result.agent, prior);
    // Never silent (the CLI's `vulns:` line); a status line, never stdout.
    if (vulnWarning !== undefined) log(`vulns: ${vulnWarning}`);
    // v0.3 — re-grade health after the CVE carry-forward so vulnerabilities land
    // in the score/headline (analyze() grades before the restore). Mirrors the CLI.
    result.human.summary.health = computeHealth(result.agent);
    // F9 — fold the durable context store (decisions / open tasks / questions
    // recorded in learnings.jsonl) into MEMORY.md's "Working context" section.
    const memoryBody = buildMemory(result.agent, result.human, {
      contextStore: buildContextStore(readLearnings()),
    });
    /* Review baseline (correctness#5): the analyze tool's write parks the
       previous agent.json at .facts/baseline/ before replacing it, so the
       baseline is always the last EXPLICIT analysis. The boot warm-up and a
       first-use analyze hold it the way the per-edit --minimal hook does:
       when agent.json already holds a full analysis they write the minimal
       set (agent.pack, human.json, MEMORY.md), leaving agent.json in place
       (marked stale) for the next explicit analyze to park. Replacing it
       without parking lost the last explicit analysis; parking it made "the
       previous analysis" mean "whatever was on disk when this session
       began". With no full analysis on disk there is nothing to hold, and
       they write the full set without parking anything. */
    const explicit = req.explicit === true;
    let written: Awaited<ReturnType<typeof writeArtifacts>> | undefined;
    try {
      written = await writeArtifacts({
        root,
        agent: result.agent,
        human: result.human,
        addGitignoreEntry,
        writeSnapshot: true,
        memoryBody,
        ...(explicit
          ? {}
          : {
              profile: isFullAnalysis(prior) ? ('minimal' as const) : ('legacy' as const),
              /* Parks nothing, and refuses (StaleResaveError) to land under
                 a NEWER agent.pack: a --minimal hook run meanwhile, or a
                 pack stamped ahead of this clock (a skewed WSL/container
                 clock, an NTP step back). */
              rotateBaseline: false,
            }),
      });
    } catch (err) {
      if (explicit || !isStaleResave(err)) throw err;
      /* Nobody asked for this write: never fail every tool over it. Serve
         the analysis from memory and keep the newer one on disk; the
         analyze tool writes over it (a new analysis the caller asked for). */
      log(
        `not writing the warm-up analysis: .facts/agent.pack holds a newer analysis (${err.packAt}); ` +
          'serving this one from memory until the analyze tool runs',
      );
    }
    cached = {
      agent: result.agent,
      human: result.human,
      memory: memoryBody,
      ...(vulnWarning !== undefined ? { vulnWarning } : {}),
    };
    if (written) logDiffSkipped(written.diffSkipped);
    /* v0.3.4 — emit a self-calibrate event so learnings.jsonl begins
       accumulating from day one. */
    try {
      appendLearning(
        selfCalibrateEvent({
          fileCount: result.agent.stats.fileCount,
          totalLoc: result.agent.stats.loc,
          totalTokens: result.agent.stats.totalTokenCost,
          riskCount: result.agent.risks.length,
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch {
      // Non-fatal — never fail an analyze because we couldn't append a row.
    }
    return { stats: result.agent.stats, symbols, vulnWarning };
  }

  function enqueueAnalyze(req: AnalyzeRequest = {}) {
    return exclusive(() => runAnalyze(req));
  }

  function ensureAnalyzed(): Promise<void> {
    if (cached) return Promise.resolve();
    if (!initial) {
      const run = enqueueAnalyze().then(() => undefined);
      initial = run;
      // A failed first analyze must not poison later calls: the next caller retries.
      run.catch(() => {
        if (initial === run) initial = null;
      });
    }
    return initial;
  }

  /** Cached artifacts, analyzing first when there are none. */
  async function current(): Promise<Cached> {
    await ensureAnalyzed();
    return cached!;
  }

  // ── learnings log ──────────────────────────────────────────────────

  function learningsPath(): string {
    return path.join(factsDir, 'learnings.jsonl');
  }

  function appendLearning(event: LearningEvent): void {
    if (!existsSync(factsDir)) mkdirSync(factsDir, { recursive: true });
    appendFileSync(learningsPath(), formatLearningEvent(event), 'utf8');
  }

  function readLearnings(): LearningEvent[] {
    // Best-effort: a missing, locked (Windows EBUSY), or otherwise unreadable
    // learnings log must NOT throw inside a tool handler — return [].
    try {
      const p = learningsPath();
      if (!existsSync(p)) return [];
      return parseLearningsJsonl(readFileSync(p, 'utf8')).events;
    } catch {
      return [];
    }
  }

  /** Mirror one learning to the signed-in user's private Firestore subtree.
   *  Optional and best-effort: never throws, never blocks a local result on
   *  anything but the (timeout-bounded) network calls. */
  async function mirrorLearning(
    event: LearningEvent,
  ): Promise<'synced' | 'off' | 'paused' | 'failed'> {
    try {
      const c = await cloud.session();
      if (c.state === 'signed-out') return 'off';
      if (c.state === 'paused') return 'paused';
      const s = c.session;
      const learnId = String(event.timestamp).replace(/[^0-9A-Za-z_-]/g, '_');
      const a = await cloud.set(s, `users/${s.uid}/learnings/${learnId}`, {
        agent: event.agent,
        action: event.action,
        outcome: event.outcome,
        at: event.timestamp,
      });
      const b = await cloud.set(s, `users/${s.uid}`, {
        email: s.email ?? '',
        uid: s.uid,
        lastSeen: event.timestamp,
      });
      return a && b ? 'synced' : 'failed';
    } catch {
      return 'failed';
    }
  }

  // ── baselines ──────────────────────────────────────────────────────

  /** Load a snapshot entry: a flat `<ts>.json` file OR a legacy
   *  `<ts>/agent.json` directory. Null on anything unreadable. */
  function loadSnapshotEntry(snapDir: string, entry: string): AgentArtifact | null {
    const candidate = entry.endsWith('.json')
      ? path.join(snapDir, entry)
      : path.join(snapDir, entry, 'agent.json');
    if (!existsSync(candidate)) return null;
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as AgentArtifact;
    } catch {
      return null;
    }
  }

  /** A full analysis that can serve as the "before" of `head`: strictly
   *  OLDER than it (so a verdict can't come out inverted) and, when
   *  `notAfter` is given, no newer than that moment. */
  const baselineFor =
    (head: AgentArtifact, notAfter: string | undefined) =>
    (a: Partial<AgentArtifact> | null): a is AgentArtifact =>
      isFullAnalysis(a) &&
      olderThan(a, head) &&
      (notAfter === undefined || Date.parse(a.generatedAt) <= Date.parse(notAfter));

  /** Newest FULL snapshot artifact (files[] + graph) that fits `head` (see
   *  baselineFor). The stats-only rollups analyze writes are skipped. */
  function readLatestFullSnapshot(head: AgentArtifact, notAfter?: string): AgentArtifact | null {
    const fits = baselineFor(head, notAfter);
    try {
      const snapDir = path.join(factsDir, 'snapshots');
      if (!existsSync(snapDir)) return null;
      const entries = readdirSync(snapDir).sort();
      for (let i = entries.length - 1; i >= 0; i--) {
        const art = loadSnapshotEntry(snapDir, entries[i]!);
        if (fits(art)) return art;
      }
    } catch {
      /* unreadable snapshot dir → no baseline */
    }
    return null;
  }

  /** The analysis to review: ours, or `.facts/agent.json` when an external
   *  analyze (the CLI, the per-edit hook, another client) wrote a newer one —
   *  the baseline it rotated is then newer than our in-memory head, and
   *  comparing the two reported added files as removed (MCP-R2). */
  function newestHead(ours: AgentArtifact): AgentArtifact {
    const disk = readPriorAgent();
    return isFullAnalysis(disk) && olderThan(ours, disk) ? disk : ours;
  }

  function readDiskHuman(): Partial<HumanArtifact> | null {
    try {
      return JSON.parse(
        readFileSync(path.join(factsDir, 'human.json'), 'utf8'),
      ) as Partial<HumanArtifact> | null;
    } catch {
      return null;
    }
  }

  /** What a CVE refresh re-saves: our head, or the newer full analysis an
   *  external analyze wrote, paired with the human.json of the same run.
   *  Re-saving our older head reverted that analysis on disk, and
   *  review_change then found no baseline older than the head (mcp-r3-adv-1).
   *  writeArtifacts lands agent.json before human.json, so a mismatch is a
   *  writer mid-run: re-read once, then refuse rather than write either one. */
  async function newestArtifacts(): Promise<Pick<Cached, 'agent' | 'human'>> {
    const ours = cached!;
    for (let attempt = 0; ; attempt++) {
      const disk = readPriorAgent();
      if (!isFullAnalysis(disk) || !olderThan(ours.agent, disk)) return ours;
      const human = readDiskHuman();
      if (human?.generatedAt === disk.generatedAt) {
        return { agent: disk, human: human as HumanArtifact };
      }
      if (attempt > 0) {
        throw new Error(
          `.facts/agent.json holds a newer analysis (${disk.generatedAt}) whose human.json is missing or from another run; ` +
            'not writing the older analysis over it. Call analyze, then refresh again.',
        );
      }
      await new Promise((r) => setTimeout(r, PRIOR_REREAD_MS));
    }
  }

  /** Is agent.json held (correctness#5)? A full analysis older than `head`
   *  that carries a stale mark: a warm-up analyze or the --minimal hook left
   *  it in place as the last explicit analysis. A stale writer's older
   *  agent.json has no mark (a full write clears it), and is no hold. */
  function holdsEarlierAnalysis(head: AgentArtifact): boolean {
    const disk = readPriorAgent();
    return isFullAnalysis(disk) && olderThan(disk, head) && readStaleMark(factsDir) !== null;
  }

  /** emit's stale-resave guard, for a write that must rotate: refuse (and
   *  write nothing) when agent.pack already holds a newer analysis than
   *  `head` — a --minimal hook run landed since `head` was analyzed. */
  function refuseUnderNewerPack(head: AgentArtifact): void {
    let body: string;
    try {
      body = readFileSync(path.join(factsDir, 'agent.pack'), 'utf8');
    } catch {
      return; // no pack on disk → nothing newer to protect
    }
    const packAt = packGeneratedAt(body);
    if (packAt !== null && Date.parse(packAt) > Date.parse(head.generatedAt)) {
      throw new StaleResaveError(head.generatedAt, packAt);
    }
  }

  /** `.facts/<rel>` parsed; null when missing or unreadable. */
  function readFactsJson(rel: string): Partial<AgentArtifact> | null {
    try {
      const p = path.join(factsDir, rel);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf8')) as Partial<AgentArtifact> | null;
    } catch {
      return null;
    }
  }

  /** The review baseline: the newest full analysis that fits `head` (see
   *  baselineFor) among
   *   - `.facts/agent.json` when it is older than the head: the last explicit
   *     analysis a warm-up analyze or the --minimal hook held in place, which
   *     the next explicit analyze parks (correctness#5);
   *   - `.facts/baseline/agent.json`, the previous analysis analyze parked
   *     (owner decision: keep one);
   *  else the newest full snapshot. `since` passes `notAfter` so a baseline
   *  newer than its timestamp never hides an older one that fits. */
  function readBaseline(head: AgentArtifact, notAfter?: string): AgentArtifact | null {
    const fits = baselineFor(head, notAfter);
    let best: AgentArtifact | null = null;
    for (const art of [readFactsJson('agent.json'), readFactsJson(BASELINE_AGENT_FILE)]) {
      if (fits(art) && (best === null || olderThan(best, art))) best = art;
    }
    return best ?? readLatestFullSnapshot(head, notAfter);
  }

  /* v0.11 — carry the last vulnerability scan across re-analyzes, reconciled
   * against the FRESH manifests (and lockfiles) so removed/upgraded deps drop
   * their stale findings. The rule is @factstack/scanners'
   * carryVulnerabilityScan, the one the CLI's carryForward calls too, so the
   * two cannot drift (pre-merge audit correctness#13): a scan without a rows
   * array is dropped (never "scanned and clean"), a malformed row costs only
   * itself, a findings/rows mismatch is reported. Returns the warning to
   * surface when anything was dropped or does not add up. */
  function restoreVulnScanInto(
    agent: AgentArtifact,
    prev: Partial<AgentArtifact> | null,
  ): string | undefined {
    const carried = carryVulnerabilityScan(
      prev,
      agent.dependencyManifests,
      () => readLockfiles(agent.dependencyManifests),
      RESCAN_HINT,
    );
    if (carried.carried) {
      agent.vulnerabilities = carried.vulnerabilities;
      agent.vulnerabilityScan = carried.scan;
    }
    return carried.warning;
  }

  // ── graph target checks ────────────────────────────────────────────

  /** Would the verb engine resolve `target`? callers/imports need the exact
   *  file path; the rest resolve forgivingly (id, name, or path suffix). */
  function targetInGraph(agent: AgentArtifact, verb: string, target: string): boolean {
    const files = agent.graph.nodes;
    if (verb === 'callers' || verb === 'imports') return files.some((n) => n.path === target);
    const lower = target.toLowerCase();
    const pathHit = (p: string) => p === target || p.endsWith('/' + target);
    return (
      files.some((n) => pathHit(n.path) || baseName(n.path).toLowerCase() === lower) ||
      (agent.graph.symbolNodes ?? []).some(
        (s) => s.id === target || s.name.toLowerCase() === lower || pathHit(s.path),
      )
    );
  }

  function didYouMean(agent: AgentArtifact, target: string): string[] {
    const want = baseName(target).toLowerCase();
    return agent.graph.nodes
      .map((n) => n.path)
      .filter((p) => baseName(p).toLowerCase() === want || p.endsWith('/' + target))
      .slice(0, 5);
  }

  /** A path-taking tool's miss (neither analyzed nor on disk): the same
   *  `didYouMean` query_graph gives for an unknown target. */
  function fileNotFound(agent: AgentArtifact, relPath: string): CallToolResult {
    return errorResult({
      error: `File not found: ${relPath}`,
      didYouMean: didYouMean(agent, relPath),
    });
  }

  // ── MCP wiring ─────────────────────────────────────────────────────

  const server = new Server(
    // The package version (--version, npm): one number for the owner to bump.
    { name: 'factstack', version: MCP_PACKAGE_VERSION },
    { capabilities: { resources: {}, tools: {} } },
  );

  // List resources (flat catalog from @factstack/spec).
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: McpResourceCatalog.map((r) => ({ ...r })),
  }));

  // Read a resource by URI. No sign-in: `.facts/` is readable on disk anyway.
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    /* v0.3.10 — schema introspection: the JSON Schema for an artifact kind, so
       agents learn the shape without reading megabytes of agent.json. Static,
       so it needs no analysis. */
    const schemaPrefix = `${FACTS_MCP_URI_SCHEME}://schema/`;
    if (uri.startsWith(schemaPrefix)) {
      const kind = uri.slice(schemaPrefix.length);
      const schema = jsonSchemaByKind(kind);
      if (schema === null) {
        throw new Error(`Unknown schema kind: ${kind} (try 'agent' or 'human')`);
      }
      return jsonResource(uri, schema);
    }

    const { agent, human } = await current();
    if (uri === `${FACTS_MCP_URI_SCHEME}://project`) {
      return jsonResource(uri, {
        ...agent.project,
        generatedAt: agent.generatedAt,
        stats: agent.stats,
        health: human.summary.health,
      });
    }
    if (uri === `${FACTS_MCP_URI_SCHEME}://graph`) return jsonResource(uri, agent.graph);
    if (uri === `${FACTS_MCP_URI_SCHEME}://routes`) return jsonResource(uri, agent.routes);
    if (uri === `${FACTS_MCP_URI_SCHEME}://risks`) return jsonResource(uri, agent.risks);
    // Parametric file resource, with the same path normalization as the tools.
    const filePrefix = `${FACTS_MCP_URI_SCHEME}://file/`;
    if (uri.startsWith(filePrefix)) {
      const relPath = normalizeRelPath(root, decodeURIComponent(uri.slice(filePrefix.length)));
      const outline = agent.files.find((f) => f.path === relPath);
      if (!outline) {
        const matches = agent.files
          .filter((f) => f.path.endsWith('/' + baseName(relPath)))
          .slice(0, 5)
          .map((f) => f.path);
        throw new Error(
          `Unknown file: ${relPath}` +
            (matches.length ? ` (did you mean: ${matches.join(', ')})` : ''),
        );
      }
      return jsonResource(uri, outline);
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  // Resource templates — advertise the parametric resources so clients can
  // discover them via resources/templates/list.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${FACTS_MCP_URI_SCHEME}://file/{path}`,
        name: 'File outline',
        description:
          'Per-file FileOutline (declarations, imports, status, LOC, tokens). Substitute {path} with a project-relative path.',
        mimeType: 'application/json',
      },
      {
        uriTemplate: `${FACTS_MCP_URI_SCHEME}://schema/{kind}`,
        name: 'JSON Schema for FACTS artifacts',
        description:
          'JSON Schema (draft-07) for the named FACTS artifact. {kind} is "agent" or "human". Use this to validate decoded responses or to generate types in any language without reading the full artifact.',
        mimeType: 'application/json',
      },
    ],
  }));

  // List tools — the catalog's three wire fields (name / description / inputSchema).
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOL_CATALOG.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  // Handle tool calls. A tool failure is a RESULT (isError) the model can
  // read and react to, never a JSON-RPC error some clients drop (MCP-14);
  // only an unknown tool name stays a protocol error.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      return await callTool(name, args);
    } catch (err) {
      if (err instanceof McpError) throw err;
      return errorResult({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── tool handlers: one per shipped tool, dispatched by callTool ──────

  async function handleAnalyze(args: Record<string, unknown>): Promise<CallToolResult> {
    const out = await enqueueAnalyze({
      ...(typeof args.symbols === 'boolean' ? { symbols: args.symbols } : {}),
      // useCache:false forces a full re-parse (skips the F8 parse cache).
      ...(args.useCache === false ? { useCache: false } : {}),
      explicit: true, // the one caller that moves the review baseline
    });
    return jsonResult({
      ok: true,
      stats: out.stats,
      symbols: out.symbols,
      version: VERSION_INFO,
      // The write succeeded; this is what it could not carry (correctness#13).
      ...(out.vulnWarning !== undefined ? { warnings: [out.vulnWarning] } : {}),
    });
  }

  async function handleQueryGraph(args: Record<string, unknown>): Promise<CallToolResult> {
    const globIssues = globArgIssues(args);
    if (globIssues.length) return invalidInput('query_graph', globIssues);
    const { agent } = await current();
    // Zod refine catches the missing-path-for-callers/imports case. Return a
    // structured error so callers see "missing required argument".
    const parseResult = QueryGraphInputSchema.safeParse(args);
    if (!parseResult.success) {
      return invalidInput('query_graph', zodIssues(parseResult.error.issues));
    }
    const parsed = parseResult.data;
    const target = parsed.path !== undefined ? normalizeRelPath(root, parsed.path) : undefined;
    const to = parsed.to !== undefined ? normalizeRelPath(root, parsed.to) : undefined;
    const result = executeQuery(agent, {
      verb: parsed.verb,
      ...(target !== undefined ? { path: target } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(parsed.direction !== undefined ? { direction: parsed.direction } : {}),
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.minConfidence !== undefined ? { minConfidence: parsed.minConfidence } : {}),
      limit: parsed.limit,
      // `depth` is intentionally undefined-when-omitted so executeQuery
      // applies the per-verb default — notably 3 for `impact`.
      ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
    });
    /* An empty answer for a target that isn't in the graph is a caller
       error, not "no callers" (MCP-12). */
    if (result.count === 0 && TARGET_VERBS.has(parsed.verb)) {
      for (const t of [target, parsed.verb === 'path-between' ? to : undefined]) {
        if (t && !targetInGraph(agent, parsed.verb, t)) {
          return errorResult({
            error: 'not in graph',
            target: t,
            didYouMean: didYouMean(agent, t),
          });
        }
      }
    }
    if (pickFormat(args) === 'pack') {
      return textResult(queryGraphToPack(result, packSnapshotId(agent)));
    }
    return jsonResult(result);
  }

  async function handleQuery(args: Record<string, unknown>): Promise<CallToolResult> {
    const globIssues = globArgIssues(args);
    if (globIssues.length) return invalidInput('query', globIssues);
    const { agent } = await current();
    const parseResult = QueryInputSchema.safeParse(args);
    if (!parseResult.success) return invalidInput('query', zodIssues(parseResult.error.issues));
    const snapshotId = packSnapshotId(agent);
    const wantPack = pickFormat(args) === 'pack';

    // Structured GraphQuery → run directly.
    const gq = parseResult.data.query;
    if (gq) {
      const q = gq.start.id
        ? { ...gq, start: { ...gq.start, id: normalizeRelPath(root, gq.start.id) } }
        : gq;
      const sub = runGraphQuery(agent, q);
      return wantPack ? textResult(subgraphToPack(agent, sub, snapshotId)) : jsonResult(sub);
    }

    // Free-text → deterministic plan (INV3). No confident match → did-you-mean.
    const plan = planFromQuestion(agent, parseResult.data.q!);
    if (!plan.ok) {
      return textResult(
        JSON.stringify({ ok: false, reason: plan.reason, candidates: plan.candidates }, null, 2),
      );
    }
    // GraphQuery plans run on the engine; verb plans (orphans/cycles/
    // path-between) run on the verb engine, lifted into a node-list subgraph.
    let sub: {
      nodes: string[];
      edges: Array<{ from: string; to: string; kind: string; confidence?: string }>;
      truncated: boolean;
    };
    if (plan.plan.graphQuery) {
      sub = runGraphQuery(agent, plan.plan.graphQuery);
    } else {
      const r = executeQuery(agent, {
        verb: plan.plan.verb!,
        ...(plan.plan.path !== undefined ? { path: plan.plan.path } : {}),
        ...(plan.plan.to !== undefined ? { to: plan.plan.to } : {}),
      });
      // `cycles` (string[][]) is flattened by verbResultNodes.
      sub = { nodes: verbResultNodes(r), edges: [], truncated: false };
    }
    if (wantPack) return textResult(subgraphToPack(agent, sub, snapshotId));
    return jsonResult({
      interpretation: plan.plan.interpretation,
      entities: plan.plan.entities,
      ...sub,
    });
  }

  async function handleGetDiagram(args: Record<string, unknown>): Promise<CallToolResult> {
    const { agent } = await current();
    /* Validate view against the union; default to package. Focal needs a
       focus path — a structured error rather than a buildDiagram throw. */
    const view = ['package', 'hub', 'focal'].includes(String(args.view))
      ? (args.view as DiagramView)
      : 'package';
    const focus =
      typeof args.focus === 'string' && args.focus.length > 0
        ? normalizeRelPath(root, args.focus)
        : undefined;
    if (view === 'focal' && !focus) {
      return errorResult({ error: 'view=focal requires a "focus" file path' }, true);
    }
    const depthRaw = typeof args.depth === 'number' ? args.depth : 2;
    const depth = Math.max(1, Math.min(5, Math.trunc(depthRaw)));
    return textResult(buildDiagram(agent, { view, ...(focus ? { focus } : {}), depth }));
  }

  async function handleGetOutline(args: Record<string, unknown>): Promise<CallToolResult> {
    const { agent } = await current();
    const relPath = normalizeRelPath(root, String(args.path ?? ''));
    if (!relPath) return errorResult({ error: "get_outline: 'path' is required" });
    const fmt = pickFormat(args);
    const snapshotId = packSnapshotId(agent);
    /* F2: outgoing symbol-graph edges whose `from` declaration lives in this
       file, mapped via the symbol NODES (whose `path` is authoritative) so a
       path containing `#` can't break the match. Empty without `--symbols`. */
    const fileSymbolIds = new Set(
      (agent.graph.symbolNodes ?? []).filter((n) => n.path === relPath).map((n) => n.id),
    );
    const refs = (agent.graph.symbolEdges ?? []).filter((e) => fileSymbolIds.has(e.from));
    // An analyzed file answers from the artifact — even with zero
    // declarations (a barrel is an empty outline, not a re-parse).
    const outline = agent.files.find((f) => f.path === relPath);
    if (outline) {
      if (fmt === 'pack') {
        return textResult(getOutlineToPack(relPath, outline.declarations, snapshotId, refs));
      }
      return jsonResult({
        path: relPath,
        outline: outline.declarations,
        refs,
        source: 'artifact',
      });
    }
    /* Not in the artifact (new since the last analyze, or ignored): extract
       live with the SAME producer analyze uses, so both branches return one
       shape — {name, kind, startLine, endLine, exported} (MCP-10). */
    const abs = resolveInRoot(root, relPath); // SEC: rejects paths escaping the root
    if (!existsSync(abs)) return fileNotFound(agent, relPath);
    if (!statSync(abs).isFile()) return errorResult({ error: `Not a file: ${relPath}` });
    const live = extractFile(
      readFileSync(abs, 'utf8'),
      path.extname(relPath).toLowerCase(),
      false,
    ).symbols;
    if (fmt === 'pack') return textResult(getOutlineToPack(relPath, live, snapshotId, refs));
    return jsonResult({ path: relPath, outline: live, refs, source: 'live' });
  }

  async function handleListRisks(args: Record<string, unknown>): Promise<CallToolResult> {
    const { agent } = await current();
    const sev = args.severity as string | undefined;
    const cat = args.category as string | undefined;
    let risks = agent.risks;
    if (sev) risks = risks.filter((r) => r.severity === sev);
    if (cat) risks = risks.filter((r) => r.category === cat);
    if (pickFormat(args) === 'pack')
      return textResult(listRisksToPack(risks, packSnapshotId(agent)));
    return jsonResult({ count: risks.length, risks });
  }

  /* v0.6 — credentials = filtered risks. Its own tool so agents asking "any
     leaked secrets?" don't have to know the category-filter trick. */
  async function handleListCredentials(args: Record<string, unknown>): Promise<CallToolResult> {
    const { agent } = await current();
    const sev = args.severity as string | undefined;
    let creds = agent.risks.filter((r) => r.category === 'secret');
    if (sev) creds = creds.filter((r) => r.severity === sev);
    /* Owner decision 2026-09-24: a generic match (a secret-named field, a
       password in a connection URL) is an UNGRADED possible secret, stored
       at severity 'info'; a test/fixture hit is 'low'. Neither counts in
       the health grade, and an agent must not treat either as an exposed
       key — so each row says so instead of leaving it to the severity.
       `graded` is core's isExposedSecret, the same rule health.secrets and
       the review verdict count by, so the three cannot drift apart. */
    const credentials = creds.map((r) =>
      r.severity === 'info'
        ? { ...r, possible: true, graded: isExposedSecret(r) }
        : { ...r, graded: isExposedSecret(r) },
    );
    const possible = credentials.filter((c) => 'possible' in c).length;
    return jsonResult({
      count: credentials.length,
      graded: credentials.filter((c) => c.graded).length,
      possible,
      ...(possible > 0
        ? {
            note: `${possible} possible secret(s) (possible:true) come from generic patterns, not a provider key format: not graded and not confirmed. Check each value before treating it as exposed.`,
          }
        : {}),
      credentials,
    });
  }

  async function handleListVulnerabilities(args: Record<string, unknown>): Promise<CallToolResult> {
    await ensureAnalyzed();
    let note: string | undefined;
    let queried: OsvQueryLabels | undefined;
    /* v0.11 — refresh: re-query OSV.dev live and PERSIST. Opt-in network
       (analyze itself stays network-free, INV6). */
    if (args.refresh === true) {
      /* The shared, lockfile-aware builder scan-vulns uses: installed
         versions, `declared-range` labels, dev/transitive scopes (INV7). */
      // The newest head's deps: an external analyze may have changed them.
      const manifests = newestHead(cached!.agent).dependencyManifests;
      const lockfiles = readLockfiles(manifests);
      const { queries, skipped, labels } = buildOsvQueries(manifests, lockfiles);
      queried = labels;
      let scanned: ReturnType<typeof osvResultsToVulnerabilities>;
      let detailsFailed = 0;
      try {
        const results = await queryOsv(queries, { cache: noopCache });
        scanned = osvResultsToVulnerabilities(results);
        // EH-3: surface advisories that degraded to id-only (detail fetch failed).
        detailsFailed = results.reduce((n, r) => n + (r.detailsFailed ?? 0), 0);
      } catch (err) {
        /* A failed refresh must NEVER look like a successful empty scan. */
        return errorResult({
          error: `OSV refresh failed: ${(err as Error).message}`,
          hint: 'Network/OSV.dev issue — the previously scanned data is unchanged. Retry later or run `factstack scan-vulns`.',
        });
      }
      const scannedAt = new Date().toISOString();
      try {
        /* MCP-01: apply the scan INSIDE the fence, to whatever analysis is
           current THEN. Building the next artifact before queueing (as this
           used to) let an analyze that finished while OSV answered be
           overwritten by the pre-analyze artifact, on disk and in memory.
           "Current" includes a newer external analyze on disk (the CLI, the
           per-edit hook): the scan lands on it, and the cache adopts it. */
        await exclusive(async () => {
          const cur = await newestArtifacts();
          const locks = readLockfiles(cur.agent.dependencyManifests);
          const now = buildOsvQueries(cur.agent.dependencyManifests, locks).queries;
          const asked = new Set(queries.map(queryKey));
          const unscanned = now.filter((q) => !asked.has(queryKey(q))).length;
          // Findings for deps removed/upgraded meanwhile drop out.
          const vulnerabilities = reconcileVulnerabilities(
            scanned,
            cur.agent.dependencyManifests,
            locks,
          );
          const nextAgent: AgentArtifact = {
            ...cur.agent,
            vulnerabilities,
            vulnerabilityScan: {
              scannedAt,
              source: 'osv.dev',
              packagesQueried: queries.length,
              packagesSkipped: skipped,
              findings: vulnerabilities.length,
              ...(detailsFailed > 0 ? { detailsFailed } : {}),
              /* Where the queried versions came from, exactly as scan-vulns
                 records it (data-model#23, INV7): absent means every version
                 was a declared range. */
              ...(lockfiles.length > 0 ? { lockfiles: lockfiles.map((l) => l.path) } : {}),
              /* Persisted (as scan-vulns does), not only this call's
                 note — a later read must not take the scan for verified clean
                 about deps it never queried. */
              ...(unscanned > 0 ? { unscanned } : {}),
            },
          };
          // v0.3 — re-grade health so the fresh CVEs land in the score. Swap
          // `cached` only AFTER the write succeeds.
          const updatedHuman: HumanArtifact = {
            ...cur.human,
            summary: { ...cur.human.summary, health: computeHealth(nextAgent) },
          };
          const memoryBody = buildMemory(nextAgent, updatedHuman, {
            contextStore: buildContextStore(readLearnings()),
          });
          /* Normally a re-save of an existing analysis, no new one:
             rotateBaseline:false, so whatever agent.json is on disk now (an
             older one from a stale writer) is not parked over the real
             previous analysis in .facts/baseline/ (as scan-vulns). But
             during a hold (correctness#5) agent.json is the last explicit
             analysis a warm-up or the --minimal hook kept in place, and
             this write replaces it with the head just scanned: park it
             first, as the next analyze would have, instead of losing it.
             emit parks only on a rotating write, which skips its
             stale-resave guard, so that guard runs here. */
          const hold = holdsEarlierAnalysis(cur.agent);
          if (hold) refuseUnderNewerPack(cur.agent);
          const written = await writeArtifacts({
            root,
            agent: nextAgent,
            human: updatedHuman,
            addGitignoreEntry: false,
            memoryBody,
            rotateBaseline: hold,
          });
          cached = { agent: nextAgent, human: updatedHuman, memory: memoryBody };
          logDiffSkipped(written.diffSkipped);
          if (unscanned > 0) {
            note = `${unscanned} dependencies changed while OSV was answering and are not in this scan — call refresh again.`;
          }
        });
      } catch (err) {
        return errorResult({
          error: `Writing the refreshed scan failed: ${(err as Error).message}`,
          hint: 'The previously scanned data is unchanged on disk.',
        });
      }
    }

    const { agent, vulnWarning } = cached!;
    const sev = args.severity as string | undefined;
    const eco = args.ecosystem as string | undefined;
    const pkg = args.package as string | undefined;
    let findings = agent.vulnerabilities;
    if (sev) findings = findings.filter((v) => v.severity === sev);
    if (eco) findings = findings.filter((v) => v.ecosystem === eco);
    if (pkg) findings = findings.filter((v) => v.package === pkg);
    /* Most-recent lastChecked across all findings — null when empty. Kept for
       backward compat; `scan` (v0.11) also marks a scanned-and-CLEAN artifact. */
    const lastChecked =
      agent.vulnerabilities.reduce((m, v) => Math.max(m, v.lastChecked), 0) || null;
    const scan = agent.vulnerabilityScan ?? null;
    const scanAgeDays = scan
      ? Math.max(0, Math.floor((Date.now() - Date.parse(scan.scannedAt)) / 86_400_000))
      : null;
    const stale = scanAgeDays !== null && scanAgeDays >= VULN_SCAN_STALE_DAYS;
    /* Deps the last scan never queried — it is not a verified-clean
       answer for them, whatever `findings` says. */
    const unscanned = scan?.unscanned ?? 0;
    /* Owner CVE decision: say how each version was found and whether the
       finding counts — the declared-range caveat and `<scope>: shown, not
       graded` for dev/transitive, in the scanners' shared VULN_LABEL_TEXT
       wording, so the CLI and dashboard read the same (INV7). */
    const labelled = findings.map((v) => {
      const labels = vulnerabilityLabels(v);
      return { ...v, graded: isGradedVulnerability(v), ...(labels.length ? { labels } : {}) };
    });
    return jsonResult({
      count: findings.length,
      graded: labelled.filter((v) => v.graded).length,
      lastChecked,
      scan,
      scanAgeDays,
      stale,
      ...(unscanned > 0 ? { partial: true } : {}),
      manifestCount: agent.dependencyManifests.length,
      // What this refresh queried, per scope and version source.
      ...(queried ? { queried } : {}),
      /* Why the last analyze dropped (part of) the previous scan — the boot
         warm-up's only other outlet is stderr, which an agent never reads. */
      ...(vulnWarning !== undefined ? { warning: vulnWarning } : {}),
      hint:
        note ??
        (scan === null
          ? 'No vulnerability scan recorded for this artifact. Pass refresh:true (queries OSV.dev live) or run `factstack scan-vulns .`.'
          : unscanned > 0
            ? `Partial scan — ${unscanned} ${unscanned === 1 ? 'dependency was' : 'dependencies were'} not queried (changed while OSV.dev was answering), so it is not a verified-clean answer for ${unscanned === 1 ? 'it' : 'them'}. Pass refresh:true to rescan.`
            : stale
              ? `Scan is ${scanAgeDays}d old — new CVEs are published daily. Pass refresh:true to update.`
              : undefined),
      findings: labelled,
    });
  }

  async function handleReadMemory(): Promise<CallToolResult> {
    // Plain text so agents render it as markdown directly.
    return textResult((await current()).memory);
  }

  // v0.3.2 — what changed since X?
  async function handleSince(args: Record<string, unknown>): Promise<CallToolResult> {
    const issues = sinceArgIssues(args);
    if (issues.length) return invalidInput('since', issues);
    const ts = args.timestamp as string;
    const agent = newestHead((await current()).agent);
    /* A full analysis is a faithful "before" only if it predates the
       asked-about moment; a newer one would hide changes made between `ts`
       and it. So take the newest that does, else mtime-only mode. */
    const usable = readBaseline(agent, ts) ?? undefined;
    const report = buildSinceReport(agent, ts, usable);
    return jsonResult({ ...report, baselineAt: usable?.generatedAt ?? null });
  }

  // v0.3.4 — append a learning event to .facts/learnings.jsonl.
  async function handleLogLearning(args: Record<string, unknown>): Promise<CallToolResult> {
    /* Validate via the schema BEFORE we write — every JSONL line must be valid. */
    let event: LearningEvent;
    try {
      event = proposalEvent({
        agent: String(args.agent ?? ''),
        action: String(args.action ?? ''),
        outcome: args.outcome as Parameters<typeof proposalEvent>[0]['outcome'],
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.ticketId === 'string' ? { ticketId: args.ticketId } : {}),
        ...(typeof args.reasoning === 'string' ? { reasoning: args.reasoning } : {}),
        ...(Array.isArray(args.filesAffected)
          ? { filesAffected: args.filesAffected as string[] }
          : {}),
        ...(typeof args.confidence === 'number' ? { confidence: args.confidence } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
      });
    } catch (err) {
      // EH-1: a validation failure is a caller error — isError + Zod issues.
      const issues =
        err && typeof err === 'object' && Array.isArray((err as { issues?: unknown }).issues)
          ? (err as { issues: Array<{ path?: unknown[]; message?: unknown }> }).issues.map((i) => ({
              field: Array.isArray(i.path) ? i.path.join('.') : '',
              message: String(i.message ?? ''),
            }))
          : undefined;
      return errorResult({ error: (err as Error).message, ...(issues ? { issues } : {}) });
    }
    try {
      appendLearning(event);
    } catch (appendErr) {
      // ENOSPC / EACCES / EROFS / Windows EBUSY: a structured failure, not a throw.
      return errorResult({
        error: `event validated but write failed: ${appendErr instanceof Error ? appendErr.message : String(appendErr)}`,
      });
    }
    // Optional cloud mirror (signed in only); the local write above is the record.
    const cloudSync = await mirrorLearning(event);
    return jsonResult({
      ok: true,
      timestamp: event.timestamp,
      cloudSync,
      /* The caveated hint, never a bare `npx -y` of an unpublished name an
         agent might run on its own (MCP-R4, security#5). */
      ...(cloudSync === 'off' ? { signIn: loginHint() } : {}),
    });
  }

  // v0.3.4 — read + filter learnings.jsonl.
  async function handleQueryLearnings(args: Record<string, unknown>): Promise<CallToolResult> {
    const issues = queryLearningsArgIssues(args);
    if (issues.length) return invalidInput('query_learnings', issues);
    const result = queryLearnings(readLearnings(), {
      ...(typeof args.since === 'string' ? { since: args.since } : {}),
      ...(typeof args.until === 'string' ? { until: args.until } : {}),
      ...(typeof args.agent === 'string' ? { agent: args.agent } : {}),
      ...(typeof args.outcome === 'string'
        ? {
            outcome: args.outcome as Parameters<typeof queryLearnings>[1] extends infer Q
              ? Q extends { outcome?: infer O }
                ? O
                : never
              : never,
          }
        : {}),
      ...(typeof args.action === 'string' ? { action: args.action } : {}),
      ...(typeof args.tag === 'string' ? { tag: args.tag } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    });
    if (pickFormat(args) === 'pack') {
      const sid = cached ? packSnapshotId(cached.agent) : new Date().toISOString();
      return textResult(queryLearningsToPack(result, sid));
    }
    return jsonResult({ count: result.length, events: result });
  }

  // v0.3.6 — env-var inventory.
  async function handleGetConfig(args: Record<string, unknown>): Promise<CallToolResult> {
    const { agent } = await current();
    const config = agent.config ?? { envVars: [], schemas: [] };
    if (pickFormat(args) === 'pack') {
      return textResult(getConfigToPack(config.envVars, packSnapshotId(agent)));
    }
    return jsonResult(config);
  }

  // Change Verdict: head (current analysis) vs the previous full analysis.
  async function handleReviewChange(args: Record<string, unknown>): Promise<CallToolResult> {
    const agent = newestHead((await current()).agent);
    const baseline = readBaseline(agent);
    if (!baseline) {
      // EH-2: a missing baseline is an actionable precondition failure.
      return errorResult({
        error:
          'No baseline yet: analyze keeps the previous analysis in .facts/baseline/agent.json. Run analyze again after a change, then retry.',
      });
    }
    const verdict = buildChangeVerdict(baseline, agent);
    if (args.format === 'markdown') return textResult(renderVerdictMarkdown(verdict));
    return jsonResult(verdict);
  }

  // F7 — token cost of a file or a raw snippet.
  async function handleCountTokens(args: Record<string, unknown>): Promise<CallToolResult> {
    const parsed = CountTokensInputSchema.safeParse(args);
    if (!parsed.success) return invalidInput('count_tokens', zodIssues(parsed.error.issues));
    // Raw text → pure estimate, no analysis needed.
    if (parsed.data.text !== undefined) {
      const text = parsed.data.text;
      return jsonResult({
        tokens: approximateTokens(text),
        chars: text.length,
        source: 'estimate',
      });
    }
    // Path → prefer the artifact's exact pre-computed tokenCost; else live-read.
    const { agent } = await current();
    const relPath = normalizeRelPath(root, String(parsed.data.path));
    const fileEntry = agent.files.find((f) => f.path === relPath);
    if (fileEntry) {
      return jsonResult({ path: relPath, tokens: fileEntry.tokenCost, source: 'artifact' });
    }
    let abs: string;
    try {
      abs = resolveInRoot(root, relPath); // SEC: reject paths escaping the project root
    } catch {
      return errorResult({ error: 'Path outside project root' });
    }
    if (!existsSync(abs)) return fileNotFound(agent, relPath);
    if (!statSync(abs).isFile()) return errorResult({ error: `Not a file: ${relPath}` });
    return jsonResult({
      path: relPath,
      tokens: approximateTokens(readFileSync(abs, 'utf8')),
      source: 'estimate',
    });
  }

  // F4 — assemble a ranked, token-budgeted context block for a task.
  async function handleGetContext(args: Record<string, unknown>): Promise<CallToolResult> {
    const { agent } = await current();
    const parsed = ContextInputSchema.safeParse(args);
    if (!parsed.success) return invalidInput('get_context', zodIssues(parsed.error.issues));
    const snapshotId = packSnapshotId(agent);
    // F9 — re-rank by what the agent recently served/read/edited. Best-effort.
    const sessionEvents = readLearnings();
    const recentEntities = recentSessionEntities(sessionEvents);
    const result = assembleContext(agent, {
      query: parsed.data.query,
      ...(parsed.data.seeds !== undefined
        ? { seeds: parsed.data.seeds.map((s) => normalizeRelPath(root, s)) }
        : {}),
      budgetTokens: parsed.data.budgetTokens,
      maxHops: parsed.data.maxHops,
      ...(recentEntities.length ? { recentEntities } : {}),
    });
    // F9 — record what we served (consecutive-dedup) so the next call re-ranks.
    try {
      const servedIds = result.items.map((i) => i.id);
      if (JSON.stringify(servedIds) !== JSON.stringify(lastServedEntities(sessionEvents))) {
        appendLearning(
          sessionActionEvent({
            action: 'served',
            entities: servedIds,
            tokens: result.totalTokens,
          }),
        );
      }
    } catch {
      /* serving context must never fail on a log write */
    }
    if (pickFormat(args) === 'pack') return textResult(contextToPack(result, snapshotId));
    return jsonResult(result);
  }

  async function handleSyncPack(args: Record<string, unknown>): Promise<CallToolResult> {
    await ensureAnalyzed();
    const parsed = SyncPackInputSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        JSON.stringify({
          status: 'error',
          error: 'invalid sync_pack input',
          issues: zodIssues(parsed.error.issues),
        }),
        true,
      );
    }
    /* Read the master + diff sidecar as one consistent pair: inside the
       fence, no in-process analyze can write between the two reads. */
    const pair = await exclusive(() => {
      let master: string | null;
      try {
        master = readFileSync(path.join(factsDir, 'agent.pack'), 'utf8');
      } catch {
        master = null;
      }
      let diff: string | undefined;
      try {
        const diffPath = path.join(factsDir, 'agent.diff.pack');
        if (existsSync(diffPath)) diff = readFileSync(diffPath, 'utf8');
      } catch {
        diff = undefined;
      }
      return { master, diff };
    });
    if (pair.master === null) {
      return textResult(
        JSON.stringify({ status: 'error', error: 'no readable agent.pack — run analyze first' }),
        true,
      );
    }
    const result = resolveSyncPack(pair.master, pair.diff, parsed.data.have);
    return textResult(JSON.stringify(result), result.status === 'error');
  }

  /** Typed on spec's shipped tool-name union: a catalog tool with no handler,
   *  or a handler for a tool the catalog dropped, fails the type check. */
  const toolHandlers: Record<ShippedMcpToolName, ToolHandler> = {
    analyze: handleAnalyze,
    query_graph: handleQueryGraph,
    query: handleQuery,
    get_diagram: handleGetDiagram,
    get_outline: handleGetOutline,
    list_risks: handleListRisks,
    list_credentials: handleListCredentials,
    list_vulnerabilities: handleListVulnerabilities,
    read_memory: handleReadMemory,
    since: handleSince,
    log_learning: handleLogLearning,
    query_learnings: handleQueryLearnings,
    get_config: handleGetConfig,
    review_change: handleReviewChange,
    count_tokens: handleCountTokens,
    get_context: handleGetContext,
    sync_pack: handleSyncPack,
  };

  async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (rootError) return errorResult({ error: rootError });
    // Own keys only: `constructor`, `toString`, `__proto__` are not tools.
    const handler = Object.hasOwn(toolHandlers, name)
      ? toolHandlers[name as ShippedMcpToolName]
      : undefined;
    if (!handler) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    return handler(args);
  }

  async function warmUp(): Promise<void> {
    try {
      await ensureAnalyzed();
      const a = cached!.agent;
      log(`cached ${a.files.length} files, ${a.graph.edges.length} edges, ${a.risks.length} risks`);
    } catch (err) {
      log(
        `initial analyze failed: ${err instanceof Error ? err.message : String(err)} — tools retry on first use`,
      );
    }
  }

  return {
    server,
    ensureAnalyzed,
    async connect(transport: Transport) {
      let settle!: () => void;
      const warm = new Promise<void>((resolve) => (settle = resolve));
      let timer: ReturnType<typeof setTimeout> | undefined;
      /* MCP-R1: nothing runs before the handshake completes. Starting the
         boot analyze in connect() let its synchronous git mining hold stdin,
         so `initialize` itself waited ~1 s on a mid-size repo. */
      server.oninitialized = () => {
        timer ??= setTimeout(() => void warmUp().then(settle), BOOT_ANALYZE_DELAY_MS);
      };
      server.onclose = () => {
        clearTimeout(timer);
        settle();
      };
      await server.connect(transport);
      return { warm };
    },
  };
}

function jsonResource(uri: string, payload: unknown) {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }],
  };
}

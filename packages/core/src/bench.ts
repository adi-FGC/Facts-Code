/**
 * F13 — reproducible benchmark harness.
 *
 * Proves, with committed numbers, that graph-aware context assembly (F4
 * `get_context`) reduces tokens-to-context vs naive file exploration. For each
 * task in a fixed set we measure BOTH strategies over the SAME analyzed corpus:
 *
 *   - FACTS side : `assembleContext(agent, task)` — the ranked, budgeted
 *                  subgraph an agent reads up front. tokens = the result's
 *                  `totalTokens`; turns = 1 (one tool call).
 *   - NAIVE side : what an agent without FACTS does — grep the task's content
 *                  words against file paths and read every hit IN FULL. tokens =
 *                  Σ tokenCost of matched files; turns = one read per file.
 *                  Deliberately the same tokenizer as F4 seeding (`queryTokens`)
 *                  so the baseline greps the same words — a plausible strategy,
 *                  not a strawman.
 *
 * Correctness is RECALL against each task's `expectedAnchors` (the files an
 * informed engineer actually needs): savings mean nothing if the cheap context
 * misses the right files.
 *
 * READ THE NUMBERS HONESTLY — the budget floor. The FACTS side fills its
 * token budget by design ("useful context up front"), and the per-task budget
 * is set relative to the CORPUS (~17% of total, mirroring an 8K budget on a
 * 500K-token repo) — NOT relative to each task's information need. So on a
 * small corpus, a task whose only needed file is tiny will show NEGATIVE
 * savings purely by construction: FACTS returns a budget-sized block while a
 * lucky single-file grep reads one small file. Those rows are reported as-is
 * (never hidden); the meaningful statistics are the aggregate savings and the
 * recall comparison, where graph-blind grep misses dependencies and over-reads
 * noise. Budgets are deliberately NOT scaled per-task to the expected anchors —
 * that would leak ground truth into the measured strategy.
 *
 * Pure + deterministic (INV1/INV2): everything derives from the artifact's
 * committed token costs — no I/O, no clock, no network. Same corpus + same
 * tasks ⇒ byte-identical report, which is what makes `bench/expected.json`
 * committable and CI-comparable.
 */

import type { AgentArtifact } from '@factstack/spec';
import { assembleContext, queryTokens } from './context.js';

export interface BenchTask {
  /** Stable id used in the report + expected-output comparison. */
  id: string;
  /** The coding task, phrased the way an agent would receive it. */
  query: string;
  /** Optional explicit seed anchors (forwarded to assembleContext). */
  seeds?: string[];
  /** Context budget for the FACTS side (default 4000 — bench corpora are small). */
  budgetTokens?: number;
  /** Files an informed engineer must read for this task — recall ground truth. */
  expectedAnchors: string[];
}

export interface BenchTaskResult {
  id: string;
  query: string;
  facts: {
    tokens: number;
    /** Always 1 — a single get_context call assembles the whole block. */
    turns: number;
    /** Fraction of expectedAnchors present in the assembled context [0,1]. */
    recall: number;
    /** Paths of the assembled anchors (diagnostic). */
    anchors: string[];
  };
  naive: {
    tokens: number;
    /** One read per matched file. */
    turns: number;
    recall: number;
    /** Paths the naive grep would open (diagnostic). */
    files: string[];
  };
  /** Token savings vs naive, percent, 1dp. 0 when the naive side read nothing. */
  savingsPct: number;
}

export interface BenchReport {
  corpus: { files: number; loc: number; totalTokens: number };
  tasks: BenchTaskResult[];
  aggregate: {
    factsTokens: number;
    naiveTokens: number;
    savingsPct: number;
    meanFactsRecall: number;
    meanNaiveRecall: number;
  };
}

const DEFAULT_BENCH_BUDGET = 4000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  return Math.round(n * 1e3) / 1e3;
}

/** Recall of `expected` within `got` (path equality). 1 when nothing expected. */
function recallOf(expected: string[], got: Set<string>): number {
  if (!expected.length) return 1;
  return round3(expected.filter((e) => got.has(e)).length / expected.length);
}

/**
 * The naive baseline: substring-grep each content word of the task against
 * every file path (case-insensitive) and "read" every hit in full. Sorted for
 * determinism. No budget, no ranking — that absence IS the baseline.
 */
export function naiveReadSet(agent: AgentArtifact, query: string): string[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const hits: string[] = [];
  for (const f of agent.files) {
    const p = f.path.toLowerCase();
    if (tokens.some((t) => p.includes(t))) hits.push(f.path);
  }
  return hits.sort();
}

/** Run one task through both strategies. */
export function runBenchTask(agent: AgentArtifact, task: BenchTask): BenchTaskResult {
  const ctx = assembleContext(agent, {
    query: task.query,
    ...(task.seeds !== undefined ? { seeds: task.seeds } : {}),
    budgetTokens: task.budgetTokens ?? DEFAULT_BENCH_BUDGET,
  });
  // Anchors compare at the FILE level: an expected anchor counts as covered
  // whether the context included the whole file or a symbol inside it.
  const factsPaths = new Set(ctx.items.map((i) => i.path));

  const naiveFiles = naiveReadSet(agent, task.query);
  const tokenByPath = new Map(agent.files.map((f) => [f.path, f.tokenCost]));
  const naiveTokens = naiveFiles.reduce((sum, p) => sum + (tokenByPath.get(p) ?? 0), 0);

  const savingsPct = naiveTokens > 0 ? round1(((naiveTokens - ctx.totalTokens) / naiveTokens) * 100) : 0;

  return {
    id: task.id,
    query: task.query,
    facts: {
      tokens: ctx.totalTokens,
      turns: 1,
      recall: recallOf(task.expectedAnchors, factsPaths),
      anchors: [...factsPaths].sort(),
    },
    naive: {
      tokens: naiveTokens,
      turns: naiveFiles.length,
      recall: recallOf(task.expectedAnchors, new Set(naiveFiles)),
      files: naiveFiles,
    },
    savingsPct,
  };
}

/** Run the full task set and aggregate. */
export function runBench(agent: AgentArtifact, tasks: BenchTask[]): BenchReport {
  const results = tasks.map((t) => runBenchTask(agent, t));
  const factsTokens = results.reduce((s, r) => s + r.facts.tokens, 0);
  const naiveTokens = results.reduce((s, r) => s + r.naive.tokens, 0);
  const mean = (xs: number[]): number => (xs.length ? round3(xs.reduce((a, b) => a + b, 0) / xs.length) : 1);
  return {
    corpus: {
      files: agent.stats.fileCount,
      loc: agent.stats.loc,
      totalTokens: agent.stats.totalTokenCost,
    },
    tasks: results,
    aggregate: {
      factsTokens,
      naiveTokens,
      savingsPct: naiveTokens > 0 ? round1(((naiveTokens - factsTokens) / naiveTokens) * 100) : 0,
      meanFactsRecall: mean(results.map((r) => r.facts.recall)),
      meanNaiveRecall: mean(results.map((r) => r.naive.recall)),
    },
  };
}

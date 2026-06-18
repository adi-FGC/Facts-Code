/**
 * F4 — graph-aware context assembly (`get_context`).
 *
 * Given a task description (+ optional seed files/symbols), assemble a
 * CONNECTED, RANKED, TOKEN-BUDGETED subgraph an agent can read up front, instead
 * of issuing many exploratory `read`s. The output is a ranked list of
 * file/symbol anchors (each with a `file:line` citation + token cost) plus the
 * edges that connect them.
 *
 * Pipeline:
 *   1. Seed    — resolve entities from `query` (fuzzy, F3) ∪ explicit `seeds`.
 *   2. Expand  — BFS up to `maxHops` over the unified file+symbol graph (F3
 *                `expandWithHops`), tracking each node's hop distance.
 *   3. Rank    — score = wI·importance(F5) + wP·proximity + wR·recency + wM·name.
 *   4. Budget  — greedily include by descending score until `budgetTokens`;
 *                seeds are NEVER dropped; dropped candidates set `truncated`.
 *   5. Assemble — ranked items + connecting edges + budget stats.
 *
 * Determinism + purity (INV1/INV2): no I/O, NO CLOCK. "Recency" reads the
 * `churnScore` already baked into the artifact at analyze time, never wall time.
 * Every list is score-then-id sorted; the ranking weights + bounds are fixed
 * and documented below. INV3: free text is resolved to seeds deterministically
 * (no model). The same artifact + request always yields a byte-identical result.
 */

import type { AgentArtifact } from '@factstack/spec';
import {
  findEntities,
  suggestEntities,
  expandWithHops,
  type SubgraphResult,
} from './query.js';

// Indexed-access aliases — track the schema without importing exact type names.
type GraphNode = AgentArtifact['graph']['nodes'][number];
type FileNode = AgentArtifact['files'][number];
type SymNode = NonNullable<AgentArtifact['graph']['symbolNodes']>[number];

/* ─────────── ranking weights (fixed + documented — INV2) ───────────
 *
 * A candidate's relevance to a task is a blend of four normalized [0,1] signals.
 * The weights sum to 1 so a score is itself in [0,1]. Tuned for "what should I
 * read before changing X":
 *
 *   - IMPORTANCE (0.35): F5 PageRank centrality. A structurally central file is
 *     the best single "read this first" signal — it's what everything leans on.
 *   - PROXIMITY  (0.30): graph closeness to the seed (1/(1+hops)). The thing
 *     you're changing and its direct neighbors dominate the relevant set.
 *   - NAME MATCH (0.20): fraction of task words that appear in the node's
 *     name/path. A direct lexical hit ("User") is a strong, cheap signal.
 *   - RECENCY    (0.15): churn (recent edit activity) — files touched lately are
 *     likelier tied to the work in flight. Lowest weight: noisy on its own.
 *
 * To retune, change these four constants (they're the only knob) and re-run the
 * determinism tests. */
const W_IMPORTANCE = 0.35;
const W_PROXIMITY = 0.3;
const W_NAMEMATCH = 0.2;
const W_RECENCY = 0.15;

const DEFAULT_BUDGET_TOKENS = 8000;
const DEFAULT_MAX_HOPS = 2;
/** F9 — additive bonus for an anchor the agent touched recently (session
 *  recency). Added on top of the [0,1] base score and clamped to 1, so it
 *  re-ranks without changing the base-4 weights or breaking score ∈ [0,1]. */
const SESSION_BONUS = 0.1;

/** Per-token fuzzy seed matches to keep — caps how many nodes one task word can
 *  pull in before ranking. Low so a generic word can't flood the seed set. */
const PER_TOKEN_SEED_CAP = 3;
/** Query-derived seeds to keep after ranking by (hit-count, importance). Tight
 *  so the seed set is a few precise anchors, not every lexical match. */
const MAX_QUERY_SEEDS = 6;
/** Hard ceiling on total seeds (explicit + query); over this we keep explicit
 *  seeds + the highest-importance rest so a vague task stays bounded. */
const MAX_SEEDS = 10;
/** Cold-start fallback breadth: top-importance files when nothing matched. */
const COLD_START_FILES = 10;
/** Fallback per-line token estimate for a symbol when its file's density is
 *  unknown (no loc). ~8 tokens/line is typical for source; files use their own
 *  measured `tokenCost`. */
const FALLBACK_TOKENS_PER_LINE = 8;

/** Min task-word length to seed on, plus task-language words to ignore — they
 *  describe the ACTION, not the code, so they'd seed noise. Code-y words
 *  (role, user, auth, field, …) are intentionally NOT here. */
const MIN_TOKEN_LEN = 3;
const STOPWORDS = new Set([
  'add', 'new', 'fix', 'the', 'and', 'for', 'with', 'this', 'that', 'from',
  'into', 'make', 'update', 'change', 'create', 'remove', 'delete', 'support',
  'using', 'feature', 'refactor', 'implement', 'want', 'need', 'please',
  'should', 'could', 'would', 'when', 'where', 'what', 'file', 'files', 'use',
]);

export interface ContextRequest {
  /** Free-text task, e.g. "add a role field to User". */
  query: string;
  /** Explicit seed file paths or symbol ids to anchor on (resolved leniently). */
  seeds?: string[];
  /** Token budget for the assembled context (default 8000). */
  budgetTokens?: number;
  /** Graph expansion radius from the seeds (default 2). */
  maxHops?: number;
  /** F9 — entity ids the agent recently served/read/edited/queried this or last
   *  session. Matching anchors get a small relevance bonus, so context tracks
   *  what's in flight. Passed in by the caller (MCP handler reads the learnings
   *  log) so the assembler stays pure. */
  recentEntities?: string[];
}

/** One ranked anchor in the assembled context. `path` + `line` is the citation. */
export interface ContextItem {
  /** Node id: a file path or a symbol id (`path#name@line`). */
  id: string;
  path: string;
  /** Basename (files) or symbol name (symbols). */
  name: string;
  /** `file` or a symbol kind (function/class/…). */
  kind: string;
  /** Symbol start line; null for a whole-file anchor. */
  line: number | null;
  /** Relevance in [0,1], rounded to 4dp. */
  score: number;
  /** Estimated token cost to read this anchor. */
  tokenCost: number;
  /** Hops from the nearest seed (0 = a seed itself). */
  hops: number;
  isSeed: boolean;
}

export interface ContextResult {
  query: string;
  /** Ranked, budget-included anchors (score-descending, id tie-break). */
  items: ContextItem[];
  /** Edges connecting the included anchors. */
  edges: SubgraphResult['edges'];
  /** Sum of included `tokenCost` (may exceed `budgetTokens` when seeds alone do). */
  totalTokens: number;
  budgetTokens: number;
  /** Candidates were dropped (budget or a seed overflow) — never a silent cap. */
  truncated: boolean;
  /** No seed matched the task → top-importance fallback brief (INV: say so). */
  coldStart: boolean;
  /** Resolved seed ids (id-sorted). */
  seeds: string[];
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Lowercased task words worth seeding on (length-filtered, stopwords removed).
 *  Exported for the F13 bench harness so the naive-baseline grep uses the SAME
 *  content words as F4 seeding — one tokenizer, fair comparison. */
export function queryTokens(query: string): string[] {
  const raw = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return raw.filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

/**
 * Split an identifier/path/name into lowercased WORD tokens: break on
 * non-alphanumerics (`/`, `.`, `-`, `_`) AND camelCase / letter→digit
 * boundaries. `src/ui/GraphRoute.tsx` → {src, ui, graph, route, tsx};
 * `runGraphQuery` → {run, graph, query}. Word-boundary matching is what stops
 * the task word "graph" from spuriously matching "typo**graph**y".
 */
function splitWords(s: string): string[] {
  return s
    .split(/[^A-Za-z0-9]+/)
    .flatMap((p) => p.split(/(?<=[a-z])(?=[A-Z])/))
    .flatMap((p) => p.split(/(?<=[A-Za-z])(?=[0-9])/))
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= MIN_TOKEN_LEN);
}

/** Word set for a node: its name + last two path segments, word-split. */
function nodeWordSet(path: string, name: string): Set<string> {
  const segs = path.split(/[/\\]/);
  const src = [name, ...segs.slice(-2)].join(' ');
  return new Set(splitWords(src));
}

/** True when a task `token` hits a node word as a whole word or a prefix
 *  (`auth` → `authenticate`). Prefix-only one way so short words stay tight. */
function wordHit(words: Set<string>, token: string): boolean {
  if (words.has(token)) return true;
  for (const w of words) if (w.startsWith(token)) return true;
  return false;
}

/** Docs / config / markup languages — excluded from CODE-context seeds (a task
 *  like "add a role field" wants source files, not a README that shares a word).
 *  Allow-by-default for anything else so unknown source languages aren't lost. */
const NON_SOURCE_LANGS = new Set([
  'json', 'yaml', 'yml', 'toml', 'markdown', 'md', 'mdx', 'html', 'htm', 'css',
  'scss', 'sass', 'less', 'gitignore', 'dockerignore', 'text', 'txt', 'xml',
  'svg', 'csv', 'lock', 'ini', 'env',
]);
function isSourceNode(language: string): boolean {
  return !NON_SOURCE_LANGS.has(language.toLowerCase());
}

/** Score-descending, then id-ascending — the canonical deterministic order. */
function byScoreThenId(a: ContextItem, b: ContextItem): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Assemble a ranked, budget-bounded context block for a task. Pure: depends
 * only on `agent` (+ the request); identical inputs yield an identical result.
 */
export function assembleContext(agent: AgentArtifact, req: ContextRequest): ContextResult {
  const budgetTokens = req.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const maxHops = req.maxHops ?? DEFAULT_MAX_HOPS;

  // ── indexes (built once) ────────────────────────────────────────────────
  const nodeByPath = new Map<string, GraphNode>();
  for (const n of agent.graph.nodes) nodeByPath.set(n.path, n);
  const fileByPath = new Map<string, FileNode>();
  for (const f of agent.files) fileByPath.set(f.path, f);
  const symbolById = new Map<string, SymNode>();
  for (const s of agent.graph.symbolNodes ?? []) symbolById.set(s.id, s);

  const importanceOf = (id: string): number => {
    const sym = symbolById.get(id);
    return nodeByPath.get(sym ? sym.path : id)?.importance ?? 0;
  };
  const tokens = queryTokens(req.query);
  const recentSet = new Set(req.recentEntities ?? []); // F9 — session-recency boost set

  // ── 1. seeds = explicit (trusted) ∪ query-word matched (ranked, capped) ───
  // (a) Explicit user seeds: resolved leniently, always kept.
  const explicitSeeds = new Set<string>();
  for (const raw of req.seeds ?? []) {
    const exact = findEntities(agent, raw);
    const ids = exact.length ? exact : suggestEntities(agent, raw, PER_TOKEN_SEED_CAP);
    for (const id of ids) explicitSeeds.add(id);
  }
  // An exact name/path passed AS the whole query is a high-confidence seed too.
  for (const id of findEntities(agent, req.query)) explicitSeeds.add(id);

  // (b) Query-derived seeds: a node is a candidate when its WORD set (name + path
  //     segments, camelCase-split) hits ≥1 task word. Rank by hit count first —
  //     a node matching BOTH "graph" and "query" (e.g. `runGraphQuery`) beats one
  //     matching "graph" only — then by importance. Capped so a vague task can't
  //     flood the seed set, and word-boundary matching keeps "graph" out of
  //     "typography".
  const querySeeds: string[] = [];
  if (tokens.length) {
    const scored: Array<{ id: string; hits: number; imp: number }> = [];
    const consider = (id: string, path: string, name: string): void => {
      const words = nodeWordSet(path, name);
      let hits = 0;
      for (const t of tokens) if (wordHit(words, t)) hits++;
      if (hits > 0) scored.push({ id, hits, imp: importanceOf(id) });
    };
    for (const n of agent.graph.nodes) if (isSourceNode(n.language)) consider(n.path, n.path, baseName(n.path));
    for (const s of agent.graph.symbolNodes ?? []) consider(s.id, s.path, s.name);
    scored.sort((a, b) =>
      b.hits !== a.hits ? b.hits - a.hits : b.imp !== a.imp ? b.imp - a.imp : a.id < b.id ? -1 : 1,
    );
    for (const s of scored.slice(0, MAX_QUERY_SEEDS)) querySeeds.push(s.id);
  }

  let coldStart = false;
  let seeds = [...new Set([...explicitSeeds, ...querySeeds])];
  if (seeds.length > MAX_SEEDS) {
    // Trim to MAX_SEEDS but never drop an explicit seed; rank the rest by importance.
    const keep = new Set(explicitSeeds);
    const extra = seeds
      .filter((id) => !keep.has(id))
      .map((id) => ({ id, imp: importanceOf(id) }))
      .sort((a, b) => (b.imp !== a.imp ? b.imp - a.imp : a.id < b.id ? -1 : 1));
    for (const e of extra) {
      if (keep.size >= MAX_SEEDS) break;
      keep.add(e.id);
    }
    seeds = [...keep];
  }
  seeds.sort();
  if (!seeds.length) {
    // Cold start: nothing matched → a top-importance "where does this project
    // live" brief. Marked so the caller knows it's a fallback, not a precise hit.
    coldStart = true;
    // Source files by importance, then path. Importance is read as `?? 0` (NOT
    // required) so a pre-F5 artifact — which has no importance — still gets a
    // brief ordered by path (INV4 backward-compat). This keeps a cold start
    // non-empty whenever the project has ANY source file, so we never emit the
    // contradictory "here's a fallback brief" that's actually empty.
    seeds = [...agent.graph.nodes]
      .filter((n) => isSourceNode(n.language))
      .sort((a, b) => {
        const ia = a.importance ?? 0;
        const ib = b.importance ?? 0;
        return ib !== ia ? ib - ia : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      })
      .slice(0, COLD_START_FILES)
      .map((n) => n.path)
      .sort();
  }

  // ── 2. expand with hop tracking ──────────────────────────────────────────
  const { hops, edges } = expandWithHops(agent, seeds, maxHops, 'both');
  const candidateIds = [...hops.keys()];

  // ── 3. rank ──────────────────────────────────────────────────────────────
  // Recency is normalized by the max churn among candidates (like F5 normalizes
  // importance by max) so it stays a [0,1] signal regardless of absolute churn.
  // churnScore is null when there's no git history (zip / fresh clone) — read as
  // 0, so on a no-git project maxChurn is 0 and the recency term cleanly drops
  // out (guarded below); ranking then leans on importance + proximity + name.
  const churnOf = (id: string): number => {
    const sym = symbolById.get(id);
    return fileByPath.get(sym ? sym.path : id)?.churnScore ?? 0;
  };
  let maxChurn = 0;
  for (const id of candidateIds) maxChurn = Math.max(maxChurn, churnOf(id));

  const seedIdSet = new Set(seeds);

  const tokenCostOf = (id: string): number => {
    const sym = symbolById.get(id);
    if (!sym) return nodeByPath.get(id)?.tokenCost ?? fileByPath.get(id)?.tokenCost ?? 0;
    // Symbol: estimate from its line span, proportional to the file's measured
    // token density when we know the file's loc, else a flat per-line rate.
    const span = Math.max(1, sym.endLine - sym.startLine + 1);
    const file = fileByPath.get(sym.path);
    if (file && file.loc > 0) return Math.max(1, Math.round((file.tokenCost * span) / file.loc));
    return Math.max(1, span * FALLBACK_TOKENS_PER_LINE);
  };

  const candidates: ContextItem[] = candidateIds.map((id) => {
    const sym = symbolById.get(id);
    const path = sym ? sym.path : id;
    const name = sym ? sym.name : baseName(id);
    const kind = sym ? sym.kind : 'file';
    const line = sym ? sym.startLine : null;
    const hop = hops.get(id) ?? 0;

    const importance = importanceOf(id);
    const proximity = 1 / (1 + hop);
    const recency = maxChurn > 0 ? churnOf(id) / maxChurn : 0;
    // Word-boundary match (same matcher as seeding) — fraction of task words the
    // node's name/path hits. Keeps "graph" out of "typography" here too.
    const words = nodeWordSet(path, name);
    const nameMatch = tokens.length ? tokens.filter((t) => wordHit(words, t)).length / tokens.length : 0;

    const base =
      W_IMPORTANCE * importance + W_PROXIMITY * proximity + W_NAMEMATCH * nameMatch + W_RECENCY * recency;
    // F9 — clamp the session bonus into the base so score stays in [0,1].
    const score = round4(Math.min(1, base + (recentSet.has(id) ? SESSION_BONUS : 0)));

    return { id, path, name, kind, line, score, tokenCost: tokenCostOf(id), hops: hop, isSeed: seedIdSet.has(id) };
  });

  // ── 4. budget ─────────────────────────────────────────────────────────────
  // DIRECT seeds (user-provided / exact whole-query match) are sacred — included
  // even over budget (spec: "always include direct seeds"). INFERRED seeds
  // (matched from task words) and expanded nodes are budget-gated by descending
  // score, so the result respects the budget the user asked for. A floor
  // guarantees at least the single top anchor so a tight budget never yields an
  // empty pack.
  const directSet = explicitSeeds;
  const direct = candidates.filter((c) => directSet.has(c.id)).sort(byScoreThenId);
  const rest = candidates.filter((c) => !directSet.has(c.id)).sort(byScoreThenId);

  const included = new Map<string, ContextItem>();
  let totalTokens = 0;
  let truncated = false;

  for (const c of direct) {
    included.set(c.id, c);
    totalTokens += c.tokenCost;
  }
  if (totalTokens > budgetTokens) truncated = true; // direct seeds alone over budget

  for (const c of rest) {
    if (totalTokens + c.tokenCost <= budgetTokens) {
      included.set(c.id, c);
      totalTokens += c.tokenCost;
    } else {
      // No room — keep scanning (a smaller, lower-score one may still fit) but
      // the result is now a visible partial.
      truncated = true;
    }
  }

  // Floor: never return an empty pack when something matched — include the single
  // highest-ranked anchor over budget (and say so) so the agent always gets the
  // most relevant hit.
  if (!included.size && candidates.length) {
    const top = [...candidates].sort(byScoreThenId)[0]!;
    included.set(top.id, top);
    totalTokens += top.tokenCost;
    truncated = true;
  }

  // ── 5. assemble: ranked items + connecting edges ─────────────────────────
  const items = [...included.values()].sort(byScoreThenId);
  const keep = new Set(included.keys());
  const outEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));

  return { query: req.query, items, edges: outEdges, totalTokens, budgetTokens, truncated, coldStart, seeds };
}

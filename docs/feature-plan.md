# FACTS — Feature Plan (vNext)

> Implementation-grade plan for the next wave of FACTS capabilities. Written
> to be executed against the current `factstack` monorepo. Every feature is
> anchored to real packages, schemas, and files. Read §1 (invariants) before
> touching any code — they are the guardrails that keep changes correct in
> this codebase.
>
> Status: proposal. Schema/format changes here are **additive-first**; the few
> breaking ones are called out explicitly with a migration note.

---

## 0. How to use this plan

- Features are labelled **F1…F14**. Each carries: **Goal · Surface · Spec
  changes · Analyzer changes · FactsPack changes · MCP/CLI surface · Algorithm
  & impl · Determinism/purity · Edge cases · Tests · Effort · Depends-on ·
  Definition of done.**
- **§3** gives the dependency-ordered phasing (A–E). Don't implement in numeric
  order — implement in phase order.
- Effort key: **S** ≈ 0.5–1 day, **M** ≈ 2–4 days, **L** ≈ 1–2 weeks.

---

## 1. Design invariants (read first)

These are inviolable unless a feature explicitly renegotiates one.

- **INV1 — Tier purity.** `spec`, `walker`, `parsers`, `extractors`, `graph`,
  `scanners`, `intent`, `core`, `factspack`, and `emit/pure` are **isomorphic
  and pure**: no `node:*`, no `fetch`, no `Date.now()`/`Math.random()`, no I/O.
  Anything needing the filesystem, `node:sqlite`, git, or the network lives in
  `packages/emit/` (Node side), `packages/emit-browser/`, or `apps/*`. When a
  feature needs both, split it: pure core + thin Node/browser adapter (the
  `FactsFS`/`FileWriter` pattern in `CONTEXT.md`).
- **INV2 — Determinism.** Same input ⇒ byte-identical output. Enforced by tests
  (`packages/core/test/memory.test.ts`, the `intent` suite, etc.). Every new
  artifact field, ranking, or clustering MUST sort deterministically, use
  iteration-bounded numeric algorithms (no convergence-dependent loop counts),
  and break ties on a stable key (path, then id). No `Math.random`, no wall
  clock inside pure code — pass timestamps in from the adapter.
- **INV3 — No model in the core.** FACTS produces *deterministic retrieval
  primitives*; it never calls an LLM. "Natural language" understanding is the
  calling agent's job. Where we accept a free-text query, we resolve it with
  deterministic entity-matching against the graph, not inference.
- **INV4 — Additive schema evolution.** New `agent.json` fields are `.optional()`
  or `.default(...)` so pre-existing artifacts validate unchanged and
  `FACTS_SCHEMA_VERSION` (`packages/spec/src/agent.ts`, currently `0.1.0`) stays
  put. A FactsPack table whose **columns change** bumps that table's schema name
  (`agent-v1` → `agent-v2`, etc. in `packages/emit/src/pack.ts` /
  `apps/mcp-server/src/pack-responses.ts`) AND updates the 8-line decoder
  preamble doc; consumers pin schema names and must reject mismatches.
- **INV5 — Single sources of truth.** Query verbs live in `QUERY_VERBS`
  (`packages/spec/src/mcp.ts`); MCP tool names in `MCP_TOOL_NAMES` + `MCP_TOOL`
  there too. Add the verb/tool to the tuple FIRST — `tsc` then points at every
  site that must change (server dispatch in `apps/mcp-server/src/server.ts`, the
  `skills` onboarding sequence).
- **INV6 — `analyze` makes no network calls** (constraint C1). Anything that
  touches the network is a separate opt-in subcommand (precedent:
  `factstack scan-vulns`).
- **INV7 — Browser parity.** Analyzer-tier features must also run under
  `fs-browser` (the `apps/ui-remix/src/scanner.worker.ts` path). If a feature is
  Node-only (e.g. a SQLite cache), it must degrade gracefully to a no-op in the
  browser, never break the build.
- **INV8 — Token-first responses.** Every new agent-facing response that is
  tabular ships as **FactsPack**, following the per-tool converter pattern in
  `pack-responses.ts` (intern repeated paths with an uppercase column; keep short
  enums literal).

---

## 2. Feature catalog

### F1 — Provenance & confidence on relationships

**Goal.** Every edge (and, post-F2, every symbol edge) carries how we know it:
`extracted` (directly in source), `inferred` (resolved/deduced), or `ambiguous`
(name-match only, flagged for review). Raises trust and gives the dashboard a
"what's certain vs guessed" axis.

**Surface.** New `confidence` field on edges; a one-line confidence summary in
`MEMORY.md`; a dashboard legend; a `--min-confidence` filter on queries.

**Spec changes** (`packages/spec/src/agent.ts`):
- Add `export const ConfidenceSchema = z.enum(['extracted','inferred','ambiguous'])`.
- Extend `GraphEdgeSchema`: `confidence: ConfidenceSchema.default('extracted')`,
  `confidenceScore: z.number().min(0).max(1).optional()`. Default keeps old
  artifacts valid (INV4). Import edges are always `extracted`/`1.0`.

**Analyzer changes.** Where edges are built (`packages/graph/src/dependency.ts`,
`resolver.ts`) set `extracted`. The `heuristic` boolean already on `RawRef`
(`extractors/src/symbols-refs.ts`) is the seed: `heuristic:false` → `extracted`;
phase-2 cross-file resolution → `inferred`; pure name match → `ambiguous`.

**FactsPack changes.** Add a `conf` column to the `imports` table in
`emit/src/pack.ts` and `queryGraphToPack` in `pack-responses.ts`. Per INV4 this
bumps `imports`/`query-graph` schema → `agent-v2`/`query-graph-v2`. Keep `conf`
literal (3 short values; interning not worth it per the file's own rule).

**MCP/CLI.** `query_graph` gains an optional `minConfidence` arg (extend
`QueryGraphInputSchema`). `list_risks`-style filter semantics.

**Algorithm & impl.** Trivial today (all deterministic ⇒ `extracted`); the value
lands once F2 introduces inferred/ambiguous edges. Build the enum + plumbing now
so F2 has somewhere to write.

**Determinism/purity.** Pure. Enum is ordered.

**Edge cases.** Old artifacts without the field → default `extracted` on read.
Don't surface a "100% extracted" confidence summary as noise — only show counts
when `inferred`/`ambiguous` > 0.

**Tests.** Schema default round-trips; pack column added; MEMORY summary omitted
when all-extracted.

**Effort.** S. **Depends-on.** none (but unlocks F2/F5/F4).
**DoD.** Edges carry confidence; pack `agent-v2` emits it; old artifacts still load.

---

### F2 — Symbol-level graph (the call/reference graph)

**Goal.** Move beyond file-level import edges to a symbol graph: nodes are
declarations (functions, classes, methods, components…), edges are
`call`/`read`/`jsx`/`type-ref`/`implements`/`extends`. This is the substrate for
real queries, impact analysis, and context retrieval.

**Surface.** New addressable symbol ids; new MCP/query verbs (F3) operate on
them; `get_outline` enriched with refs.

**Spec changes** (`packages/spec/src/agent.ts`):
- Stable symbol id scheme: `\`${path}#${name}@${startLine}\`` (path + name +
  line disambiguates overloads/duplicates). Document it once; reuse everywhere.
- Add `SymbolNodeSchema { id, path, name, kind, startLine, endLine, exported }`
  and `SymbolEdgeSchema { from, to, kind: z.enum(['call','read','jsx','type-ref',
  'implements','extends']), confidence, confidenceScore? }`.
- Extend `GraphSchema` additively: `symbolNodes: z.array(SymbolNodeSchema).default([])`,
  `symbolEdges: z.array(SymbolEdgeSchema).default([])`. File-level
  `nodes`/`edges` stay.

**Analyzer changes.** Implement **symbols-refs phase 2** (the file already
reserves it): a cross-file resolver in `packages/graph/` (new
`symbol-resolver.ts`) that, per `RawRef`:
1. resolve same-file → the file's own `declarations` (exact name) ⇒ `extracted`.
2. else resolve via imports: match the ref name against `FileOutline.imports[]`
   specifiers, follow `import.resolved` to the target file, match its
   `exports[]`/`declarations[]` ⇒ `inferred` (score 0.9).
3. else, name exists as a top-level decl in exactly one other file ⇒ `inferred`
   (0.7); in many files ⇒ `ambiguous` (emit lowest-id deterministically, mark
   `ambiguous`).
Build a `Map<name, SymbolNode[]>` index once per analyze for O(1) lookups.

**FactsPack changes.** Two new tables in `encodeAgentPack`: `symbols`
(`id`(PK,literal), `F`(interned path), `name`, `kind`, `start`, `end`, `exp`) and
`calls` (`id`, `S`(interned from-symbol), `T`(interned to-symbol), `kind`,
`conf`). Bump pack schema to `agent-v2`. Mirror as `symbolsToPack`/`callsToPack`
in `pack-responses.ts` for the new query verbs.

**MCP/CLI.** `get_outline` response gains a refs section. New verbs land in F3.

**Algorithm & impl.** The resolver is the hard part; keep it pure and indexed.
Cap fan-out (e.g. skip building edges for names with >N candidates, emit a single
`ambiguous` marker) to bound output size on huge repos.

**Determinism/purity.** Pure. Sort `symbolNodes` by id, `symbolEdges` by
`(from,to,kind)`. Deterministic candidate selection (lowest id).

**Edge cases.** Dynamic dispatch / computed members → not emitted (honest gap).
Re-exports / barrel files → follow one hop, then mark `ambiguous` if it chains.
Same name exported by many files → `ambiguous`, not a guess.

**Tests.** Resolver fixtures (same-file, import-resolved, ambiguous);
determinism; pack `agent-v2` tables; size cap honored.

**Effort.** L. **Depends-on.** F1. **DoD.** A small fixture project yields
symbol edges with correct confidence; pack carries `symbols`+`calls`.

---

### F3 — Declarative graph-query engine + free-text retrieval

**Goal.** Replace four hardcoded verbs with one small **declarative pattern
query** interpreted over in-memory adjacency, then expose a free-text entry that
maps a question to a query plan and returns a minimal connected subgraph with
citations. Existing verbs become sugar over the engine (no behavior drift).

**Surface.** New MCP tool `query` (free-text + structured); `query_graph` keeps
working; new structured verbs: `neighbors`, `path-between`, `references`,
`implementers`, `impact` (F5).

**Spec changes** (`packages/spec/src/mcp.ts`):
- Define a `GraphQuery` type: `{ start: NodeSelector, traverse?: { edgeKinds?,
  direction: 'out'|'in'|'both', maxDepth }, where?: Filter, select: 'nodes'|
  'edges'|'subgraph', limit }` where `NodeSelector` = by path / symbol id / glob
  / kind / name.
- Extend `QUERY_VERBS` (INV5) with the new verbs; `tsc` will flag every site.

**Analyzer/core changes** (`packages/core/src/query.ts`):
- Add `runGraphQuery(agent, q: GraphQuery): QueryResult`. Build adjacency maps
  once (the `importsOf` BFS already demonstrates the pattern — generalize it:
  direction-aware, edge-kind-filtered, depth-bounded, var-length). Operate over
  file edges and (when present) `symbolEdges`.
- Reimplement `callers/imports/cycles/orphans` as thin `GraphQuery` literals so
  the verb set can't drift. `executeQuery` stays the public entry.
- **Free-text → plan** (`packages/core/src/query-nl.ts`, pure, INV3): tokenize
  the question; match tokens against known entity names/paths in the graph
  (exact + case-insensitive + path-suffix); pick a template by keyword cues
  ("who calls"/"depends on"/"between X and Y"/"unused"/"impact"); return the
  resolved `GraphQuery` + the matched seed entities. No match ⇒ return a ranked
  candidate list ("did you mean…") instead of guessing.

**FactsPack changes.** A `subgraph` response: `nodes`, `edges`, and a `citations`
table (`id`, `F`(file), `line`, `sym`) so the agent gets `file:line` anchors.
Schema `subgraph-v1`.

**MCP/CLI.** `query` tool (free-text or `GraphQuery` JSON). CLI:
`factstack query "<question>"` (free-text) keeps the structured
`factstack query <verb> <target>` form.

**Determinism/purity.** Pure. Stable ordering of results; deterministic
tokenizer; ties broken by id/path.

**Edge cases.** Ambiguous entity ("User" in 9 files) → return the candidate set,
let the agent disambiguate. Huge subgraph → cap by `limit` and emit a
truncation marker row (never silently drop).

**Tests.** Verb-parity (old verbs == new engine output); NL mapping fixtures;
truncation marker present; citations correct.

**Effort.** M (engine) + M (NL mapper). **Depends-on.** F2 (for symbol queries;
file-level works without it). **DoD.** `query "who calls buildMemory"` returns
the right subgraph + citations as FactsPack.

---

### F4 — Graph-aware context assembly (`get_context`)

**Goal.** Given a task description (and optional seed files/symbols), assemble a
**connected, ranked, token-budgeted** subgraph and emit it as a compact FactsPack
"context block" the agent can consume up front — instead of the agent issuing
many exploratory reads.

**Surface.** New MCP tool `get_context`; new CLI `factstack context "<task>"
[--budget N]`. Output: a FactsPack subgraph + a ranked file/symbol list with
`file:line` citations and per-item token cost.

**Spec changes.** `ContextRequest { query, seeds?: string[], budgetTokens:
number (default 8000), maxHops: number (default 2) }`; `ContextResult` (nodes,
edges, citations, totalTokens, truncated). Add `get_context` to `MCP_TOOL_NAMES`.

**Core changes** (`packages/core/src/context.ts`, pure):
1. **Seed** = entities resolved from `query` (reuse F3 `query-nl`) ∪ explicit
   `seeds`.
2. **Expand** along edges up to `maxHops` (reuse F3 engine), collecting a
   candidate node set with the path that connected each (for citations).
3. **Rank** each candidate deterministically:
   `score = wI·importance(F5) + wP·proximityToSeed(1/hops) + wR·recency(churn/mtime,
   already on FileOutline) + wM·nameMatch`. Fixed weights; document them.
4. **Budget** greedily by descending score, summing `tokenCost` (already on
   `FileOutline`; per-symbol estimate from line span) until `budgetTokens`.
   Always include direct seeds even if over budget; mark `truncated:true` when
   candidates were dropped and emit a marker row (INV: no silent caps).
5. **Emit** FactsPack subgraph + citations.

**FactsPack changes.** Reuse F3 `subgraph` + a `context` header carrying
`totalTokens`/`truncated` (extend `PackHeader` usage via a metadata row, since
`PackHeader` is fixed — put budget stats in a 1-row `meta` table).

**MCP/CLI.** `get_context` tool; `factstack context`. Session logging in F9
records what was served (for re-ranking next call).

**Determinism/purity.** Pure given a fixed clock — recency uses
`lastModifiedMs`/`churnScore` already in the artifact, not wall time. Stable
sort; documented weights.

**Edge cases.** Budget smaller than seeds → return seeds + `truncated`. No seed
match → fall back to top-importance nodes for the whole project (a "cold start"
brief) and say so via a marker.

**Tests.** Budget respected; truncation marked; deterministic ranking; seeds
always present.

**Effort.** M–L. **Depends-on.** F2, F3, F5, F7. **DoD.** `factstack context
"add a role field to User"` returns a connected, citation-anchored, ≤budget pack.

---

### F5 — Graph analytics: importance, communities, impact

**Goal.** Turn the graph into ranked insight: importance scores (better "key
files" than raw in-degree), module/community grouping, and blast-radius/impact.

**Surface.** `MEMORY.md` "Key files" reordered by importance; new "Modules"
section; `impact` query verb / `impact_of` semantics; dashboard module map.

**Spec changes.** Optional `importance: z.number().optional()` and `community:
z.number().int().optional()` on `GraphNodeSchema` (default absent → INV4).

**Core/graph changes** (`packages/graph/src/metrics.ts`, pure):
- **Importance = PageRank** over the file-import graph (and symbol-call graph
  when present). Power iteration with **fixed iteration count** (e.g. 30) and
  damping 0.85 for determinism (INV2) — do not loop-until-converge (iteration
  count would vary). Normalize; round to fixed precision before storing.
- **Communities** = deterministic **label propagation**: process nodes in id
  order, assign the most-frequent neighbor label with lowest-id tie-break, fixed
  pass count (e.g. 10). Avoid randomized Louvain (non-deterministic) unless a
  seeded, tie-stable variant is used. Number communities by smallest-member-id.
- **Impact** = reverse reachability: from a changed node, walk `in` edges
  (callers/importers) up to depth, confidence-weighted; return the affected set.
  Implement as a `GraphQuery` (F3) so it's one engine.

**MEMORY.md changes** (`packages/core/src/memory.ts`):
- Replace `topImportedFiles` ranking in "Key files" with importance order
  (fallback to in-degree when importance absent). Add a capped "Modules" section
  (top N communities by size, each named by its highest-importance member).
  Respect the 2–10 KB budget (cap counts).

**FactsPack changes.** Add `importance`/`community` to a `nodeMetrics` table (or
columns on `files`); bump affected schema.

**Determinism/purity.** The whole point — fixed iterations, ordered processing,
stable ties. Add a determinism test that runs the algorithm twice on a fixture
and asserts byte-identical output.

**Edge cases.** Disconnected graph → multiple communities (fine). Empty graph →
no metrics, sections omitted. Dangling nodes in PageRank → standard uniform
redistribution.

**Tests.** PageRank on a known tiny graph (hand-computed expected); label-prop
determinism; MEMORY "Key files" reorders; "Modules" capped.

**Effort.** M. **Depends-on.** F1 (confidence weighting for impact); benefits
from F2. **DoD.** Deterministic importance + communities in the artifact and
MEMORY; `impact` verb works.

---

### F6 — Multi-language extraction

**Goal.** Extend beyond JS/TS (Babel) to more languages without re-writing a
parser per language.

**Surface.** More languages appear in `files[]`, the graph, and symbols.

**Approach A — tree-sitter framework (primary).** Add `web-tree-sitter` (wasm —
isomorphic, runs in Node and the browser worker, satisfies INV1/INV7). Define a
per-language adapter interface in `packages/extractors/src/ts/` mirroring the
Babel extractors: `parse(source) → { imports, symbols, refs }`. Ship grammars
incrementally (Go, Rust, Java, Ruby, C#…). The existing
`extractors/src/imports-python.ts` shows the per-language pattern already exists.

**Approach B — external index import (optional, complementary).** A Node-only
importer (`apps/cli` + `packages/emit`) that ingests a precomputed cross-language
symbol index (LSIF/SCIP-family protobuf) emitted by an external indexer and maps
its documents/occurrences/symbols into FACTS `symbolNodes`/`symbolEdges`. Gives
compiler-grade precision for languages we don't parse natively. Opt-in
subcommand `factstack ingest-index <file>` (no network ⇒ honors C1).

**Spec changes.** Extend the language set already enumerated in
`core/src/query.ts:isSourceModule`; add symbol kinds if a language needs them.

**Determinism/purity.** wasm parse is deterministic. Keep parse-once-share-tree
per the Babel precedent.

**Edge cases.** Grammar load failure → file marked `parse_error` (status already
exists), never crash the run. Mixed-language repos already supported by the
file-loop.

**Tests.** One fixture per language (mirror `tests/test_languages` style);
imports+symbols extracted; graph edges resolve.

**Effort.** L (framework once; then incremental per grammar). **Depends-on.**
F2 (to populate symbol graph). **DoD.** A Go (or Rust) fixture produces symbols +
import edges through the same pipeline as TS.

---

### F7 — Live token accounting & savings proof

**Goal.** Make the token economics first-class and provable in-session.

**Surface.** `count_tokens` + `session_stats` MCP tools; `factstack tokens
<path|->` CLI; live numbers in the dashboard (`ui-remix/src/lib/tokenEconomics.ts`
already exists — wire it to live data).

**Spec/core changes.** Reuse the estimator behind `scanners/src/tokencost.ts`
(already computes per-file `tokenCost`). Expose a pure `estimateTokens(text):
number`. `session_stats` aggregates from the session log (F9): tokens served via
FACTS responses vs an estimated baseline of the raw file reads they replaced.

**FactsPack changes.** Optionally annotate responses with a 1-row `meta` table
carrying `packTokens` and `rawEquivalentTokens` so the agent can see the saving
per call.

**MCP/CLI.** Add `count_tokens`, `session_stats` to `MCP_TOOL_NAMES`.

**Determinism/purity.** `estimateTokens` pure. Aggregation reads the log.

**Edge cases.** No session log yet → `session_stats` returns zeros + a hint.

**Tests.** Estimator parity with `tokenCost`; aggregation math.

**Effort.** S–M. **Depends-on.** F9 for `session_stats` (count_tokens standalone).
**DoD.** Agent can estimate tokens and read running savings.

---

### F8 — Incremental, idempotent refresh + content-hash cache + git hook

**Goal.** Re-analyze only what changed; emit tiny delta packs; make `.facts/` a
clean, committable, merge-safe artifact; auto-refresh on commit.

**Surface.** Fast re-analyze; incremental `.pack` deltas; `factstack hook install`;
a git merge driver for `agent.pack`.

**Core/emit changes.**
- **Content-hash cache (Node-only, `packages/emit/`, honors INV1/INV7).** The
  per-file `contentHash` (djb2) already exists in `extractors/src/parse.ts`. Add
  a `node:sqlite`-backed store (the workspace already moved to `node:sqlite`;
  this was the deferred "v0.3 SQLite cache") keyed by `contentHash` → cached
  per-file extraction. On analyze, skip files whose hash is unchanged. Browser
  build: no-op cache (full analyze), per INV7.
- **Idempotent graph update.** Every node/edge/symbol already (post-F2) has a
  stable id. Model refresh as upsert-by-id + delete-missing. Emit deltas using
  the existing `IncrementalTable` (`+`/`x`) support in `factspack` —
  `encodeIncremental` already exists in the types; wire a `writeIncrementalPack`
  path in `emit`.
- **Dedup.** Stable ids make AST-decl vs ref-resolved duplicates collapse
  naturally (merge by id at build time).

**Git integration (`apps/cli`).**
- `factstack hook install` writes a `post-commit` hook running
  `factstack analyze --incremental` (no network ⇒ C1-safe), embedding the
  resolved interpreter path so it fires under GUI/CI gits.
- A git **merge driver** for `*.pack` / `.facts/graph.json` that union-merges by
  id so parallel commits never leave conflict markers. Register via
  `.gitattributes` + an install step.

**Spec/format.** Document the stable-id scheme (shared with F2). No `agent.json`
shape change required.

**Determinism/purity.** The pure analyzer is unchanged; caching/hooks are
adapter-side. Incremental output for an unchanged file set must equal a full
re-analyze (test this).

**Edge cases.** Hash collision (djb2) → acceptably rare; offer `--no-cache` and
a `--force` full rebuild. Deleted files → `x` rows. Cache schema migration →
version the cache table; nuke-and-rebuild on mismatch.

**Tests.** Incremental == full for same inputs; delta pack applies to a baseline
to reproduce full state (round-trip); merge driver union test.

**Effort.** M–L. **Depends-on.** F2 (stable ids). **DoD.** Touching one file
re-analyzes ~that file; a delta pack reproduces full state; commit auto-refreshes.

---

### F9 — Session + cross-session memory (extend the learnings log)

**Goal.** Remember what happened across turns and sessions, and re-inject durable
context — reusing the existing append-only learnings store, not a new system.

**Surface.** New event kinds in `.facts/learnings.jsonl`; a `context-store` view
(decisions/tasks/open-questions) surfaced in `MEMORY.md` and `get_context`.

**Core changes** (`packages/core/src/learnings.ts`).
- The log already models `{agent, action, outcome, confidence, filesAffected,
  meta, …}` with pure `formatLearningEvent`/`parseLearningsJsonl`/`queryLearnings`.
  Add two `action`/`outcome` conventions (no schema break — `meta` is free-form):
  - **session-action** events: `served`/`read`/`edited`/`queried` with entity ids
    + token counts (feeds F4 re-ranking and F7 `session_stats`).
  - **decision/fact/task** events: durable context an agent or human records;
    `outcome:'pending'` for open tasks.
- Add a pure `buildContextStore(events): { decisions, tasks, openQuestions }`
  aggregator (most-recent-wins per key).

**MEMORY.md / get_context.** Append a capped "Working context" section (open
tasks + recent decisions) when present; `get_context` re-ranks by recent
session-action entities.

**MCP/CLI.** `log_learning`/`query_learnings` already exist — extend their schemas
to accept the new conventions. Optional `factstack context-store` CLI to print
the aggregate.

**Determinism/purity.** Aggregator pure. The log write stays Node-side
(`appendFileSync`), as today.

**Edge cases.** Log truncation/corruption already tolerated
(`parseLearningsJsonl` skips bad lines). Cap the working-context section size.

**Tests.** Aggregator (latest-wins, pending tasks surface); MEMORY section cap;
re-rank uses recent actions.

**Effort.** S–M. **Depends-on.** F4 (consumer). **DoD.** A recorded decision
shows up in next session's MEMORY/get_context.

---

### F10 — Rationale ("the why") as linked facts

**Goal.** Capture design rationale (`NOTE`/`WHY`/`HACK` comments, docstrings, doc
references) as facts linked to the code they explain, so retrieval can surface
intent, not just structure.

**Surface.** Rationale attached to symbols/files in the outline, MEMORY, and
`get_context`.

**Spec/analyzer changes.** `Todo` already captures `NOTE/HACK/XXX/FIXME` with
line (`agent.ts`/`scanners/src/todos.ts`); `Symbol.docstring` already exists. Add
a pure linker (`packages/core/src/rationale.ts`) that attaches each rationale item
to the nearest enclosing symbol id (F2) by line span, plus links docs (already in
`agent.docs[]`) to code by name/path match → `rationale` edges (`explains`).

**FactsPack.** A `rationale` table (`id`, `S`(symbol), `kind`, `text`, `F`, `line`).

**Determinism/purity.** Pure; line-span containment; stable order.

**Edge cases.** Rationale not inside any symbol → attach to file node. Long text →
cap length.

**Tests.** Containment linkage; doc-to-code match; caps.

**Effort.** S. **Depends-on.** F2 (symbol ids; works at file level without).
**DoD.** "why is X like this" retrieval returns the NOTE/docstring near X.

---

### F11 — Whole-stack modalities (SQL schema, IaC, docs-as-nodes)

**Goal.** One graph spanning app code + data layer + infrastructure.

**Surface.** Tables/views/resources appear as graph nodes; docs link to code.

**Analyzer changes** (new `packages/scanners/` or `extractors/` modules, pure):
- **SQL**: parse `.sql` for tables/views/foreign-keys/joins → entity nodes +
  relationship edges.
- **IaC**: parse Terraform/HCL (`.tf`) resources + references → resource nodes +
  dependency edges.
- **Docs-as-nodes**: `agent.docs[]` already parsed; add edges from a doc to the
  symbols/files it names (reuse F10's matcher).

**Spec changes.** Extend the graph with an additive `entities` set (or new node
kinds `table`/`view`/`resource`/`doc` on a parallel array) — keep `nodes`/`edges`
backward-compatible.

**Determinism/purity.** Pure parsers; deterministic ids (`db:schema.table`,
`tf:type.name`).

**Edge cases.** Dialect variance (Postgres vs MySQL) → start with ANSI subset,
mark unparsed as `ambiguous`.

**Tests.** SQL/HCL fixtures; cross-modality edges.

**Effort.** M per modality (phase independently). **Depends-on.** F1 (confidence),
F6 framework helps. **DoD.** A repo with `.sql` + `.tf` yields a connected
app+data+infra graph.

---

### F12 — Distribution: skill, installer, query-first nudges

**Goal.** One command wires FACTS into a coding agent: instruction files + MCP
config + (where supported) a pre-tool hook nudging graph-first lookups.

**Surface.** `factstack install [--agent <name>] [--project]`; expanded renderer
set; a one-line bootstrap.

**Changes** (`packages/skills/` + `apps/cli/`).
- The renderer pipeline already exists: `agentToSkillSpec` + `buildSkillsTo` with
  `claude`/`cursor`/`copilot`/`agents` renderers, typed against
  `ShippedMcpToolName`. Add renderers for more targets; add a Node-side installer
  (`apps/cli`) that writes the rendered files into the target agent's config dir
  and registers the MCP server (stdio) in its config, with `--project` vs
  user-scope like the existing pattern.
- **Query-first hook**: where a host supports pre-tool hooks, install a hook that,
  before raw file-search/read, suggests the FACTS `query`/`get_context` path.
  Where it doesn't, the always-on instruction file carries the same guidance
  (already the renderers' job).
- Self-update check on CLI start.

**Determinism/purity.** Rendering is pure (`skills` is isomorphic); writing is
Node-side.

**Edge cases.** Unknown agent → list supported; idempotent re-install; uninstall
path.

**Tests.** Renderer snapshots; installer writes to a `MemoryFileWriter`.

**Effort.** M. **Depends-on.** F3/F4 (so the nudge points at real tools).
**DoD.** `factstack install --agent claude` makes an agent graph-first with zero
manual config.

---

### F13 — Reproducible benchmark harness

**Goal.** Prove, reproducibly, that FACTS reduces tokens/turns-to-answer vs raw
file exploration.

**Surface.** `factstack bench [--corpus dir]` → a report (tokens, turns,
correctness) with committed fixtures.

**Changes** (`apps/cli` + a `bench/` fixture dir). A fixed task set over a sample
repo; for each task measure tokens to assemble context via `get_context` (F4) vs
a baseline (raw reads of the files a naive search would open), using
`estimateTokens` (F7). Commit inputs + expected outputs so anyone reproduces the
numbers.

**Determinism/purity.** The measured pipeline is deterministic; the harness reads
fixtures, no network.

**Effort.** M. **Depends-on.** F4, F7. **DoD.** `factstack bench` emits a
committed, reproducible savings report.

---

### F14 — Graph export (optional)

**Goal.** Let power users take the FACTS graph into external graph tooling.

**Surface.** `factstack export --graph <graphml|json-graph>` (+ optional
property-graph-DB dump).

**Changes.** Pure serializers in `packages/emit/pure` (`graphml.ts`,
`json-graph.ts`) over `AgentArtifact.graph` (+ symbol graph). Node-side write via
the existing `writeArtifactsTo` orchestrator.

**Determinism/purity.** Pure serialization; stable ordering.

**Effort.** S–M. **Depends-on.** F2. **DoD.** Exported graph round-trips node/edge
counts.

---

## 3. Phasing & sequencing

Implement in **phase order**, not numeric order. Each phase is shippable.

- **Phase A — Graph depth.** **F1** (confidence) → **F2** (symbol graph) → **F5**
  (importance/communities/impact). Outcome: a provenance-tagged, ranked,
  symbol-level graph. Highest leverage; unblocks everything.
- **Phase B — Ask anything.** **F3** (query engine + free-text) → **F10**
  (rationale) → **F7** (token tools). Outcome: arbitrary structural + intent
  queries with citations, and live token visibility.
- **Phase C — Context on demand.** **F4** (`get_context`) → **F9** (session /
  cross-session memory). Outcome: budgeted, ranked, connected context packs that
  improve across a session.
- **Phase D — Always fresh, everywhere.** **F8** (incremental + hooks) → **F12**
  (distribution) → **F13** (benchmark). Outcome: fast refresh, one-command
  adoption, reproducible proof.
- **Phase E — Breadth.** **F6** (multi-language) → **F11** (SQL/IaC/docs) → **F14**
  (export). Outcome: whole-stack, multi-language coverage. Parallelizable with
  D once A/B land.

Dependency summary: `F1→F2→{F5,F3,F8,F6,F11,F14}`; `F3→{F4,F12}`;
`{F2,F3,F5,F7}→F4→{F9,F13}`; `F7→F13`.

---

## 4. Cross-cutting concerns

- **Schema migration.** Bump FactsPack `agent-v1 → agent-v2` once for Phase A
  (new `conf` column + `symbols`/`calls`/`nodeMetrics` tables) rather than
  per-feature, to avoid churning consumers. Keep `agent.json`
  `FACTS_SCHEMA_VERSION` at `0.1.0` (all changes additive/optional). Update the
  8-line decoder preamble doc and the `schema-export.ts` JSON-schema dump in the
  same commit (the `CONTEXT.md` living-docs rule).
- **Determinism budget.** Every numeric algorithm (PageRank, label propagation,
  ranking) is iteration-fixed and tie-stable. Add a shared "run twice, assert
  identical" determinism test helper and apply it to F5/F4 outputs.
- **MEMORY.md size budget.** New sections (Modules, Working context, Confidence
  summary) must stay within the 2–10 KB cap — add per-section caps mirroring the
  existing `TRUNCATE_*` constants.
- **Performance.** Build adjacency/symbol indexes once per analyze and pass them
  down (the `importsOf` map pattern). Cap fan-out on ambiguous resolution and
  large subgraphs; always emit a truncation marker (never a silent cap).
- **Browser parity.** Node-only pieces (SQLite cache, git hooks, installer) must
  no-op cleanly under `fs-browser`/the scanner worker. Pure features (F1–F5, F10)
  run identically in both.
- **Rollout.** Gate symbol-graph emission behind a flag until F2 stabilizes
  (`analyze --symbols`), then default it on. Same for `get_context`.

---

## 5. Open questions (decide at implementation time)

1. **Symbol id format** — `path#name@line` vs a content-addressed id. Line-based
   is human-readable and diff-friendly but shifts on edits; content-addressed is
   stable but opaque. Leaning line-based for citations; revisit if F8 deltas churn
   too much.
2. **Community algorithm** — deterministic label propagation (simple, fast, INV2-
   safe) vs a seeded greedy-modularity variant (better quality, more code).
   Start with label propagation; upgrade if module quality is poor.
3. **Free-text resolution depth** — how hard FACTS tries to match an entity before
   returning "did you mean". Keep it deterministic and shallow (INV3); push real
   NL to the agent.
4. **`agent-v2` timing** — one combined bump for Phase A (preferred) vs staged.
   Combined reduces consumer churn.
5. **Per-symbol token estimate** — exact tokenization of each symbol's span vs a
   line-proportional estimate from the file's `tokenCost`. Start proportional.

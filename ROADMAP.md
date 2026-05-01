# FACTS — Roadmap

> Working source of truth for what's shipped, what's queued, and how
> each item gets built. The original product plan lives in
> [`app_plan_spec.md`](./app_plan_spec.md) — this file is the operational
> companion: phases, sequences, first-PRs, definitions-of-done.

**Last updated**: 2026-05-01 (after `67e3b48` GitHub source + Supabase persistence; revised by [`plan.md`](./plan.md) feasibility analysis)

---

## Current state

### Shipped (v0.0 → v0.2.1, 9 commits on `master`)

| Surface | Commit | What landed |
|---|---|---|
| `v0.1` analyzer pipeline + CLI | `27e3da5` | Walker + extractors + scanners + emit + agent.json/human.json. CLI at `apps/cli`. |
| `v0.2` symbols + MCP + watch + diff + query + Library + About | `7c77d36` | Caller index, MCP server, `factstack watch/diff/query`, 10 UI tabs. |
| Reviewer-pass polish (P2 + nits) | `78e6c9c` | Astro reclassification, README abbreviation handling, sr-only h2, etc. |
| Netlify static deploy | `2d2ead2` | Live at https://factstack-demo.netlify.app |
| Static-mode detection | `761a727` | Hide Re-analyze on hosted demo, friendly alert. |
| Toolbar reorder (chip → Open → Scan) | `6771dcf` | Always-visible Scan button. |
| Modal scan flow | `051bb83` | Directory display + tips + live progress bar. |
| Rootness fix + smoke test | `4c73b31` | Open button now works on real projects. |
| Imports/Files/Routes/Tests fixes | `9374ef9` | Library imports list populated, Files folder breakdown, client routes, new Tests tab. |
| Test coverage — 26 → 230 tests | `7c98417` | All packages have vitest + coverage; smoke tests guard against regression. |
| Master roadmap consolidated | `98cddb5` | This file: v0.3-v0.6 phases with PRs + sequencing. |
| GitHub source + Supabase persistence | `67e3b48` | Toolbar GitHub button → zipball fetch → JSZip → synthetic FSDH → existing scanHandle. Cache-first deep links via Supabase storage bucket. New `smoke-scan-github.mjs` test. |

### Live

- **CLI**: `factstack analyze`, `factstack ui`, `factstack watch`, `factstack diff`, `factstack query`, `factstack export`, `factstack doctor`
- **MCP server**: 5 tools (`analyze`, `query_graph`, `get_outline`, `list_risks`, `reanalyze_file`) over stdio
- **Static demo**: https://factstack-demo.netlify.app (FACTS analyzing itself)
- **Tests**: 230 (vitest) + 2 prototype smokes; 71-93% coverage per package

---

## Architectural commitments (lock these in before v0.3)

Every later phase assumes these. Violate any one and the bug-to-PR loop won't close.

1. **All AI-touched data is tagged + sourced.** Every dashboard claim ties back to evidence in `agent.json`. No invented prose anywhere in the pipeline. (Already true; keep it true.)
2. **MCP is the only public surface for agents.** Add no HTTP APIs that bypass MCP. Tools + resources only. Keeps the agent-agnostic story clean.
3. **Tickets are files, not a database.** `.facts/tickets/*.json` lives in git. Diff-able, auditable, no cloud lock-in.
4. **Trust is per-fix, not per-agent.** Confidence scoring lives on the proposal, not on the agent identity.
5. **Postmortem learning is mandatory from day one.** `.facts/learnings.jsonl` logs every AI proposal + human decision, even before bug-to-PR exists. By the time the loop is real, you have months of calibration data.

---

## v0.3 — Memory layer (next 30 days)

**Goal**: AI agents joining the project have persistent context across sessions and a 5KB summary instead of a 200KB cold-read.

### v0.3.1 — `.facts/MEMORY.md` auto-generated brain

**What it is**: a markdown file FACTS keeps in sync with the codebase. Every agent reads it FIRST when joining. Sections: project tagline, architecture (tier breakdown), conventions, recent decisions (PR-derived), known patterns to follow, anti-patterns to avoid.

**Files to add/modify**:
```
packages/core/src/memory.ts          (NEW — generates the markdown)
packages/core/src/index.ts           (call memory generator at end of analyze())
apps/cli/src/cli.ts                  (NEW subcommand: `factstack memory init` / `regen`)
apps/mcp-server/src/server.ts        (NEW MCP tool: read_memory())
packages/core/test/memory.test.ts    (NEW — pure-function tests)
```

**Definition of done**:
- Running `factstack analyze .` regenerates `.facts/MEMORY.md`
- File is git-trackable (consumers can review changes)
- MCP tool `read_memory()` returns the file's content
- Smoke test: open MEMORY.md after fr-school-ai analyze, read first 30 lines, assert it contains the project name + framework list + at least one detected convention

**First PR**: `feat(memory): .facts/MEMORY.md generator + MCP read_memory tool`

**Estimated**: 3 days

---

### v0.3.2 — `since(timestamp)` MCP tool

**What it is**: returns added / modified / removed files + new declarations + new routes + new risks since a given ISO timestamp. Lets long-running agents recover state in 5KB instead of re-reading 200KB.

**Files**:
```
packages/core/src/since.ts           (NEW — diff against snapshot or previous artifact)
apps/mcp-server/src/server.ts        (NEW MCP tool: since(timestamp))
packages/core/test/since.test.ts     (NEW — multiple-snapshot fixtures)
```

**Definition of done**:
- MCP `since('2026-04-30T00:00:00Z')` returns structured diff
- Re-analyzes are fast (uses existing snapshot store)
- 5+ tests for: nothing changed, file added, file removed, declaration added, route added, risk added

**First PR**: `feat(mcp): since(timestamp) tool for cross-session state recovery`

**Estimated**: 2 days

---

### v0.3.3 — Stable agent identity + session log

**What it is**: `.facts/agents/<agent-id>.json` per-agent file tracking: lastSeen, filesRead, openTopics, decisions made, decisions accepted by humans. Foundation for the trust framework.

**Files**:
```
packages/core/src/agents.ts          (NEW — read/write agent session files)
apps/mcp-server/src/server.ts        (NEW: register_agent, log_decision tools)
packages/core/test/agents.test.ts
```

**Definition of done**:
- MCP tools: `register_agent({ id, name, model })`, `log_decision({ ticketId, action, reasoning })`, `resume_session(agentId)`
- Files diff-able in git (humans can audit AI activity)
- Privacy: NEVER includes file contents — only paths + metadata

**First PR**: `feat(memory): persistent agent identity + session log`

**Estimated**: 3 days

---

### v0.3.4 — Postmortem learning loop (`learnings.jsonl`)

**What it is**: append-only log of every AI proposal and its outcome. Calibration data for the trust framework that the bug-to-PR pipeline will need at v0.6.

**Files**:
```
packages/core/src/learnings.ts       (NEW — append + query helpers)
apps/mcp-server/src/server.ts        (NEW MCP tool: log_learning, query_learnings)
packages/core/test/learnings.test.ts
```

**Definition of done**:
- JSONL format (one event per line, append-only)
- Schema validated
- `query_learnings({ since, agent, outcome })` returns filtered events
- Even if no other agent uses it, FACTS itself logs every analyze + reanalyze (for self-calibration)

**First PR**: `feat(memory): learnings.jsonl postmortem log`

**Estimated**: 2 days

---

### v0.3.5 — Symbol-level call graph (substrate for v0.4 power tools)

**What it is**: extend the AST walk to record `defs` (where each symbol is declared) and `refs` (where each symbol is read or called) per file. Indexed by stable symbol id (`<package>:<file>#<name>`). The file→file import graph stays; this adds the symbol→symbol layer underneath. ([`plan.md`](./plan.md) candidate **C1**.)

**Why now**: this is the substrate that makes `impact_of` / `find_examples` / `unused` cheap. Every later phase compounds on it. Without it, v0.5 power tools cost 2-3x as much to build and return weaker answers.

**Files**:
```
packages/extractors/src/symbols.ts      (extend — emit refs alongside defs)
packages/extractors/src/symbols-refs.ts (NEW — identifier walk that records call sites)
packages/graph/src/symbol-graph.ts      (NEW — symbol→symbol index)
packages/spec/src/agent.ts              (extend FileOutline with `refs[]`; new top-level `symbolGraph`)
packages/extractors/test/symbols-refs.test.ts
packages/graph/test/symbol-graph.test.ts
```

**Definition of done**:
- Every declaration tracked has a `refs[]` array with `{file, line, kind: 'call' | 'read' | 'type-ref'}`
- Symbol resolution handles named imports + default imports + re-exports
- Confidence flag per ref (`exact` for resolved imports, `heuristic` for string-name matches in dynamic contexts)
- `agent.json` size delta measured against `examples/react-fastapi-booking` and the FACTS-self analysis; must stay under the 5 MB cap (chunk if needed)
- Backward-compat: missing `symbolGraph` field in older artifacts → renderers fall back to file-level imports as today

**First PR**: `feat(graph): symbol-level call graph (refs + defs index)`

**Estimated**: 5 days

---

### v0.3.6 — Config + env-var schema extraction

**What it is**: detect every `process.env.X`, `os.getenv("X")`, `import.meta.env.X`, and Zod/Pydantic config schema in the codebase. Emit a deduplicated list with read sites + inferred schema where possible. ([`plan.md`](./plan.md) candidate **C5** — composite +6, highest in its group.)

**Why now**: highest-composite-score CXO signal in the inventory. *"This app needs 12 env vars; here they are."* Onboarding gold; reviewer gold; investor gold.

**Files**:
```
packages/extractors/src/config-schema.ts (NEW — env-var + Zod/Pydantic detector)
packages/spec/src/agent.ts               (NEW top-level `config: { envVars: EnvVar[], schemas: ConfigSchema[] }`)
prototype/index.html                     (Config tab gets a "Required env vars" panel)
apps/mcp-server/src/server.ts            (NEW MCP tool: get_config)
packages/extractors/test/config-schema.test.ts
```

**Definition of done**:
- Env-var entry: `{ name, readSites: [{ file, line }], defaultValue?: string, schema?: 'zod' | 'pydantic' | null }`
- Zod / Pydantic config objects extracted as JSON Schema where shape is statically inferable
- Config tab renders the table sorted by read-site count (most-used first)
- MCP `get_config()` returns the same data
- 6+ tests including: bare `process.env.FOO`, destructured, with default, in Zod object, in Pydantic BaseSettings

**First PR**: `feat(extractors): env-var + config-schema extraction`

**Estimated**: 2 days

---

### v0.3.7 — Test → subject coverage heuristic

**What it is**: heuristic test-coverage map. For each test file, infer which non-test files (and ideally which symbols once C1 lands) it exercises, by walking the import graph from the test root. ([`plan.md`](./plan.md) candidate **C7** — composite +6.)

**Why now**: enables the "if I change X, run these tests" answer that agents need before proposing refactors. Cheap heuristic version is fine — false positives are tolerable here because the failure mode is *running too many tests*, not *missing failures*.

**Files**:
```
packages/graph/src/test-coverage.ts     (NEW — walks import graph from test files)
packages/spec/src/agent.ts              (NEW top-level `testCoverage: { [subject]: testFile[] }`)
prototype/index.html                    (Tests tab: per-test "covers N files" + per-file "tested by")
apps/mcp-server/src/server.ts           (NEW MCP tool: tests_for(filePath))
packages/graph/test/test-coverage.test.ts
```

**Definition of done**:
- Documented heuristic with measured precision/recall against `examples/react-fastapi-booking` (target ≥70% precision, recall is bonus)
- Confidence per pairing (`direct-import` = high, `transitive-import-depth-2` = medium, etc.)
- Tests tab shows new "Tested by" column when a file is selected
- MCP `tests_for("src/auth/login.ts")` returns the test files that exercise it
- Documented limitations: dynamic test loading, indirect mocks, snapshot-only tests

**First PR**: `feat(graph): test→subject coverage heuristic`

**Estimated**: 2 days

---

### v0.3.8 — Reading-time + owner inference + plain-English risk (CXO trust bundle)

**What it is**: three small CXO-facing items shipped as a single bundle PR because they share UI surface and all build on existing data. ([`plan.md`](./plan.md) candidates **C20 + C28 + C24**.)

- **Reading-time** per folder: `loc / 25 + complexity_bonus` minutes. Surfaces in tree node tooltips and the Folder Breakdown panel.
- **Owner inference**: per-file top-3 contributors with last-touched date. Already have git history extraction; just summarize. Replaces a `CODEOWNERS` file you never wrote.
- **Plain-English risk**: rewrite each rule's `message` field to be CXO-readable. Not "47 high-severity SCA findings" but *"3 packages haven't shipped in 2+ years; 1 maintainer's account is deleted."* Deterministic — just a rule message rewrite, no LLM.

**Why now**: cheapest CXO trust signals in the entire feasibility doc (3 items, ~2.5 days total) and they touch existing UI surfaces with no new tabs.

**Files**:
```
packages/core/src/reading-time.ts        (NEW — pure fn: loc + complexity → minutes)
packages/core/src/owner-inference.ts     (NEW — git stats → top-3 + last-touched)
packages/scanners/src/risks-rewrite.ts   (NEW — rule-id → human-readable message map)
packages/spec/src/agent.ts               (extend FileOutline with `readingMinutes`, `topContributors`)
prototype/index.html                     (tree tooltips + folder breakdown + risks rewrite)
packages/core/test/reading-time.test.ts
packages/core/test/owner-inference.test.ts
packages/scanners/test/risks-rewrite.test.ts
```

**Definition of done**:
- Folder breakdown shows reading-time (e.g., "~12 min cold")
- Hovering a tree row shows top-3 contributors + days-since-last-touched
- Every existing risk rule has a human-readable message variant; old technical text retained as `messageTechnical`
- 100% deterministic; no behavior change for files without git history

**First PR**: `feat(human): reading-time + owners + plain-English risks`

**Estimated**: 2.5 days

---

**v0.3 total**: ~17 days (was 10 days; expanded by 7 days of cheap, deterministic substrate + CXO trust signals per [`plan.md`](./plan.md)).

---

## v0.4 — Architecture, vulnerabilities, staleness (next 60 days)

**Goal**: turn FACTS into a tool you ship to investors AND that AI agents respect as the source of truth.

### v0.4.1 — Category + tier + role taxonomy

The 3-level classification work designed in the strategic conversation. Every file gets `category` (app/manifest/lockfile/etc), `tier` (frontend/backend/etc), `role` (page/route/middleware/etc).

**Files**:
```
packages/core/src/categorize.ts      (NEW ~150 lines — top-level category)
packages/core/src/tier.ts            (NEW ~200 lines — frontend/backend/etc detection)
packages/core/src/role.ts            (NEW ~150 lines — extract Library tab role logic)
packages/spec/src/agent.ts           (extend FileOutline schema with category/tier/role)
prototype/index.html                 (Architecture tab + tier filters in Graph/DAG)
packages/core/test/categorize.test.ts
packages/core/test/tier.test.ts
packages/core/test/role.test.ts
```

**Definition of done**:
- Every file in `agent.json` has a category + tier
- Stratified stats in Overview ("89 app · 34 tests · 18 docs · 12 config")
- New global tab "Architecture" with tier-block diagram
- Tier filters in Graph + DAG views ("Frontend only", "Cross-tier edges", etc)
- Backward-compat: old artifacts get `category: 'app', tier: null` defaults

**First PR**: `feat(taxonomy): category + tier + role classification`

**Estimated**: 7 days

---

### v0.4.2 — Architecture document generator

**What it is**: `factstack docs` emits `ARCHITECTURE.md` from analyzer data. Pure-data mode for v0.4 (no LLM). Every claim is traceable.

**Files**:
```
packages/emit/src/docs.ts            (NEW — markdown generator)
apps/cli/src/cli.ts                  (NEW subcommand: `factstack docs`)
apps/mcp-server/src/server.ts        (NEW MCP tool: read_docs())
packages/emit/test/docs.test.ts
```

**Definition of done**:
- `factstack docs` writes ARCHITECTURE.md to project root
- Sections: At a Glance, Tiers, Public API surface, Routes, Conventions, Risks
- Marked `<!-- AUTO-GENERATED · regenerate with `factstack docs` -->`
- Idempotent: same input → same output (bit-for-bit)
- Suitable for committing to repo (CXOs forward to investors)

**First PR**: `feat(docs): ARCHITECTURE.md auto-generator (pure-data mode)`

**Estimated**: 4 days

---

### v0.4.3 — Supply-chain vulnerability scanner

**What it is**: hits npm registry + OSV.dev API for each dep. Surfaces CVEs, age, maintainer count.

**Files**:
```
packages/scanners/src/dependencies.ts   (NEW — registry + OSV API client)
packages/scanners/src/index.ts          (export new scanner)
packages/core/src/index.ts              (call dependency scanner during analyze)
prototype/index.html                    (NEW Supply Chain tab)
apps/mcp-server/src/server.ts           (NEW MCP tool: dependency_risks())
packages/scanners/test/dependencies.test.ts (with mocked HTTP)
```

**Definition of done**:
- Per-dep: CVEs, last-release age, maintainer count, weekly downloads
- New Supply Chain tab with severity-grouped rows
- New risks of category `supply-chain` in `agent.risks`
- Cached responses in `.facts/cache/deps/<name>-<version>.json` (24h TTL)
- Offline mode: if no network, use cache or skip silently (don't break analyze)

**First PR**: `feat(scanners): npm + OSV.dev supply-chain risk scanner`

**Estimated**: 6 days

**Folds in C18 `why_dependency` ([`plan.md`](./plan.md))**: the same registry data backs the new MCP tool `why_dependency(pkg)`. Returns: which workspace files import it (direct), which transitive deps pull it in, and a "could you drop it?" answer when no direct importers exist. +1 day on top of the 6-day base.

---

### v0.4.4 — Code-pattern vulnerability scanner (taint flow)

**What it is**: trace user input from sources to sinks. Flags SSRF / SQL-injection / XSS shapes.

**Files**:
```
packages/scanners/src/taint.ts          (NEW — AST walker with source/sink rules)
packages/spec/src/agent.ts              (add 'taint-flow' to risk category enum)
packages/scanners/test/taint.test.ts
```

**Definition of done**:
- Sources detected: req.body, req.query, searchParams, form.value, localStorage
- Sinks detected: exec, spawn, query (string-concat), innerHTML, eval, fetch with user URL, redirect with user URL
- Each unsanitized flow → risk with severity HIGH
- 8+ test cases (each common vuln shape)
- AST walk uses existing `parseJS` infrastructure

**First PR**: `feat(scanners): taint-flow code vulnerability detection`

**Estimated**: 5 days

---

### v0.4.5 — Staleness scanner (AI authorship + pattern drift)

**What it is**: track AI-author trailers in commits + detect convention drift.

**Files**:
```
packages/scanners/src/staleness.ts      (NEW — git blame + pattern comparison)
packages/fs-node/src/git.ts             (extend mineGitStats with AI-author detection)
prototype/index.html                    (Staleness section in Risks tab)
apps/mcp-server/src/server.ts           (NEW MCP tool: staleness_report())
packages/scanners/test/staleness.test.ts
```

**Definition of done**:
- Per-file `aiTouchedAt` + `humanTouchedAt` from git history (uses `AI-Author:` commit trailer convention)
- Pattern drift: detects React class components when project is mostly hooks, var when const elsewhere, etc
- New risks of category `staleness` with severity LOW (informational)
- Files with high drift (>14 days AI-touched without human review) get severity MEDIUM

**First PR**: `feat(scanners): AI authorship + pattern-drift staleness detector`

**Estimated**: 5 days

**Folds in C16 `drift(symbol)` ([`plan.md`](./plan.md))**: same staleness data, sliced at the symbol level. New MCP tool `drift(symbol)` returns: when the implementation last changed vs when its tests last changed, and the divergence in days. +1 day on top of the 5-day base.

---

### v0.4.6 — Public/private API surface + `unused` + dead-code visualization

**What it is**: classify every export as `public` (≥1 referrer in the rest of the workspace) or `private` (zero non-test referrers). Surface `unused()` MCP tool + dead-code map in the UI. ([`plan.md`](./plan.md) candidates **C4 + C15 + C27** — composite +5 each, all unblocked by v0.3.5 symbol graph.)

**Why**: deletable code is a CXO-readable signal of project hygiene. `unused()` is the "what can I safely delete?" query agents currently brute-force with grep + manual inspection.

**Files**:
```
packages/graph/src/api-surface.ts        (NEW — classifies exports as public/private)
packages/spec/src/agent.ts               (extend exports with `visibility: 'public' | 'private'`)
apps/mcp-server/src/server.ts            (NEW MCP tool: unused(scope?))
prototype/index.html                     (Library tab: gray out private exports; new Dead Code map under Files breakdown)
packages/graph/test/api-surface.test.ts
```

**Definition of done**:
- Visibility correct for: named exports, default exports, re-exports
- "Test files" + entry points correctly excluded as referrers (so test-only exports → `private` is intentional)
- `unused('src/lib/')` returns scoped list
- UI: hovering a private export shows "no callers in workspace"
- Folder breakdown shows "X% reachable from entry points"

**First PR**: `feat(graph): public/private API surface + unused MCP tool`

**Estimated**: 3 days

---

### v0.4.7 — `impact_of` MCP tool (PROMOTED from v0.5.1 per [`plan.md`](./plan.md))

**What it is**: original v0.5.1 spec, promoted to v0.4 because v0.3.5 symbol graph makes it cheap.

**Promotion rationale**: with C1 in place, the implementation cost drops from 6 days to 2-3 days (we read the symbol graph instead of building one). Demo value for "agents you can trust" is highest of any tool in the inventory.

**Files**:
```
packages/core/src/impact.ts             (uses graph + symbols + callers from v0.3.5)
apps/mcp-server/src/server.ts           (NEW MCP tool: impact_of)
packages/core/test/impact.test.ts
```

**Definition of done**:
- Supports change kinds: rename / delete_symbol / change_signature / move_file / extract_function
- Returns: definite changes (definition site), likely (call sites), ambiguous (string matches)
- **Confidence flag per result** (per the [`plan.md`](./plan.md) risk note: gate `impact_of` on "high confidence only" by default; surface "I don't know" instead of wrong answers)
- Tier-stratified output (frontend / backend / shared / tests) — depends on v0.4.1
- Suggested PR split for high-blast changes

**First PR**: `feat(mcp): impact_of tool — blast radius (promoted from v0.5)`

**Estimated**: 3 days (was 6 in v0.5)

---

### v0.4.8 — `find_examples` MCP tool (PROMOTED from v0.5.2 per [`plan.md`](./plan.md))

**What it is**: ranked usage sites of an API across the repo. The highest-frequency "show me how this is used" agent need.

**Promotion rationale**: same as v0.4.7. With v0.3.5 symbol graph, this is a sorted lookup, not a fresh graph build. Folds **C36 live exemplar mining** (which was just "find_examples with rendering").

**Files**:
```
packages/core/src/examples.ts           (NEW — symbol → ranked usage list)
apps/mcp-server/src/server.ts           (NEW MCP tool: find_examples(api, n=5))
prototype/index.html                    (when a symbol is selected: "How it's used" inline panel)
packages/core/test/examples.test.ts
```

**Definition of done**:
- Returns top-N usage sites ranked by: recency, diversity (different files/symbols), and concision (shorter call sites first)
- UI inline panel shows the call site with 3 lines of context
- Heuristic ranking documented; no LLM in the loop
- 6+ tests for various API shapes (function, class, hook, default export)

**First PR**: `feat(mcp): find_examples tool + inline call-site renderer`

**Estimated**: 2 days (was 4 in v0.5)

---

### v0.4.9 — `risk_explain` MCP tool + plain-English risk extension

**What it is**: takes a `(rule_id, file)` pair and returns: what the rule means, why it fires here specifically, what to fix, and (when v0.5.2 conventions land) the fix in *this codebase's style*. ([`plan.md`](./plan.md) candidate **C19**.)

**Files**:
```
packages/scanners/src/risk-explain.ts   (NEW — rule registry + per-rule explainer fns)
apps/mcp-server/src/server.ts           (NEW MCP tool: risk_explain(ruleId, filePath))
prototype/index.html                    (Risks tab: each row gets a "Why?" disclosure)
packages/scanners/test/risk-explain.test.ts
```

**Definition of done**:
- Every risk rule has a `summary` (one sentence), a `why` (file-context-aware paragraph), and a `fix` (concrete action)
- Deterministic; no LLM (LLM polish slot reserved for v0.5.5)
- 100% rule coverage; CI fails if a new rule lacks an explainer

**First PR**: `feat(mcp): risk_explain tool + per-rule fix guidance`

**Estimated**: 3 days

---

### v0.4.10 — Architecture lint (`rules.toml`)

**What it is**: declarative graph constraints. Express "controllers must not import models directly" or "shared/ may not import from app/" as rules in `.facts/rules.toml`; CI fails on violation. ([`plan.md`](./plan.md) candidate **C37**.)

**Why**: replaces architecture meetings with CI checks. Folds naturally into v0.4.1 taxonomy + v0.4.2 ARCHITECTURE.md (rules.toml is the machine-readable companion to the doc).

**Files**:
```
packages/core/src/arch-lint.ts          (NEW — rule loader + graph evaluator)
apps/cli/src/cli.ts                     (NEW subcommand: `factstack lint` exits non-zero on violations)
.facts/rules.toml.example               (NEW — sample rules)
packages/core/test/arch-lint.test.ts
```

**Definition of done**:
- Rule shape: `{ from: glob, to_not: glob, kind?: 'import' | 'call' }` (and `to:` allowlist variant)
- Violations include the offending edge (file → file, line) + the rule id
- Exit code 0/1; JSON output via `--json` for CI parsing
- Example file has 3 useful starter rules
- No rules.toml = silent (don't bother projects that haven't opted in)

**First PR**: `feat(arch): declarative architecture lint via rules.toml`

**Estimated**: 3 days

---

### v0.4.11 — Effect graph + call-counts per route

**What it is**: annotate functions with detected effects (`db.read`, `db.write`, `network`, `fs`, `env`, `time`). Aggregate per route to surface "this route does 3 DB reads + 1 external HTTP call." ([`plan.md`](./plan.md) candidates **C3** + the *counts half* of **C21** — dollar estimates explicitly deferred to v0.7+ per the trust-killer rationale in plan.md.)

**Why**: makes "what does this route actually do?" answerable at a glance. Counts (not dollars) are deterministic and useful both as agent context and CXO clarity.

**Files**:
```
packages/extractors/src/effects.ts      (NEW — heuristic detector for known APIs)
packages/graph/src/route-effects.ts     (NEW — aggregate per route)
packages/spec/src/agent.ts              (extend RouteDecl with `effects: { db: number, network: number, ... }`)
prototype/index.html                    (Routes tab: per-row effect chips)
packages/extractors/test/effects.test.ts
```

**Definition of done**:
- Detected APIs: pg/postgres/mysql/sqlite (db), fetch/axios/got (network), fs/fs-extra (fs), `process.env`/`os.getenv` (env), Date.now/performance.now (time)
- Routes tab shows e.g. `↓2 ↑1` for "2 DB reads, 1 DB write"
- Documented as heuristic; false-positive bound measured on `examples/`
- **Explicit non-goal**: dollar estimates. Counts only. The trust-killer rationale is captured in [`plan.md`](./plan.md) under C21.

**First PR**: `feat(graph): effect graph + per-route call counts`

**Estimated**: 5 days

---

### v0.4.12 — Stale tests panel

**What it is**: tests that haven't been edited in N months *and* whose subject (per v0.3.7 mapping) hasn't changed either *and* haven't run in CI in K runs. Often surfaces dead tests for live code OR live tests for dead code — both are signals worth acting on. ([`plan.md`](./plan.md) candidate **C29**.)

**Files**:
```
packages/scanners/src/stale-tests.ts    (NEW — combines git mtime + test-coverage map + CI metadata if present)
prototype/index.html                    (Tests tab: new "Stale" sub-tab)
packages/scanners/test/stale-tests.test.ts
```

**Definition of done**:
- Stale signals stratified: "test untouched 6+ months", "subject untouched same period", "no recent CI runs (when CI metadata available)"
- Optional: reads `.facts/ci-runs.jsonl` if present (out of scope to populate; users wire their CI)
- New panel renders 3-column table (test file, last-edited, status)

**First PR**: `feat(scanners): stale tests panel`

**Estimated**: 2 days

---

**v0.4 total**: ~33 days (was 27; expanded by 6 days for the 5 new sub-phases per [`plan.md`](./plan.md). Two of those days are recovered by promoting `impact_of`/`find_examples` here at lower cost than the v0.5 estimate, so net add is ~4 days.)

---

## v0.5 — Agent power tools + LLM-augmented docs (next 90 days)

**Goal**: ship the MCP tools that turn FACTS from a map into a navigation system for agents.

### v0.5.1 — *PROMOTED to v0.4.7* — `impact_of` MCP tool

Per [`plan.md`](./plan.md): cheaply unlocked once v0.3.5 symbol graph lands, so moved into v0.4. See **v0.4.7**.

---

### v0.5.2 — `code_conventions` tool

`code_conventions()` returns inferred naming/import/pattern rules. (`find_examples` moved to **v0.4.8** per [`plan.md`](./plan.md) — symbol graph from v0.3.5 makes the API-shaped lookup cheap; `code_conventions` is the harder, heuristic-heavy half and stays here.)

**Files**:
```
packages/core/src/conventions.ts       (NEW — sample-based pattern inference)
apps/mcp-server/src/server.ts          (NEW MCP tool: code_conventions)
packages/core/test/conventions.test.ts
```

**Definition of done**:
- `code_conventions()` returns naming + import order + tab-vs-space + return-style + error-handling pattern
- Conventions are tier-aware (frontend rules vs backend rules) — depends on v0.4.1
- Each convention rule includes 3-5 exemplar files
- Confidence flag per rule (sample size + agreement %)

**First PR**: `feat(mcp): code_conventions for in-style code generation`

**Estimated**: 4 days

---

### v0.5.3 — `suggest_location(intent)` + `query_around(focus)` tools

Where should I add this? + Just-the-neighborhood query.

**Files**:
```
packages/core/src/suggest.ts           (NEW — path-frequency + role match)
packages/core/src/neighborhood.ts      (NEW — focus + N-hop graph query)
apps/mcp-server/src/server.ts          (NEW MCP tools)
```

**Definition of done**:
- `suggest_location(intent)` returns 1-3 ranked file/dir candidates with rationale
- `query_around(focus)` returns subject + callers + callees + siblings + tests
- Both <50KB output even on large repos

**First PR**: `feat(mcp): suggest_location + query_around for AI navigation`

**Estimated**: 4 days

---

### v0.5.4 — `data_shapes()` tool

Project-defined types as plain shapes. Pulls from TS interfaces, Zod, Prisma, Pydantic.

**Files**:
```
packages/extractors/src/data-shapes.ts  (NEW — extracts type defs across formats)
apps/mcp-server/src/server.ts           (NEW MCP tool: data_shapes())
packages/extractors/test/data-shapes.test.ts
```

**Definition of done**:
- Returns flat map: typeName → { field: type } pairs
- Handles TypeScript interfaces, Zod schemas, Prisma models, basic Pydantic
- Used by agents writing queries / DTOs

**First PR**: `feat(extractors): data_shapes tool — project types as plain shapes`

**Estimated**: 5 days

---

### v0.5.5 — `trace_data(input_route, output_route)` MCP tool

**What it is**: given two endpoints (or a route + an external sink like a Stripe call), return the ordered call chain between them with effect annotations from v0.4.11. Replaces a class of multi-file investigations agents currently do via grep + read. ([`plan.md`](./plan.md) candidate **C14**.)

**Files**:
```
packages/core/src/trace-data.ts        (NEW — graph traversal between two anchors)
apps/mcp-server/src/server.ts          (NEW MCP tool: trace_data(from, to))
packages/core/test/trace-data.test.ts
```

**Definition of done**:
- Anchors can be: route paths (`POST /api/checkout`), file:symbol pairs (`src/lib/stripe.ts:createCharge`), or external API references (`stripe.charges.create`)
- Returns ordered call chain with effect at each step + confidence
- Returns "no path found" cleanly (not a wrong path)
- 5+ tests including a multi-hop trace through middleware

**First PR**: `feat(mcp): trace_data — call chain between two endpoints`

**Estimated**: 5 days

---

### v0.5.6 — Onboarding 5-stop tour (deterministic v1)

**What it is**: auto-generated 5-step tour for a new engineer (or a fresh agent): entry point → main router → 2 most-edited business modules → tests dir. Each stop has a 1-line summary. Deterministic v1; LLM polish reserved for v0.6+. ([`plan.md`](./plan.md) candidate **C22**.)

**Files**:
```
packages/core/src/tour.ts              (NEW — pick stops by churn + role + edge centrality)
prototype/index.html                   (NEW Tour tab + per-stop "next" navigation)
apps/mcp-server/src/server.ts          (NEW MCP tool: get_tour())
packages/core/test/tour.test.ts
```

**Definition of done**:
- Stop selection is deterministic given the same dataset
- Each stop: file path, role, 1-line summary (template-driven, not LLM)
- Tour is < 10 KB output
- New "Tour" tab walks visually through the stops with "Next →" navigation

**First PR**: `feat(human): onboarding tour generator (deterministic v1)`

**Estimated**: 4 days

---

### v0.5.7 — Decision archaeology (PR linking)

**What it is**: for any file, return the linked PR(s) that last touched it with title + body excerpt. Mines `git log` + GitHub API (when remote is GitHub). Cached in `.facts/cache/prs/`. ([`plan.md`](./plan.md) candidate **C23**.)

**Files**:
```
packages/scanners/src/pr-archaeology.ts (NEW — git log → PR numbers + GH API fetch)
packages/spec/src/agent.ts              (extend FileOutline with `recentPRs: PRRef[]`)
prototype/index.html                    (file outline header: "Last edited in PR #1241")
apps/mcp-server/src/server.ts           (NEW MCP tool: prs_for(filePath))
packages/scanners/test/pr-archaeology.test.ts (mocked HTTP)
```

**Definition of done**:
- Detects PR numbers from `Merge pull request #N` and squash-style `(#N)` suffix
- GitHub API client respects rate limits + uses PAT when available
- Cache: 24h TTL keyed by `(repo, prNumber)`
- Offline mode: falls back to git data only if no network
- File outline shows "Last touched in #1241 — fix race in checkout"

**First PR**: `feat(scanners): PR archaeology — file → recent PRs with titles`

**Estimated**: 5 days

---

### v0.5.8 — Copy-paste / clone detector

**What it is**: detect duplicated code blocks across the repo. Side-by-side renderer in the UI. ([`plan.md`](./plan.md) candidate **C26** — where bugs hide; CXO hook is *"you have 3 copies of billing logic, last edited at different times."*)

**Files**:
```
packages/scanners/src/clones.ts        (NEW — token-stream hashing with sliding window)
packages/spec/src/agent.ts             (NEW top-level `clones: CloneCluster[]`)
prototype/index.html                   (Risks tab: new "Clones" sub-tab with side-by-side diff)
packages/scanners/test/clones.test.ts
```

**Definition of done**:
- Detects ≥80-token blocks duplicated across ≥2 files
- Each cluster: { fingerprint, files: [{path, range}], lastEditedAt[] }
- Severity LOW (informational) by default; MEDIUM when last-edit dates diverge >30 days (= drift risk)
- Side-by-side renderer with diff highlighting
- Documented false-positive bound (boilerplate, generated code) with examples

**First PR**: `feat(scanners): copy-paste / clone detection`

**Estimated**: 6 days

---

### v0.5.9 — Semantic diff

**What it is**: function-level diffs that say *"renamed `getUser` → `fetchUser`, body unchanged"* or *"signature changed: added `opts?: Options` parameter"* instead of red/green lines. Layered on top of `factstack diff` (already shipped). ([`plan.md`](./plan.md) candidate **C32** — PR review collapse from 30 min → 5.)

**Files**:
```
packages/core/src/semantic-diff.ts     (NEW — pair declarations across snapshots; classify the change)
apps/cli/src/cli.ts                    (extend `factstack diff --semantic`)
prototype/index.html                   (History tab: per-file semantic-diff view)
packages/core/test/semantic-diff.test.ts
```

**Definition of done**:
- Change kinds detected: rename, signature change (added/removed/reordered params), body change with same signature, moved file (same content), pure reformatting
- Classification is heuristic; documented precision
- New History sub-tab "Semantic" shows the classified changes alongside the line-diff
- Backward-compat: `factstack diff` (no flag) behaves as today

**First PR**: `feat(diff): semantic diff — classify changes, not just lines`

**Estimated**: 8 days

---

### v0.5.10 — Spec drift (OpenAPI server vs client)

**What it is**: extract OpenAPI from server route handlers (TS types + Zod schemas + framework decorators) AND from client API call sites (fetch URLs + body shapes). Diff them; surface mismatches. ([`plan.md`](./plan.md) candidate **C38** — single most common silent-bug class in web apps.)

**Files**:
```
packages/extractors/src/openapi-server.ts (NEW — derive OpenAPI from route handlers)
packages/extractors/src/openapi-client.ts (NEW — derive expected shapes from call sites)
packages/scanners/src/spec-drift.ts       (NEW — diff the two specs)
prototype/index.html                      (Routes tab: drift indicator per route)
apps/mcp-server/src/server.ts             (NEW MCP tool: spec_drift())
packages/scanners/test/spec-drift.test.ts
```

**Definition of done**:
- Detects: missing fields on either side, type mismatches (string vs number), removed routes still called by client, new routes not yet called
- Confidence flag per finding (server side is usually high; client side often heuristic)
- New `spec-drift` risk category
- Routes tab shows "✓ matched", "⚠ drift", "? unknown" per route

**First PR**: `feat(scanners): OpenAPI server↔client drift detection`

**Estimated**: 10 days

---

### v0.5.11 — LLM-augmented design.md (opt-in, optional ship)

**Demoted to optional** per [`plan.md`](./plan.md): only ship if v0.5 deterministic stack lands clean. The deterministic ARCHITECTURE.md from v0.4.2 is the must-have; LLM polish is a nice-to-have, not a foundation. If v0.5 budget runs tight, drop this entirely.

The optional second mode for ARCHITECTURE.md generation: an LLM pass that drafts narrative prose, marked as AI-generated.

**Files**:
```
packages/emit/src/docs-llm.ts          (NEW — LLM client + prompt templates)
apps/cli/src/cli.ts                    (NEW: `factstack docs --llm` flag)
.facts/config.json                     (LLM provider + key configuration)
packages/emit/test/docs-llm.test.ts    (mocked LLM responses)
```

**Definition of done**:
- `factstack docs --llm` writes ARCHITECTURE.draft.md alongside ARCHITECTURE.md
- Every LLM-drafted paragraph carries `<!-- ai-draft -->` marker
- LLM context: ONLY `agent.json` + extracted symbols + framework list — never raw file contents (privacy)
- Provider-agnostic: supports Anthropic, OpenAI, OpenRouter via env vars
- Falls back to pure-data mode if no API key configured

**First PR**: `feat(docs): LLM-augmented ARCHITECTURE.draft.md (opt-in)`

**Estimated**: 7 days (optional — ship only if budget allows)

**v0.5 total (must-ship)**: ~50 days
- v0.5.2 code_conventions: 4 days
- v0.5.3 suggest_location + query_around: 4 days
- v0.5.4 data_shapes: 5 days
- v0.5.5 trace_data: 5 days
- v0.5.6 onboarding tour: 4 days
- v0.5.7 PR archaeology: 5 days
- v0.5.8 clone detector: 6 days
- v0.5.9 semantic diff: 8 days
- v0.5.10 spec drift: 10 days

**v0.5 total (with optional v0.5.11)**: ~57 days

(Was 27 days before [`plan.md`](./plan.md) re-eval. Net +23 days; the larger budget reflects 6 new sub-phases that survived feasibility scoring. Two items moved out to v0.4 — `impact_of` and `find_examples` — which is why v0.4 grew by less than v0.5 shrank-then-grew.)

---

## v0.6 — Bug-to-PR pipeline foundation (next 6 months)

**Goal**: bug enters from a user, FACTS reproduces it, proposes a fix, runs it through tests, opens a PR. Developer reviews + merges.

### v0.6.1 — Bug intake (`factstack tickets`)

**What it is**: simple file-based ticket store + intake endpoints.

**Files**:
```
packages/core/src/tickets.ts            (NEW — file-based store)
apps/cli/src/cli.ts                     (NEW commands: tickets create/list/show)
apps/mcp-server/src/server.ts           (NEW MCP tools: list_tickets, show_ticket, create_ticket)
.facts/tickets/                         (NEW directory — JSON-per-ticket)
packages/spec/src/ticket.ts             (NEW Zod schema)
packages/core/test/tickets.test.ts
```

**Ticket schema**:
```jsonc
{
  "id": "T-2026-05-01-001",
  "reportedAt": "2026-05-01T12:00:00Z",
  "reporter": "user@example.com",
  "summary": "users see 500 on /api/login",
  "details": "since this morning, login returns 500. logs show...",
  "status": "intake | reproducing | reproduced | fix-ready | in-pr | merged | rejected | wont-fix",
  "verifiedAt": null,
  "fixProposedAt": null,
  "prUrl": null,
  "humanReviewedAt": null,
  "confidenceScore": null,
  "linkedFiles": []
}
```

**Definition of done**:
- `factstack tickets create --summary "..." --details "..."`
- `.facts/tickets/T-*.json` is git-committable
- MCP can list / read / create tickets
- Status transitions are validated (no skipping intake → fix-ready directly)

**First PR**: `feat(tickets): file-based bug intake + MCP tools`

**Estimated**: 5 days

---

### v0.6.2 — Reproduction agent (the unknown)

**What it is**: given a ticket, AI localizes the surface area + writes a failing test that proves the bug.

This is THE unknown — depends on AI capability and how much sandboxing you accept.

**Files**:
```
packages/core/src/reproduce.ts          (NEW — orchestrator: ticket → test draft)
apps/cli/src/cli.ts                     (NEW: `factstack bug verify <ticket-id>`)
.facts/sandbox/                         (NEW — runs tests in isolation)
```

**Definition of done**:
- `factstack bug verify T-001` runs end-to-end
- Output: `tests/regression/T-001-*.test.ts` written + ticket status → "reproduced" if test fails as predicted
- Confidence score attached: "AI is X% confident this test reproduces the bug"
- If confidence < 70%, escalates to human (status → "needs-human-repro")
- Sandbox: tests run in a worker_threads isolate with no fs access outside `tests/`

**First PR**: `feat(bugs): AI-driven bug reproduction (alpha)`

**Estimated**: 3 weeks (~15 days). The test-runner sandbox alone is a week.

---

### v0.6.3 — Fix proposal

**What it is**: given a confirmed reproduction, AI proposes a code change.

**Files**:
```
packages/core/src/propose-fix.ts        (NEW — orchestrator)
apps/cli/src/cli.ts                     (NEW: `factstack bug fix <ticket-id>`)
```

**Definition of done**:
- Given a ticket in `reproduced` status, write a fix
- Run the regression test + full test suite
- Status transitions: `reproduced` → `fix-ready` (if all tests pass) | `fix-failed` (else)
- Risk score attached (uses `impact_of`)
- Fix is held in a topic branch, not merged

**First PR**: `feat(bugs): AI fix proposal with sandbox verification`

**Estimated**: 3 weeks.

---

### v0.6.4 — PR creation + adversarial test loop

**What it is**: open a PR with the test + fix + risk analysis. Run a SECOND AI to write attack tests trying to break the fix.

**Files**:
```
packages/core/src/pr.ts                 (NEW — git automation)
packages/core/src/adversarial.ts        (NEW — second-AI attack tester)
```

**Definition of done**:
- Auto-PR with templated description
- Adversarial pass writes 5 tests trying to break the fix; if any pass, PR is rejected
- Confidence score visible in PR body
- Human-required-review tier based on confidence + blast radius
- Webhook integration: GitHub / GitLab / Bitbucket

**First PR**: `feat(bugs): PR automation + adversarial verification loop`

**Estimated**: 2 weeks.

---

### v0.6.5 — Trust calibration (uses learnings.jsonl from v0.3)

**What it is**: read the postmortem log, surface AI accuracy by ticket type, calibrate confidence gates.

**Files**:
```
packages/core/src/calibration.ts        (NEW — learnings → accuracy stats)
prototype/index.html                    (NEW Trust tab — agent calibration over time)
```

**Definition of done**:
- Per-agent accuracy: % of accepted fixes by confidence tier
- Trends over time
- Suggested confidence-gate adjustments based on data
- Human can override gates per-agent

**First PR**: `feat(bugs): trust calibration dashboard`

**Estimated**: 1 week.

**v0.6 total**: ~10 weeks (40 days). The reproduction + fix-proposal stages are the unknowns.

---

## v0.7+ — Deferred (re-evaluate when v0.6 lands)

These survived [`plan.md`](./plan.md) feasibility but didn't make the cut for v0.3-v0.6. Each has a specific gate that must clear before it's worth the engineering cost.

| Candidate | Gate | Why deferred |
|---|---|---|
| **TS type flow across modules** (C2) | tsserver integration matures, or a non-TS user appears who needs equivalent | TS-only fragments the cross-language story; reinventing tsserver is wasteful |
| **Build/runtime config inference** (C8) | An explicit user need for accurate bundle topology beyond what framework detection covers | Existing detection covers 80%; marginal value not yet justified |
| **`find_pattern(description)` LLM mode** (C11) | Cost model for LLM-driven AST queries proves out (per-call $ + hit rate) | Deterministic AST query DSL is fine for v0.7; LLM angle blocked on cost |
| **Money-per-month $ estimates** (C21-$) | A pricing-data partner that warrants the trust contract OR a regulator mandates disclosure | Pricing tables drift quarterly; confidently-wrong $ in a CXO dashboard is a trust killer (call counts ship in v0.4.11) |
| **Cross-repo graph** (C33) | Single-repo case is rock-solid AND a multi-repo customer asks for it | Premature; assumes a deployment model FACTS hasn't earned yet |

---

## Dropped — explicit decisions not to build

These were proposed in the strategic discussion on 2026-05-01 and explicitly rejected after [`plan.md`](./plan.md) feasibility scoring. Recording the *rationale* so future "should we revisit?" conversations have a record.

| Candidate | Rationale |
|---|---|
| **Property-based test synthesis** (C31) | Trust collapse if synthesized tests are wrong. v0.6 bug-pipeline already targets test generation in a controlled, adversarial setting — that's the right vehicle. Free-floating PBT would undermine the trust framework. |
| **AI-fingerprint detection** (C34) | Adversarial signal — devs work around it the moment it's deployed. Low actual user value. The problem it solves (review-quality ranking) is better addressed by `learnings.jsonl` calibration data, not by "is this AI?" guessing. |
| **Carbon estimate** (C35) | Built on shaky math (cost × CO2-per-cost factor). Emission factors change quarterly. CXO dashboards trade on precision — a fuzzy carbon number in a tool whose moat is *clarity* is the wrong trade-off. |
| **Replay scenarios** (C39) | Not really static analysis. Closer to integration testing or staging tooling. The static substrate (route detection, type extraction) makes it possible but the operational surface (dev-traffic capture, PII redaction, replay infra) is a separate product. Don't fold it in. |

---

## How to make it happen — sequencing + rules

### Build order (strict)

```
v0.3 (memory)            10 days   foundational
  └→ v0.3 must ship before v0.6 because bug-to-PR needs MEMORY.md +
     learnings.jsonl + agent identity to function

v0.3 substrate           7 days    after v0.3.1-v0.3.4
  └→ symbol-graph (v0.3.5) gates v0.4.7 impact_of + v0.4.8 find_examples
  └→ test-coverage (v0.3.7) gates v0.4.5 staleness + v0.4.12 stale tests

v0.4 (taxonomy + vulns +  33 days   parallel-able with v0.3 memory work
      promoted tools)              after v0.3.5 symbol graph lands
  └→ taxonomy gates docs.ts (ARCHITECTURE.md needs tiers)
  └→ effect graph (v0.4.11) gates v0.5.5 trace_data
  └→ public/private (v0.4.6) gates dead-code viz + unused()
  └→ vulns gate v0.6 risk scoring (PR risk reads supply-chain)

v0.5 (agent tools +       50 days   needs effect graph + symbol graph
      human clarity)                from v0.3+v0.4
  └→ trace_data needs effect graph
  └→ semantic diff needs symbol-level pairing
  └→ spec drift needs route extraction (already shipped) + data shapes
  └→ PR archaeology needs git history mining (already shipped)

v0.6 (bug-to-PR)          40 days   needs everything above
  └→ reproduction needs MCP tools (find_examples, query_around, trace_data)
  └→ trust framework needs learnings.jsonl from v0.3
```

### What ships in week 1

```
PR 1  feat(memory): MEMORY.md generator       (v0.3.1, 3d)
PR 2  feat(graph): symbol-level call graph    (v0.3.5, 5d)  ← gates v0.4 promotions
```

By Friday: AI agents get a 5KB summary, AND the symbol-graph substrate that
unlocks `impact_of` + `find_examples` in v0.4 (the demo-grade tools that
make new users say "oh, I trust this"). Per [`plan.md`](./plan.md): **C1 is
the foundation that 80% of agent superpowers compound on — front-load it.**

### What ships in month 1

```
Week 1: PR 1 + PR 2  (MEMORY.md + symbol graph)
Week 2: PR 3         (since() — v0.3.2)
        PR 4         (env vars + reading-time + owners + plain-risk bundle — v0.3.6 + v0.3.8)
Week 3: PR 5         (test-coverage heuristic — v0.3.7)
        PR 6         (agent identity + learnings.jsonl — v0.3.3 + v0.3.4)
Week 4: PR 7         (taxonomy: category + tier + role — v0.4.1)
```

By end of month 1: **complete v0.3 + start v0.4.1**. Agents have memory,
the substrate is in place, the CXO trust signals are deployed.

### What ships in month 3

All of v0.4 (12 sub-phases) + most of v0.5. Agents have:
- v0.4 power tools: `impact_of`, `find_examples`, `unused`, `risk_explain`, `why_dependency`, `drift`, `arch_lint`, `tests_for`
- v0.5 (in flight): `code_conventions`, `suggest_location`, `query_around`, `data_shapes`, `trace_data`, onboarding tour, PR archaeology

The MCP tool surface is feature-complete by end of month 3 *for everything
that doesn't need an LLM*. LLM-augmented `design.md` (v0.5.11) becomes
optional cleanup.

### What ships in month 6

v0.5 fully landed (clones, semantic diff, spec drift) + v0.6.1 (bug intake)
+ v0.6.2 (reproduction alpha). Bug-to-PR is partially live for HIGH-
confidence cases only. Calibration data starts accumulating.

### What ships in year 1

Full v0.6 loop including adversarial testing and trust calibration. After
100 tickets, calibration data lets you expand to MEDIUM-confidence fixes.

---

## Per-PR template

Every PR in this roadmap ships with:

1. **Definition of done** stated above (in this file or in the linked spec)
2. **Tests added** — minimum 1 vitest file per new module + smoke test where it crosses package boundaries
3. **Coverage target** — 80%+ statement on new code (existing baseline: 71-93% per package)
4. **No regressions** — `pnpm test` must pass; `pnpm test:cov` must not drop below baseline
5. **Documentation** — README section if user-facing; comment in code if internal
6. **Backward compat** — schema changes are additive within a major; breaking changes bump the major
7. **Privacy invariant** — no raw secret values, no source code in artifacts that get exfiltrated, no cloud calls without opt-in

---

## Risks + open questions

### v0.4 risks
- **OSV.dev API rate limits** — research before v0.4.3. Caching mitigates but need a fallback.
- **Taint-flow false positives** — every static analyzer over-reports. Need a calibration period before HIGH severity is trusted.
- **AI authorship convention** — needs `AI-Author:` commit trailer adoption. Document in CONTRIBUTING.

### v0.5 risks
- **MCP scope creep** — too many tools = agent confusion. Cap at 15 tools total. Currently at 5; budget for 10 more.
- **LLM cost in --llm mode** — ARCHITECTURE.draft.md generation costs ~$0.10-1 per regen depending on project size. Document in CLI help.

### v0.6 risks (the big ones)
- **Reproduction AI accuracy** — unknown until we ship and measure. Need 50+ test runs against real bugs to calibrate.
- **Sandbox security** — AI-generated tests can't have fs/network access by default. Worker_threads is a start; revisit with proper isolation if needed.
- **Adversarial agent collusion** — if both repro and adversarial AIs are the same model, they share blind spots. Use different providers (claude reproduces, gpt attacks).
- **PR automation permissions** — GitHub bot needs scoped write. Document the permission model in v0.6.4.

---

## Where this lives

- **This file (`ROADMAP.md`)** — sequencing + first-PR per item. Updated as commits land.
- **`app_plan_spec.md`** — original v0.1 product strategy. Don't update; this file supersedes for operational planning.
- **`.facts/MEMORY.md`** (when v0.3.1 ships) — auto-generated, not edited by hand.
- **`.facts/tickets/`** (when v0.6.1 ships) — bug tracker in git.
- **`.facts/learnings.jsonl`** (when v0.3.4 ships) — append-only postmortem log.
- **`.facts/snapshots/`** (already shipping) — historical analyzer state.

---

## What I'd ship next week (revised after [`plan.md`](./plan.md) feasibility)

Two PRs paired for maximum compounding:

**PR 1 (~3 days) — `.facts/MEMORY.md` generator + `read_memory` MCP tool** *(v0.3.1)*

Why: smallest unit of code, biggest single-PR impact. Every AI agent that uses FACTS gets a 40× context savings on cold-start (5KB MEMORY.md vs 200KB agent.json walk). Pure synthesis from existing data — no new analyzer pass, no new schemas, just a markdown templater + an MCP wrapper.

**PR 2 (~5 days) — Symbol-level call graph** *(v0.3.5)*

Why: the substrate decision. Doing this in week 1 cheapens v0.4's `impact_of` (3d → 2d), `find_examples` (4d → 2d), `unused()` (3d → 1d), and dead-code viz (3d → 1d). Net cost across the program drops by ~7 days — front-loading C1 *pays for itself before v0.4 starts*.

Per [`plan.md`](./plan.md) C1 risk note: ship with **a confidence flag per ref**. Surface "I don't know" instead of wrong answers. The worst outcome is `impact_of` returning a confidently wrong "what breaks if I rename" answer when the symbol graph has bugs — gate on high-confidence by default, expose low-confidence behind an explicit flag.

Then build outward in priority order: memory → substrate → identity → learnings → taxonomy → docs → tools → bugs. Each PR makes the next cheaper because the substrate compounds.

---

## Cross-references

- [`plan.md`](./plan.md) — feasibility analysis driving this roadmap revision (40 candidates scored; verdicts: ship/fold/defer/drop)
- [`app_plan_spec.md`](./app_plan_spec.md) — original v0.1 product plan
- [`app_spec.md`](./app_spec.md), [`design_spec.md`](./design_spec.md), [`animations_spec.md`](./animations_spec.md) — functional + design + motion specs
- [`README.md`](./README.md) — what ships today + Quick start + GitHub source + Supabase setup

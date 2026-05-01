# plan.md — Candidate features, feasibility analysis, roadmap deltas

> **Purpose**: capture every idea on the table, score each one honestly, kill
> the ones that don't earn their bloat, and only then propagate the survivors
> into [`ROADMAP.md`](./ROADMAP.md). This file is the working scratchpad for
> the strategic discussion that happened on 2026-05-01; ROADMAP.md becomes
> the operational plan.

**Status**: v0.2.1 shipped + GitHub source live at https://factstack-demo.netlify.app
**Last updated**: 2026-05-01 (after `67e3b48` GitHub source commit)

---

## What this is and is not

**This is**: a feasibility doc. Every candidate feature gets the same rubric.
Some get cut. The cuts are at least as important as the picks — we are
explicitly resisting bloat in a tool whose moat is *clarity*.

**This is not**: the operational plan. Once verdicts are agreed, ROADMAP.md
gets updated; this file becomes a snapshot of "why we did/didn't do X."

---

## What just shipped this session (2026-05-01)

| ID | Feature | Commit | Notes |
|---|---|---|---|
| S1 | **GitHub source** | `67e3b48` | Toolbar button + modal accepting `owner/repo`, `owner/repo@ref`, full URLs; optional PAT raises rate limit 60→5000/hr; zipball fetched via `api.github.com`; unpacked in-browser with JSZip; synthetic `FileSystemDirectoryHandle` adapter so `scanHandle` runs unchanged. |
| S2 | **Supabase persistence** | `67e3b48` | Opt-in storage bucket; immutable per-snapshot + `latest.json` upsert pointer; cache-first deep links (`?gh=owner/repo`) replay in <500ms with no GH API hit. Anon key publishable; RLS controls writes. |
| S3 | **Smoke test for GH adapter** | `67e3b48` | `prototype/scripts/smoke-scan-github.mjs` covers `parseRepoSpec` (9 cases), `repoSpecKey` (sanitization + traversal), `buildHandleFromZip` (FSDH shape, ENOENT, binary detection). Wired into `pnpm test:proto`. |
| S4 | **README docs** | `67e3b48` | "Open from GitHub" section + Supabase setup walkthrough (bucket + RLS SQL + Netlify env-var pattern). |
| S5 | **Master roadmap** | `98cddb5` | `ROADMAP.md` consolidating v0.3-v0.6 strategic plan with PR sequencing. |

These are not in the feasibility table below — they are facts. The table
below is everything *next*.

---

## Inventory — every candidate on the table

Sourced from the strategic discussion on 2026-05-01 plus prior planning
already captured in `ROADMAP.md`. Each candidate gets a stable ID
(`C1`...`C40`) so the rest of the doc can reference them.

### A — Substrate signals (foundational layer everything else compounds on)

| ID | Candidate | One-liner |
|---|---|---|
| C1 | Symbol-level call graph | Refs + defs per symbol (not just file→file imports). |
| C2 | TS type flow across modules | Propagate inferred types through call sites. |
| C3 | Effect graph | Annotate functions that read/write DB, network, fs, env, time. |
| C4 | Public-vs-private API surface | Mark exports that have ≥1 external referrer. |
| C5 | Config + env-var schema extraction | Find every `process.env.X`, link to read sites, dedupe. |
| C6 | Data-shape inference (runtime) | Infer concrete shapes from JSON fixtures, sample responses, DB queries. |
| C7 | Test → subject coverage | Heuristic: `foo.test.ts` covers symbols imported from `foo.ts`. |
| C8 | Build/runtime config inference | Vite/Webpack/Turbo/Nx/Cargo workspaces — detect entry points + bundle topology. |

### B — Agent superpowers (MCP tools)

| ID | Candidate | One-liner | Already on roadmap? |
|---|---|---|---|
| C9 | `impact_of(symbol)` | Transitive reverse-refs + affected tests + downstream type errors. | v0.5.1 |
| C10 | `find_examples(api, n)` | Ranked usage sites of an API across the repo. | v0.5.2 |
| C11 | `find_pattern(description)` | AST-shape queries (e.g., "catch blocks without logging"). | NEW |
| C12 | `code_conventions(scope)` | Inferred naming/structure rules + 3-5 exemplars. | v0.5.2 |
| C13 | `suggest_location(intent)` | "Where would a new MetricsService go?" → ranked candidate paths. | v0.5.3 |
| C14 | `trace_data(input_route, output_route)` | Ordered call chain with effect annotations between two endpoints. | NEW |
| C15 | `unused(scope)` | Exports with zero callers (filtered for tests + entry points). | NEW |
| C16 | `drift(symbol)` | Flag when impl moved but tests didn't, or vice versa. | NEW (overlap v0.4.5) |
| C17 | `since(timestamp)` | Incremental memory: what changed since last AI session. | v0.3.2 |
| C18 | `why_dependency(pkg)` | Trace transitive deps to root causes; "could we drop lodash?" | NEW |
| C19 | `risk_explain(rule_id, file)` | Connect risk + code + conventions; suggest fix in this codebase's style. | NEW |

### C — Human clarity (CXO + new-engineer ergonomics)

| ID | Candidate | One-liner |
|---|---|---|
| C20 | Reading-time per folder | "Reading this folder cold takes ~12 minutes." Per-folder estimate. |
| C21 | Money-per-month cost surfaces | Cost-attribute effectful calls (DB, S3, OpenAI, fns) to $/month estimates. |
| C22 | Onboarding 5-stop tour | Auto-generated: entry → router → 2 most-edited business modules → tests. |
| C23 | Decision archaeology | Mine commit msgs + PR descriptions linked to a file. |
| C24 | Risk in plain English | Translate every finding into a sentence an exec can act on. |
| C25 | Architecture sketch | Detect layered patterns; draw what code *does* vs README claims. |
| C26 | Copy-paste / clone detector | Side-by-side diff of duplicated blocks. |
| C27 | Dead-code visualization | Color tree nodes by reachability from entry points. |
| C28 | Owner inference | Per-file top-3 contributors + last-touched date. |
| C29 | Stale tests panel | Tests for code that hasn't changed in N months *and* hasn't run in CI. |

### D — Moonshots (high effort, transformative if they land)

| ID | Candidate | One-liner | Already on roadmap? |
|---|---|---|---|
| C30 | Symbolic execution / taint analysis | Sources (`req.body`, env) → sinks (`exec`, `fs.write`, `db.query`). | v0.4.4 |
| C31 | Property-based test synthesis | Generate fast-check / hypothesis tests from types + effects. | NEW |
| C32 | Semantic diff | Function-level diffs ("renamed X→Y, body unchanged"). | NEW |
| C33 | Cross-repo graph | Federate `agent.json` across an org's repos; link by published pkg + import. | NEW |
| C34 | AI-fingerprint detection | Flag code that looks LLM-generated (boilerplate density, generic naming). | NEW |
| C35 | Carbon estimate | Cost × kg-CO2-per-cost factor; EU board narrative. | NEW |
| C36 | Live exemplar mining | Render call sites inline as docs (subset of C10). | NEW |
| C37 | Architecture lint (`rules.toml`) | Express "controllers must not import models" as graph constraints. | NEW |
| C38 | Spec drift (OpenAPI server vs client) | Extract OpenAPI from both sides; flag mismatches. | NEW |
| C39 | Replay scenarios | Record dev traffic, replay against changed code, surface behavioral diffs. | NEW |

### E — Already-on-roadmap items not yet re-evaluated

| ID | Candidate | One-liner | Roadmap slot |
|---|---|---|---|
| C40 | `.facts/MEMORY.md` auto-generated brain | Compact summary of "what an AI agent should know about this repo right now." | v0.3.1 |
| C41 | Stable agent identity + session log | Per-agent context resume across sessions. | v0.3.3 |
| C42 | Postmortem `learnings.jsonl` | Capture "we tried X, it failed, here's why" — fed back into agent context. | v0.3.4 |
| C43 | Category/tier/role taxonomy | frontend/backend/shared/pipelines/data/infra/cli labels per file. | v0.4.1 |
| C44 | `ARCHITECTURE.md` generator | Layered-pattern detection rendered as a doc. | v0.4.2 (overlaps C25) |
| C45 | Supply-chain vuln scanner | OSV / npm advisory hits per dep + age + maintainer signals. | v0.4.3 |
| C46 | Staleness scanner | AI-authorship hints + pattern drift over time. | v0.4.5 (overlaps C16) |
| C47 | LLM-augmented design.md | Optional LLM polish over deterministic extraction. | v0.5.5 |
| C48 | Bug intake (`factstack tickets`) | Structured bug capture surface. | v0.6.1 |
| C49 | Reproduction agent | Auto-spin a sandbox + reproduce failure. | v0.6.2 |
| C50 | Fix proposal | Generate candidate patches from reproduction. | v0.6.3 |
| C51 | PR creation + adversarial test loop | Auto-PR with tests that try to break the fix. | v0.6.4 |
| C52 | Trust calibration | `learnings.jsonl` feeds reliability scoring per agent action. | v0.6.5 |

---

## Scoring framework

Every candidate gets six scores and a verdict.

| Axis | Scale | What it means |
|---|---|---|
| **Value-AI** | 1-5 | How much it raises the floor for an agent operating on the codebase. |
| **Value-CXO** | 1-5 | How much it helps a non-developer understand or trust the codebase. |
| **Cost** | S / M / L / XL | S=≤2d, M=3-7d, L=8-15d, XL=15+d. Engineering days, not calendar. |
| **Bloat** | 1-5 | Artifact size, surface area, UI complexity added. 5 = significant. |
| **Maint** | 1-5 | Recurring engineering tax (test maintenance, third-party API drift, etc.). 5 = high. |
| **Det** | D / H / L | Determinism: D=deterministic, H=heuristic with known false-positive rate, L=requires LLM. |

**Verdict** is one of:
- **SHIP** — make the cut for the next phase. Specifies which version.
- **FOLD** — overlaps existing work; merge into that scope. No new phase entry.
- **DEFER** — keep on the table but push past v0.6.
- **DROP** — explicit decision *not* to build, with rationale.

**Decision rule**:
> Ship when `(Value-AI + Value-CXO) ≥ 6` AND `Bloat + Maint ≤ 6` AND
> dependencies on other substrate items are satisfied. Heuristic items
> (`Det = H`) need the same numbers PLUS a clear false-positive bound.
> LLM-required items (`Det = L`) need an explicit cost model (per-call
> dollar cost) before ship.

The decision rule is a guide, not a constraint — explain any exceptions.

---

## Feasibility table (the matrix)

Sorted by composite value `(V-AI + V-CXO) − (Bloat + Maint)`. Higher is
better.

### A — Substrate

| ID | Candidate | V-AI | V-CXO | Cost | Bloat | Maint | Det | Composite | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| C1 | Symbol-level call graph | 5 | 3 | M (5d) | 3 | 2 | D | **+3** | **SHIP v0.3** (foundation; unblocks C9-C16) |
| C5 | Config + env-var extraction | 4 | 5 | S (2d) | 1 | 2 | D | **+6** | **SHIP v0.3** (highest composite) |
| C7 | Test → subject coverage | 5 | 3 | S (2d) | 1 | 1 | H | **+6** | **SHIP v0.3** (heuristic v1 ≥ 70% precision is fine) |
| C4 | Public-vs-private API surface | 4 | 3 | S (2d after C1) | 1 | 1 | D | **+5** | **SHIP v0.4** (trivial after C1) |
| C3 | Effect graph | 5 | 4 | M (6d) | 2 | 3 | H | **+4** | **SHIP v0.4** (powers cost surfaces + agent tools) |
| C2 | TS type flow across modules | 4 | 2 | L (12d) | 4 | 4 | H | **−2** | **DEFER v0.7** (TS-only fragments the cross-language story; tsserver does this — leverage rather than reinvent) |
| C6 | Data-shape inference | 4 | 2 | L (10d) | 3 | 4 | H | **−1** | **SHIP v0.5** (already v0.5.4 — keep slot, accept the maint cost; pairs with C14 trace_data) |
| C8 | Build/runtime config inference | 3 | 4 | M (5d) | 2 | 3 | D | **+2** | **DEFER v0.6** (existing framework detection covers 80%; marginal value not worth scope right now) |

### B — Agent superpowers

| ID | Candidate | V-AI | V-CXO | Cost | Bloat | Maint | Det | Composite | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| C17 | `since(timestamp)` | 5 | 2 | S (2d) | 1 | 1 | D | **+5** | **SHIP v0.3.2** (already on roadmap; pure win) |
| C9 | `impact_of(symbol)` | 5 | 3 | S (2d after C1) | 1 | 2 | D | **+5** | **PROMOTE v0.5.1 → v0.4** (cheaply unlocked by C1; demo-grade for trust) |
| C10 | `find_examples(api, n)` | 5 | 2 | S (2d after C1) | 1 | 1 | D | **+5** | **PROMOTE v0.5.2 → v0.4** (highest-frequency agent need; folds C36) |
| C15 | `unused(scope)` | 3 | 5 | S (1d after C4) | 1 | 1 | D | **+6** | **SHIP v0.4** (delete-it report = CXO gold; trivial after C4) |
| C19 | `risk_explain(rule_id, file)` | 3 | 4 | S (2d) | 1 | 2 | D | **+4** | **SHIP v0.4** (rule message rewrite + file context; LLM polish optional v0.5+) |
| C18 | `why_dependency(pkg)` | 4 | 4 | M (4d) | 2 | 2 | D | **+4** | **SHIP v0.4** (folds into v0.4.3 supply-chain) |
| C13 | `suggest_location(intent)` | 4 | 1 | M (5d after C1) | 2 | 2 | H | **+1** | **KEEP v0.5.3** (heuristic precision matters here; needs C1 + C12 first) |
| C12 | `code_conventions(scope)` | 5 | 1 | M (6d after C1) | 2 | 3 | H | **+1** | **KEEP v0.5.2** (high-value but heuristic; pair with C13) |
| C14 | `trace_data(in, out)` | 5 | 3 | L (10d after C3+C6) | 3 | 4 | H | **+1** | **SHIP v0.5** (replaces a class of multi-file investigations) |
| C16 | `drift(symbol)` | 4 | 3 | S (2d after C7) | 1 | 2 | D | **+4** | **FOLD into v0.4.5 staleness** (same data, different view) |
| C11 | `find_pattern(description)` | 4 | 1 | M (6d) deterministic / XL with LLM | 2 | 3 | H/L | **0** | **DEFER v0.7** (deterministic AST DSL is good; LLM angle blocked by cost model — drop the LLM ambition for now) |

### C — Human clarity

| ID | Candidate | V-AI | V-CXO | Cost | Bloat | Maint | Det | Composite | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| C20 | Reading-time per folder | 1 | 5 | S (½d) | 1 | 1 | D | **+4** | **SHIP v0.3** (cheapest CXO trust signal in the doc) |
| C24 | Risk in plain English | 1 | 5 | S (1d, rule rewrite) | 1 | 2 | D | **+3** | **SHIP v0.3** (piggyback C19 + C20) |
| C28 | Owner inference | 2 | 5 | S (1d, git data already in pipeline) | 1 | 1 | D | **+5** | **SHIP v0.3** (free after existing git history mining) |
| C27 | Dead-code visualization | 3 | 4 | S (1d after C4) | 1 | 1 | D | **+5** | **SHIP v0.4** (just renders C15) |
| C25 | Architecture sketch | 2 | 5 | M (5d) | 2 | 3 | H | **+2** | **FOLD into v0.4.2 ARCHITECTURE.md** (same detection layer) |
| C29 | Stale tests panel | 3 | 3 | S (1d after C7) | 1 | 2 | D | **+3** | **SHIP v0.4** (renders C7 + C16) |
| C26 | Copy-paste / clone detector | 3 | 4 | M (6d) | 3 | 3 | H | **+1** | **SHIP v0.5** (where bugs hide; CXO hook = "you have 3 copies of billing logic") |
| C23 | Decision archaeology (PRs) | 4 | 5 | M (5d) GitHub API + cache | 3 | 3 | D | **+3** | **SHIP v0.5** (big "wow" moment for both audiences) |
| C22 | Onboarding 5-stop tour | 2 | 5 | M (4d) deterministic v1 | 2 | 2 | H/L | **+3** | **SHIP v0.5** (deterministic v1; LLM polish v0.6+) |
| C21 | Money-per-month cost surfaces | 3 | 5 | M (6d for $; S for counts) | 3 | 5 | H | **0** | **SPLIT**: SHIP **call-counts-per-route** v0.4 (after C3); DEFER **$ estimates** to v0.7 (pricing tables drift; confidently-wrong $$ in a CXO dashboard is a trust killer) |

### D — Moonshots

| ID | Candidate | V-AI | V-CXO | Cost | Bloat | Maint | Det | Composite | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| C37 | Architecture lint (`rules.toml`) | 3 | 4 | M (5d after C43) | 2 | 2 | D | **+3** | **SHIP v0.4** (replace meetings with CI; folds into v0.4.1+v0.4.2 work) |
| C38 | Spec drift (OpenAPI) | 4 | 5 | L (12d) | 3 | 4 | D | **+2** | **SHIP v0.5** (single most common silent-bug class in web apps) |
| C30 | Taint analysis | 5 | 4 | XL (16d) | 3 | 4 | H | **+2** | **KEEP v0.4.4** (already on roadmap; SonarQube charges enterprises for this) |
| C32 | Semantic diff | 4 | 5 | L (12d) | 2 | 3 | H | **+4** | **SHIP v0.5** (PR review collapse from 30 min → 5; high upside) |
| C36 | Live exemplar mining | 3 | 4 | S (1d as render of C10) | 1 | 1 | D | **+5** | **FOLD into C10** (`find_examples` with rendering — not a separate feature) |
| C33 | Cross-repo graph | 4 | 4 | L (12d) | 4 | 4 | D | **0** | **DEFER v0.7** (single-repo case must be perfect first; assumes multi-repo deployment) |
| C31 | Property-based test synthesis | 3 | 2 | XL (20d) | 5 | 5 | H | **−5** | **DROP** (trust collapse if generated tests are wrong; bug-pipeline v0.6 is a better vehicle for synthesized tests) |
| C39 | Replay scenarios | 4 | 4 | XL (25d) | 5 | 5 | D | **−2** | **DROP** (not really static analysis; closer to integration testing — wrong tool, wrong vehicle) |
| C34 | AI-fingerprint detection | 1 | 1 | M (5d) | 2 | 3 | H | **−3** | **DROP** (adversarial signal — devs work around it; low actual user value) |
| C35 | Carbon estimate | 1 | 2 | S (after C21 $) | 1 | 5 | H | **−3** | **DROP** (built on shaky math: cost × CO2/cost; emission factors change quarterly; confidently wrong) |

### E — Already-on-roadmap re-evaluation (sanity check)

All of these were committed to the roadmap before this session. The
re-eval confirms they should stay — no demotions or drops.

| ID | Candidate | Roadmap slot | Re-verdict | Notes |
|---|---|---|---|---|
| C40 | `MEMORY.md` brain | v0.3.1 | **KEEP** | Anchor of v0.3; defines the agent-memory contract. |
| C41 | Stable agent identity | v0.3.3 | **KEEP** | Required for C42 to be useful. |
| C42 | `learnings.jsonl` | v0.3.4 | **KEEP** | Foundation for C52 trust calibration. |
| C43 | Category/tier/role taxonomy | v0.4.1 | **KEEP** | Required for C37 architecture lint. |
| C44 | `ARCHITECTURE.md` generator | v0.4.2 | **KEEP** + absorb C25 | One detection layer powers both. |
| C45 | Supply-chain vuln scanner | v0.4.3 | **KEEP** + absorb C18 | `why_dependency` becomes a query against the same data. |
| C46 | Staleness scanner | v0.4.5 | **KEEP** + absorb C16 | `drift` is the symbol-level slice. |
| C47 | LLM-augmented design.md | v0.5.5 | **DEMOTE to optional** | Only ship if v0.5 deterministic stack lands clean — LLM polish is a "nice to have" not a "must." |
| C48-C52 | Bug-to-PR pipeline (v0.6) | v0.6.x | **KEEP** | Long-horizon bet; depends on EVERYTHING above being trustworthy. |

---

## Synthesis — what changes in ROADMAP.md

### Promotions (move earlier)

- **C9 `impact_of`**: v0.5.1 → **v0.4** (cheap once C1 lands; demo-quality)
- **C10 `find_examples`**: v0.5.2 → **v0.4** (highest-frequency agent need; folds C36)

### Additions to v0.3 (the memory phase)

The v0.3 brief becomes "memory + cheap CXO trust signals + symbol-level
substrate." This expands v0.3 from 10 days → ~17 days but everything
new is small (S-cost) and high composite score:

- **C1** Symbol-level call graph (foundation for v0.4 promotions)
- **C5** Config + env-var extraction (composite +6)
- **C7** Test → subject coverage (composite +6)
- **C20** Reading-time per folder (½ day, +4)
- **C24** Risk in plain English (1 day, +3)
- **C28** Owner inference (1 day, +5)

These are ALL deterministic. No LLM dependency. Each one is independently
shippable as its own PR.

### Additions to v0.4 (architecture + vulns + staleness, expanded)

v0.4 absorbs the agent power-tools that became cheap once C1 ships:

- **C4** Public/private API surface (after C1)
- **C9** `impact_of` MCP tool (promoted)
- **C10** `find_examples` MCP tool (promoted; folds C36)
- **C15** `unused(scope)` MCP tool + UI panel
- **C19** `risk_explain` MCP tool
- **C27** Dead-code visualization (renders C15)
- **C29** Stale tests panel (renders C7 + C16)
- **C37** Architecture lint (`rules.toml`) — folds into v0.4.1 + v0.4.2
- **C21-counts** Call-counts-per-route (folded into v0.4.1 effect graph)

`C18 why_dependency` folds into v0.4.3 supply-chain.
`C16 drift` folds into v0.4.5 staleness.

### Additions to v0.5 (agent power tools + LLM-augmented docs)

v0.5 shrinks slightly because v0.4 stole the cheap items, but gains:

- **C14** `trace_data(input_route, output_route)` — pairs with v0.5.4 `data_shapes`
- **C22** Onboarding 5-stop tour (deterministic v1)
- **C23** Decision archaeology (PR linking)
- **C26** Copy-paste / clone detector
- **C32** Semantic diff
- **C38** Spec drift (OpenAPI server vs client)

### v0.6 unchanged

The bug-to-PR pipeline depends on everything above being trustworthy.
No additions or removals; the v0.4 + v0.5 expansion just gives v0.6 a
richer substrate to work with.

### Deferred to v0.7+

- **C2** TS type flow (TS-only fragments cross-language story; tsserver does this)
- **C8** Build/runtime config inference (existing detection covers 80%)
- **C11** `find_pattern` (deterministic AST DSL is fine; LLM angle blocked by cost model)
- **C21-$** Money-per-month $ estimates (pricing drift is a trust killer)
- **C33** Cross-repo graph (single-repo perfection first)

### Dropped (with rationale)

- **C31** Property-based test synthesis — trust collapse risk if synthesized tests are wrong; v0.6 bug-pipeline is the better vehicle.
- **C34** AI-fingerprint detection — adversarial signal; devs work around it; low actual user value.
- **C35** Carbon estimate — confidently wrong math; emission factors change quarterly; CXO trust trap.
- **C39** Replay scenarios — not really static analysis; wrong tool for the job.

### Folds (no separate roadmap entry)

- **C16** `drift(symbol)` → into v0.4.5 staleness
- **C18** `why_dependency` → into v0.4.3 supply-chain
- **C25** Architecture sketch → into v0.4.2 ARCHITECTURE.md
- **C36** Live exemplar mining → into C10 `find_examples`

---

## Bloat budget — staying honest

The deciding question for each "ship" verdict was: **does this earn its
weight in artifact bytes, code surface, and UI density?**

A rough size accounting after all proposed additions land:

| Phase | New `agent.json` fields | New `human.json` fields | New MCP tools | New UI panels | Code added (est) |
|---|---|---|---|---|---|
| **v0.3** (current) | 4 (memory + identity + since + learnings) | 0 | 4 | 0 | ~1,500 LOC |
| **v0.3** (proposed) | 8 (+ symbols, env vars, test-coverage, owner) | 4 (+ reading-time, owner, plain-risk, env vars) | 5 | 1 (Memory tab) | ~3,000 LOC |
| **v0.4** (current) | 5 (taxonomy, arch, vulns, taint, staleness) | 5 | 1 | 3 | ~3,500 LOC |
| **v0.4** (proposed) | 9 (+ public-API, effect graph, call counts, drift) | 8 (+ dead-code map, stale tests, why-dep, risk explain) | 6 (+ impact_of, find_examples, unused, why_dep, risk_explain, arch_lint) | 5 | ~6,500 LOC |
| **v0.5** (current) | 3 (data shapes, conventions, suggest_location) | 1 (LLM design.md) | 5 | 2 | ~4,500 LOC |
| **v0.5** (proposed) | 5 (+ trace_data, OpenAPI extracted, clones) | 5 (+ tour, archaeology, semantic-diff, clones, spec-drift) | 7 (+ trace_data) | 6 | ~7,500 LOC |

**Total proposed code ≈ 17,000 LOC across v0.3-v0.5** (vs 9,500 baseline).
That's a 1.8x increase — significant but not unreasonable for the value
delivered. The kill list (C2, C8, C11, C21-$, C33, C31, C34, C35, C39)
prevented an additional ~12,000 LOC and most of the maintenance tax.

**`agent.json` stays under the 5 MB cap** if symbol graph is stored as
a delta-encoded blob (refs + defs only, no AST). Worst case for a
100k-LOC monorepo: ~3.2 MB. Test before shipping; chunk into
`agent.chunks/` if exceeded (already specced in §C2 of the original plan).

---

## Risks introduced by promoting items earlier

Pulling C9 + C10 into v0.4 from v0.5 sounds cheap (they unblock once C1
lands) but carries one specific risk:

- **Symbol graph correctness becomes a v0.4 hard dependency**, not a v0.5
  one. If C1 has bugs, `impact_of` returns wrong "what breaks if I rename
  this" answers — and that's exactly the question agents will trust most.
  Mitigation: ship C1 with a confidence flag per result, and gate
  `impact_of` on "high confidence only" by default. Surface a clear "I
  don't know" instead of a wrong answer.

The v0.3 expansion (6 new items) carries no new architectural risk — all
deterministic, all small, all rendering to existing UI conventions.

---

## What ships next week (revised after this analysis)

The first PR remains **`.facts/MEMORY.md` generator + `read_memory` MCP
tool** (per the existing v0.3.1 entry). But the second PR slot changes:

- **PR 2 (~3 days)**: **C1 symbol-level call graph** — extractor + index
  + smoke test. Unblocks v0.4 promotions.
- **PR 3 (~1 day)**: **C5 env-var extraction + C20 reading-time + C28
  owner inference** as one bundle. All deterministic, all small, all
  high composite score.
- **PR 4 (~2 days)**: **C7 test → subject coverage** with the heuristic
  documented and false-positive bound measured against `examples/`.

By end of next week: v0.3 fundamentally landed, with substrate (C1) in
place to unlock v0.4's promoted agent tools.

---

## How this doc evolves

- After each PR lands, update the **status** column on this doc + the
  status column on `ROADMAP.md`.
- New ideas that arrive get scored using the same rubric and appended to
  the inventory before being slotted into a phase.
- Verdicts are revisitable — if a "DROP" item turns out to matter (e.g.,
  a regulator mandates carbon disclosure), it gets re-scored on its
  next-best phase entry. No silent additions.

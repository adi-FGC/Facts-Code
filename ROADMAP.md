# FACTS — Roadmap

> Working source of truth for what's shipped, what's queued, and how
> each item gets built. The original product plan lives in
> [`app_plan_spec.md`](./app_plan_spec.md) — this file is the operational
> companion: phases, sequences, first-PRs, definitions-of-done.

**Last updated**: 2026-05-01 (after `7c98417` test-coverage commit)

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

**v0.3 total**: 10 days of focused work.

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

**v0.4 total**: ~27 days.

---

## v0.5 — Agent power tools + LLM-augmented docs (next 90 days)

**Goal**: ship the MCP tools that turn FACTS from a map into a navigation system for agents.

### v0.5.1 — `impact_of(change)` MCP tool — the safe-refactor enabler

Highest-value agent tool. Given a proposed change, return the blast radius.

**Files**:
```
packages/core/src/impact.ts             (NEW — uses graph + symbols + callers)
apps/mcp-server/src/server.ts           (NEW MCP tool: impact_of)
packages/core/test/impact.test.ts
```

**Definition of done**:
- Supports change kinds: rename / delete_symbol / change_signature / move_file / extract_function
- Returns: definite changes (definition site), likely (call sites), ambiguous (string matches)
- Tier-stratified output (frontend / backend / shared / tests)
- Suggested PR split for high-blast changes

**First PR**: `feat(mcp): impact_of tool — blast radius for proposed changes`

**Estimated**: 6 days

---

### v0.5.2 — `find_examples` + `code_conventions` tools

`find_examples(intent)` returns concrete examples in the codebase matching the intent. `code_conventions()` returns inferred naming/import/pattern rules.

**Files**:
```
packages/core/src/examples.ts          (NEW — intent → file matcher)
packages/core/src/conventions.ts       (NEW — sample-based pattern inference)
apps/mcp-server/src/server.ts          (NEW MCP tools: find_examples, code_conventions)
packages/core/test/examples.test.ts
packages/core/test/conventions.test.ts
```

**Definition of done**:
- `find_examples({ intent: 'api_route' })` returns 3 ranked examples with handler shape + framework
- `code_conventions()` returns naming + import order + tab-vs-space + return-style
- Conventions are tier-aware (frontend rules vs backend rules)

**First PR**: `feat(mcp): find_examples + code_conventions for in-style code generation`

**Estimated**: 5 days

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

### v0.5.5 — LLM-augmented design.md (opt-in)

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

**Estimated**: 7 days

**v0.5 total**: ~27 days.

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

## How to make it happen — sequencing + rules

### Build order (strict)

```
v0.3 (memory)            10 days   foundational
  └→ v0.3 must ship before v0.6 because bug-to-PR needs MEMORY.md +
     learnings.jsonl + agent identity to function

v0.4 (taxonomy + vulns)  27 days   parallel-able with memory work
  └→ taxonomy gates docs.ts (ARCHITECTURE.md needs tiers)
  └→ vulns gate v0.6 risk scoring (PR risk reads supply-chain)

v0.5 (agent tools)       27 days   needs taxonomy from v0.4
  └→ impact_of needs callers + tiers
  └→ find_examples needs role classification

v0.6 (bug-to-PR)         40 days   needs everything above
  └→ reproduction needs MCP tools (find_examples, query_around)
  └→ trust framework needs learnings.jsonl from v0.3
```

### What ships in week 1

```
PR 1  feat(memory): MEMORY.md generator       (v0.3.1, 3d)
PR 2  feat(memory): since(timestamp)          (v0.3.2, 2d)
```

By Friday: any AI agent visiting the project gets a 5KB summary + "what changed since I left" tool. Immediately useful even before the bug-to-PR loop exists.

### What ships in month 1

```
Week 1: PR 1 + PR 2  (memory layer foundation)
Week 2: PR 3 + PR 4  (agent identity + learnings.jsonl)
Week 3: PR 5         (taxonomy: category + tier + role)
Week 4: PR 6         (ARCHITECTURE.md generator)
```

By end of month 1: complete v0.3 + v0.4.1 + v0.4.2.

### What ships in month 3

All of v0.4 + most of v0.5. Agents have impact_of, find_examples, code_conventions, suggest_location, query_around, data_shapes. The MCP tool surface is feature-complete.

### What ships in month 6

v0.6.1 (bug intake) + v0.6.2 (reproduction alpha). Bug-to-PR is partially live for HIGH-confidence cases only. Calibration data starts accumulating.

### What ships in year 1

Full v0.6 loop including adversarial testing and trust calibration. After 100 tickets, calibration data lets you expand to MEDIUM-confidence fixes.

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

## What I'd ship next week

If forced to pick ONE PR for week 1:

**PR 1 — `.facts/MEMORY.md` generator + `read_memory` MCP tool.**

Why: smallest unit of code, biggest single-PR impact. Every AI agent that uses FACTS gets a 40× context savings on cold-start (5KB MEMORY.md vs 200KB agent.json walk). Pure synthesis from existing data — no new analyzer pass, no new schemas, just a markdown templater + an MCP wrapper. 3 days of work, ships meaningful value to every consumer.

Then build outward from there. Memory → identity → learnings → taxonomy → docs → tools → bugs. Each PR makes the next one cheaper to build because the substrate compounds.

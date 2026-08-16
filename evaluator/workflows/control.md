# Build → Review → Ship — Rally Pro engineering workflows (handoff)

- **Added on:** 2026-07-02
- **Status:** Active — v2 (post gap-analysis, post pglite substrate, post skills-registry update)
- **Purpose:** self-contained operating manual so any fresh Claude session can run the
  three pipelines without this conversation's context.
- **Companions:** [`scoring-tournament-spec.md`](scoring-tournament-spec.md) (feature
  source of truth), repo `CLAUDE.md` (auto-loaded; deploy/commit hard gates),
  `audits/` (living audit docs).

---

## 0. Bootstrap for a fresh session

1. `CLAUDE.md` auto-loads — it owns the deploy config, invariants, and hard gates.
   This doc does not duplicate site IDs / env tables; it references them.
2. Read `docs/plans/scoring-tournament-spec.md` (WS0–WS4 plan, §5 engine design, §8 invariants).
3. Reproduce the test state: `pnpm test` (expect §2's intentional RED) and
   `pnpm test:integration` (expect green).
4. **Standing user authorizations (do NOT re-ask):**
   - Adversarial review runs as **parallel Workflow fan-outs, as often as needed**.
   - Integration substrate = **pglite in vitest** (managed Supabase branch was
     paywalled — Pro plan; user explicitly chose pglite instead).

---

## 1. Hard rules (never bypass; source: CLAUDE.md + user memory)

| Rule | Detail |
|---|---|
| **Deploy gate** | Only the literal words **"deploy" / "ship it" / "go live" / "push live"** in the *current* message authorize a deploy. Bare "deploy" → ask which platform (Netlify / Cloudflare / Deno, multiSelect). "deploy to all" → all three. |
| **Commit gate** | Before *asking* to commit: build + typecheck + tests green, code review done, whole-app test pass, and a **400-point ELI5 "new-CTO" HTML audit** generated and presented *with* the ask. The commit itself still needs literal **"commit" / "ship it"**. |
| **`--no-build`** | Netlify deploys always ship a pre-built artifact with `--no-build`, then live smoke test (public `/` → 200, admin `/` → 303). Dropping it has gutted prod twice. |
| **Kartik artifacts** | Reddit-thread HTML, ELI5, zero jargon (no serverless/MAU/jsonb/RPC-speak). |
| **No `/admin/*` links** | Public app never links admin paths (middleware 404s them). |
| **pnpm** | Always pnpm. Windows quirk: if `pnpm build` fails env-only, use `pnpm --config.verify-deps-before-run=false exec astro build`. |
| **No human-time estimates** | Sequence + dependency only. |
| **Audits are living docs** | Every audit state transition (status flip, verified date, counters) lands **in the same commit as the work**. |
| **Pre-deploy ER-audit gate** | Re-verify the ER audit's claims + bump `ER_LAST_VERIFIED` in the deploy's commit arc (checklist in CLAUDE.md). |

---

## 2. State snapshot (as of 2026-07-02)

- **Worktree:** `.claude/worktrees/serene-wiles-8da646`, branch `cc/serene-wiles-8da646`. Nothing committed this arc.
- **Unit suite** (`pnpm test`): 688 pass, **9 fail + 1 todo — intentional test-first RED**:
  - `tests/scoring-format-options.test.ts` — WS0/WS2 contract (mini-set `gamesPerSet`, deciding-set `match_tiebreak_10`, scoped relaxation). 9 RED + 1 todo (mini-set TB rule, open product question).
  - `tests/scoring-live.test.ts` — WS3 contract; fails at import until `src/lib/scoring/live.ts` exists.
  - **Consequence — procedural, not physical:** RED blocks `pnpm build` (the pnpm
    lifecycle `prebuild` hook). But `node ./scripts/build.mjs` invoked directly
    **skips prebuild** and builds green even with a RED suite, and the sanctioned
    `--no-build` deploy path never runs tests. The gate that actually blocks a
    ship is §5 gate 2 (`pnpm verify`) — do not treat "the build passed" as proof
    tests ran. Policy: RED must not outlive its workstream arc (see §3 lane A1).
- **Integration suite** (`pnpm test:integration`): **7/7 green across 2 files**
  (`schema-loads` + `casual-match-rpc`) — pglite harness
  (`tests/integration/harness.ts`) applies all 64 `supabase/migrations`, shims
  `auth.uid()`/roles, and runs the **real `log_casual_match` RPC**. One test
  deliberately **pins the gap**: the DB accepts an illegal `8-6` tennis set today
  (score legality is TS-only). It flips to `.rejects` when WS0 lands
  `validate_score()` in SQL — that flip is the acceptance criterion.
- **Deployed this arc:** `https://rally-invest.netlify.app` (investor report portal,
  React Router SPA). **Soft gate:** access codes + all report content ship in the
  client bundle — treat everything in `report-portal/` as public.
- **Uncommitted concerns — slice into separate commit arcs, each passing §5 gates:**
  1. Report-portal: Kartik scoring thread + portal tweaks + `_redirects` + `netlify.toml`.
  2. Test substrate: `tests/integration/*`, `vitest.integration.config.ts`, `vitest.config.ts` exclude, `package.json` script + pglite dep.
  3. Scoring RED contract tests (land WITH the WS0 implementation, not before).
  4. Docs: `docs/plans/*`, audit HTML.
- **Gate sequencing for these arcs (resolves the RED-vs-gate conflict):**
  preferred order is **WS0 lands first** (suite green), then the other arcs commit
  cleanly. If an arc must ship *before* WS0: its unit gate is
  `pnpm exec vitest run --exclude tests/scoring-format-options.test.ts --exclude tests/scoring-live.test.ts`
  (must be 100% green) plus the normal lint/css/fmt gates; the **only** tolerated
  failures in the full suite are those two named contract files, and they are
  committed exclusively in the WS0 arc, together with the implementation that
  turns them green.
- **Open product decisions:** groups flexibility (gates WS4 form); mini-set tie-break at 4-4 (gates one WS2 assertion, pinned as `it.todo`).

---

## 3. Pipeline A — BUILD (run per workstream, never big-bang)

Driver skill: **`/feature-dev:feature-dev`** (codebase understanding + architecture).
Three lanes by change type — TDD is lane-specific, not universal:

### A1 — Pure logic (`rules.ts`, `live.ts`, helpers)
1. **Contract tests first (RED)** — new test files only; never edit the 113 frozen
   scoring tests (`tests/scoring-rules*.test.ts`). `/tdd` enforces the discipline.
2. **Map consumers before widening a shared API** — Grep +
   `feature-dev:code-explorer` for every caller (e.g. `validateScore` feeds
   casual / friendly / tournament paths; two divergent score models exist).
3. Implement to green.
4. **Simplify after green only** (`/simplify` or `code-simplifier` agent), then full
   re-test. Never simplify-then-ship a correctness-critical state machine untested.
5. RED discipline: a RED contract must land in the same arc as its implementation.
   If a decision blocks an assertion, park it as `it.todo` + a spec §9 entry —
   don't leave the suite failing across sessions.

### A2 — Schema (`supabase/migrations/`)
1. Write the migration **expand-contract**: additive + nullable first; destructive
   steps ship in a *later* deploy than the code that stops using them (so
   `restoreSiteDeploy` rollback never strands the schema).
2. Prove it applies: `pnpm test:integration` (the harness replays ALL migrations —
   a broken one fails the suite) + an integration test for the new CHECK/RPC.
3. Regenerate `src/lib/db/types.ts` (Supabase MCP `generate_typescript_types`) —
   same commit.
4. Sync ER audit + `audits/index.html` — same commit.
5. After the migration reaches the cloud DB: `get_advisors` (security + performance).

### A3 — Net-new UI (live scorer, group forms)
1. **Design first:** `/frontend-design` or `/design-consultation` *before* code —
   `/design-review` and `/impeccable` audit built UI, they can't design unbuilt UI.
2. Build on island conventions; obey the text-color token-pairing invariant
   (CLAUDE.md; `lint:css` enforces).
3. Verify with `preview_*` tools + `/webapp-testing`; polish with `/impeccable`
   → `/design-review`.

---

## 4. Pipeline B — REVIEW (layers cheap→expensive, then adversarial, then fix-loop)

Scope all code review to the **working-tree diff**, not the repo.

| Layer | Command / tool | Catches | Blind to |
|---|---|---|---|
| Unit / contract | `pnpm test` (<2 s) | TS logic, scoring legality, API handler contracts (RPCs stubbed) | SQL, RLS, UI |
| Integration | `pnpm test:integration` (pglite) | real RPC bodies, CHECK constraints, triggers, migration replay | **RLS — pglite runs superuser, policies don't bind** |
| System | `node ./scripts/build.mjs` (local artifact) · `node scripts/smoke.mjs` | build integrity locally. **Caution:** `smoke.mjs` hits the **deployed prod URLs** (hardcoded; `--site=<url>` to override) — pre-deploy it only baselines the *previous* deploy. To smoke the new artifact, serve it locally (`astro preview` / `netlify dev`) and pass `--site=`. New-bundle proof lives in §5 step 7's post-deploy smoke. | logic depth |
| E2E | `pnpm test:e2e` (`e2e/`) via `/webapp-testing` | user flows. Authed flows: the `storageState` fixture **already exists** (`e2e/auth.setup.ts` → `e2e/.auth/user.json`; specs self-skip without creds) — the WS3 prerequisite is only provisioning a test player account + setting `E2E_EMAIL` / `E2E_PASSWORD`, not building fixture code | perf |
| Performance | Lighthouse mobile (chrome-devtools MCP) on `/` + changed surfaces: a11y = 100, BP = 100, SEO ≥ 90, LCP < 2.5 s, CLS ≤ 0.05; `grep` changed classes in `dist/_astro/*.css` | regressions | — |
| DB posture | Supabase MCP `get_advisors` (security + perf) | missing RLS / indexes on new tables & columns | logic |
| QA | `/qa` (gstack) | exploratory, user-reported | — |
| Code review | `/code-review` (pick effort; `--fix` optional) or `/review`; `pr-review-toolkit:*` agents for silent-failures / comments / type design | bugs, conventions, silent failures | — |
| Security | `/security-review` on the branch | injection, authz, secrets | — |
| Adversarial | parallel Workflow fan-out — template §6 | plausible-but-wrong, threat-model attacks | — |

**RLS hole — stated honestly:** no layer executes RLS policies today (pglite =
superuser; api tests stub the client). Mitigation: advisors catch *missing* RLS,
human review covers policy *logic*. A `set role authenticated` + grants extension
to the harness is the eventual fix; do not claim RLS coverage until it exists.

**Fix-loop convergence:** every confirmed finding → failing regression test → fix →
prove the flip → re-run the adversarial pass **until a dry round** (zero new
findings). Fixes without regression tests don't count.

**Threat model to feed adversarial agents (this feature):**
RPC bypass of TS validation · format-lock bypass after start (direct write) ·
live-scoring races (double-tap, two devices, refresh mid-point) · group integrity
(KO seeded from unfinished groups; standings tampering) · `score_events`
undo/replay abuse · legacy rows with `match_format = null` (must read as classic
Bo3 full-set).

---

## 5. Pipeline C — SHIP-READY (per commit arc)

1. **Slice**: one concern per commit arc (see §2 list).
2. **Gates**: `pnpm verify` (lint + css-lint + fmt + unit — **this is the test
   gate**; `scripts/build.mjs` skips the prebuild test chain) · `pnpm
   test:integration` · build green (`node ./scripts/build.mjs`) · `pnpm typecheck`
   (advisory — ~477 known Supabase `never` errors don't block).
3. **Secrets pass on the diff** — no keys/credentials. Reminder: `report-portal/`
   is public-by-design (soft gate); never put anything there you wouldn't publish.
4. **Evidence**: screenshots tied to acceptance criteria (not decorative). Live
   scoring example: the deuce → adv → game → set → 10-8 match-TB sequence, plus
   final `score.sets` equal to the result-entry path (the equivalence invariant).
5. **Artifacts (both, before asking):**
   - **CTPO** = the 400-point ELI5 new-CTO HTML audit (this *is* the commit-gate artifact) — what was built, bugs found, how fixed, verification evidence.
   - **CEO** = Kartik Reddit-thread HTML (zero jargon), per the established design (`audits/rallypro-money-thread-kartik-2026-06-01.html` reference).
6. **Ask commit** with the audit presented. Wait for the literal word.
7. **Deploy** (own literal-word gate; ask platform if unnamed):
   pre-built artifact + `--no-build` → per-site smoke (public 200 / admin 303) →
   after any `@supabase/*` bump, check `.netlify/v1/functions/ssr/node_modules/@supabase/`
   for dropped transitives → after any Astro-ecosystem bump, re-pin the
   `@astrojs/internal-helpers` symlink patch + `pnpm-workspace.yaml`
   `patchedDependencies` (procedure in CLAUDE.md — a stale patch ships a gutted
   SSR bundle) → ER-audit verification gate → bundle class grep.
   **Report-portal arc ships on its own lane:** `cd report-portal` → `pnpm build`
   (react-router) → its own `pnpm typecheck` → deploy **from inside
   `report-portal/`**: `netlify deploy --prod --no-build --dir=build/client
   --site=rally-invest`. Never deploy it from repo root — a root-run deploy once
   bundled the main app's scheduled functions (why `report-portal/netlify.toml`
   pins `functions.directory = "no-functions"`).
8. **Post-deploy**: fresh-viewport console check + surface screenshot; verify any
   shipped migration via `execute_sql`; optional `/canary` monitoring.
9. **Rollback**: `netlify api restoreSiteDeploy` for the app; expand-contract (§3 A2)
   guarantees the schema tolerates it.
10. **Docs in the same arc**: audits sync, `app-plan-spec.md` milestone,
    `/document-release` if user-facing.

---

## 6. Adversarial fan-out — template + ops notes

Standing authorization: run as a parallel Workflow, as often as needed.

**Mechanism:** the Claude Code harness **`Workflow` tool** — an inline JS
orchestration script (`agent()` / `parallel()` / `pipeline()`, schema-validated
returns, `resumeFromRunId` phase caching). It is a harness *tool*, not a skill —
look for `Workflow` in your tool list, not the skills registry. If your harness
lacks it, fallback: parallel `Agent` fan-outs in batches of ≤6 with manual
dedupe and per-finding re-verification (you lose phase caching — budget for
re-runs).

**Shape:** finders (one per threat-model dimension) → dedupe vs `seen` →
per-finding 3-lens verify (correctness / security / does-it-reproduce), kill on
majority-refute → survivors get regression tests → loop until a dry round.

**Ops lessons (2026-07-02, learned the expensive way):**
- A 26-agent verify wave hit provider rate limiting and lost the entire
  verify + synthesize output. **Cap verify waves (~6 concurrent), run in
  batches, retry once after a backoff.**
- Workflow phases cache: on failure, resume with `resumeFromRunId` — completed
  map/find phases replay free; only the failed phase re-runs.
- Embed all needed context in agent prompts (subagents have no session memory);
  use `schema` for structured returns so nothing needs re-parsing.

---

## 7. Skill / tool routing (registry-verified 2026-07-02)

The named skills **are installed** in this environment — invoke them directly
(an earlier session note claiming otherwise is obsolete):

| Step | Primary | Support |
|---|---|---|
| Build driver | `/feature-dev:feature-dev` | `feature-dev:code-architect` / `code-explorer` agents |
| TDD discipline | `/tdd` | — |
| UI design (before code) | `/frontend-design`, `/design-consultation` | `/design-shotgun` for options |
| UI polish (after built) | `/impeccable` | `/design-review` |
| Browser / e2e testing | `/webapp-testing` | `preview_*` tools, `/qa` |
| Simplify (after green) | `/simplify` | `code-simplifier` agent |
| Code review | `/code-review` (effort levels, `--fix`) | `/review` (gstack), `pr-review-toolkit:*` agents |
| Security | `/security-review` | `/cso` |
| Change verification | `/verify`, `/run` | — |
| Ship | `/ship`, `/land-and-deploy` — **still subject to the literal-word gates** | `/canary` post-deploy |
| Investigation | `/investigate` | — |
| Adversarial orchestration | `Workflow` **tool** (harness — see §6) | fallback: batched parallel `Agent` calls |

---

## 8. factstack (optional enhancer — not yet wired)

- **Current state:** the factstack MCP is analyzing **its own repo**, not Rally Pro
  (`FACTS_ROOT` defaults to the server's cwd — read site
  `apps/mcp-server/src/server.ts:184` in factstack's tree). Its dashboard's
  "6 secrets exposed" are factstack's own scanner **test fixtures** — not Rally
  Pro leaks. **Every factstack read is about the wrong repo until re-pointed.**
- **To wire in:** set `FACTS_ROOT=<this worktree>` in the MCP server config →
  `analyze` (writes `.facts/` + a snapshot baseline) → then:
  1. `get_context` / `query_graph verb:impact` — blast radius before touching shared code (Pipeline A step A1-2).
  2. `review_change format:markdown` — one change-verdict per review arc (new secrets / CVEs / cycles + blast radius) in Pipeline B.
  3. `list_vulnerabilities refresh:true` — OSV CVE sweep in the ship gate (pairs with the @supabase transitive-deps hazard).
  4. `get_config` — env-var read-site matrix, checked against both Netlify sites' env tables before deploy.
- **Honest non-uses:** it cannot execute SQL/RPCs (pglite owns integration truth);
  it is not a secrets scanner for *our* commits until re-pointed; it never replaces
  tests. (A deeper 26-candidate verification workflow was cut short by rate
  limiting; the 4 uses above are verified against the live tool schemas.)

---

## 9. Workstream order + immediate next actions

```
WS0 (engine options + match_format + validate_score() in SQL)   ← DO FIRST:
 │   turns the 9 unit RED green AND flips the integration GAP test
 ├─> WS1 quick wins (req 7 sticky-0, req 8 set-count lock, req 10 "Create draw")
 └─> WS2 format UI (pre-start step, lock on start)
        ├─> WS3 live engine (long pole; /frontend-design consult first + provision
        │    the e2e test account — fixture code already exists, see §4 E2E row)
        └─> WS4 groups (BLOCKED on groups-flexibility decision — ask before building the form)
```

Each workstream runs A → B → C end-to-end before the next starts (WS3 ∥ WS4 allowed).

---

## 10. Key file index

| File | Role |
|---|---|
| `docs/plans/scoring-tournament-spec.md` | Feature spec — locked decisions, WS0–WS4, invariants |
| `src/lib/scoring/rules.ts` | Scoring engine (extend `{bestOf}` → `{bestOf, gamesPerSet, finalSet, noAd}`) |
| `tests/scoring-rules*.test.ts` | 113 frozen tests — protect, never edit |
| `tests/scoring-format-options.test.ts` | WS0/WS2 RED contract |
| `tests/scoring-live.test.ts` | WS3 RED contract → designs `src/lib/scoring/live.ts` |
| `tests/integration/harness.ts` | pglite substrate (bootstrap prelude + replica-mode migration replay) |
| `tests/integration/casual-match-rpc.test.ts` | Real-RPC proof + the score-legality GAP pin |
| `tests/integration/schema-loads.test.ts` | Migration-replay + auth-shim smoke (the other half of "7/7") |
| `e2e/auth.setup.ts` | Existing authed-e2e storageState fixture (needs `E2E_EMAIL`/`E2E_PASSWORD`) |
| `report-portal/netlify.toml` | Scopes portal deploys; prevents root-functions bundling |
| `supabase/migrations/20260517201629_phase3_casual_match_log.sql` | `log_casual_match` (dead `p_best_of` to wire in WS0) |
| `src/islands/FriendlyTournamentForm.tsx` | WS4 surface (`single_elim` gate at ~L262) |
| `audits/rallypro-scoring-tournament-thread-kartik-2026-07-01.html` | Kartik thread (deployed on rally-invest) |
| `report-portal/` | Investor portal SPA — public-by-design soft gate |

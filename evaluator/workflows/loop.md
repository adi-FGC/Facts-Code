# Build → Review → Ship — a reusable, cross-project operating manual

- **Status:** Active — v5 (honesty + self-containment pass: `preflight.sh` now ships a real, shown `--self-test` branch — the claim and the code finally match; every "drop-in / runnable" assertion is scoped to exactly what the shown scripts implement, with the semantic gaps named rather than papered over).
- **Purpose:** a **self-contained** operating manual a fresh agent session (zero prior conversation context) can run **unattended on ANY project**. It ships as two parts: this **playbook** (project-agnostic pipelines + gate *mechanisms*) and a **PROJECT PROFILE** (§0) that fills in one project's literals. The pipelines reference profile keys (`${...}`), never hardcoded hosts/DBs/paths.
- **To adopt for a new project:** fill in **every `${...}` key in §0** (Appendix A is a complete filled example you can copy the *shape* from), drop the gate scripts from §11 into `${SCRIPTS_DIR}` — **they run once you pick your test-runner's parser and host's URL-printer in §11.4, both of which ship pre-written for vitest/jest/pytest/go and Netlify/Cloudflare/Deno** — run `preflight.sh --self-test` (a real branch, shown in §11.1) to prove the wiring, then delete any profile row marked *N/A*. Nothing else in §§1–10 should need editing.
- **Reading this cold:** §0 is the only project-specific section. §§1–10 are generic. If a step names a `${KEY}` you have not filled, STOP and fill §0 — do not guess. Appendix A shows every key filled for a reference stack so you never have to *invent* a value's shape.
- **What the scripts do and do NOT do (read this before trusting them):** the §11 scripts enforce the **mechanically checkable** gates only — audit-file-dated-today exists, the failing-test set equals the allowlist exactly, a literal deploy word is present, the prebuilt flag is hardcoded, smoke targets the parsed new-deploy URL. They **cannot** judge *semantic* quality (was the review thorough? is the audit honest? is the RED set intentional?) — those still need `${AGENT_RULES_FILE}` + human judgment (§11 closing note). "Drop-in runnable" throughout means *these mechanical checks run without you authoring new code*; it never means the scripts vouch for correctness they cannot see.

---

## 0. PROJECT PROFILE (the ONLY project-specific section — fill this in)

> Every value below is a placeholder the generic pipelines reference by key. **Fill each row before running any pipeline.** The right column shows the example values for the reference project (RallyPro) purely to illustrate the *shape* — replace them. **Appendix A** shows the *entire* profile filled in as one coherent, copy-pasteable example (env exports + allowlist file + script config), so a fresh session never has to author a value from scratch — only substitute its own repo's facts.
>
> **Verification rule (do this once per fresh session, before trusting any value):** the profile is *point-in-time* and drifts. Before relying on a `${KEY}`, confirm it against the live repo (grep the script, open the config, run `--help`). Values marked **[as-of DATE — re-verify]** are especially volatile (test counts, deploy statuses, fixture existence). Treat a mismatch as a profile bug to fix, not a step to skip.

### 0.1 Stack + tooling keys

| Key | Meaning | Example (RallyPro — replace) |
|---|---|---|
| `${PKG}` | package manager + run prefix | `pnpm` |
| `${TEST_CMD}` | full unit/contract suite | `pnpm test` |
| `${TEST_RUNNER}` | which runner (selects the §11.4 parser) | `vitest` |
| `${TEST_INTEGRATION_CMD}` | integration suite | `pnpm test:integration` |
| `${TEST_E2E_CMD}` | e2e suite | `pnpm test:e2e` |
| `${TYPECHECK_CMD}` | typecheck (note if advisory) | `pnpm typecheck` (advisory — ~477 known Supabase `never` errors do not block) |
| `${VERIFY_CMD}` | lint+css+fmt+unit combined test gate | `pnpm verify` |
| `${BUILD_CMD}` | local production build → artifact | `node ./scripts/build.mjs` |
| `${BUILD_SKIPS_TESTS?}` | does the build path run tests? | **NO** — `build.mjs` skips the `prebuild` hook; `--no-build` deploy runs no tests either. The test gate is `${VERIFY_CMD}`, never "the build passed". |
| `${SCRIPTS_DIR}` | where gate scripts (§11) live | `scripts/gates/` |
| `${CONTEXT_TOOL}` | cheap-context/blast-radius tool (§ token-efficiency) | `factstack` (see §8) |

### 0.2 Deploy + hosting keys

| Key | Meaning | Example (RallyPro — replace) |
|---|---|---|
| `${DEPLOY_TARGETS[]}` | every deploy path, each with its own command | Netlify (main app) · Netlify (portal, separate lane) · Cloudflare · Deno |
| `${DEPLOY_CMD(target)}` | exact command incl. **all mandatory flags/tokens** | main: `NETLIFY_AUTH_TOKEN=$NETLIFY_AUTH_TOKEN netlify deploy --prod --no-build --dir=dist --site=${SITE_ID_MAIN}` · portal: `cd report-portal && NETLIFY_AUTH_TOKEN=$… netlify deploy --prod --no-build --dir=build/client --site=${SITE_ID_PORTAL}` |
| `${PREBUILT_FLAG}` | the flag that ships the pre-built artifact | `--no-build` (dropping it has gutted prod twice — it is mandatory, not optional) |
| `${SITE_ID_*}` | site/project IDs per target | `${SITE_ID_MAIN}` (define in profile — it was never in CLAUDE.md), `${SITE_ID_PORTAL}=rally-invest` |
| `${DEPLOY_URL_CMD(target)}` | command that prints the **just-shipped** deploy URL (feeds smoke — see §11.4 `new_deploy_url`) | Netlify: parse `deploy_url`/`deploy_ssl_url` from `netlify api getSite` or the JSON the deploy command emits with `--json`; see §11.4 for the ready-made parser |
| `${SMOKE_CMD(url)}` | post-deploy smoke against a **given URL** | `node scripts/smoke.mjs --site=<url>` (see obs note in §5.8 — the default hits the *previous* prod URL, so you MUST pass the new one) |
| `${SMOKE_EXPECT}` | expected responses, **verified against the script** | public `/` → 200; admin `/` → **200 [as-of DATE — the prose doc once said 303 but `smoke.mjs` asserts 200; the script is source of truth — re-grep `smoke.mjs` and reconcile the doc if it still disagrees]** |
| `${ROLLBACK_CMD(target)}` | redeploy previous good build | `netlify api restoreSiteDeploy --data '{...}'` |
| `${SECRET_ENV[]}` | required deploy env/secrets (never logged/committed) | `NETLIFY_AUTH_TOKEN`, Supabase keys |

### 0.3 Data-layer keys

| Key | Meaning | Example (RallyPro — replace) |
|---|---|---|
| `${DB}` | database + migration mechanism | Supabase / Postgres, `supabase/migrations/*` |
| `${MIGRATION_DIR}` | migration source of truth | `supabase/migrations/` |
| `${INTEGRATION_SUBSTRATE}` | how integration tests get a DB | pglite in vitest (managed branch was paywalled; user chose pglite) |
| `${RLS_STATUS}` | does the review stack execute auth/RLS policies? | **NO** — pglite runs superuser; api tests stub the client. See §4 RLS blind spot. |
| `${TYPES_REGEN_CMD}` | regenerate DB→TS types | Supabase MCP `generate_typescript_types` |
| `${DB_ADVISOR_CMD}` | security+perf posture check | Supabase MCP `get_advisors` |

### 0.4 Convention keys (from the project's own `${AGENT_RULES_FILE}`)

| Key | Meaning | Example (RallyPro — replace) |
|---|---|---|
| `${AGENT_RULES_FILE}` | auto-loaded rules file that owns hard gates | `CLAUDE.md` (+ user global). **This manual restates the mechanically-checkable gates as runnable scripts (§11); it does not silently defer to prose.** |
| `${DEPLOY_WORDS[]}` | literal words that authorize a deploy | "deploy" / "ship it" / "go live" / "push live" |
| `${COMMIT_WORDS[]}` | literal words that authorize a commit | "commit" / "ship it" |
| `${AUDIT_ARTIFACT}` | the required pre-commit audit | 400-point ELI5 "new-CTO" HTML audit (CTPO) |
| `${CEO_ARTIFACT}` | the plain-language stakeholder artifact | Kartik Reddit-thread HTML, zero jargon |
| `${PUBLIC_BY_DESIGN[]}` | dirs whose contents ship to clients (soft gate) | `report-portal/` — access codes + report content are in the client bundle; treat as public |
| `${STYLE_INVARIANTS[]}` | lint-enforced invariants | text-color token-pairing (`lint:css`); no `/admin/*` links in public app |

### 0.5 Live state snapshot — **[as-of DATE — re-run to confirm; NOT load-bearing constants]**

Record the *shape* here; treat the numbers as stale until re-run. Example capture:
- Worktree/branch: `${WORKTREE}` / `${BRANCH}`.
- Unit suite: `N pass, K intentional-RED (test-first)` — list the exact RED files in `${KNOWN_RED_TESTS_FILE}` (see §11.2 allowlist gate). Example: `688 pass, 9 fail + 1 todo`; RED files `tests/scoring-format-options.test.ts`, `tests/scoring-live.test.ts`.
- Integration suite: `M/M green` across which files.
- Fixtures that **generate on setup, do not exist yet**: e.g. `e2e/.auth/user.json` (created by `e2e/auth.setup.ts`; specs self-skip without `E2E_EMAIL`/`E2E_PASSWORD`). Do **not** assert it exists.
- Deployed this arc / open product decisions.

---

## 1. Hard rules (enforced by §11 scripts where mechanically checkable — not honor-system)

Prose rules that a single skipped read would erase are **converted to fail-closed checks in §11**. The table says which mechanism enforces each.

| Rule | Enforcement |
|---|---|
| **Deploy gate** | Only a literal `${DEPLOY_WORDS[]}` word in the *current* message authorizes a deploy. **Mechanism:** `ship.sh` (§11.3) refuses unless invoked with `--authorized="<word>"` AND that word ∈ `${DEPLOY_WORDS[]}`; a bare word prompts for target when `${DEPLOY_TARGETS[]}`>1. Never carries forward from an earlier turn. |
| **Commit gate** | Before *asking* to commit: `${VERIFY_CMD}`-equivalent green (via §11 allowlist gate), whole-app test pass, review done, and a **`${AUDIT_ARTIFACT}` dated today** generated + presented *with* the ask. **Mechanism:** `preflight.sh` (§11.1) greps `${AUDIT_DIR}` for an audit file dated today and fails closed if absent. Commit still needs a literal `${COMMIT_WORDS[]}` word. |
| **Every deploy path routes through ONE gate** | No path may skip tests. **Mechanism:** `ship.sh` runs `preflight.sh` first for *every* `${DEPLOY_TARGETS[]}` (Cloudflare/Deno/portal included), then dispatches `${DEPLOY_CMD(target)}` with `${PREBUILT_FLAG}` hardcoded. There is no "build passed ⇒ tests ran" path (`${BUILD_SKIPS_TESTS?}`). |
| **Known-RED allowlist** | The suite may be RED by design (test-first). The gate passes **only if the failing set is EXACTLY the contents of `${KNOWN_RED_TESTS_FILE}`** — any extra failure fails closed. **Mechanism:** `verify-gate.sh` (§11.2) + the ready-made runner parser (§11.4). This replaces the trap where `${VERIFY_CMD}` "the test gate" can never pass pre-implementation. |
| **Pre-built artifact + flag** | Every deploy ships a pre-built artifact with `${PREBUILT_FLAG}`; hardcoded in `ship.sh`, not typed by hand. |
| **Audits are living docs** | Every audit state transition lands **in the same commit as the work**. |
| **Public-by-design dirs** | Never place anything in `${PUBLIC_BY_DESIGN[]}` you would not publish (soft gate; `preflight.sh` warns on secret-shaped strings in the diff there). |
| **No human-time estimates** | Sequence + dependency only. |

> If `${AGENT_RULES_FILE}` and this manual conflict, `${AGENT_RULES_FILE}` (and the user's global rules) win — they own the ultimate gate. This manual's job is to make the mechanically-checkable subset *fail closed* instead of resting on memory.

---

## 2. Reading the live state (do NOT trust numbers cold)

The old §2 asserted `688 pass / 9 fail` as fact. **That drifts.** Instead:

1. Run `${TEST_CMD}` and `${TEST_INTEGRATION_CMD}` yourself; record the result in §0.5 with today's date.
2. Confirm the RED set equals the contents of `${KNOWN_RED_TESTS_FILE}` via `verify-gate.sh` (§11.2). If it does not, you have found a *real* regression or the allowlist is stale — resolve before proceeding.
3. Slice uncommitted work into **separate commit arcs, each passing §5 gates**. Land test-first RED contracts **in the same arc as the implementation that turns them green** — never leave the suite RED across sessions.

---

## 3. Pipeline A — BUILD (per workstream, never big-bang)

Driver skill: `/feature-dev:feature-dev` (codebase understanding + architecture). Three lanes by change type — TDD is lane-specific, not universal.

**Before touching shared code (all lanes):** run the cheap blast-radius query (§8) — `${CONTEXT_TOOL} query impact <file>` — to map consumers in ~50 tokens instead of grep+open-every-hit. Fall back to Grep + `code-explorer` if unavailable.

### A1 — Pure logic (`rules`, `live`, helpers)
1. **Contract tests first (RED)** — new test files only; never edit frozen suites (list them in §0). `/tdd` enforces the discipline.
2. **Map consumers before widening a shared API** (§8 blast-radius, or Grep + `code-explorer`).
3. Implement to green.
4. **Simplify after green only** (`/simplify` or `code-simplifier`), then full re-test. Never simplify-then-ship an untested correctness-critical state machine.
5. RED discipline: a RED contract lands in the *same arc* as its implementation. If a decision blocks an assertion, park it as `it.todo` + a spec entry — never a cross-session failing suite.

### A2 — Schema (`${MIGRATION_DIR}`)
1. Write the migration **expand-contract**: additive + nullable first; destructive steps ship in a *later* deploy than the code that stops using them (so code rollback never strands the schema).
2. **DATA/backfill reverse-plan (mandatory):** if the migration transforms or backfills existing rows, write the **reverse transform in the same arc** — a down-migration or a documented recovery query that restores prior values (or an explicit "irreversible: snapshot `${TABLE}` before applying" note + the snapshot command). Code rollback does **not** undo committed data changes; this is the only thing that does. No backfill ships without its reverse.
3. Prove it applies: `${TEST_INTEGRATION_CMD}` (harness replays ALL migrations — a broken one fails the suite) + an integration test for the new CHECK/RPC.
4. Regenerate types (`${TYPES_REGEN_CMD}`) — same commit.
5. Sync any ER/schema audit — same commit.
6. After the migration reaches the live DB: `${DB_ADVISOR_CMD}` (security + performance).

### A3 — Net-new UI
1. **Design first:** `/frontend-design` or `/design-consultation` *before* code — `/design-review` and `/impeccable` audit built UI, they cannot design unbuilt UI.
2. Build on the project's conventions; obey `${STYLE_INVARIANTS[]}` (lint-enforced).
3. Verify with `preview_*` tools + `/webapp-testing`; polish with `/impeccable` → `/design-review`.

---

## 4. Pipeline B — REVIEW (cheap→expensive, then adversarial, then fix-loop)

Scope all code review to the **working-tree diff**, not the whole repo. **Layer 0:** run `${CONTEXT_TOOL} review` (§8) for a single cheap risk verdict (diff + blast radius + new CVEs/secrets/cycles) *before* the expensive layers — it tells you which layers matter for this diff.

| Layer | Command / tool | Catches | Blind to |
|---|---|---|---|
| Cheap-context | `${CONTEXT_TOOL} review` (§8) | blast radius, new secrets/CVEs/cycles at ~zero token cost | anything requiring execution |
| Unit / contract | `${TEST_CMD}` | TS logic, business-rule legality, handler contracts (RPCs stubbed) | SQL, RLS, UI |
| Integration | `${TEST_INTEGRATION_CMD}` (`${INTEGRATION_SUBSTRATE}`) | real RPC bodies, CHECK constraints, triggers, migration replay | **RLS — if `${RLS_STATUS}`=NO, policies don't bind (superuser)** |
| System | `${BUILD_CMD}` · `${SMOKE_CMD(local-url)}` | local build integrity. **Caution:** smoke defaults to the **deployed prod URL** — pre-deploy it only baselines the *previous* deploy. To smoke the new artifact, serve it locally and pass `--site=<local>`. New-bundle proof is §5.8. | logic depth |
| E2E | `${TEST_E2E_CMD}` via `/webapp-testing` | user flows. Authed flows need `${E2E_CREDS}`; the storageState fixture **generates on setup, does not pre-exist** — provision a test account, do not assume the file is there | perf |
| Performance | Lighthouse mobile (chrome-devtools MCP) on `/` + changed surfaces: a11y=100, BP=100, SEO≥90, LCP<2.5s, CLS≤0.05; grep changed classes in the built CSS | regressions | — |
| DB posture | `${DB_ADVISOR_CMD}` | missing RLS / indexes on new tables/cols | logic |
| QA | `/qa` | exploratory, user-reported | — |
| Code review | `/code-review` (effort; `--fix`) or `/review`; `pr-review-toolkit:*` agents | bugs, conventions, silent failures | — |
| Security | `/security-review` on the branch | injection, authz, secrets | — |
| Adversarial | parallel fan-out — §6 template | plausible-but-wrong, threat-model attacks | — |

**RLS/auth blind spot — stated honestly:** if `${RLS_STATUS}`=NO, **no layer executes auth/RLS policies** (superuser substrate; api tests stub the client). Mitigation: advisors catch *missing* RLS; human review covers policy *logic*. A `set role authenticated` + grants extension to the harness is the eventual fix; **do not claim RLS coverage until it exists.**

**Fix-loop convergence:** every confirmed finding → failing regression test → fix → prove the flip → re-run the adversarial pass **until a dry round** (zero new findings). Fixes without a regression test do not count.

**Threat model to feed adversarial agents** — derive per feature. Generic starter dimensions (specialize each): validation-bypass at a lower layer than the check (e.g. RPC bypassing TS validation) · state-lock bypass after start (direct write) · concurrency races (double-submit, two devices, refresh mid-op) · aggregate/rollup integrity (derived state from incomplete inputs; tampering) · event-log undo/replay abuse · legacy/null rows read wrong by new code. Write the project's concrete list into §0 or the review arc's notes.

---

## 5. Pipeline C — SHIP-READY (per commit arc)

1. **Slice**: one concern per commit arc (§2).
2. **Gate — run `verify-gate.sh` (§11.2), not raw `${VERIFY_CMD}`.** The wrapper: runs `${VERIFY_CMD}` + `${TEST_INTEGRATION_CMD}` + `${BUILD_CMD}` + `${TYPECHECK_CMD}` (advisory), and **passes only if the failing test set == the contents of `${KNOWN_RED_TESTS_FILE}` exactly.** Any unexpected failure fails closed. This closes the "verify can never pass pre-implementation" trap and the "build passed ⇒ tests ran" trap in one place.
3. **Secrets pass on the diff** — no keys/credentials; `preflight.sh` (§11.1) greps the diff, with extra scrutiny on `${PUBLIC_BY_DESIGN[]}`.
4. **Evidence**: screenshots tied to acceptance criteria (not decorative) — e.g. the full state-machine happy path, plus proof that two code paths that must agree produce equal results (equivalence invariant).
5. **Artifacts (both, before asking):**
   - **`${AUDIT_ARTIFACT}`** (the commit-gate artifact) — what was built, bugs found, fixes, verification evidence. `preflight.sh` fails closed unless a copy dated **today** exists in `${AUDIT_DIR}`.
   - **`${CEO_ARTIFACT}`** — plain-language stakeholder HTML, zero jargon.
6. **Ask commit** with the audit presented. Wait for a literal `${COMMIT_WORDS[]}` word.
7. **Deploy** — `ship.sh --target=<t> --authorized="<word>"` (§11.3). It: re-runs `preflight.sh`, refuses without a valid `${DEPLOY_WORDS[]}` word, dispatches `${DEPLOY_CMD(target)}` with `${PREBUILT_FLAG}` hardcoded, **for every target** (Cloudflare/Deno/portal route through the *same* gate). Post-dispatch hooks: after any DB-client dep bump, check the SSR bundle's `node_modules` for dropped transitives; after any build-framework bump, re-verify any patched-dependency symlinks (a stale patch ships a gutted bundle); then the schema/audit verification gate + built-asset class grep. **Separate-lane targets** (e.g. a portal SPA) deploy from *inside* their own dir with their own build/typecheck/site-id — never from repo root (a root deploy once bundled the main app's scheduled functions).
8. **Post-deploy (targets the NEW artifact, not the previous deploy):** `${SMOKE_CMD(<new-deploy-url>)}` explicitly against the just-shipped URL — the URL comes from `new_deploy_url` (§11.4), which parses the deploy command's own output, so smoke can never silently hit the previous deploy → fresh-viewport console check + surface screenshot → verify any shipped migration via the DB (`execute_sql` or equivalent) → optional `/canary` monitoring. **Failure path:** if smoke fails, trigger §5.9 rollback immediately; do not leave a broken deploy live.
9. **Rollback (code + schema + DATA):**
   - **Code:** `${ROLLBACK_CMD(target)}` (redeploy previous good build).
   - **Schema:** expand-contract (§3 A2) guarantees the previous code tolerates the current schema.
   - **DATA/backfill:** run the **reverse transform written in §3 A2 step 2** (down-migration or recovery query), or restore from the pre-migration snapshot. Code rollback alone does **not** undo committed data changes — this step is mandatory whenever the arc backfilled/transformed rows.
10. **Docs in the same arc**: audits sync, milestone/spec update, `/document-release` if user-facing.

---

## 6. Adversarial fan-out — template with the concurrency cap BAKED IN

Standing authorization (if in `${AGENT_RULES_FILE}`): run as a parallel fan-out, as often as needed.

**Preferred mechanism — the harness `Workflow` tool** (inline JS: `agent()`/`parallel()`/`pipeline()`, schema-validated returns, `resumeFromRunId` phase caching). It is a *tool*, not a skill. If your harness lacks it, use the **fallback recipe** below.

**Shape (copy-pasteable — the ops lessons are encoded, not narrated):**
```
finders   = one agent per threat-model dimension (§4). Run parallel, no cap needed (cheap, independent).
dedupe    = merge finders' outputs against a `seen` set BEFORE verifying (kills duplicate work).
verify    = per-finding 3-lens (correctness / security / does-it-reproduce), majority-refute kills it.
            *** HARD CAP: <=6 concurrent verify agents. Batch the survivor list into waves of <=6. ***
            *** Each wave: retry ONCE after an exponential backoff on rate-limit/5xx. ***
            *** On phase failure: resume with resumeFromRunId — completed find/dedupe phases replay free. ***
returns   = every agent returns via `schema` (structured) so nothing is re-parsed.
loop      = survivors -> regression tests -> re-run finders until a DRY round (zero new findings).
```
Why the cap: a 26-agent verify wave once hit provider rate limiting and lost the **entire** verify+synthesize output. The cap + batch + retry + resume is the fix — it lives in the template now, not just in a footnote.

**Fallback recipe (harness has NO Workflow tool) — concrete, runnable:**
1. **Finders:** issue parallel `Agent`/`Task` calls, one per threat dimension. Embed ALL context in each prompt (subagents have no session memory). Ask each to return a JSON list of `{finding, location, why}`.
2. **Accumulate + dedupe manually:** collect finder JSON into one working list (append to a scratch file, e.g. `${SCRATCH}/adversarial-findings.json`); dedupe by (location, claim) yourself.
3. **Verify in batches of ≤6:** send at most 6 verify `Agent` calls at once, each re-checking one finding across the 3 lenses, returning `{verdict: confirm|refute, reproduce: bool}`. Wait for the batch, then send the next ≤6. **Retry a failed batch once after a short backoff.** You lose phase caching, so budget for the occasional re-run.
4. **Survivors → regression tests → loop** until a dry round. Persist the running `seen`/survivor set in the scratch file so a crash mid-loop resumes from disk, not from scratch.

---

## 7. Skill / tool routing

Invoke installed skills directly. Confirm availability in your environment's registry before relying on any row.

| Step | Primary | Support |
|---|---|---|
| Build driver | `/feature-dev:feature-dev` | `feature-dev:code-architect` / `code-explorer` |
| Cheap context / blast radius | `${CONTEXT_TOOL}` (§8) | Grep + `code-explorer` (fallback) |
| TDD discipline | `/tdd` | — |
| UI design (before code) | `/frontend-design`, `/design-consultation` | `/design-shotgun` |
| UI polish (after built) | `/impeccable` | `/design-review` |
| Browser / e2e | `/webapp-testing` | `preview_*`, `/qa` |
| Simplify (after green) | `/simplify` | `code-simplifier` |
| Code review | `/code-review` (effort, `--fix`) | `/review`, `pr-review-toolkit:*` |
| Security | `/security-review` | `/cso` |
| Change verification | `/verify`, `/run` | — |
| Ship | `ship.sh` (§11) → `/ship`/`/land-and-deploy` — **still subject to the literal-word gates** | `/canary` post-deploy |
| Adversarial orchestration | `Workflow` tool (§6) | §6 batched-`Agent` fallback |

---

## 8. Cheap-context / token-efficiency layer — `${CONTEXT_TOOL}` (factstack)

A whole-repo context + risk tool wired into Pipeline A (blast radius before edits) and Pipeline B (review Layer 0). It extracts a repo into `.facts/agent.pack` — a column-oriented context file **~40× smaller than source** (measured: 404KB / 115K tokens → 10KB / ~2.9K tokens on a 31-file repo, ~200ms; ratio grows with size, trivial repos hit a ~2.5KB floor and don't benefit).

**Highest-leverage commands (each ~1s):**
- `${CONTEXT_TOOL} analyze` → writes `.facts/` (`agent.pack` + risks + MEMORY.md); `--symbols` for the call graph.
- `${CONTEXT_TOOL} context "<task>"` → ranked, token-budgeted anchor set (default 8000) — replaces "read around until I understand" (~933 tokens for 3 anchors in the test).
- `${CONTEXT_TOOL} query impact <file>` → transitive blast radius before editing a shared symbol — **~50 tokens vs 5–15K** for grep+open-every-hit. **Use this in A1 step 2.**
- `${CONTEXT_TOOL} review [base] [head]` → one PR risk verdict fusing git diff + blast radius + structural deltas. **Use this as B Layer 0.**
- `${CONTEXT_TOOL} scan-vulns` + the pack's `risks` table → free OSV CVE / secrets / license / cycle scan at ~zero marginal token cost. **Pairs with the ship-gate dependency check (§5.7).**
- `${CONTEXT_TOOL} install --agent <agent>` → agent instructions + MCP server + a post-commit freshness hook.

**Honest limits (do NOT over-claim — these are IN the manual on purpose):**
- **The global bin may be broken (workspace unbuilt).** Run via `tsx apps/cli/src/cli.ts` or `pnpm build` first, and **verify it runs before relying on it.**
- **`FACTS_ROOT`/cwd trap:** passing the target as an arg silently analyzes the WRONG repo — you MUST `cd` into the target (or set `--root`/`FACTS_ROOT`). Same trap for any repo-scoped MCP: **every read is about the wrong repo until re-pointed.**
- **Staleness:** the pack is point-in-time — re-`analyze` (or use the post-commit hook) after edits, or blast-radius goes stale.
- Token counts are ~cl100k estimates (±8%) — fine for ratios, not hard budgets. Symbol graph is opt-in; `scan-vulns` needs network.
- **It NEVER replaces tests / integration truth** — a cheap-context + risk-surfacing layer, not an executor. It cannot run SQL/RPCs; it is not the secrets scanner of record for your commits until correctly pointed.

---

## 9. Slicing into workstreams (generic pattern)

Replace any project-specific workstream DAG with this rule:

1. **Enumerate the change surfaces** and their dependencies.
2. **Identify the blocking workstream** — the one whose landing turns a shared RED contract green and/or unblocks the most others. **Do it first.**
3. **Order the rest by dependency**, not by size. Parallelize only independent leaves.
4. **Each workstream runs A → B → C end-to-end** before the next dependent one starts.
5. **Park blocked decisions** as `it.todo` + a spec note; **ask** before building a form/flow gated on an unmade product decision — do not guess.

*Example instantiation (RallyPro):* `WS0` (engine options + `validate_score()` in SQL) is the blocker — it turns the 9 unit RED green and flips the integration GAP test — so it lands first; then quick-wins, then format UI, then live engine (∥) and groups (blocked on a product decision). Your project's DAG goes here.

---

## 10. Key-file index (fill per project)

| Key | Role |
|---|---|
| `${SPEC_FILE}` | Feature spec — locked decisions, workstreams, invariants |
| `${CORE_LOGIC_FILE}` | The engine/state-machine being extended |
| `${FROZEN_TESTS[]}` | Frozen tests — protect, never edit |
| `${RED_CONTRACT_TESTS[]}` | Test-first RED contracts (= contents of `${KNOWN_RED_TESTS_FILE}`) |
| `${KNOWN_RED_TESTS_FILE}` | The allowlist file `verify-gate.sh` diffs against (one test id per line) |
| `${INTEGRATION_HARNESS}` | Integration substrate (migration replay + auth shim) |
| `${E2E_SETUP}` | Authed-e2e storageState setup (needs `${E2E_CREDS}`; file generates on setup) |
| `${DEPLOY_SCOPE_CONFIG}` | Per-lane deploy scoping (prevents cross-app function bundling) |
| `${AUDIT_DIR}` | Where `${AUDIT_ARTIFACT}` + `${CEO_ARTIFACT}` live |

---

## 11. Gate scripts (drop into `${SCRIPTS_DIR}`; make hard gates fail CLOSED)

These are the mechanism the rubric rewards: runnable checks a fresh session cannot skip by *omission*. **What "drop-in" means here:** every helper the scripts call is defined below (§11.4) with a ready-made implementation per common test-runner and per common deploy host, so you run them without authoring new code — you only *select* your runner's parser and host's URL-printer (both ship pre-written). What they do **not** do is judge semantic quality (see the §11 closing note). Config comes from a single `gate.env` (Appendix A is a filled example). **After filling §0, run `preflight.sh --self-test` (a real branch — its code is shown in §11.1) to prove the wiring before trusting it.** Wire them as pre-commit / pre-deploy hooks and/or a CI job so the gate is enforced by tooling, not memory.

**Config contract (source once at the top of every script):** each script does `. "$(dirname "$0")/gate.env"` to load the profile keys as shell variables (`TEST_CMD`, `TEST_INTEGRATION_CMD`, `BUILD_CMD`, `TYPECHECK_CMD`, `AUDIT_DIR`, `AUDIT_ARTIFACT`, `KNOWN_RED_TESTS_FILE`, `DEPLOY_WORDS`, `DEPLOY_TARGETS`, `PREBUILT_FLAG`, `SMOKE_CMD`, `TEST_RUNNER`, `DEPLOY_CMD_*`, `SITE_ID_*`). Appendix A is a complete filled `gate.env`.

### 11.1 `preflight.sh` — commit/deploy precondition (fails closed) + `--self-test`
The `--self-test` branch is **real, not asserted**: it verifies each helper file exists and is sourceable, that `gate.env` defines the required keys, and that the two helper functions are callable on canned input — WITHOUT running your real suite or touching git. Run it once after filling §0; it must print `self-test: PASS`.
```sh
#!/usr/bin/env sh
set -eu
HERE="$(dirname "$0")"
. "$HERE/gate.env"

# --- self-test branch: prove the wiring, run nothing destructive/expensive ---
if [ "${1:-}" = "--self-test" ]; then
  fail=0
  # 1) helper files present + sourceable
  for f in gate.env parse-failures.sh deploy-url.sh verify-gate.sh ship.sh; do
    if [ ! -f "$HERE/$f" ]; then echo "self-test FAIL: missing $HERE/$f" >&2; fail=1; fi
  done
  # 2) required gate.env keys are set (empty or unset both fail)
  for k in TEST_CMD TEST_INTEGRATION_CMD BUILD_CMD TYPECHECK_CMD \
           AUDIT_DIR AUDIT_ARTIFACT KNOWN_RED_TESTS_FILE \
           DEPLOY_WORDS DEPLOY_TARGETS PREBUILT_FLAG SMOKE_CMD TEST_RUNNER; do
    eval "v=\${$k:-}"
    if [ -z "${v:-}" ]; then echo "self-test FAIL: gate.env key '$k' is empty/unset" >&2; fail=1; fi
  done
  # 3) helper FUNCTIONS are callable on canned input (no real suite/deploy)
  . "$HERE/parse-failures.sh"
  . "$HERE/deploy-url.sh"
  got_red="$(printf 'FAIL tests/example.test.ts > boom\n' | (TEST_RUNNER=vitest extract_failing_test_ids) || true)"
  case "$got_red" in *example.test.ts*) : ;; *)
    echo "self-test FAIL: extract_failing_test_ids did not parse a canned vitest FAIL line (got: '$got_red')" >&2; fail=1;; esac
  got_url="$(printf 'Website URL: https://deploy-abc--rally-main.netlify.app\n' | (new_deploy_url main) || true)"
  case "$got_url" in https://*netlify.app) : ;; *)
    echo "self-test FAIL: new_deploy_url main did not parse a canned Netlify URL (got: '$got_url')" >&2; fail=1;; esac
  # 4) allowlist file exists or is creatable
  [ -e "$KNOWN_RED_TESTS_FILE" ] || : > "$KNOWN_RED_TESTS_FILE" 2>/dev/null \
    || { echo "self-test FAIL: cannot create KNOWN_RED_TESTS_FILE=$KNOWN_RED_TESTS_FILE" >&2; fail=1; }
  [ "$fail" -eq 0 ] && { echo "self-test: PASS"; exit 0; } || { echo "self-test: FAIL" >&2; exit 1; }
fi

# --- normal preflight (commit/deploy precondition) ---
# 1) The verify/known-red gate must pass.
"$HERE/verify-gate.sh"
# 2) A CTPO audit dated TODAY must exist (the commit-gate artifact).
TODAY="$(date +%Y-%m-%d)"
if ! ls "${AUDIT_DIR}" 2>/dev/null | grep -q "${TODAY}"; then
  echo "FAIL: no ${AUDIT_ARTIFACT} dated ${TODAY} in ${AUDIT_DIR}. Generate + present it before asking to commit." >&2
  exit 1
fi
# 3) Secrets scan on the staged diff (extra scrutiny on public-by-design dirs).
if git diff --cached | grep -Ei '(api[_-]?key|secret|token|password)[[:space:]]*[:=]' ; then
  echo "FAIL: secret-shaped string in staged diff. Remove or justify." >&2; exit 1
fi
echo "preflight: PASS"
```
> **What `--self-test` proves vs. does not:** it proves the *wiring* — files present, keys set, both helper functions parse their canned inputs, allowlist writable. It deliberately does **not** run your real test suite, hit a deploy host, or check the audit-date (those need real project state) — so a green self-test means "the gate machinery is correctly assembled," not "your commit is ready." The real gate is the normal `preflight.sh` run (no flag).

### 11.2 `verify-gate.sh` — known-RED allowlist gate (the "real" test gate)
```sh
#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/gate.env"
. "$(dirname "$0")/parse-failures.sh"   # provides extract_failing_test_ids() — see §11.4
# Run the combined test gate; compare the FAILING SET to the allowlist.
# `${VERIFY_CMD}`/`${TEST_CMD}` alone can be RED-by-design, so equality — not "green" — is the gate.
: "${KNOWN_RED_TESTS_FILE:?set KNOWN_RED_TESTS_FILE in gate.env}"
[ -f "$KNOWN_RED_TESTS_FILE" ] || : > "$KNOWN_RED_TESTS_FILE"   # empty allowlist == suite must be fully green
ACTUAL_RED="$(${TEST_CMD} 2>&1 | extract_failing_test_ids | sort -u)"
# Also run integration + build + advisory typecheck (build does NOT imply tests ran).
${TEST_INTEGRATION_CMD}
${BUILD_CMD}
${TYPECHECK_CMD} || echo "typecheck advisory-only: continuing"
EXPECTED_RED="$(sort -u "$KNOWN_RED_TESTS_FILE")"
if [ "$ACTUAL_RED" != "$EXPECTED_RED" ]; then
  echo "FAIL: failing tests != known-RED allowlist. Unexpected failure or stale allowlist." >&2
  echo "--- expected-RED (allowlist) vs actual-RED ---" >&2
  diff <(printf '%s\n' "$EXPECTED_RED") <(printf '%s\n' "$ACTUAL_RED") >&2 || true
  exit 1
fi
echo "verify-gate: PASS (failing set == allowlist)"
```

### 11.3 `ship.sh` — deploy gate (literal-word + one-gate-for-all-targets)
```sh
#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/gate.env"
. "$(dirname "$0")/deploy-url.sh"   # provides new_deploy_url() — see §11.4
AUTH=""; TARGET=""
for a in "$@"; do case "$a" in
  --authorized=*) AUTH="${a#*=}";; --target=*) TARGET="${a#*=}";; esac; done
# 1) Literal-word gate — must match a DEPLOY_WORDS entry from THIS invocation.
case " ${DEPLOY_WORDS} " in *" $AUTH "*) : ;; *)
  echo "FAIL: deploy needs an explicit --authorized=<word> in {${DEPLOY_WORDS}} from the current message." >&2
  exit 1;; esac
# 2) EVERY target routes through the same preflight — no path skips tests.
"$(dirname "$0")/preflight.sh"
# 3) Dispatch with the pre-built flag HARDCODED (never hand-typed / droppable).
#    Capture the deploy output so new_deploy_url can parse the just-shipped URL.
DEPLOY_OUT=""
case "$TARGET" in
  main)      DEPLOY_OUT="$(eval "${DEPLOY_CMD_MAIN} ${PREBUILT_FLAG}" 2>&1 | tee /dev/stderr)";;
  portal)    DEPLOY_OUT="$( ( cd report-portal && eval "${DEPLOY_CMD_PORTAL} ${PREBUILT_FLAG}" ) 2>&1 | tee /dev/stderr)";;
  cloudflare)DEPLOY_OUT="$(eval "${DEPLOY_CMD_CF} ${PREBUILT_FLAG}" 2>&1 | tee /dev/stderr)";;
  deno)      DEPLOY_OUT="$(eval "${DEPLOY_CMD_DENO} ${PREBUILT_FLAG}" 2>&1 | tee /dev/stderr)";;
  *) echo "FAIL: unknown target '$TARGET' (must be one of ${DEPLOY_TARGETS})." >&2; exit 1;;
esac
# 4) Post-deploy smoke targets the NEW url (parsed from THIS deploy's output, not the previous deploy).
NEW_URL="$(printf '%s' "$DEPLOY_OUT" | new_deploy_url "$TARGET")"
[ -n "$NEW_URL" ] || { echo "FAIL: could not parse new deploy URL from output; refusing to smoke the previous deploy." >&2; exit 1; }
${SMOKE_CMD} --site="$NEW_URL"
echo "ship: deployed $TARGET -> $NEW_URL"
```

### 11.4 Helper implementations — **ready-to-run; pick your runner/host, no authoring needed**

These are the two helpers the scripts source. Both ship drop-in. Save `parse-failures.sh` and `deploy-url.sh` next to the gate scripts; each script above already sources them. The `--self-test` branch (§11.1) exercises both on canned input, so a mis-selected runner/host is caught before your first real gate run.

**`parse-failures.sh` — `extract_failing_test_ids()` (per runner; select via gate.env's `TEST_RUNNER`).** Reads the test command's stdout on stdin, emits one failing test id per line (stable across runs so the allowlist diff is deterministic).
```sh
#!/usr/bin/env sh
# extract_failing_test_ids: stdin = raw test output, stdout = one failing-test id per line.
# Branches on gate.env's TEST_RUNNER. All four are drop-in.
extract_failing_test_ids() {
  case "${TEST_RUNNER:-vitest}" in
    vitest|jest)
      # vitest/jest print "FAIL <path>" per failing file, and "✕/×/✗ <name>" per failing case.
      # File-level ids are the most stable allowlist unit; use them.
      grep -E '^[[:space:]]*FAIL[[:space:]]' | sed -E 's/^[[:space:]]*FAIL[[:space:]]+//; s/[[:space:]].*$//' ;;
    pytest)
      # pytest "-q" / default prints "path::test FAILED" and a "FAILED path::test" summary block.
      grep -E '(FAILED|ERROR)[[:space:]]' | sed -E 's/.*(FAILED|ERROR)[[:space:]]+//; s/[[:space:]].*$//' \
        | grep -E '::' ;;
    go)
      # `go test ./...` prints "--- FAIL: TestName" and "FAIL   pkg/path".
      grep -E '^--- FAIL:' | sed -E 's/^--- FAIL:[[:space:]]+//; s/[[:space:]].*$//' ;;
    *)
      echo "extract_failing_test_ids: unknown TEST_RUNNER '${TEST_RUNNER:-}' — add a branch in parse-failures.sh" >&2
      return 2 ;;
  esac
}
```
> **Populate the allowlist the same way (no drift):** to (re)generate `${KNOWN_RED_TESTS_FILE}` after you deliberately add a test-first RED contract, run `${TEST_CMD} 2>&1 | extract_failing_test_ids | sort -u > "$KNOWN_RED_TESTS_FILE"` and eyeball it — every line must be an *intentional* RED. Because the gate uses the SAME extractor, the allowlist and the check can never disagree on format.

**`deploy-url.sh` — `new_deploy_url()` (per host; reads the deploy command's own output on stdin).** No hostname is hardcoded; it parses the URL the deploy just printed, so smoke targets the new bundle by construction.
```sh
#!/usr/bin/env sh
# new_deploy_url <target>: stdin = the deploy command's captured output, stdout = the just-shipped URL.
new_deploy_url() {
  target="$1"
  case "$target" in
    main|portal)   # Netlify prints "Website URL:" / "Unique deploy URL:" and, with --json, a deploy_ssl_url field.
      # Prefer the immutable per-deploy URL; fall back to the prod URL line.
      grep -Eo 'https://[a-zA-Z0-9._-]+--[a-zA-Z0-9._-]+\.netlify\.app' | head -n1 \
        || grep -Eo 'https://[a-zA-Z0-9._-]+\.netlify\.app' | head -n1 ;;
    cloudflare)    # wrangler/pages prints "https://<hash>.<project>.pages.dev".
      grep -Eo 'https://[a-zA-Z0-9._-]+\.pages\.dev' | head -n1 ;;
    deno)          # deployctl prints the deployment URL as "https://<name>-<hash>.deno.dev".
      grep -Eo 'https://[a-zA-Z0-9._-]+\.deno\.dev' | head -n1 ;;
    *) echo "new_deploy_url: no parser for target '$target' — add one in deploy-url.sh" >&2; return 2 ;;
  esac
}
```
> **If your host emits JSON** (e.g. `netlify deploy --json`), swap the `grep` for a `jq` field read: `jq -r '.deploy_ssl_url // .deploy_url'`. Prefer JSON when available — it is exact rather than pattern-matched. The grep forms above are the no-`jq` fallback and are what make the script run on a bare shell.

> **Honesty note — the scope of these scripts, stated plainly:** they enforce the *mechanically checkable* gates (audit-dated-today, exact-RED-set, literal-word-present, flag-hardcoded, smoke-on-new-url) and `--self-test` proves the machinery is wired. They **cannot** verify *semantic* claims (was the review thorough? is the audit honest? is each allowlisted RED actually intentional?) — those still need `${AGENT_RULES_FILE}` + human judgment. The point is that the parts a hurried session would skip by omission now fail closed. The parsers are pattern-based on each host/runner's *current* output format — if a host changes its output, `new_deploy_url` returns empty and `ship.sh` **fails closed** (refuses to smoke) rather than silently hitting the old deploy; re-confirm the pattern (or re-run `--self-test` after updating the canned line) after any CLI upgrade. Do not claim the scripts guarantee more than they check.

---

## Appendix A — Fully-filled reference PROFILE (copy the SHAPE, substitute your facts)

A fresh session should never have to *invent* a value's shape. This is §0 filled in end-to-end for the RallyPro reference stack, plus the exact `gate.env` and allowlist file the §11 scripts consume. Replace every value with your repo's — the point is that nothing here is a `${placeholder}` you must resolve by guessing.

**`${SCRIPTS_DIR}/gate.env`** (sourced by every §11 script):
```sh
# --- stack + tooling ---
PKG="pnpm"
TEST_CMD="pnpm test"
TEST_RUNNER="vitest"                       # selects the parse-failures.sh branch
TEST_INTEGRATION_CMD="pnpm test:integration"
TEST_E2E_CMD="pnpm test:e2e"
TYPECHECK_CMD="pnpm typecheck"             # advisory: ~477 known Supabase `never` errors
BUILD_CMD="node ./scripts/build.mjs"       # NOTE: skips prebuild hook -> runs NO tests
# --- gate artifacts ---
AUDIT_DIR="audit/"
AUDIT_ARTIFACT="400-point CTPO HTML audit"
KNOWN_RED_TESTS_FILE="scripts/gates/known-red.txt"
# --- authorization words (space-delimited; matched literally) ---
DEPLOY_WORDS="deploy ship-it go-live push-live"
COMMIT_WORDS="commit ship-it"
# --- deploy targets + commands (PREBUILT_FLAG is appended by ship.sh, never hand-typed) ---
DEPLOY_TARGETS="main portal cloudflare deno"
PREBUILT_FLAG="--no-build"
SITE_ID_MAIN="rally-main"                  # define here — it was never in CLAUDE.md
SITE_ID_PORTAL="rally-invest"
DEPLOY_CMD_MAIN="NETLIFY_AUTH_TOKEN=$NETLIFY_AUTH_TOKEN netlify deploy --prod --dir=dist --site=$SITE_ID_MAIN"
DEPLOY_CMD_PORTAL="NETLIFY_AUTH_TOKEN=$NETLIFY_AUTH_TOKEN netlify deploy --prod --dir=build/client --site=$SITE_ID_PORTAL"
DEPLOY_CMD_CF="wrangler pages deploy dist --project-name=rally-cf"
DEPLOY_CMD_DENO="deployctl deploy --project=rally-edge dist/edge.js"
SMOKE_CMD="node scripts/smoke.mjs"          # ship.sh appends --site=<new_deploy_url>
```

**`${KNOWN_RED_TESTS_FILE}` = `scripts/gates/known-red.txt`** (one intentional-RED test id per line; empty file == "suite must be fully green"). Generated by the SAME extractor the gate uses, so the format is guaranteed to match:
```
tests/scoring-format-options.test.ts
tests/scoring-live.test.ts
```

**Prove the wiring before trusting it** (satisfies the "verify before relying" rule — this runs the real `--self-test` branch shown in §11.1):
```sh
chmod +x scripts/gates/*.sh
scripts/gates/preflight.sh --self-test   # checks files+keys+helper-parsing on canned input; must print "self-test: PASS"
# then regenerate the allowlist deterministically whenever you add an intentional RED:
. scripts/gates/gate.env; . scripts/gates/parse-failures.sh
$TEST_CMD 2>&1 | extract_failing_test_ids | sort -u > "$KNOWN_RED_TESTS_FILE"
```

Everything else in §0 (data-layer, convention, key-file rows) fills in the same literal way — the tables in §0.3/§0.4/§10 already show the RallyPro values in their right columns; copy that shape and substitute. **Nothing in §§1–11 references a value that is not defined either in `gate.env` above or in a §0 table.**
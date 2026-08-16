# Build → Review → Ship — a reusable engineering workflow manual

- **Kind:** project-agnostic operating manual. A fresh agent session runs all three pipelines on
  **any** project by filling in §0 (Project Profile) — nothing below §0 hardcodes a stack.
- **Purpose:** self-contained. Assume **no** prior conversation context. Every step is either
  unambiguous or points to the exact in-repo source of truth.
- **How to adopt for a new project:** fill §0, run the §0.2 self-check, then use §3–§5. The RallyPro
  values are kept as a **worked example** in each profile row so the pattern is concrete.

---

## 0. Project Profile — fill this first (the only project-specific section)

Every pipeline step references a `PROFILE.key`, never a literal. Fill each key from the repo, and
**verify it against the repo before trusting it** (values drift; treat every row as "as-of today,
re-confirm"). If a key is unknown, mark it `TODO` — an unfilled key blocks the steps that use it.

| Key | What it is | How to find it | Example (RallyPro, 2026-07-02) |
|---|---|---|---|
| `PKG` | package manager + run prefix | `packageManager` in package.json; lockfile | `pnpm` |
| `TEST` | full unit test command | package.json scripts | `pnpm test` (`vitest run`) |
| `TEST_KNOWN_RED` | tests allowed to be red right now + exact count | git status + spec | 2 files, `9 fail + 1 todo` |
| `VERIFY` | the real ship gate command | package.json scripts | `pnpm verify` (lint+css+fmt+**test**) |
| `INTEG` | integration test command + substrate | scripts + config | `pnpm test:integration` (pglite) |
| `BUILD` | build command that is authoritative | scripts | `node ./scripts/build.mjs` |
| `BUILD_RUNS_TESTS` | does BUILD run the test gate? | read the build script | **no** (skips prebuild) |
| `TYPECHECK` | typecheck cmd + advisory baseline | scripts | `pnpm typecheck` (~477 known `never`) |
| `DEPLOY_TARGETS` | every deploy path (all must be gated) | scripts/CI | netlify, cloudflare, deno |
| `DEPLOY_CMD[t]` | exact deploy command **incl. required flags/tokens** per target | deploy scripts + CLAUDE.md | `NETLIFY_AUTH_TOKEN=… netlify deploy --prod --no-build --dir=dist --site=<id>` |
| `SITES` | site id(s) + their roles/URLs | host dashboard + CLAUDE.md | main app; `rally-invest` (report-portal) |
| `SMOKE` | post-deploy smoke cmd + **what it targets** | scripts/smoke.* | `node scripts/smoke.mjs` (⚠ hardcoded prod URLs) |
| `SMOKE_EXPECT` | expected smoke responses | read the smoke script, not the doc | public `/`→200, admin `/`→(verify: 200 or 303) |
| `DB` | database + migration dir + type-gen | supabase/prisma/etc | Supabase; `supabase/migrations` (64); MCP `generate_typescript_types` |
| `ROLLBACK_CMD` | code rollback command | host API | `netlify api restoreSiteDeploy` |
| `PUBLIC_SURFACES` | anything shipped to clients = public-by-design | audit | `report-portal/` (access codes in bundle) |
| `INVARIANTS` | project hard rules not duplicated here | CLAUDE.md | token-pairing, no `/admin/*` public links |
| `AUDIT_ARTIFACTS` | required pre-commit/pre-deploy audits | CLAUDE.md | CTPO 400-pt ELI5 HTML; CEO thread HTML |

**0.1 Bootstrap:** load the repo's `CLAUDE.md`/`AGENTS.md` (owns invariants + gates). Read the
feature spec named in `PROFILE.INVARIANTS`. Reproduce test state: run `PROFILE.TEST` (expect
`TEST_KNOWN_RED`) and `PROFILE.INTEG` (expect green).

**0.2 Profile self-check (run before trusting the profile):** for each of `VERIFY`, `BUILD`,
`DEPLOY_CMD[*]`, `SMOKE`, confirm the command exists in the repo and read the script's first 20
lines. If `SMOKE_EXPECT` or `BUILD_RUNS_TESTS` disagrees with the script, **the script wins** —
fix the profile. This 5-minute check prevents shipping on a stale assumption.

---

## 1. Hard rules & gates — enforced, not just asserted

The gates below are **honor-system unless you make them runnable**. A fresh session skips any rule
it doesn't read. So each gate has a *mechanism* (a command that fails closed), not only prose.

| Gate | Rule | Mechanism (make it fail closed) |
|---|---|---|
| **Deploy word-gate** | Only the literal words **"deploy"/"ship it"/"go live"/"push live"** in the *current* message authorize a deploy. Bare "deploy" → ask which of `DEPLOY_TARGETS`. | Wrap every `DEPLOY_CMD` in a preflight (§5.7) that refuses without an explicit `--confirm-goahead` token you set only after the literal word. |
| **Commit gate** | Before *asking* to commit: build+typecheck+tests green, review done, whole-app test pass, and the `AUDIT_ARTIFACTS` generated + presented **with** the ask. Commit itself needs literal **"commit"/"ship it"**. | Preflight greps for an `AUDIT_ARTIFACTS` file dated today and a green `VERIFY`; exits non-zero otherwise. |
| **Test gate** | `VERIFY` is the gate — **not** `BUILD`. If `BUILD_RUNS_TESTS=no`, a green build is **not** proof tests ran. | See §5.2 — use the known-red allowlist wrapper, never a bare pass/fail. |
| **Deploy artifact** | Ship a pre-built artifact with the host's no-rebuild flag (dropping it has gutted prod). All flags live in `DEPLOY_CMD[t]`. | The flag is baked into `DEPLOY_CMD`, so it can't be forgotten. |
| **Every deploy path gated** | `DEPLOY_TARGETS` may include paths that build with no test gate — ALL route through the same preflight. | §5.7 preflight is target-agnostic; no target bypasses it. |
| **Public surfaces** | Treat everything in `PUBLIC_SURFACES` as published — never put a secret there. | Secrets scan on the diff (§5.3) + a hard check that `PUBLIC_SURFACES` gained no credential. |
| **Living-doc audits** | Audit state transitions land in the **same commit** as the work — but only for audits the change actually touches (don't re-verify the world every commit). | Scope: sync only the audit(s) whose claims the diff changes; a pre-commit hook can list stale ones. |
| **Project invariants** | Obey `PROFILE.INVARIANTS` (not duplicated here — they win on conflict). | The repo's own linters/hooks enforce these. |

**Principle:** if a gate matters, give it a command. Prose gates are a reminder, not a control.

---

## 2. Capturing state for a fresh session

A handoff must let a cold session reproduce reality. Record, at the top of your working notes:
worktree/branch; `PROFILE.TEST` result **as a re-runnable command, not a frozen number** ("run
`TEST`; known-red = `TEST_KNOWN_RED`, anything else is a real failure"); `PROFILE.INTEG` result +
the specific gap any test intentionally pins; what's deployed where; and the list of uncommitted
concerns sliced into **independent commit arcs** (one concern each). Never assert a test *count* as
a static fact — assert the command + the allowlist, so drift surfaces instead of misleading.

---

## 3. Pipeline A — BUILD (per workstream, never big-bang)

Driver: the feature-development skill (codebase understanding + architecture first). Three lanes:

**A1 — Pure logic.** (1) Contract tests first (RED) — new files only; never edit frozen test
suites. (2) **Blast-radius before widening a shared API:** `factstack query impact <file>` (§7) or
grep every caller — a shared validator often feeds several call paths. (3) Implement to green.
(4) Simplify **after** green, then re-test. (5) A RED contract lands in the **same arc** as its
implementation; park a decision-blocked assertion as `todo` + a spec entry — never leave the suite
red across sessions.

**A2 — Schema/DB.** (1) **Expand-contract:** additive + nullable first; destructive steps ship a
*later* deploy than the code that stops using them, so a code rollback never strands the schema.
(2) Prove it applies via `PROFILE.INTEG` (replays migrations) + a test for the new constraint/RPC.
(3) Regenerate DB types **same commit**. (4) Sync the ER/schema audit **same commit**. (5) After it
reaches the cloud DB, run the host's security+perf advisors. (6) **Data dimension (often missed):**
if a migration *backfills or transforms existing rows*, write the reverse/backfill-down plan now —
`ROLLBACK_CMD` restores code and expand-contract tolerates the shape, but already-transformed DATA
is not auto-reversible. State how to recover it before you ship the forward migration.

**A3 — Net-new UI.** (1) Design **before** code (design skills; review/polish skills audit built
UI, they can't design unbuilt UI). (2) Obey `PROFILE.INVARIANTS` (e.g. token-pairing). (3) Verify
with browser tooling; polish with the UI-polish skill.

---

## 4. Pipeline B — REVIEW (cheap → expensive → adversarial → fix-loop)

Scope every review to the **working-tree diff**, not the whole repo.

| Layer | Command | Catches | Blind to |
|---|---|---|---|
| Cheap context | `factstack context "<task>"` / `query impact` (§7) | what to read + blast radius, at ~1/40th the tokens | runtime truth |
| Unit/contract | `PROFILE.TEST` | logic, API contracts (RPCs stubbed) | DB, auth, UI |
| Integration | `PROFILE.INTEG` | real RPC bodies, constraints, triggers, migration replay | **auth/RLS if the substrate runs as superuser — policies don't bind** |
| System | `PROFILE.BUILD` + `PROFILE.SMOKE` | build integrity. **⚠ verify what SMOKE targets** — if it hits deployed prod URLs, pre-deploy it only baselines the *previous* deploy; to smoke the new artifact, serve it locally and point SMOKE at it | logic depth |
| E2E | the e2e command | user flows. Authed flows need a **provisioned** test account + creds env vars — the fixture *code* existing ≠ the account existing; provision it or the specs self-skip | perf |
| Performance | Lighthouse mobile on changed surfaces (targets in `PROFILE`) | Core-Web-Vitals regressions | logic |
| DB posture | host advisors | missing policies/indexes on new tables | logic |
| Code review | the code-review skill (+ silent-failure / type-design agents) | bugs, conventions, swallowed errors | — |
| Security | the security-review skill | injection, authz, secrets | — |
| Adversarial | parallel fan-out (§6) | plausible-but-wrong, threat-model attacks | — |

**State blind spots honestly.** If no layer executes auth/RLS policy *logic* (e.g. a superuser
integration substrate), say so and name the mitigation (advisors catch *missing* policies; human
review covers policy *logic*) — do **not** claim coverage you don't have.

**Fix-loop convergence:** every confirmed finding → a **failing regression test** → fix → prove the
flip → re-run the adversarial pass **until a dry round** (zero new). A fix without a regression test
doesn't count.

**Threat model (adapt per feature):** e.g. RPC bypass of client-side validation; state-lock bypass
after start; concurrency races (double-submit, two devices, refresh mid-op); integrity of derived
state seeded from incomplete inputs; event-log undo/replay abuse; legacy rows with a null
discriminator that must read as a specific default.

---

## 5. Pipeline C — SHIP-READY (per commit arc)

1. **Slice:** one concern per arc.
2. **Gates — use the known-red allowlist, never a bare pass/fail.** Run `PROFILE.VERIFY`. If the
   suite has intentional reds (`TEST_KNOWN_RED`), a plain `VERIFY` can't pass, and hand-waving the
   reds also hides a *new* failure. So gate on: **the failing set is EXACTLY `TEST_KNOWN_RED`** (same
   files, same count) — any other failing test, or a different count, fails the gate. Bake this into
   a named script (e.g. `verify:gate`) that runs the suite with a JSON reporter and asserts the
   red set == allowlist; exit non-zero on any deviation. Then `PROFILE.INTEG` green, `PROFILE.BUILD`
   green (remember `BUILD_RUNS_TESTS` may be `no` — the build passing is not the test gate), and
   `PROFILE.TYPECHECK` (advisory against its known baseline — a *new* type error still fails).
3. **Secrets pass on the diff** — no keys; assert `PUBLIC_SURFACES` gained no credential.
4. **Evidence:** screenshots/output tied to the acceptance criteria (not decorative) — including any
   equivalence invariant the feature promises (two code paths producing the same result).
5. **Artifacts (all required, before asking):** generate the `AUDIT_ARTIFACTS` (e.g. the CTPO
   400-point ELI5 new-CTO HTML audit — this *is* the commit-gate artifact — and any stakeholder
   artifact). Present them **with** the commit ask.
6. **Ask commit** with the audit shown. Wait for the literal word.
7. **Deploy** (own literal-word gate; ask which of `DEPLOY_TARGETS` if unnamed). Run every target
   through **one preflight** that: refuses without the confirm token; uses the exact `DEPLOY_CMD[t]`
   (flags + auth token baked in); then post-deploy **smoke the NEW artifact** (`SMOKE`, verifying it
   targets the new bundle not the prior deploy) with `SMOKE_EXPECT` **read from the script, not
   assumed**. Host/stack-specific follow-ups (transitive-dep checks after a dependency bump, patch
   re-pins, etc.) live in `PROFILE.INVARIANTS`. **A sub-app with its own build/deploy (e.g. a portal)
   ships on its own lane from inside its own directory** — never from repo root — and gets its own
   smoke coverage (a root-run deploy can bundle the wrong functions).
8. **Post-deploy:** fresh-viewport console check + surface screenshot; verify any shipped migration
   against the live DB; optional canary monitoring.
9. **Rollback:** `PROFILE.ROLLBACK_CMD` for code; expand-contract (§3 A2) makes the schema tolerate
   it; **and execute the A2 data-recovery plan if the arc backfilled/transformed rows** (code
   rollback does not un-transform data).
10. **Docs same arc:** sync only the audits whose claims this diff changed; update the milestone; run
    the release-notes skill if user-facing.

---

## 6. Adversarial fan-out — the template (bakes in the ops lessons)

Standing pattern: run adversarial review as a parallel fan-out, as often as needed.

**Mechanism:** if your harness has a **Workflow orchestration tool** (inline JS: `agent()` /
`parallel()` / `pipeline()`, schema-validated returns, resume-on-failure caching), use it. It is a
harness *tool*, not a skill.

**Shape (copy-paste checklist — the caps are not optional):**
1. **Finders:** one agent per threat-model dimension, in parallel; each returns a **schema'd** list
   (so nothing needs re-parsing) and reads the actual files (never invent — if the target is
   missing, return empty).
2. **Dedupe** vs a `seen` set before the expensive step.
3. **Verify in waves of ≤ 6 concurrent** — a large single verify wave hits provider rate limits and
   can lose the *entire* run. Batch, and **retry once after a short backoff** on a rate-limit error.
   Each finding gets an independent skeptic instructed to *refute*; kill on majority-refute.
4. **Survivors → regression tests**; loop the whole thing until a **dry round**.
5. **Deliver by path, not inlined:** pass agents the file **path** to read, not a giant inlined
   blob — inlined content can arrive as `undefined` and induce hallucination.
6. **Resume:** on a partial failure, resume from the run id — completed phases replay free.

**Fallback when there is no Workflow tool:** run the finders as parallel `Agent` calls in **batches
of ≤ 6**; collect their JSON returns into one working file; dedupe by hand; re-verify each survivor
with a second `Agent` call; you lose phase-caching so budget for a re-run. This fallback is real and
runnable — do not treat the Workflow tool as a hard dependency.

---

## 7. factstack — the token-efficiency layer (verified 2026-07-02; wire in honestly)

factstack extracts a repo into `.facts/agent.pack`, a self-describing context file. **Measured: a
115K-token / 31-file repo → a ~2.9K-token pack (~40× smaller) in ~200ms.** Use it as the cheap-context
front of Pipeline B and before A1 shared-API edits.

- `analyze` → writes `.facts/` (pack + a `risks` table: secrets/CVE/license/cycle/stale).
- `context "<task>"` → ranked, token-budgeted anchor set (replaces "read around until I get it").
- `query impact <file>` → transitive blast radius before editing a shared symbol (~50 tokens vs
  reading every caller).
- `review [base] [head]` → one PR risk verdict fusing diff + blast radius + structural deltas.
- `scan-vulns` + the pack `risks` table → free OSV CVE / secrets / license sweep for the ship gate.

**Honest limits (must stay in the doc):** the global bin may be **unbuilt/broken** — run via `tsx`
or build the workspace first, and *verify it runs* before relying on it. The **`FACTS_ROOT`/cwd
trap** silently analyzes the *wrong* repo unless you `cd` into the target (or set `--root`). The
pack is **point-in-time** — re-`analyze` (or install the post-commit hook) after edits or blast-radius
goes stale. Token counts are ~estimates; the symbol-level graph is opt-in; `scan-vulns` needs
network. factstack **never** replaces tests/integration truth — it is cheap context + risk
surfacing, not an executor.

---

## 8. Skill / tool routing

Build → feature-dev skill (+ code-architect / code-explorer agents). TDD discipline → the TDD skill.
UI design **before** code → design/consultation skills; UI polish **after** built → the polish +
design-review skills. Browser/e2e → the webapp-testing skill + preview tools + QA skill. Simplify
**after** green → the simplify skill. Code review → the code-review skill + PR-review agents.
Security → the security-review skill. Verify a change → the verify/run skills. Ship → the ship /
land-and-deploy skills (**still subject to the literal-word gates**) + a canary skill post-deploy.
Adversarial orchestration → the Workflow tool (§6), or the batched-`Agent` fallback. Cheap context →
factstack (§7). *Confirm a skill exists in your environment before routing to it — availability
varies by harness.*

---

## 9. Workstream sequencing (generic pattern)

Don't big-bang. Order by dependency: do the **blocking workstream first** — the one that unblocks the
most others and turns the intentional REDs green (typically the core engine/contract change). Then
independent quick wins, then the UI that depends on the engine, then anything gated on an open
product decision (**ask before building a form whose shape a pending decision controls**). Each
workstream runs A → B → C end-to-end before the next starts; genuinely independent ones may run in
parallel. Represent it as a small DAG in your notes so the critical path is explicit.

*Example (RallyPro): WS0 engine options + `validate_score()` in SQL (turns the 9 unit REDs green +
flips the integration gap test) → WS1 quick wins → WS2 format UI → {WS3 live engine ∥ WS4 groups
(blocked on a groups-flexibility decision)}.*

---

## 10. Adopt-for-a-new-project checklist + key artifacts

**To adopt:** (1) fill §0 Project Profile from the repo; (2) run §0.2 self-check; (3) create the
named gate scripts referenced in §1/§5 (deploy preflight, `verify:gate` allowlist wrapper); (4) run
`factstack analyze` once to seed cheap context; (5) confirm your skills/tools (§8) exist. Then §3–§5
are stack-agnostic.

**Key artifacts to locate per project:** the feature spec; the core engine/logic module and its
frozen test suites; the migration dir + type-gen; the build + deploy + smoke scripts (read them, per
§0.2); the public-by-design surfaces; the audit templates. Record these as a small index in your
notes so a fresh session finds them fast.

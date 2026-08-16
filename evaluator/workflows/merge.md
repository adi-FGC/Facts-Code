# Build → Review → Ship — a reusable engineering workflow manual

- **Kind:** project-agnostic operating manual. A fresh agent session runs all three pipelines on
  **any** project by filling in §0 (Project Profile) — nothing below §0 hardcodes a stack.
- **Purpose:** self-contained; assume **no** prior conversation context. Every step is either
  unambiguous or points to the exact in-repo source of truth. The hard gates are **runnable
  fail-closed scripts (§11)**, not honor-system prose — a fresh session cannot skip them by omission.
- **To adopt:** fill §0, drop the §11 scripts into `${SCRIPTS_DIR}`, run `preflight.sh --self-test`
  to prove the wiring, then use §3–§5. Appendix A is a complete filled example — copy the *shape*.
- **Reading cold:** §§1–10 are generic and skim-clean; §0 + §11 + Appendix A are the only
  project-specific / mechanical parts. If a step names a `${KEY}` you have not filled, STOP and fill
  §0 — do not guess.

---

## 0. Project Profile — fill this first (the only project-specific section)

Every pipeline step references a `${KEY}`, never a literal. Fill each from the repo and **verify it
against the repo before trusting it** (values drift — treat every row as "as-of today, re-confirm").
An unfilled key blocks the steps that use it. The §11 scripts read these keys from a `gate.env`
(Appendix A shows it filled).

| Key | What it is | Example (RallyPro — replace) |
|---|---|---|
| `${PKG}` | package manager + run prefix | `pnpm` |
| `${TEST_CMD}` | full unit/contract suite | `pnpm test` |
| `${TEST_RUNNER}` | runner (selects the §11.4 parser) | `vitest` (also: jest/pytest/go) |
| `${KNOWN_RED_TESTS_FILE}` | allowlist file of intentionally-RED tests (one id/line; empty = must be fully green) | `scripts/gates/known-red.txt` |
| `${INTEG_CMD}` | integration suite + substrate | `pnpm test:integration` (pglite) |
| `${E2E_CMD}` + `${E2E_CREDS}` | e2e suite + the creds its fixture needs (fixture *generates on setup*, doesn't pre-exist) | `pnpm test:e2e`; `E2E_EMAIL`/`E2E_PASSWORD` |
| `${VERIFY_CMD}` | the real ship gate (lint+css+fmt+**test**) — NOT the build | `pnpm verify` |
| `${BUILD_CMD}` + `${BUILD_RUNS_TESTS?}` | authoritative build; does it run tests? | `node ./scripts/build.mjs`; **NO** (skips prebuild) |
| `${TYPECHECK_CMD}` | typecheck + advisory baseline | `pnpm typecheck` (~477 known `never`) |
| `${SCRIPTS_DIR}` | where §11 gate scripts live | `scripts/gates/` |
| `${CONTEXT_TOOL}` | cheap-context/blast-radius tool (§7) | `factstack` |
| `${DEPLOY_TARGETS[]}` | every deploy path (all gated) | main · portal · cloudflare · deno |
| `${DEPLOY_CMD(t)}` | exact command incl. **all mandatory flags/tokens** per target | `NETLIFY_AUTH_TOKEN=$… netlify deploy --prod --dir=dist --site=${SITE_ID}` |
| `${PREBUILT_FLAG}` | the flag that ships the pre-built artifact (dropping it has gutted prod) | `--no-build` |
| `${SITE_ID_*}` | site/project ids per target | `${SITE_ID_MAIN}` (define it — never in CLAUDE.md); `${SITE_ID_PORTAL}=rally-invest` |
| `${SMOKE_CMD}` + `${SMOKE_EXPECT}` | post-deploy smoke + expected responses **read from the script, not assumed** | `node scripts/smoke.mjs`; public→200, admin→200 *(doc once said 303; script wins — re-grep)* |
| `${ROLLBACK_CMD(t)}` | redeploy previous good build | `netlify api restoreSiteDeploy` |
| `${DB}` / `${MIGRATION_DIR}` / `${TYPES_REGEN}` / `${DB_ADVISORS}` / `${RLS_STATUS}` | data layer + does the review stack execute RLS? | Supabase; `supabase/migrations`; MCP type-gen; MCP advisors; **RLS=NO** (pglite superuser) |
| `${AGENT_RULES_FILE}` | auto-loaded rules that own the ultimate gates (win on conflict) | `CLAUDE.md` (+ user global) |
| `${DEPLOY_WORDS[]}` / `${COMMIT_WORDS[]}` | literal words that authorize deploy / commit | "deploy"/"ship it"/"go live"/"push live"; "commit"/"ship it" |
| `${AUDIT_DIR}` + `${AUDIT_ARTIFACT}` + `${CEO_ARTIFACT}` | required pre-commit audits + dir | `audit/`; CTPO 400-pt HTML; stakeholder HTML |
| `${PUBLIC_BY_DESIGN[]}` | dirs shipped to clients = public | `report-portal/` (access codes in bundle) |
| `${STYLE_INVARIANTS[]}` | lint-enforced invariants | token-pairing; no `/admin/*` public links |

**0.1 Bootstrap:** load `${AGENT_RULES_FILE}`; read the feature spec; run `${TEST_CMD}` (expect the
`${KNOWN_RED_TESTS_FILE}` set) and `${INTEG_CMD}` (green). **0.2 Self-check (once, before trusting
the profile):** for `${VERIFY_CMD}`, `${BUILD_CMD}`, `${DEPLOY_CMD(*)}`, `${SMOKE_CMD}`, confirm the
command exists and read the script's first 20 lines — **the script wins** over any doc claim
(`${SMOKE_EXPECT}`, `${BUILD_RUNS_TESTS?}`). Then run `preflight.sh --self-test` (§11.1).

---

## 1. Hard rules & gates — enforced by §11 scripts, not asserted

A prose rule a single skipped read would erase is **converted to a fail-closed check in §11**.

| Gate | Rule | Enforcing mechanism |
|---|---|---|
| **Deploy word-gate** | Only a literal `${DEPLOY_WORDS[]}` word in the *current* message authorizes a deploy (never carries forward). Bare word → ask which `${DEPLOY_TARGETS[]}`. | `ship.sh --authorized="<word>"` refuses unless `<word>` matches a `${DEPLOY_WORDS[]}` line exactly (multi-word phrases supported). |
| **Commit gate** | Before *asking* to commit: gate green, review done, whole-app test pass, `${AUDIT_ARTIFACT}` dated today generated + presented **with** the ask. Commit needs a literal `${COMMIT_WORDS[]}` word. | `preflight.sh` fails closed unless a `${AUDIT_DIR}` file dated today exists + the gate passes + no secret-shaped string in the staged diff. |
| **Test gate** | `${VERIFY_CMD}` is the gate — **not** `${BUILD_CMD}` (if `${BUILD_RUNS_TESTS?}`=NO, a green build ≠ tests ran). Suite may be RED-by-design. | `verify-gate.sh` passes **only if the failing set == `${KNOWN_RED_TESTS_FILE}` exactly** — any extra red fails closed. Closes both the "verify can never pass pre-impl" and "build passed ⇒ tests ran" traps. |
| **Every deploy path gated** | No target (incl. cloudflare/deno/portal) skips tests. | `ship.sh` runs `preflight.sh` first for **every** target, then dispatches `${DEPLOY_CMD(t)}` with `${PREBUILT_FLAG}` hardcoded. |
| **Public surfaces** | Never put a secret in `${PUBLIC_BY_DESIGN[]}`. | `preflight.sh` greps the diff, extra scrutiny there. |
| **Living-doc audits** | Audit transitions land in the same commit — but only for audits the diff actually touches. | Scope to the changed audit(s); a pre-commit hook can list stale ones. |

> `${AGENT_RULES_FILE}` + the user's global rules win on any conflict — they own the ultimate gate.
> This manual makes the *mechanically-checkable subset* fail closed instead of resting on memory.

---

## 2. Reading the live state (do NOT trust numbers cold)

Never assert a test *count* as a static fact — it drifts. Instead: (1) run `${TEST_CMD}` +
`${INTEG_CMD}` yourself, record in your notes with today's date; (2) confirm the RED set ==
`${KNOWN_RED_TESTS_FILE}` via `verify-gate.sh` — a mismatch is a real regression or a stale
allowlist, resolve it; (3) slice uncommitted work into **independent commit arcs** (one concern
each); land test-first RED contracts in the *same arc* as the implementation that greens them.

---

## 3. Pipeline A — BUILD (per workstream, never big-bang)

Driver: the feature-dev skill (architecture first). **Before touching shared code (all lanes):** run
the cheap blast-radius query (§7) — `${CONTEXT_TOOL} query impact <file>` — to map consumers in ~50
tokens instead of grep+open-every-hit; fall back to Grep + a code-explorer agent.

**A1 — Pure logic.** (1) Contract tests first (RED) — new files only; never edit frozen suites.
(2) Map consumers before widening a shared API (§7). (3) Implement to green. (4) Simplify **after**
green, re-test. (5) A RED contract lands in the *same arc* as its implementation; park a
decision-blocked assertion as `todo` + a spec note — never a cross-session red suite.

**A2 — Schema/DB.** (1) **Expand-contract:** additive + nullable first; destructive steps ship a
*later* deploy than the code that stops using them. (2) **DATA/backfill reverse-plan (mandatory):**
if a migration transforms/backfills existing rows, write the reverse (down-migration / recovery
query / pre-migration snapshot command) **in the same arc** — code rollback does *not* undo
committed data. No backfill ships without its reverse. (3) Prove it applies via `${INTEG_CMD}` + a
test for the new constraint/RPC. (4) Regenerate types (`${TYPES_REGEN}`) same commit. (5) Sync the
schema audit same commit. (6) After it reaches the live DB, run `${DB_ADVISORS}`.

**A3 — Net-new UI.** (1) Design **before** code (design skills; audit/polish skills can't design
unbuilt UI). (2) Obey `${STYLE_INVARIANTS[]}`. (3) Verify with browser tooling; polish with the
UI-polish skill.

---

## 4. Pipeline B — REVIEW (cheap → expensive → adversarial → fix-loop)

Scope to the **working-tree diff**. **Layer 0:** `${CONTEXT_TOOL} review` (§7) — one cheap risk
verdict (diff + blast radius + new CVEs/secrets/cycles) that tells you which layers matter.

| Layer | Command | Catches | Blind to |
|---|---|---|---|
| Cheap context | `${CONTEXT_TOOL} review` / `query impact` | blast radius, new secrets/CVEs at ~1/40th the tokens | execution truth |
| Unit/contract | `${TEST_CMD}` | logic, API contracts (RPCs stubbed) | DB, auth, UI |
| Integration | `${INTEG_CMD}` | real RPC bodies, constraints, triggers, migration replay | **auth/RLS if `${RLS_STATUS}`=NO (superuser — policies don't bind)** |
| System | `${BUILD_CMD}` · `${SMOKE_CMD}` | build integrity. **⚠ verify what SMOKE targets** — if it hits deployed prod URLs, pre-deploy it only baselines the *previous* deploy; serve locally to smoke the new artifact | logic depth |
| E2E | `${E2E_CMD}` | user flows. Authed flows need a **provisioned** `${E2E_CREDS}` account — fixture code existing ≠ the account existing | perf |
| Performance | Lighthouse mobile on changed surfaces | Core-Web-Vitals regressions | logic |
| DB posture | `${DB_ADVISORS}` | missing policies/indexes on new tables | logic |
| Code review | the code-review skill (+ silent-failure / type-design agents) | bugs, conventions, swallowed errors | — |
| Security | the security-review skill | injection, authz, secrets | — |
| Adversarial | parallel fan-out (§6) | plausible-but-wrong, threat-model attacks | — |

**Blind spots stated honestly.** If `${RLS_STATUS}`=NO, no layer executes auth/RLS policy *logic* —
say so; mitigation is advisors (catch *missing* policies) + human review (policy *logic*). **Do not
claim RLS coverage until it exists. Fix-loop:** every confirmed finding → failing regression test →
fix → prove the flip → re-run until a **dry round**; a fix without a regression test doesn't count.
**Threat model (specialize per feature):** validation-bypass at a lower layer than the check;
state-lock bypass after start; concurrency races (double-submit, two devices, refresh mid-op);
derived/rollup integrity from incomplete inputs; event-log undo/replay abuse; legacy/null rows read
wrong by new code.

---

## 5. Pipeline C — SHIP-READY (per commit arc)

1. **Slice:** one concern per arc.
2. **Gate — run `verify-gate.sh` (§11.2), not raw `${VERIFY_CMD}`:** it runs verify + `${INTEG_CMD}`
   + `${BUILD_CMD}` + `${TYPECHECK_CMD}` (advisory) and passes **only if the failing set ==
   `${KNOWN_RED_TESTS_FILE}` exactly.** Closes the RED-by-design and build-passed-⇒-tests-ran traps.
3. **Secrets pass on the diff** (`preflight.sh` greps it; extra scrutiny on `${PUBLIC_BY_DESIGN[]}`).
4. **Evidence** tied to acceptance criteria (not decorative) — incl. any equivalence invariant.
5. **Artifacts (both, before asking):** `${AUDIT_ARTIFACT}` (the commit-gate artifact — `preflight.sh`
   fails closed unless one dated today exists) + `${CEO_ARTIFACT}`.
6. **Ask commit** with the audit shown; wait for a literal `${COMMIT_WORDS[]}` word.
7. **Deploy** — `ship.sh --target=<t> --authorized="<word>"` (§11.3): re-runs `preflight.sh`,
   refuses without a valid word, dispatches `${DEPLOY_CMD(t)}` with `${PREBUILT_FLAG}` hardcoded for
   **every** target, then smokes the **new** URL parsed from the deploy's own output. Stack-specific
   post-deploy follow-ups (transitive-dep checks after a dep bump; patch re-pins) live in
   `${AGENT_RULES_FILE}`. **A sub-app with its own build/deploy ships on its own lane from inside its
   own dir** — never repo root (a root deploy can bundle the wrong functions).
8. **Post-deploy:** fresh-viewport console check + surface screenshot; verify any shipped migration
   against the live DB; optional canary. **If smoke fails, roll back immediately (§5.9).**
9. **Rollback (code + schema + DATA):** `${ROLLBACK_CMD(t)}` for code; expand-contract (§3 A2) makes
   the schema tolerate it; **run the §3 A2 data-reverse plan if the arc backfilled/transformed rows.**
10. **Docs same arc:** sync the audits the diff changed; update the milestone; release-notes if user-facing.

---

## 6. Adversarial fan-out — template with the concurrency cap BAKED IN

Standing pattern: run adversarial review as a parallel fan-out. **Preferred:** the harness `Workflow`
tool (inline JS `agent()`/`parallel()`/`pipeline()`, schema returns, `resumeFromRunId` caching) — a
*tool*, not a skill.

```
finders = one agent per threat dimension (§4), parallel, no cap (cheap, independent), schema returns.
dedupe  = merge vs a `seen` set BEFORE verifying.
verify  = per-finding skeptic (correctness / security / does-it-reproduce), majority-refute kills it.
          *** HARD CAP: <=6 concurrent verify agents; batch survivors into waves of <=6. ***
          *** Retry ONCE after a backoff on rate-limit/5xx; on failure resume with resumeFromRunId. ***
deliver = pass agents the file PATH to read, never a giant inlined blob (inlined can arrive as
          `undefined` and induce hallucination).
loop    = survivors -> regression tests -> re-run finders until a DRY round.
```
Why the cap: a 26-agent verify wave once hit provider rate limiting and lost the **entire** output.

**Fallback (no Workflow tool):** parallel `Agent` calls in **batches of ≤6**, each with ALL context
embedded (subagents have no session memory), returning JSON `{finding,location,why}`; accumulate to a
scratch file; dedupe by (location, claim); verify survivors in ≤6-batches (retry once); loop until
dry. Persist the `seen`/survivor set to disk so a crash resumes from there. This fallback is runnable
— do not treat the Workflow tool as a hard dependency.

---

## 7. Cheap-context / token-efficiency layer — `${CONTEXT_TOOL}` (factstack)

Extracts a repo into `.facts/agent.pack`, a self-describing context file **~40× smaller than source**
(measured: 404KB/115K tokens → 10KB/~2.9K tokens on a 31-file repo, ~200ms; ratio grows with size).
Wire into Pipeline A (blast radius before edits) + Pipeline B (Layer 0).

- `analyze` → writes `.facts/` (pack + a `risks` table: secrets/CVE/license/cycle/stale).
- `context "<task>"` → ranked, token-budgeted anchor set (replaces "read around until I get it").
- `query impact <file>` → blast radius (~50 tokens vs 5–15K). **Use in A1 step 2.**
- `review [base] [head]` → one PR risk verdict. **Use as B Layer 0.**
- `scan-vulns` + the pack `risks` table → free OSV CVE / secrets / license sweep for the ship gate.

**Honest limits (keep in-doc):** the global bin may be **unbuilt/broken** — run via `tsx` or build
first, and *verify it runs*. The **`FACTS_ROOT`/cwd trap** silently analyzes the *wrong* repo unless
you `cd` into the target (or set `--root`). The pack is **point-in-time** — re-`analyze` after edits.
Token counts are ~estimates; symbol graph is opt-in; `scan-vulns` needs network. It **never** replaces
tests/integration truth — cheap context + risk surfacing, not an executor.

---

## 8. Skill / tool routing (confirm availability in your environment before relying on a row)

Build → feature-dev skill (+ code-architect / code-explorer). Cheap context → `${CONTEXT_TOOL}` (§7,
fallback Grep + code-explorer). TDD → the TDD skill. UI design **before** code → design/consultation
skills; polish **after** → polish + design-review skills. Browser/e2e → webapp-testing + preview
tools + QA skill. Simplify **after** green → the simplify skill. Code review → the code-review skill +
PR-review agents. Security → security-review + CSO skills. Verify → verify/run skills. Ship →
`ship.sh` (§11) → ship / land-and-deploy skills (**still subject to the literal-word gates**) + a
canary skill. Adversarial → the Workflow tool (§6) or the batched-`Agent` fallback.

---

## 9. Slicing into workstreams (generic pattern)

Don't big-bang. (1) Enumerate change surfaces + dependencies. (2) **Do the blocking workstream
first** — the one that greens a shared RED contract and/or unblocks the most others. (3) Order the
rest by dependency, not size; parallelize only independent leaves. (4) Each workstream runs A → B → C
end-to-end before the next dependent one. (5) Park blocked decisions as `todo` + a spec note; **ask**
before building a form/flow gated on an unmade product decision.

*Example (RallyPro): `WS0` (engine options + `validate_score()` in SQL) is the blocker — greens the 9
unit REDs + flips the integration gap test — so it lands first; then quick-wins, format UI, then live
engine (∥) and groups (blocked on a product decision). Your project's DAG goes here.*

---

## 10. Key-file index (fill per project)

`${SPEC_FILE}` (feature spec) · `${CORE_LOGIC_FILE}` (engine/state-machine extended) ·
`${FROZEN_TESTS[]}` (protect, never edit) · `${KNOWN_RED_TESTS_FILE}` (allowlist `verify-gate.sh`
diffs against) · `${INTEGRATION_HARNESS}` (migration replay + auth shim) · `${E2E_SETUP}` (authed
fixture, needs `${E2E_CREDS}`) · `${DEPLOY_SCOPE_CONFIG}` (per-lane deploy scoping) · `${AUDIT_DIR}`.
Record these in your notes so a fresh session finds them fast.

---

## 11. Gate scripts (drop into `${SCRIPTS_DIR}`; make hard gates fail CLOSED)

The mechanism the whole manual leans on: runnable checks a fresh session cannot skip by *omission*.
Every helper the scripts call is defined here (§11.4), pre-written per common test-runner/host, so
you **select** rather than **author**. They enforce only the *mechanically checkable* gates
(audit-dated-today, exact-RED-set, literal-word, hardcoded flag, smoke-on-new-url); they **cannot**
judge semantic quality (was the review thorough? is each allowlisted RED intentional?) — that needs
`${AGENT_RULES_FILE}` + human judgment. All scripts are POSIX `sh` and source one `gate.env`
(Appendix A). After filling §0, run `preflight.sh --self-test` (a real branch) to prove the wiring.

### 11.1 `preflight.sh` — commit/deploy precondition + `--self-test`
```sh
#!/usr/bin/env sh
set -eu
HERE="$(dirname "$0")"
. "$HERE/gate.env"

if [ "${1:-}" = "--self-test" ]; then   # prove wiring; run nothing destructive/expensive
  fail=0
  for f in gate.env parse-failures.sh deploy-url.sh verify-gate.sh ship.sh; do
    [ -f "$HERE/$f" ] || { echo "self-test FAIL: missing $HERE/$f" >&2; fail=1; }
  done
  for k in TEST_CMD INTEG_CMD BUILD_CMD TYPECHECK_CMD AUDIT_DIR AUDIT_ARTIFACT \
           KNOWN_RED_TESTS_FILE DEPLOY_WORDS DEPLOY_TARGETS PREBUILT_FLAG SMOKE_CMD TEST_RUNNER; do
    eval "v=\${$k:-}"; [ -n "${v:-}" ] || { echo "self-test FAIL: gate.env key '$k' empty/unset" >&2; fail=1; }
  done
  . "$HERE/parse-failures.sh"; . "$HERE/deploy-url.sh"
  got_red="$(printf 'FAIL tests/example.test.ts > boom\n' | (TEST_RUNNER=vitest extract_failing_test_ids) || true)"
  case "$got_red" in *example.test.ts*) : ;; *) echo "self-test FAIL: extract_failing_test_ids (got '$got_red')" >&2; fail=1;; esac
  got_url="$(printf 'Website URL: https://d--rally.netlify.app\n' | (new_deploy_url main) || true)"
  case "$got_url" in https://*netlify.app) : ;; *) echo "self-test FAIL: new_deploy_url (got '$got_url')" >&2; fail=1;; esac
  [ -e "$KNOWN_RED_TESTS_FILE" ] || : > "$KNOWN_RED_TESTS_FILE" 2>/dev/null \
    || { echo "self-test FAIL: cannot create $KNOWN_RED_TESTS_FILE" >&2; fail=1; }
  [ "$fail" -eq 0 ] && { echo "self-test: PASS"; exit 0; } || { echo "self-test: FAIL" >&2; exit 1; }
fi

"$HERE/verify-gate.sh"                                    # 1) the verify/known-RED gate must pass
TODAY="$(date +%Y-%m-%d)"                                 # 2) a commit-gate audit dated today must exist
ls "${AUDIT_DIR}" 2>/dev/null | grep -q "${TODAY}" \
  || { echo "FAIL: no ${AUDIT_ARTIFACT} dated ${TODAY} in ${AUDIT_DIR}." >&2; exit 1; }
if git diff --cached | grep -Ei '(api[_-]?key|secret|token|password)[[:space:]]*[:=]'; then
  echo "FAIL: secret-shaped string in staged diff." >&2; exit 1                 # 3) secrets scan
fi
echo "preflight: PASS"
```

### 11.2 `verify-gate.sh` — known-RED allowlist gate (POSIX; the real test gate)
```sh
#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/gate.env"
. "$(dirname "$0")/parse-failures.sh"          # extract_failing_test_ids() — §11.4
: "${KNOWN_RED_TESTS_FILE:?set in gate.env}"
[ -f "$KNOWN_RED_TESTS_FILE" ] || : > "$KNOWN_RED_TESTS_FILE"   # empty allowlist == suite fully green
ACTUAL_RED="$(${TEST_CMD} 2>&1 | extract_failing_test_ids | sort -u)"
${INTEG_CMD}; ${BUILD_CMD}                      # build does NOT imply tests ran
${TYPECHECK_CMD} || echo "typecheck advisory-only: continuing"
EXPECTED_RED="$(sort -u "$KNOWN_RED_TESTS_FILE")"
if [ "$ACTUAL_RED" != "$EXPECTED_RED" ]; then
  echo "FAIL: failing tests != known-RED allowlist (unexpected failure or stale allowlist)." >&2
  # POSIX diff (no process substitution): write to temp files.
  _e="$(mktemp)"; _a="$(mktemp)"
  printf '%s\n' "$EXPECTED_RED" > "$_e"; printf '%s\n' "$ACTUAL_RED" > "$_a"
  diff "$_e" "$_a" >&2 || true
  rm -f "$_e" "$_a"
  exit 1
fi
echo "verify-gate: PASS (failing set == allowlist)"
```

### 11.3 `ship.sh` — deploy gate (literal-word incl. multi-word phrases; one gate for all targets)
```sh
#!/usr/bin/env sh
set -eu
. "$(dirname "$0")/gate.env"
. "$(dirname "$0")/deploy-url.sh"               # new_deploy_url() — §11.4
AUTH=""; TARGET=""
for a in "$@"; do case "$a" in --authorized=*) AUTH="${a#*=}";; --target=*) TARGET="${a#*=}";; esac; done
# 1) Literal-word gate. DEPLOY_WORDS is NEWLINE-delimited so multi-word phrases ("ship it") match.
printf '%s\n' "$DEPLOY_WORDS" | grep -Fxq -- "$AUTH" \
  || { echo "FAIL: deploy needs --authorized=<word> from {$(printf '%s' "$DEPLOY_WORDS" | tr '\n' '|')} in the current message." >&2; exit 1; }
"$(dirname "$0")/preflight.sh"                  # 2) EVERY target routes through preflight
DEPLOY_OUT=""                                    # 3) dispatch with the pre-built flag HARDCODED
case "$TARGET" in
  main)       DEPLOY_OUT="$(eval "${DEPLOY_CMD_MAIN} ${PREBUILT_FLAG}" 2>&1 | tee /dev/stderr)";;
  portal)     DEPLOY_OUT="$( ( cd report-portal && eval "${DEPLOY_CMD_PORTAL} ${PREBUILT_FLAG}" ) 2>&1 | tee /dev/stderr)";;
  cloudflare) DEPLOY_OUT="$(eval "${DEPLOY_CMD_CF} ${PREBUILT_FLAG}" 2>&1 | tee /dev/stderr)";;
  deno)       DEPLOY_OUT="$(eval "${DEPLOY_CMD_DENO} ${PREBUILT_FLAG}" 2>&1 | tee /dev/stderr)";;
  *) echo "FAIL: unknown target '$TARGET' (must be one of ${DEPLOY_TARGETS})." >&2; exit 1;;
esac
NEW_URL="$(printf '%s' "$DEPLOY_OUT" | new_deploy_url "$TARGET")"   # 4) smoke the NEW url, not the previous deploy
[ -n "$NEW_URL" ] || { echo "FAIL: could not parse new deploy URL; refusing to smoke the previous deploy." >&2; exit 1; }
${SMOKE_CMD} --site="$NEW_URL"
echo "ship: deployed $TARGET -> $NEW_URL"
```

### 11.4 Helper implementations — ready-to-run; pick your runner/host, no authoring
Save next to the gate scripts; each script above sources them; `--self-test` exercises both on canned input.

**`parse-failures.sh`** — `extract_failing_test_ids()` reads test stdout on stdin, emits one failing id/line.
```sh
#!/usr/bin/env sh
extract_failing_test_ids() {
  case "${TEST_RUNNER:-vitest}" in
    vitest|jest) grep -E '^[[:space:]]*FAIL[[:space:]]' | sed -E 's/^[[:space:]]*FAIL[[:space:]]+//; s/[[:space:]].*$//' ;;
    pytest)      grep -E '(FAILED|ERROR)[[:space:]]' | sed -E 's/.*(FAILED|ERROR)[[:space:]]+//; s/[[:space:]].*$//' | grep -E '::' ;;
    go)          grep -E '^--- FAIL:' | sed -E 's/^--- FAIL:[[:space:]]+//; s/[[:space:]].*$//' ;;
    *) echo "extract_failing_test_ids: unknown TEST_RUNNER '${TEST_RUNNER:-}' — add a branch" >&2; return 2 ;;
  esac
}
```
> Populate the allowlist with the SAME extractor (so formats can't drift):
> `${TEST_CMD} 2>&1 | extract_failing_test_ids | sort -u > "$KNOWN_RED_TESTS_FILE"`, then eyeball — every line must be an *intentional* RED.

**`deploy-url.sh`** — `new_deploy_url(<target>)` reads the deploy's own output on stdin; no hostname hardcoded.
```sh
#!/usr/bin/env sh
new_deploy_url() {
  case "$1" in
    main|portal) grep -Eo 'https://[a-zA-Z0-9._-]+--[a-zA-Z0-9._-]+\.netlify\.app' | head -n1 \
                   || grep -Eo 'https://[a-zA-Z0-9._-]+\.netlify\.app' | head -n1 ;;
    cloudflare)  grep -Eo 'https://[a-zA-Z0-9._-]+\.pages\.dev' | head -n1 ;;
    deno)        grep -Eo 'https://[a-zA-Z0-9._-]+\.deno\.dev' | head -n1 ;;
    *) echo "new_deploy_url: no parser for '$1' — add one" >&2; return 2 ;;
  esac
}
```
> If your host emits JSON (`netlify deploy --json`), prefer `jq -r '.deploy_ssl_url // .deploy_url'` — exact, not pattern-matched. The grep forms are the no-`jq` fallback.

> **Honesty note — scope of these scripts:** they enforce the *mechanically checkable* gates and
> `--self-test` proves the machinery is wired; they cannot verify semantic claims. The parsers are
> pattern-based on each runner/host's *current* output — if a host changes its format, `new_deploy_url`
> returns empty and `ship.sh` **fails closed** (refuses to smoke) rather than hitting the old deploy;
> re-confirm the pattern after a CLI upgrade. Do not claim the scripts guarantee more than they check.

---

## Appendix A — Fully-filled reference `gate.env` (copy the SHAPE, substitute your facts)

```sh
# --- stack + tooling ---
PKG="pnpm"; TEST_CMD="pnpm test"; TEST_RUNNER="vitest"
INTEG_CMD="pnpm test:integration"; E2E_CMD="pnpm test:e2e"
TYPECHECK_CMD="pnpm typecheck"                 # advisory: ~477 known Supabase `never`
BUILD_CMD="node ./scripts/build.mjs"           # NOTE: skips prebuild -> runs NO tests
KNOWN_RED_TESTS_FILE="scripts/gates/known-red.txt"
# --- gate artifacts ---
AUDIT_DIR="audit/"; AUDIT_ARTIFACT="400-point CTPO HTML audit"
# --- authorization words: NEWLINE-delimited so multi-word phrases match exactly ---
DEPLOY_WORDS="deploy
ship it
go live
push live"
COMMIT_WORDS="commit
ship it"
# --- deploy: PREBUILT_FLAG is appended by ship.sh, never hand-typed ---
DEPLOY_TARGETS="main portal cloudflare deno"; PREBUILT_FLAG="--no-build"
SITE_ID_MAIN="rally-main"                       # define here — never in CLAUDE.md
SITE_ID_PORTAL="rally-invest"
DEPLOY_CMD_MAIN="NETLIFY_AUTH_TOKEN=$NETLIFY_AUTH_TOKEN netlify deploy --prod --dir=dist --site=$SITE_ID_MAIN"
DEPLOY_CMD_PORTAL="NETLIFY_AUTH_TOKEN=$NETLIFY_AUTH_TOKEN netlify deploy --prod --dir=build/client --site=$SITE_ID_PORTAL"
DEPLOY_CMD_CF="wrangler pages deploy dist --project-name=rally-cf"
DEPLOY_CMD_DENO="deployctl deploy --project=rally-edge dist/edge.js"
SMOKE_CMD="node scripts/smoke.mjs"              # ship.sh appends --site=<new_deploy_url>
```
**`scripts/gates/known-red.txt`** (one intentional-RED id/line; empty == suite must be fully green):
```
tests/scoring-format-options.test.ts
tests/scoring-live.test.ts
```
**Prove the wiring, then trust it:**
```sh
chmod +x scripts/gates/*.sh
scripts/gates/preflight.sh --self-test          # must print "self-test: PASS"
. scripts/gates/gate.env; . scripts/gates/parse-failures.sh
$TEST_CMD 2>&1 | extract_failing_test_ids | sort -u > "$KNOWN_RED_TESTS_FILE"   # regenerate allowlist deterministically
```
Everything else in §0 fills in the same literal way. **Nothing in §§1–11 references a value not
defined in `gate.env` or a §0 row.**

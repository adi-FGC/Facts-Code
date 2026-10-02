/**
 * reviewCatalog — the code-review setups the Overview prices, measured.
 *
 * Every figure here was MEASURED from the setup's own text, never estimated:
 * a published file, or for Claude Code (whose prompt is not published) the
 * prompt embedded in the app build. `instructionChars` is the character
 * length of what the setup always loads when invoked with default options,
 * and `codeReadPasses` is how many model contexts the instructions make read
 * the code, at minimum. Each row was researched, then independently
 * re-measured by a second pass told to refute it (2026-09-26). A setup whose
 * text could not be measured keeps `null` and says why in `notes`, and the
 * panel shows "not measured" rather than a guess.
 *
 * RULES FOR EDITING
 *   - Re-measure from `sourceUrl` at the new version and bump `measuredOn` in
 *     the same edit. Tools change their prompts between releases.
 *   - Count only what is unconditional. Conditional passes and files go in
 *     `notes`, so the floor stays a floor.
 *   - See lib/reviewFloor.ts for how these become tokens.
 */
import type { ReviewMeasure } from './reviewFloor.ts';

export interface ReviewSetup extends ReviewMeasure {
  id: string;
  /** How users invoke it, e.g. "Claude Code /code-review". */
  label: string;
  /** Built into an agent harness, or a skill added to one. */
  kind: 'harness' | 'skill';
  maker: string;
  version: string;
  /** YYYY-MM-DD the row was measured against `sourceUrl`. */
  measuredOn: string;
  sourceUrl: string;
  /** Plain words for who reads the code at the smallest diff. */
  readers: string;
  /** What is not counted, or why a figure is missing. */
  notes: string;
  /**
   * Set when the setup's instructions and reviewer count change with the
   * model it runs on: the MODEL_CATALOG id it was measured on. The panel
   * shows no figure for this row under any other model.
   */
  measuredOnModel?: string;
}

const M = '2026-09-26';

export const REVIEW_CATALOG: readonly ReviewSetup[] = [
  /* ── Built into the harness ─────────────────────────────────────────── */
  {
    id: 'claude-code-code-review',
    label: 'Claude Code /code-review',
    kind: 'harness',
    maker: 'Anthropic',
    version: 'v2.1.281',
    measuredOn: M,
    /* The prompt is not published; this docs page describes the command and
       how its effort level is chosen (last level typed, else the session's
       effort, else the model default). Measured from the prompt text
       embedded in the 2.1.281 app build. The same 1,572-char string exists
       in the 2.1.272 CLI, but that build routes some models differently, so
       this figure is for 2.1.281. Opus 5.5 with no effort set uses medium,
       which routes to the minimal single-pass prompt. The verifier
       re-measured the other routes: xhigh 8,010 (desktop) / 7,101
       (terminal) and high 6,525 / 5,616, all one pass; max effort starts 10
       finder sub-agents plus a sweep finder; Sonnet 5 routes start 2 to 8
       finders. Verifier sub-agents run only per candidate finding, so they
       are not counted. */
    sourceUrl: 'https://code.claude.com/docs/en/code-review',
    instructionChars: 1_572,
    codeReadPasses: 1,
    measuredOnModel: 'claude-opus-5-5',
    readers: 'one reviewer',
    notes:
      'Measured on Opus 5.5 with no effort level set (it then uses medium). A session effort, or the level you last typed, picks a longer prompt: about 8,000 characters at xhigh, still one reviewer. At max effort it starts at least 11 reviewers, and on Sonnet 5 models 2 to 8. The prompt isn’t published; measured from the app.',
  },
  {
    id: 'codex-review',
    label: 'Codex /review',
    kind: 'harness',
    maker: 'OpenAI',
    version: 'v0.157.1',
    measuredOn: M,
    /* rubric.md (7,666) replaces Codex's usual system prompt in the review
       thread; the "uncommitted changes" preset (105) is the shortest fixed
       user message. The reviewer thread cannot fan out (multi-agent
       features are disabled for it). */
    sourceUrl:
      'https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/prompts/templates/review/rubric.md',
    instructionChars: 7_771,
    codeReadPasses: 1,
    readers: 'one reviewer',
    notes:
      'Counts the review rubric, which replaces Codex’s usual system prompt for the review, plus the “uncommitted changes” preset.',
  },

  /* ── Skills ─────────────────────────────────────────────────────────── */
  {
    id: 'gstack-review',
    label: 'gstack /review',
    kind: 'skill',
    maker: 'Garry Tan',
    version: 'v1.91.1.0',
    measuredOn: M,
    /* SKILL.md 72,819 + checklist.md 12,193 + sections/plan-completion.md
       13,683 + sections/review-army.md 14,326 + sections/adversarial.md
       24,881, all read unconditionally. greptile-triage.md is skipped when
       no PR exists, so it is left out. Tier sizes come from
       sections/review-army.md: specialists are skipped under 50 changed
       lines, Testing and Maintainability are "always-on" at 50+, red team
       runs "only if DIFF_LINES > 200" (or on a CRITICAL finding). */
    sourceUrl:
      'https://github.com/garrytan/gstack/blob/2a113ae7e623f590095bcaaa0cc581c9a10a6632/review/SKILL.md',
    instructionChars: 137_902,
    /* The main reviewer reads the full diff ("Read the FULL diff before
       commenting"); the always-on adversarial sub-agent reads full content
       for non-test code only and sees test/fixture/spec files as a --stat
       summary (sections/adversarial.md). */
    codeReadPasses: 1,
    nonTestPasses: 1,
    tiers: [
      {
        minLines: 50,
        addPasses: 2,
        addInstructionChars: 3_415 + 2_498,
        adds: 'Testing and Maintainability specialists',
      },
      { minLines: 201, addPasses: 1, addInstructionChars: 2_258, adds: 'a red-team reviewer' },
    ],
    readers: 'the main reviewer, and an adversarial sub-agent that reads non-test code only',
    notes:
      'Not counted, because they run only sometimes: specialists picked by what the diff touches or by its size (security, performance, API, design, simplification and more), which gstack can also skip on past hit rates; Codex passes; and fix-and-re-review cycles. Reviews a branch against its base.',
  },
  {
    id: 'matt-pocock-code-review',
    label: 'Matt Pocock’s code-review',
    kind: 'skill',
    maker: 'Matt Pocock',
    version: 'commit 5c89081',
    measuredOn: M,
    /* One file; its sub-agent prompts are inline and counted once. The
       Spec reviewer is skipped when no spec is found, so the floor is the
       Standards reviewer alone. */
    sourceUrl:
      'https://github.com/mattpocock/skills/blob/5c89081d4bbeb3d039a42093653f90bb698d780e/skills/engineering/code-review/SKILL.md',
    instructionChars: 6_559,
    codeReadPasses: 1,
    readers: 'the Standards sub-agent',
    notes:
      'A second, Spec reviewer runs only when a spec is found, and is not counted. Reviews the changes since a commit you name.',
  },
];

/**
 * reviewFloor — the minimum input tokens a code-review setup must read to
 * review every file of THIS project.
 *
 * By default every setup priced here reviews a DIFF. "Every file" means the
 * whole project reviewed as new code: a diff that adds every file. It is the
 * most a review of this project can cover, and the only size that makes the
 * floor a property of the project rather than of one change. The panel says
 * so next to the figures.
 *
 * WHAT "MINIMUM" COUNTS
 *   - The review instructions the setup always loads when invoked with its
 *     default options: its command or skill file, plus files it is told to
 *     read unconditionally. Counted once, although sub-agents receive parts
 *     of them again (so this stays a floor).
 *   - The project's code, once per model context that must read it. A
 *     context told to read non-test code only is charged the non-test tokens
 *     only. Some setups start more reviewers as the diff grows; `tiers`
 *     records those size rules, and only unconditional ones (never scope- or
 *     flag-gated).
 * WHAT IT LEAVES OUT
 *   - The harness's own system prompt and tool definitions: sent with every
 *     request whatever the task, so they are not a cost of reviewing.
 *   - Anything conditional, context the reviewer reads beyond the diff,
 *     re-sent context on later calls, and output tokens.
 *
 * The FACTS artifact does NOT lower this floor: a review has to read the code
 * it reviews. That is stated in the panel, never implied otherwise.
 *
 * Instruction sizes are characters measured from each setup's own text
 * (lib/reviewCatalog.ts), converted with the SAME chars-per-token rule as the
 * codebase count, so the two halves of every sum are comparable.
 */
import type { DatasetTreeNode } from './loadArtifacts.ts';
import { CHARS_PER_TOKEN } from './tokenEconomics.ts';

/** A size rule: at `minLines` added lines or more, the review always adds these. */
export interface PassTier {
  minLines: number;
  /** Extra contexts that each read the whole diff. */
  addPasses: number;
  addInstructionChars: number;
  /** Plain words for what the tier adds, e.g. "Testing and Maintainability specialists". */
  adds: string;
}

export interface ReviewMeasure {
  /** Characters of instructions always loaded; null = could not be measured. */
  instructionChars: number | null;
  /** Contexts that read the whole diff at the smallest size; null = not established. */
  codeReadPasses: number | null;
  /** Contexts told to read non-test code only (see isTestLikePath). */
  nonTestPasses?: number;
  /** Unconditional size rules, if the setup scales with the diff. */
  tiers?: readonly PassTier[];
}

/** What is being reviewed: the whole project, as new code. */
export interface ReviewedCode {
  tokens: number;
  /** Tokens outside test-like paths; see isTestLikePath. */
  nonTestTokens: number;
  /** Added lines, as git would count them for the diff. */
  lines: number;
}

export interface ReviewFloor {
  /** Every context that reads code, including non-test-only ones. */
  passes: number;
  instructionTokens: number;
  codeTokens: number;
  totalTokens: number;
  /** The tiers that applied, smallest first. */
  applied: readonly PassTier[];
}

/**
 * The paths gstack's adversarial reviewer reads only as a summary:
 * `':(exclude)*test*' ':(exclude)*fixture*' ':(exclude)*.spec.*'`. Those are
 * git pathspecs, so `*` crosses `/` and the match is case-sensitive: any path
 * containing "test" anywhere (a `test/` folder, `latest.ts`) is excluded.
 * Matched the same way here, so the non-test figure is what that reviewer
 * actually reads in full.
 */
export function isTestLikePath(path: string): boolean {
  return path.includes('test') || path.includes('fixture') || path.includes('.spec.');
}

/** Tokens of every file whose path is not test-like. */
export function nonTestTokensOf(tree: DatasetTreeNode | undefined): number {
  if (!tree) return 0;
  let sum = 0;
  const walk = (n: DatasetTreeNode) => {
    for (const f of n.files ?? []) if (!isTestLikePath(f.path)) sum += Math.max(0, f.tokens || 0);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return sum;
}

/**
 * The floor for one setup reviewing `code`, or null when a measurement is
 * missing. Never a partial sum: a total missing a term would read as a real,
 * smaller floor.
 */
export function reviewFloor(setup: ReviewMeasure, code: ReviewedCode): ReviewFloor | null {
  const { instructionChars, codeReadPasses } = setup;
  const nonTestPasses = setup.nonTestPasses ?? 0;
  if (typeof instructionChars !== 'number' || typeof codeReadPasses !== 'number') return null;
  if (instructionChars < 0 || codeReadPasses < 1 || !Number.isInteger(codeReadPasses)) return null;
  if (nonTestPasses < 0 || !Number.isInteger(nonTestPasses)) return null;

  const applied = (setup.tiers ?? [])
    .filter((t) => code.lines >= t.minLines)
    .sort((a, b) => a.minLines - b.minLines);
  const fullPasses = applied.reduce((n, t) => n + t.addPasses, codeReadPasses);
  const chars = applied.reduce((n, t) => n + t.addInstructionChars, instructionChars);

  const tokens = Math.max(0, Math.round(code.tokens));
  /* Never above the whole: a non-test figure larger than the total would be
     a measurement error, and must not inflate a minimum. */
  const nonTest = Math.min(tokens, Math.max(0, Math.round(code.nonTestTokens)));
  const instructionTokens = Math.round(chars / CHARS_PER_TOKEN);
  const codeTokens = fullPasses * tokens + nonTestPasses * nonTest;
  return {
    passes: fullPasses + nonTestPasses,
    instructionTokens,
    codeTokens,
    totalTokens: instructionTokens + codeTokens,
    applied,
  };
}

/**
 * Plain-English risk rewrites — v0.3.8.
 *
 * Maps every rule id the FACTS scanner pipeline emits to a CXO-readable
 * version of the message. Deterministic, no LLM. The original technical
 * text is retained on the Risk as `messageTechnical` so AI agents
 * reading `agent.json` get both: the action-oriented message goes to
 * humans, the precise rule-name + raw context goes to agents.
 *
 * Why this matters: a CXO opening the Risks tab today sees
 * "47 high-severity SCA findings". That's a number. The rewrite
 * version says "3 packages haven't shipped in 2+ years and 1
 * maintainer's account is deleted" — which is a sentence they can
 * forward to a co-founder.
 *
 * Rule-id → template. Templates take a context (technical message,
 * file, optional count) so quantity-aware rewrites can rebuild a
 * count from the original message via regex when useful. Pure /
 * isomorphic per the package's existing convention.
 */

export interface RewriteContext {
  /** The original technical message — used by quantity-aware templates. */
  technical: string;
  /** Optional file path. Most templates inject this when present. */
  file?: string | undefined;
}

export type RewriteTemplate = (ctx: RewriteContext) => string;

/* The map keys MUST match the rule ids actually emitted by the
 * scanner pipeline. Adding a new rule id without a rewrite is safe —
 * `rewriteRiskMessage()` returns null and the original message
 * passes through unchanged.
 *
 * The phrasing rules:
 *   - Lead with the consequence to the user / business / system.
 *   - Name the file when present (most readers can't search the repo).
 *   - End with what to do, not "this is bad".
 *   - No jargon: no "entropy", no "SCA", no "SPDX", no "transitive".
 */
export const RULE_REWRITES: Record<string, RewriteTemplate> = {
  // ─── Secrets ────────────────────────────────────────────────────
  'aws-access-key': ({ file }) =>
    `An AWS access key is hardcoded${file ? ` in ${file}` : ''}. Anyone with access to this repo can read it. Rotate the key now and switch to runtime credentials.`,

  'aws-secret-key': ({ file }) =>
    `AWS secret credentials are embedded in source${file ? ` (${file})` : ''}. This grants full programmatic access to your AWS account. Rotate immediately.`,

  'openai-api-key': ({ file }) =>
    `An OpenAI API key is committed to the repository${file ? ` in ${file}` : ''}. Crawlers will find this and run up charges. Rotate the key and store it in an environment variable.`,

  'github-token': ({ file }) =>
    `A GitHub personal access token is in source${file ? ` (${file})` : ''}. This may grant push access or private-repo read. Revoke and replace before merging anything else.`,

  'github-classic-token': ({ file }) =>
    `A classic GitHub token is committed${file ? ` in ${file}` : ''}. Revoke it now — classic tokens carry broad scope and rarely have IP restrictions.`,

  'stripe-secret-key': ({ file }) =>
    `A Stripe secret key is committed${file ? ` in ${file}` : ''}. Anyone reading this can charge your customers, issue refunds, and read full payment data. Rotate immediately.`,

  'stripe-restricted-key': ({ file }) =>
    `A Stripe restricted API key is committed${file ? ` in ${file}` : ''}. Even with limited scope, rotate it — keys in source belong to the repo, not a person.`,

  'private-key-header': ({ file }) =>
    `A private cryptographic key is checked in${file ? ` (${file})` : ''}. Treat the corresponding public key as compromised. Replace it and audit who has cloned the repo since the key landed.`,

  'generic-secret': ({ file }) =>
    `A long random-looking string was found${file ? ` in ${file}` : ''} that looks like a secret. Confirm whether it is, and if so, rotate it before pushing further commits.`,

  'env-secret-pair': ({ file }) =>
    `A name=value pair that looks like secret config is committed${file ? ` in ${file}` : ''}. Move it to a .env file (and add .env to .gitignore) or to a secrets manager.`,

  // ─── Imports / structure ────────────────────────────────────────
  'unresolved-import': ({ file }) =>
    `A broken import in ${file ?? 'an unknown file'} means part of the codebase can't be built or tested as currently written. Either the dependency was removed or the path is stale.`,

  'unscanned-import': ({ file }) =>
    `An import in ${file ?? 'an unknown file'} points at a file that exists on disk but sits in a directory the analyzer doesn't scan (build output like dist/, or an ignored folder). It likely works after a build — but it breaks whenever that output is missing or regenerated, so prefer importing from source.`,

  'parse-error': ({ file }) =>
    `${file ?? 'A source file'} has a syntax error and couldn't be analyzed. The rest of the report is missing data from this file until it's fixed.`,

  'read-error': ({ file }) =>
    `${file ?? 'A file'} could not be read during analysis (it may have been locked or mid-save). Its line and token counts in this report are placeholders, not measurements — re-run the analysis to fill them in.`,

  'binary-source': ({ file }) =>
    `${file ?? 'A source file'} looks like code by its name but its content reads as binary — most likely it was saved in an unusual encoding (like UTF-16). The analyzer couldn't measure it; re-save the file as UTF-8 to bring it back into the report.`,

  'import-cycle': ({ technical }) => {
    const fileCount = technical.match(/across (\d+) file/i)?.[1] ?? technical.match(/(\d+)\s*files?/i)?.[1] ?? 'several';
    return `A circular dependency between ${fileCount} files makes this code harder to test and easier to break in unexpected ways. The cycle forces the whole loop to rebuild together.`;
  },

  // ─── Licenses ───────────────────────────────────────────────────
  'copyleft-detected': ({ file }) =>
    `A GPL or AGPL-licensed file (${file ?? 'unknown path'}) is included in this project. If the rest of the project ships under a permissive license, this combination may legally require open-sourcing the whole thing.`,

  'missing-license': () =>
    `No software license is declared. Without one, contributors and users have no legal right to use, copy, or distribute this code — even if the repo is public.`,

  'license-mismatch': ({ file, technical }) =>
    `A file (${file ?? 'unknown'}) declares a license that disagrees with the project's top-level LICENSE. ${technical} Pick one and align them.`,

  // ─── Size / staleness ──────────────────────────────────────────
  'file-size-cap': ({ file, technical }) => {
    const sizeMatch = technical.match(/(\d+(?:\.\d+)?)\s*(MB|KB|bytes)/i);
    const size = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2]}` : 'oversized';
    return `${file ?? 'A file'} is ${size} — large enough that the analyzer skipped it. Consider whether it belongs in source (large fixtures, generated code, and binaries usually don't).`;
  },

  'stale-todo': ({ file, technical }) =>
    `${file ?? 'A file'} carries a TODO that hasn't been touched in over a year. ${technical}`,

  'large-file': ({ file }) =>
    `${file ?? 'A file'} has grown past the size where one person can hold it all in head. Consider whether it should be split into focused modules.`,
};

/**
 * Given a rule id + technical message + optional file, return the
 * CXO-readable rewrite. Returns null when no rewrite exists for the
 * rule id — caller should fall through to the technical message
 * unchanged.
 */
export function rewriteRiskMessage(
  ruleId: string,
  technicalMessage: string,
  file?: string | undefined,
): string | null {
  const tmpl = RULE_REWRITES[ruleId];
  if (!tmpl) return null;
  return tmpl({ technical: technicalMessage, file });
}

/** Convenience for callers that have a partial Risk object — returns
 *  a copy with the message rewritten and the technical text moved into
 *  `messageTechnical`. When no rewrite exists, returns the input
 *  unchanged. */
export function applyRewrite<T extends { rule: string; message: string; file?: string | undefined; messageTechnical?: string | undefined }>(
  risk: T,
): T {
  const plain = rewriteRiskMessage(risk.rule, risk.message, risk.file);
  if (!plain) return risk;
  return { ...risk, message: plain, messageTechnical: risk.message };
}

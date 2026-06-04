/**
 * Tiny formatting helpers shared across renderers.
 *
 * Lives in its own file rather than inlined per renderer because the
 * three renderers (claude/cursor/copilot) had three byte-identical
 * copies of this function, which is exactly the "duplication is a
 * fact" signal that justifies promotion.
 *
 * Kept dependency-free + isomorphic — same constraint as the rest of
 * @factstack/skills.
 */

import type { SkillSpec } from './types.js';

/**
 * Format an integer for display: 1.2M / 3.4K / 567.
 *
 * Tokens and LOC use the same scale (both are large integers humans
 * want to skim at-a-glance), so one formatter serves both. The unit
 * label travels with the call site, not the formatter.
 */
export function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * The FACTS operating contract — the highest-leverage thing a skill
 * teaches: work *from* the FACTS pack, keep it fresh, and don't
 * re-derive the codebase by scanning. Shared verbatim across every
 * renderer so all agent tools (Claude, Cursor, Copilot, Codex/AGENTS.md)
 * learn the identical workflow; only each format's surrounding
 * persona/voice differs.
 *
 * Encodes the two adoption decisions (roadmap Phase 6, 2026-06-04):
 *   - Freshness → a PostToolUse hook re-runs `factstack analyze --minimal`
 *     after each edit (fallback: the agent runs it itself).
 *   - Context  → read `.facts/agent.pack` + MEMORY.md FIRST; the FACTS MCP
 *     server's live tools are the enhancement when connected, not the
 *     prerequisite (the old skill went "stale snapshot" whenever the MCP
 *     was down).
 *
 * `heading` lets each renderer keep the section title that fits its
 * document (claude/copilot default to "How to work in this project";
 * AGENTS.md leads with "Before you scan: use the FACTS map"; cursor
 * reuses its existing "Workflow conventions" title so its section-
 * presence test still holds). Returns markdown lines for the caller to
 * splice into its own array.
 */
export function workflowContract(
  spec: SkillSpec,
  heading = 'How to work in this project',
): string[] {
  const tools = spec.onboardingSequence.map((t) => `\`${t}\``).join(', ');
  const mcpClause = tools
    ? ` When the FACTS MCP server is connected, its live tools (${tools}) are the` +
      ' preferred query path; the pack files are the always-available fallback.'
    : '';
  const out: string[] = [];
  out.push(`## ${heading}`);
  out.push('');
  out.push(
    'This repo ships a **FACTS context pack**. Work *from* it — do not re-derive' +
      ' the codebase by grepping or listing the whole tree.',
  );
  out.push('');
  out.push(
    '1. **Orient from the pack, not a scan.** Before any broad search, read' +
      ' `.facts/agent.pack` (token-lean: every file, top-level symbol, import' +
      ' edge, route, and risk) and `MEMORY.md` (the cold-start brief) — the' +
      ' source of truth for *where things are*.' + mcpClause,
  );
  out.push(
    '2. **Navigate by the graph.** "Where is `X`?" → the pack\'s declarations' +
      ' (symbol → file:line). "What breaks if I change `Y`?" → the imports table' +
      " (a resolved graph; grep can't do transitive). Open only the files the" +
      ' pack points you to.',
  );
  out.push(
    '3. **Keep the pack fresh.** A `PostToolUse` hook re-runs `factstack analyze' +
      ' --minimal` after each edit, so the pack + `MEMORY.md` track your changes.' +
      ' If the hook is not installed, run that command yourself after editing —' +
      ' then re-read the pack before planning the next change.',
  );
  out.push(
    '4. **Verify load-bearing claims against source.** The pack is generated; if' +
      ' a fact decides your change, confirm it in the file the pack cites.',
  );
  return out;
}

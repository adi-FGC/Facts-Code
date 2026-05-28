/**
 * Canonical types for the skill-bundle emitter.
 *
 * Two layers:
 *
 *   1. `SkillSpec` — format-agnostic intermediate representation of
 *      everything a skill bundle needs to know about a project. All
 *      three renderers (Claude, Cursor, GitHub Copilot) consume only
 *      this shape. Adding a 4th format = one new renderer file that
 *      reads from here. Adding a new field here = the new data
 *      becomes visible in every format on the next regen.
 *
 *   2. `SkillRenderer` — per-format adapter. `render(spec)` returns
 *      a map of relative output paths → file body strings. The
 *      orchestrator (`buildSkillsTo`) walks the registry, calls each
 *      renderer, and writes the resulting files through the supplied
 *      `FileWriter` interface from `@factstack/spec`.
 *
 * Why this lives in its own package (not in @factstack/core like
 * memory.ts):
 *   - Three adapters today (Claude, Cursor, Copilot) — past the
 *     "one adapter = hypothetical seam; two adapters = real seam"
 *     line from CONTEXT.md.
 *   - Future MCP `list_skills` tool, UI `/skills` preview route, and
 *     additional formats (Continue.dev, Aider, GitHub Copilot Workspace)
 *     all consume the same `SkillSpec` IR — keeping it in a dedicated
 *     package makes those additions cheap and avoids bloating core/
 *     with format-specific code.
 *
 * Pure isomorphic — no DOM imports, no `node:*`, no Zod runtime
 * validation. The IR is built from artifacts that have already been
 * validated upstream; this tier just shapes + renders.
 */

import type { Risk } from '@factstack/spec';

/* The spec doesn't export a standalone Severity type — Risk's severity
 * is an inline z.enum. Project it as a named alias so SkillRisk consumers
 * don't have to dereference Risk['severity']. */
export type SkillRiskSeverity = Risk['severity'];

/* ─────────── canonical IR ─────────── */

/** Project's primary languages by source-line share. Cap 3 in the spec
 *  to keep the skill bundle scannable; full breakdown lives in
 *  agent.json for agents who want it. */
export interface SkillLanguage {
  id: string;
  pct: number;
}

/** A route surface (HTTP endpoint, file-based route, etc.) the agent
 *  should know about. Cap 12 across all frameworks. */
export interface SkillRoute {
  method: string;
  path: string;
  framework: string;
}

/** Most-imported "hub" files — the things to read first. Derived from
 *  graph in-degree. Cap 5 (Pareto: top files account for most coupling). */
export interface SkillKeyFile {
  path: string;
  inDegree: number;
}

/** A high-/critical-severity finding worth surfacing to the agent on
 *  first contact. Lower-severity findings live in agent.risks for
 *  agents who drill in. Cap 8. */
export interface SkillRisk {
  severity: SkillRiskSeverity;
  category: string;
  message: string;
  file?: string;
}

/**
 * Format-agnostic shape every renderer consumes. The 12 fields below
 * are the union of what all three target formats find useful when an
 * AI agent first joins a project.
 *
 * Design constraints:
 *   - Stable: don't add fields that change every analyze (file count
 *     is fine; per-file LOC isn't).
 *   - Deterministic: same input → byte-identical output. No
 *     `Date.now()` calls at render time; the timestamp comes from the
 *     source artifact's `generatedAt`.
 *   - Capped: caps are load-bearing — without them the Claude
 *     SKILL.md balloons past 10 KB on large monorepos. Mirrors
 *     memory.ts's cap constants.
 */
export interface SkillSpec {
  /* ── Identity ─────────────────────────────────────────────────── */
  name: string;
  intent: string;
  factsVersion: string;
  generatedAt: string;

  /* ── Stack ────────────────────────────────────────────────────── */
  languages: SkillLanguage[];
  frameworks: string[];
  stats: { files: number; loc: number; tokens: number };

  /* ── Map ──────────────────────────────────────────────────────── */
  capabilities: string[];
  entryPoints: string[];
  keyFiles: SkillKeyFile[];
  routes: SkillRoute[];

  /* ── Risk surface ─────────────────────────────────────────────── */
  openRisks: SkillRisk[];
  vulnerabilityCount: number;

  /* ── Onboarding ───────────────────────────────────────────────── */
  /** Ordered MCP-tool names the agent should follow when joining the
   *  project. Hardcoded — see ONBOARDING_SEQUENCE below. */
  onboardingSequence: string[];
}

/* ─────────── per-format renderer adapter ─────────── */

/**
 * One registered output format = one `SkillRenderer`. The `render`
 * function returns a map of relative paths (within the output
 * directory) → file body text. Multi-file outputs are allowed (a
 * renderer can emit several files into different sub-paths if needed,
 * e.g. `.claude/skills/factstack/SKILL.md` + a sidecar manifest).
 *
 * Same shape used by every adapter, so the orchestrator dispatches via
 * a plain object map without conditionals.
 */
export interface SkillRenderer {
  /** Stable id for the format (also the `--target` CLI flag value). */
  id: SkillFormatId;
  /** Human-readable name for log output. */
  label: string;
  /** Returns: { relativePath: body, ... } */
  render(spec: SkillSpec): Record<string, string>;
}

export type SkillFormatId = 'claude' | 'cursor' | 'copilot';

/* ─────────── caps ─────────── */

/* Mirror memory.ts's TRUNCATE_* constants so skill output stays in
 * a similar size envelope (~5-10 KB). Tune deliberately. */
export const CAPS = {
  languages: 3,
  frameworks: 8,
  capabilities: 6,
  entryPoints: 8,
  keyFiles: 5,
  routes: 12,
  risks: 8,
} as const;

/* ─────────── onboarding sequence ─────────── */

/**
 * MCP tool names an agent should call (in this order) when first
 * contacting a FACTS-scanned project. Renderers reference this in the
 * "preparation" section of each output so every format teaches the
 * same workflow.
 *
 * Sync with `apps/mcp-server/src/server.ts` when MCP tools change.
 * The shipped sequence as of v0.7:
 *
 *   1. read_memory          — fast 2-10 KB project brief (factstack-memory.v1)
 *   2. analyze              — kick fresh analysis if MEMORY.md is stale
 *   3. query_graph          — answer "who calls X?" / "what imports X?"
 *   4. list_risks           — full risk surface (filterable by severity/category)
 *   5. list_credentials     — leaked-secrets sub-view
 *   6. list_vulnerabilities — CVE findings from `factstack scan-vulns`
 *
 * Lower-leverage tools (`get_outline`, `since`, `log_learning`,
 * `query_learnings`, `get_config`) are intentionally omitted — the
 * skill teaches the 80% path; full tool list lives in the MCP server
 * description that the client already shows.
 */
export const ONBOARDING_SEQUENCE: readonly string[] = [
  'read_memory',
  'analyze',
  'query_graph',
  'list_risks',
  'list_credentials',
  'list_vulnerabilities',
] as const;

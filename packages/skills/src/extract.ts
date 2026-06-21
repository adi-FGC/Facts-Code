/**
 * Pure extractor: AgentArtifact + HumanArtifact → SkillSpec.
 *
 * Mirrors the section-extraction logic in `@factstack/core`'s
 * `memory.ts` (top languages by LOC %, top-imported hub files,
 * high-and-critical risks only). We don't import from core to avoid
 * the dependency edge — both packages descend from @factstack/spec
 * and stay isomorphic.
 *
 * Design contract (matches buildMemory):
 *   - PURE: no Date.now(), no Math.random(), no Node imports.
 *   - DETERMINISTIC: byte-identical output for byte-identical input.
 *   - CAPPED: every list field respects CAPS so the resulting skill
 *     bundle stays in the 5-10 KB envelope.
 *   - SECTION OMISSION over empty fields: empty arrays are passed
 *     through; renderers decide whether to omit the section header.
 *
 * The hardcoded `ONBOARDING_SEQUENCE` constant ships in the spec
 * regardless of input — it teaches the workflow, not a per-project
 * fact. Renderers reference it in their preparation sections.
 */

import type { AgentArtifact, HumanArtifact, Risk } from '@factstack/spec';
import { byCodeUnit } from '@factstack/spec';
import {
  CAPS,
  ONBOARDING_SEQUENCE,
  type SkillKeyFile,
  type SkillLanguage,
  type SkillRisk,
  type SkillRoute,
  type SkillSpec,
} from './types.js';

export function agentToSkillSpec(
  agent: AgentArtifact,
  human: HumanArtifact,
): SkillSpec {
  return {
    name: agent.project.name,
    intent: pickIntent(human),
    factsVersion: agent.factsVersion,
    generatedAt: agent.generatedAt,

    languages: topLanguages(agent, CAPS.languages),
    frameworks: (agent.project.frameworks ?? []).filter(Boolean).slice(0, CAPS.frameworks),
    stats: {
      files: agent.stats.fileCount,
      loc: agent.stats.loc,
      tokens: agent.stats.totalTokenCost,
    },

    capabilities: (agent.capabilities ?? []).slice(0, CAPS.capabilities),
    entryPoints: (agent.project.entryPoints ?? []).filter(Boolean).slice(0, CAPS.entryPoints),
    keyFiles: topImportedFiles(agent, CAPS.keyFiles),
    routes: pickRoutes(agent, CAPS.routes),

    openRisks: pickOpenRisks(agent, CAPS.risks),
    /* Headline only — the full Vulnerability[] lives in agent.json.
       Renderers show "N known CVEs" + a pointer to list_vulnerabilities. */
    vulnerabilityCount: agent.vulnerabilities?.length ?? 0,

    onboardingSequence: [...ONBOARDING_SEQUENCE],
  };
}

/* ─────────── helpers (private to this module) ─────────── */

/** Prefer the deterministic intent sentence (composed by the v0.3.10
 *  intent generator) over the legacy one-liner. Empty intent ⇒ fall
 *  back to oneLiner. Same precedence buildMemory uses. */
function pickIntent(human: HumanArtifact): string {
  const intent = human.summary.intent;
  if (intent && intent.length > 0) return intent;
  return human.summary.oneLiner ?? '';
}

/** Top-N languages by total LOC, with integer percentages. */
function topLanguages(agent: AgentArtifact, limit: number): SkillLanguage[] {
  const totals = new Map<string, number>();
  let totalLoc = 0;
  for (const f of agent.files) {
    if (!f.language) continue;
    const loc = f.loc || 0;
    totals.set(f.language, (totals.get(f.language) ?? 0) + loc);
    totalLoc += loc;
  }
  if (totalLoc === 0) return [];
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, loc]) => ({ id, pct: Math.round((loc / totalLoc) * 100) }));
}

/** Most-imported "hub" files via graph in-degree. Sorted desc by
 *  in-degree; ties broken alphabetically for determinism. */
function topImportedFiles(agent: AgentArtifact, limit: number): SkillKeyFile[] {
  const inDegree = new Map<string, number>();
  for (const e of agent.graph?.edges ?? []) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }
  return [...inDegree.entries()]
    .filter(([, n]) => n > 0)
    // DI-1: code-unit (not locale) for INV2 byte-determinism
    .sort((a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]))
    .slice(0, limit)
    .map(([path, n]) => ({ path, inDegree: n }));
}

/** Routes sorted by framework then path. Caps total count regardless
 *  of framework distribution — different from memory.ts which caps
 *  per group. For a skill bundle, "top N across the whole project"
 *  is what the agent actually needs to see. */
function pickRoutes(agent: AgentArtifact, limit: number): SkillRoute[] {
  const routes = agent.routes ?? [];
  return routes
    .slice()
    .sort((a, b) => {
      const fw = byCodeUnit(a.framework || '', b.framework || '');
      if (fw !== 0) return fw;
      return byCodeUnit(a.path || '', b.path || '');
    })
    .slice(0, limit)
    .map((r) => ({
      method: r.method ?? 'GET',
      path: r.path,
      framework: r.framework,
    }));
}

/** High- and critical-severity risks only. Anything lower is noise
 *  in a skill bundle — agents drill into the full risk surface via
 *  the MCP `list_risks` tool when they need it. */
function pickOpenRisks(agent: AgentArtifact, limit: number): SkillRisk[] {
  const filtered = (agent.risks ?? []).filter(
    (r): r is Risk => r != null && (r.severity === 'high' || r.severity === 'critical'),
  );
  return filtered
    .slice(0, limit)
    .map((r) => ({
      severity: r.severity,
      category: r.category,
      message: r.message,
      ...(r.file ? { file: r.file } : {}),
    }));
}

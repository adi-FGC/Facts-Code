/**
 * Renderer contract for FACTS discoverability artifacts.
 *
 * Mirrors `@factstack/skills`' `SkillRenderer`: one registered artifact =
 * one `SiteRenderer`. `render(reg)` returns a map of relative output paths
 * (within `dist/`) → file body strings. The orchestrator
 * (`buildSiteArtifactsTo`) walks the registry, calls each renderer, and
 * writes every entry through the supplied `FileWriter`.
 *
 * Pure + isomorphic — no `node:*`, no DOM. Every renderer reads only the
 * `SiteRegistry` IR, so output is deterministic given a fixed registry
 * (whose `generatedAt` is itself threaded in by the caller).
 */

import type { SiteRegistry } from '@factstack/registry';

export interface SiteRenderer {
  /** Stable id (also the orchestrator's `ids?` selector value). */
  id: string;
  /** Returns { relativePath: body, ... }. A renderer may emit several
   *  files (e.g. llms.txt AND llms-full.txt). */
  render(reg: SiteRegistry): Record<string, string>;
}

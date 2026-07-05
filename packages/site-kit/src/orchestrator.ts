/**
 * `buildSiteArtifactsTo` — pure orchestrator that renders every registered
 * discoverability artifact and writes it through a `FileWriter`.
 *
 * Mirrors `@factstack/skills`' `buildSkillsTo`:
 *   - First positional arg is the `FileWriter` (Node / FSA / Memory).
 *   - Then the `SiteRegistry` input.
 *   - Trailing `ids?` selects a subset of registered renderers; defaults
 *     to all.
 *
 * The orchestrator owns no I/O — every `writer.writeText(...)` is the
 * FileWriter's responsibility, which is what makes `MemoryFileWriter`
 * viable as a zero-disk test surface. Adding a new artifact = one entry
 * in `SITE_RENDERERS` plus one renderer file; no orchestrator change.
 *
 * NOTE: the HTML `<meta>` fragment is intentionally NOT in this registry —
 * it isn't a standalone file; it's spliced into `index.html`. Callers use
 * `renderMetaFragment(reg)` (re-exported from the barrel) for that.
 */

import type { FileWriter } from '@factstack/spec';
import type { SiteRegistry } from '@factstack/registry';
import type { SiteRenderer } from './types.js';
import { llmsTxtRenderer } from './renderers/llms-txt.js';
import { mcpManifestRenderer } from './renderers/mcp-manifest.js';
import { sitemapRenderer } from './renderers/sitemap.js';
import { robotsRenderer } from './renderers/robots.js';
import { manifestRenderer } from './renderers/manifest.js';
import { securityTxtRenderer } from './renderers/security-txt.js';

/** Single source of truth: every file-emitting renderer, keyed by id.
 *  Iteration order is stable (declaration order); tests may rely on it. */
export const SITE_RENDERERS: readonly SiteRenderer[] = [
  llmsTxtRenderer,
  mcpManifestRenderer,
  sitemapRenderer,
  robotsRenderer,
  manifestRenderer,
  securityTxtRenderer,
];

/** All registered renderer ids — useful for `ids?` validation + logging. */
export const ALL_SITE_ARTIFACT_IDS: readonly string[] = SITE_RENDERERS.map((r) => r.id);

export interface BuildSiteArtifactsResult {
  /** Map of every file written (relpath → body). */
  files: Record<string, string>;
  /** Total UTF-8 bytes across every emitted file. */
  bytesWritten: number;
  /** Renderer ids actually run (filtered against the registry). */
  ids: string[];
}

/**
 * Render + write the requested artifacts to `writer`. Unknown ids are
 * silently dropped (the caller's CLI/build layer surfaces typos), matching
 * `buildSkillsTo`'s pure-orchestrator behavior.
 */
export async function buildSiteArtifactsTo(
  writer: FileWriter,
  reg: SiteRegistry,
  ids?: string[],
): Promise<BuildSiteArtifactsResult> {
  const selected = ids
    ? SITE_RENDERERS.filter((r) => ids.includes(r.id))
    : SITE_RENDERERS;

  const allFiles: Record<string, string> = {};
  let bytes = 0;
  for (const renderer of selected) {
    const files = renderer.render(reg);
    for (const [path, body] of Object.entries(files)) {
      allFiles[path] = body;
      bytes += await writer.writeText(path, body);
    }
  }

  return { files: allFiles, bytesWritten: bytes, ids: selected.map((r) => r.id) };
}

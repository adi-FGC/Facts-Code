/**
 * @factstack/emit-browser — browser-side artifact emitter.
 *
 * Composition strategy:
 *   - Pure-isomorphic helpers (humanToViz, encodeAgentPack) are
 *     re-exported from @factstack/emit verbatim. No reason to
 *     duplicate code that already runs in any environment.
 *   - Browser-only surfaces (writeBrowserArtifacts, browserGzip)
 *     live here because they touch FSA + CompressionStream APIs
 *     that have no analog in Node-land.
 *
 * Constraint C1 still holds: this package imports DOM types but
 * NEVER node:* anything. Safe to bundle into browser + Worker.
 */

export { writeBrowserArtifacts, readBrowserSnapshots, writeBrowserSkills, ALL_FORMATS } from './write.js';
export type {
  BrowserWriteOptions,
  BrowserWriteResult,
  EmitProfile,
  BrowserSkillsOptions,
  BrowserSkillsResult,
  SkillFormatId,
} from './write.js';

export { browserGzippedBytes, shouldGzip } from './gzip.js';

/* Re-export the pure surfaces so callers have a single import line:
 *   import { humanToViz, encodeAgentPack, writeBrowserArtifacts } from '@factstack/emit-browser';
 * No need to remember which functions live in which package — emit-browser
 * is the umbrella for all browser-side emit work.
 *
 * Imported through the `/pure` subpath so we don't transitively pull in
 * gzip.ts + write.ts (Node-only). See @factstack/emit/src/pure.ts. */
export { humanToViz, encodeAgentPack } from '@factstack/emit/pure';
export type { VizArtifact, VizFile, VizTreeNode, VizLanguage } from '@factstack/emit/pure';

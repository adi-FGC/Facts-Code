/**
 * Isomorphic re-export surface — the slice of @factstack/emit that
 * does NOT touch node:* imports.
 *
 * Why this file exists:
 *   `index.ts` re-exports gzip.ts (node:zlib) and write.ts (node:fs,
 *   node:path) so the CLI can do one import. But @factstack/emit-browser
 *   needs to type-check WITHOUT @types/node — its tsconfig deliberately
 *   omits the node lib so a stray `Buffer` reference fails loudly.
 *   Importing through this `./pure` subpath gives browser code access
 *   to pack + viz + their types without dragging in the Node modules.
 *
 * Subpath consumers:
 *   import { encodeAgentPack, humanToViz } from '@factstack/emit/pure';
 *
 * Anyone in the Node tier should keep using the default `@factstack/emit`
 * import — there's no benefit to splitting hairs there.
 */

export { encodeAgentPack } from './pack.js';
export { humanToViz } from './viz.js';
export type { VizArtifact, VizFile, VizTreeNode, VizLanguage } from './viz.js';
export { writeArtifactsTo } from './orchestrator.js';
export type {
  EmitProfile,
  WriteArtifactsToOptions,
  WriteArtifactsResult,
} from './orchestrator.js';

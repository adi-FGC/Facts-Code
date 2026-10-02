export { gzippedBytes, shouldGzip } from './gzip.js';
export { writeArtifacts, readSnapshots } from './write.js';
export type { WriteOptions } from './write.js';
/* performance#1 — the per-edit --minimal hook leaves agent.json/agent.jsonl
 * as they are and marks them `<file>.stale`; every reader of those files
 * checks `readStaleMark(factsDir)` before serving them as current. */
export {
  RAW_JSON_ARTIFACTS,
  StaleResaveError,
  packGeneratedAt,
  parseStaleMark,
  staleHint,
  staleMarkName,
} from './stale-mark.js';
export type { RawJsonArtifact, StaleMark } from './stale-mark.js';
export { readStaleMark } from './stale-mark-node.js';
export type { EmitProfile } from './orchestrator.js';
export { humanToViz } from './viz.js';
export type { VizArtifact, VizFile, VizTreeNode, VizLanguage } from './viz.js';
export { encodeAgentPack } from './pack.js';
export { exportGraph, toGraphML, toJsonGraph, graphExportFilename } from './graph-export.js';
export type { GraphExportFormat } from './graph-export.js';
/* NodeFileWriter is exported for callers that need a Node-backed
 * FileWriter scoped to something other than `.facts/` (e.g.
 * `factstack export-skills` writes at the project root). */
export { NodeFileWriter } from './node-writer.js';
/* F8 — node:sqlite-backed content-hash extraction cache. Node-only (imports
 * node:sqlite); the browser build never imports it. */
export { SqliteExtractionCache, openExtractionCache } from './extraction-cache-sqlite.js';

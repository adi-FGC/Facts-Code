/**
 * `buildSkillsTo` — pure orchestrator for writing skill bundles
 * through a `FileWriter`.
 *
 * Mirrors `writeArtifactsTo` from `@factstack/emit/pure`:
 *   - First positional arg is the `FileWriter` (Node / FSA / Memory).
 *   - Subsequent args are the inputs (agent + human artifacts).
 *   - Trailing `formats?` selects a subset of registered formats;
 *     defaults to all.
 *
 * The orchestrator owns no I/O — every `writer.writeText(...)` call
 * is the FileWriter's responsibility. That's what makes
 * `MemoryFileWriter` viable as a test surface (no temp directories,
 * microseconds per test, same shape as the production path).
 *
 * The registry pattern means adding a 4th format is one entry plus
 * one renderer file — no orchestrator change, no consumer change.
 */

import type { AgentArtifact, FileWriter, HumanArtifact } from '@factstack/spec';
import { agentToSkillSpec } from './extract.js';
import { claudeRenderer } from './renderers/claude.js';
import { cursorRenderer } from './renderers/cursor.js';
import { copilotRenderer } from './renderers/copilot.js';
import { agentsRenderer } from './renderers/agents.js';
import type { SkillFormatId, SkillRenderer, SkillSpec } from './types.js';

/* Single source of truth: every registered renderer keyed by SkillFormatId.
 * Adding a new format: import + add one entry here. Iteration order
 * matches the type union; tests assume `Object.keys` is stable. */
export const SKILL_REGISTRY: Record<SkillFormatId, SkillRenderer> = {
  claude: claudeRenderer,
  cursor: cursorRenderer,
  copilot: copilotRenderer,
  agents: agentsRenderer,
};

/** Convenience accessor for the full set of registered format IDs.
 *  Useful for `--target=all` resolution + sanity checking caller input. */
export const ALL_FORMATS: readonly SkillFormatId[] = Object.keys(
  SKILL_REGISTRY,
) as SkillFormatId[];

export interface BuildSkillsResult {
  /** Map of every file written by every renderer in this run. */
  files: Record<string, string>;
  /** Total bytes across every emitted file (UTF-8). */
  bytesWritten: number;
  /** Format IDs actually rendered (filtered against the registry). */
  formats: SkillFormatId[];
}

/**
 * Write the requested skill formats to `writer`. Returns the map of
 * paths→bodies actually written + a byte total.
 *
 * Unknown format IDs are silently dropped — the caller's CLI layer
 * is responsible for telling the user they typo'd `--target=cusror`.
 * (Throwing here would force every test to handle the validation
 * branch; quieter behavior keeps the orchestrator pure.)
 */
export async function buildSkillsTo(
  writer: FileWriter,
  agent: AgentArtifact,
  human: HumanArtifact,
  formats?: SkillFormatId[],
): Promise<BuildSkillsResult> {
  const targetIds = (formats ?? ALL_FORMATS).filter(
    (id): id is SkillFormatId => id in SKILL_REGISTRY,
  );
  const spec: SkillSpec = agentToSkillSpec(agent, human);

  const allFiles: Record<string, string> = {};
  let bytes = 0;
  for (const id of targetIds) {
    const renderer = SKILL_REGISTRY[id];
    const files = renderer.render(spec);
    for (const [path, body] of Object.entries(files)) {
      allFiles[path] = body;
      bytes += await writer.writeText(path, body);
    }
  }

  return { files: allFiles, bytesWritten: bytes, formats: targetIds };
}

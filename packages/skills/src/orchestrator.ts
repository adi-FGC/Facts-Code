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
import { isFactsManaged, type SkillFormatId, type SkillRenderer, type SkillSpec } from './types.js';

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
export const ALL_FORMATS: readonly SkillFormatId[] = Object.keys(SKILL_REGISTRY) as SkillFormatId[];

/**
 * Formats whose file path is shared with hand-written team rules. An
 * existing `.cursorrules` / `.github/copilot-instructions.md` is rewritten
 * ONLY when it carries the FACTS-managed marker — never a hand-written one,
 * whatever the caller asked for (owner decision 2026-09-24). The Claude
 * skill lives in its own `factstack-*` folder and always refreshes.
 */
export const MANAGED_ONLY_FORMATS: readonly SkillFormatId[] = ['cursor', 'copilot'];

export interface BuildSkillsResult {
  /** Map of every file written by every renderer in this run. */
  files: Record<string, string>;
  /** Total bytes across every emitted file (UTF-8). */
  bytesWritten: number;
  /** Format IDs actually rendered (filtered against the registry). */
  formats: SkillFormatId[];
  /** Paths skipped because they already existed and were not FACTS's to
   *  overwrite: a format in `preserveExisting` (a hand-authored
   *  `AGENTS.md`), or a MANAGED_ONLY_FORMATS file without the marker. */
  preserved: string[];
}

export interface BuildSkillsOptions {
  /**
   * Formats whose output file is left untouched if it already exists on
   * the writer. The intended use is `['agents']`: `AGENTS.md` is a
   * cross-tool standard a team often hand-authors, so FACTS must not
   * silently clobber it. `.cursorrules` and Copilot are guarded by the
   * managed marker regardless (MANAGED_ONLY_FORMATS); Claude `SKILL.md` is
   * FACTS-managed config and always refreshes.
   */
  preserveExisting?: SkillFormatId[];
  /**
   * Read an existing file's text (null when absent/unreadable), so a
   * FACTS-managed `.cursorrules` / Copilot file can be refreshed. Falls back
   * to the writer's optional `FileWriter.readText` when it has one. With
   * neither, an existing file of those formats is always preserved — the
   * safe side.
   */
  readExisting?: (path: string) => Promise<string | null>;
}

/**
 * The on-writer path of an existing file at `path`, or null when there is
 * none. Uses only `FileWriter.listKeys` — the read capability the interface
 * exposes — so no `readText` is needed.
 *
 * Names match case-insensitively: on Windows and macOS `agents.md`
 * and `AGENTS.md` are ONE file, so an exact-case check let a write replace a
 * hand-written `agents.md` (or skip the marker check for a mixed-case
 * `.github/Copilot-Instructions.md`). An exact match wins; on a
 * case-sensitive disk a case variant still counts — the safe side.
 */
async function existingPath(writer: FileWriter, path: string): Promise<string | null> {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const keys = await writer.listKeys(dir);
  const lower = name.toLowerCase();
  const hit = keys.includes(name) ? name : keys.find((k) => k.toLowerCase() === lower);
  if (hit === undefined) return null;
  return slash >= 0 ? `${dir}/${hit}` : hit;
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
  opts?: BuildSkillsOptions,
): Promise<BuildSkillsResult> {
  const targetIds = (formats ?? ALL_FORMATS).filter(
    (id): id is SkillFormatId => id in SKILL_REGISTRY,
  );
  const preserve = new Set<SkillFormatId>(opts?.preserveExisting ?? []);
  const managedOnly = new Set<SkillFormatId>(MANAGED_ONLY_FORMATS);
  const readExisting =
    opts?.readExisting ??
    (typeof writer.readText === 'function' ? writer.readText.bind(writer) : null);
  const spec: SkillSpec = agentToSkillSpec(agent, human);

  const allFiles: Record<string, string> = {};
  const preserved: string[] = [];
  let bytes = 0;
  for (const id of targetIds) {
    const renderer = SKILL_REGISTRY[id];
    const files = renderer.render(spec);
    for (const [path, body] of Object.entries(files)) {
      /* Don't clobber a file the user may have hand-authored (e.g.
         AGENTS.md). Formats opted into `preserveExisting` are kept
         whenever they exist; a shared-path rules file is kept unless it
         provably carries the FACTS-managed marker. */
      const onDisk =
        preserve.has(id) || managedOnly.has(id) ? await existingPath(writer, path) : null;
      if (onDisk !== null) {
        let current: string | null = null;
        if (!preserve.has(id) && readExisting) {
          try {
            // The file as it is named on disk: the marker check reads it.
            current = await readExisting(onDisk);
          } catch {
            /* unreadable — treat as not ours */
          }
        }
        if (current === null || !isFactsManaged(current)) {
          preserved.push(path);
          continue;
        }
      }
      allFiles[path] = body;
      bytes += await writer.writeText(path, body);
    }
  }

  return { files: allFiles, bytesWritten: bytes, formats: targetIds, preserved };
}

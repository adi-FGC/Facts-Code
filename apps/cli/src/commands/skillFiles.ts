/**
 * The one write path for the agent skill files. `export-skills`,
 * `setup-agents`, `install` and the dashboard's POST /api/setup-agents all
 * render through writeSkillFiles, so the preserve rules cannot drift
 * between them (cli-dry-1).
 */
import { NodeFileWriter } from '@factstack/emit';
import { buildSkillsTo, type BuildSkillsResult, type SkillFormatId } from '@factstack/skills';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { readExistingUnder } from '../artifacts.js';

export interface WriteSkillFilesOptions {
  /** The formats to render; every format when omitted. */
  formats?: readonly SkillFormatId[] | undefined;
  /** Overwrite an existing AGENTS.md. Only an explicit `--format` request
   *  sets this; every default path keeps the one that is there. */
  replaceAgentsMd?: boolean;
}

/**
 * Render the skill files at the PROJECT ROOT, not under .facts/:
 * `.cursorrules` lives next to package.json, `.claude/skills/...` is what
 * Claude Code scans, `.github/copilot-instructions.md` is GitHub's
 * convention. The preserve rules (owner decision 2026-09-24):
 *   - an existing AGENTS.md (the cross-tool standard, usually hand-written)
 *     is kept unless `replaceAgentsMd`;
 *   - a .cursorrules / copilot-instructions.md is rewritten only when it
 *     carries the FACTS-managed marker (@factstack/skills MANAGED_ONLY_FORMATS);
 *   - Claude's SKILL.md is FACTS-managed config and always refreshes.
 */
export function writeSkillFiles(
  root: string,
  agent: AgentArtifact,
  human: HumanArtifact,
  opts: WriteSkillFilesOptions = {},
): Promise<BuildSkillsResult> {
  return buildSkillsTo(
    new NodeFileWriter(root, ''),
    agent,
    human,
    opts.formats ? [...opts.formats] : undefined,
    {
      preserveExisting: opts.replaceAgentsMd ? [] : ['agents'],
      readExisting: readExistingUnder(root),
    },
  );
}

/**
 * Why a preserved path was left alone, for the TTY summaries. AGENTS.md is
 * kept because it exists (marker or not), so its line says so and adds
 * `replaceHint`: how the calling command's user can replace it. Any other
 * preserved file was kept because it lacks the FACTS marker.
 */
export function keptReason(filePath: string, replaceHint: string): string {
  return filePath === 'AGENTS.md'
    ? `kept (existing AGENTS.md, not overwritten; ${replaceHint})`
    : 'kept (existing file without the FACTS marker, not overwritten)';
}

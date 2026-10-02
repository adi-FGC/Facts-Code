/**
 * The agent skill files:
 *   `factstack export-skills [target]`  SKILL.md / .cursorrules / copilot /
 *                                       AGENTS.md at the project root
 *   `factstack setup-agents [target]`   the same + the PostToolUse freshness hook
 * Neither auto-analyzes: both write user-visible files, so "analyze
 * happened" stays an explicit decision. Both share one write path
 * (writeSkills, over skillFiles.ts writeSkillFiles, which `install` and the
 * dashboard use too) and one summary (skillsJson / skillsSummaryLines), so
 * the two cannot drift (cli-dry-1).
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import kleur from 'kleur';
import { ALL_FORMATS, type BuildSkillsResult, type SkillFormatId } from '@factstack/skills';
import type { AgentArtifact, HumanArtifact } from '@factstack/spec';
import { installFreshnessHook, type InstallHookResult } from '../agentHook.js';
import { loadAndValidate } from '../artifacts.js';
import { formatBytes } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { freshnessHookNote, hookResultLines } from './install.js';
import { keptReason, writeSkillFiles } from './skillFiles.js';

type SkillsCommandName = 'export-skills' | 'setup-agents';

/**
 * Load + validate the artifacts, check `--format`, and write the skill files
 * at the project root. Exits 1 (prefixed with the command name) before
 * writing anything when the artifacts are missing or invalid, or a requested
 * format is unknown.
 */
async function writeSkills(
  root: string,
  format: string | undefined,
  io: CliIO,
  cmd: SkillsCommandName,
): Promise<BuildSkillsResult> {
  const prefix = kleur.red(`factstack ${cmd}: `);
  const agentPath = path.join(root, '.facts', 'agent.json');
  const humanPath = path.join(root, '.facts', 'human.json');

  /* Pre-flight: artifact must exist. Unlike `ui` we do NOT auto-analyze
     here — these commands write user-visible files at the project root, and
     the user's "analyze happened" decision stays explicit. */
  if (!existsSync(agentPath) || !existsSync(humanPath)) {
    io.stderr.write(prefix + 'no .facts/agent.json or human.json found.\n');
    io.stderr.write(kleur.dim(`  run \`factstack analyze .\` first; then re-run ${cmd}.\n`));
    io.exit(1);
  }

  let agent: AgentArtifact;
  let human: HumanArtifact;
  try {
    agent = loadAndValidate<AgentArtifact>(agentPath, 'agent');
    human = loadAndValidate<HumanArtifact>(humanPath, 'human');
  } catch (err) {
    io.stderr.write(prefix + (err instanceof Error ? err.message : String(err)) + '\n');
    io.exit(1);
  }

  /* Parse --format. Filter against ALL_FORMATS so a typo doesn't silently
     emit nothing (the orchestrator silently drops unknowns by design; we
     surface the typo here at the CLI layer where the user can see it). */
  let formats: SkillFormatId[] | undefined;
  if (format) {
    const requested = format
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const known = new Set<string>(ALL_FORMATS);
    const unknown = requested.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      io.stderr.write(
        prefix + `unknown format${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}\n`,
      );
      io.stderr.write(kleur.dim(`  available: ${ALL_FORMATS.join(', ')}\n`));
      io.exit(1);
    }
    formats = requested as SkillFormatId[];
  }

  /* Keep an existing AGENTS.md on the default path; an explicit
     `--format agents` request is intent to (over)write it. */
  return writeSkillFiles(root, agent, human, { formats, replaceAgentsMd: formats !== undefined });
}

/** The `--json` fields both commands print. */
function skillsJson(result: BuildSkillsResult) {
  return {
    ok: true,
    formats: result.formats,
    files: Object.keys(result.files),
    bytesWritten: result.bytesWritten,
    preserved: result.preserved,
  };
}

/** The TTY summary: header, ✓ written / • kept lines, `extra` (the hook
 *  lines for setup-agents), then the counts footer. */
function skillsSummaryLines(
  cmd: SkillsCommandName,
  result: BuildSkillsResult,
  extra: readonly string[] = [],
): string[] {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const written = Object.keys(result.files);
  return [
    '',
    kleur.bold().green('FACTS') + kleur.dim(` · ${cmd}`),
    kleur.dim('  ─────────────────'),
    ...written.sort().map((p) => `  ${kleur.green('✓')} ${p}`),
    ...result.preserved
      .slice()
      .sort()
      .map(
        (p) =>
          `  ${kleur.yellow('•')} ${p} ${kleur.dim(`— ${keptReason(p, '--format agents replaces it')}`)}`,
      ),
    ...extra,
    '',
    kleur.dim(
      `  ${count(result.formats.length, 'format')} · ${count(written.length, 'file')} · ` +
        `${formatBytes(result.bytesWritten)} written`,
    ),
    '',
  ];
}

export interface ExportSkillsOptions {
  format?: string;
  json?: boolean;
}

export async function exportSkillsCommand(
  target: string | undefined,
  opts: ExportSkillsOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const result = await writeSkills(root, opts.format, io, 'export-skills');

  if (opts.json) {
    io.stdout.write(JSON.stringify(skillsJson(result), null, 2) + '\n');
    return;
  }
  io.stderr.write(skillsSummaryLines('export-skills', result).join('\n') + '\n');
}

export interface SetupAgentsOptions {
  format?: string;
  hookCommand?: string;
  hook: boolean;
  json?: boolean;
}

export async function setupAgentsCommand(
  target: string | undefined,
  opts: SetupAgentsOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = path.resolve(target ?? '.');
  const result = await writeSkills(root, opts.format, io, 'setup-agents');

  // Freshness hook (unless --no-hook). The command is configurable so a
  // self-hosting repo (where the published launch isn't the right
  // invocation, e.g. this monorepo) can point it at the local CLI instead.
  // Neither flag nor env → undefined: the default, which keeps a user's own
  // FACTS hook command instead of rewriting it to FRESHNESS_HOOK_COMMAND.
  let hook: InstallHookResult | null = null;
  let hookError: string | undefined;
  if (opts.hook) {
    try {
      hook = installFreshnessHook(
        root,
        opts.hookCommand || process.env.FACTSTACK_HOOK_COMMAND || undefined,
      );
    } catch (err) {
      hookError = err instanceof Error ? err.message : String(err);
      io.stderr.write(
        kleur.yellow('factstack setup-agents: ') +
          'skill files written, but the freshness hook failed: ' +
          hookError +
          '\n',
      );
    }
  }

  if (opts.json) {
    const note = hook ? freshnessHookNote(hook) : undefined;
    io.stdout.write(
      JSON.stringify(
        {
          ...skillsJson(result),
          hook: hook
            ? {
                added: hook.added,
                command: hook.command,
                ...(note !== undefined ? { note } : {}),
                settingsPath: hook.settingsPath,
                replaced: hook.replaced,
                removed: hook.removed,
                kept: hook.kept,
                gitignore: hook.gitignore,
              }
            : null,
          ...(hookError !== undefined ? { hookError } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const hookLines = hook
    ? hookResultLines(hook, root, '  ')
    : hookError !== undefined
      ? [kleur.yellow(`  ! freshness hook not installed: ${hookError}`)]
      : [kleur.dim('  · freshness hook skipped (--no-hook)')];
  io.stderr.write(skillsSummaryLines('setup-agents', result, hookLines).join('\n') + '\n');
}

/**
 * F12 — `factstack install [target]` wires FACTS into a coding agent
 * (instruction files + MCP registration + the freshness hook);
 * `factstack uninstall [target]` reverses the MCP registration and the hook.
 */
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import kleur from 'kleur';
import {
  DEFAULT_MCP_COMMAND,
  INSTALL_AGENTS,
  INSTALL_TARGETS,
  mergeMcpConfig,
  parseServerCommand,
  removeMcpConfig,
  withProjectRoot,
  type InstallAgent,
  type McpServerCommand,
} from '@factstack/skills';
import { MCP_NPM_PACKAGE, type AgentArtifact, type HumanArtifact } from '@factstack/spec';
import {
  chainsOtherLogic,
  FRESHNESS_HOOK_COMMAND,
  hookLaunchNote,
  installFreshnessHook,
  uninstallFreshnessHook,
  type InstallHookResult,
} from '../agentHook.js';
import { loadAndValidate } from '../artifacts.js';
import { relativize } from '../format.js';
import { processIO, type CliIO } from '../io.js';
import { formatServerCommand, mcpPortabilityNote, mcpServerNote } from '../mcpInstall.js';
import { keptReason, writeSkillFiles } from './skillFiles.js';

/** How an `install` user replaces a kept AGENTS.md: install has no
 *  --format, and never overwrites one. */
const INSTALL_AGENTS_MD_HINT = '`factstack export-skills --format agents` replaces it';

/**
 * The project root install pins into the MCP configs: absolute and
 * canonical (cli-r3-1). realpathSync.native expands a Windows 8.3 short name
 * (C:\PROGRA~1\…) and resolves junctions and symlinks, so installing
 * the same project through another spelling of its path finds the configs
 * already installed instead of rewriting them. A path that does not exist
 * stays as path.resolve gives it (install then reports the missing .facts).
 */
export function installRoot(target: string | undefined): string {
  const abs = path.resolve(target ?? '.');
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** How a user points the freshness hook somewhere else. */
export const FRESHNESS_HOOK_OVERRIDE =
  '`setup-agents --hook-command <cmd>` or FACTSTACK_HOOK_COMMAND';

/** The not-on-npm warning for the command a freshness hook runs,
 *  or undefined. In the TTY lines and the --json summaries. */
export function freshnessHookNote(r: InstallHookResult): string | undefined {
  return hookLaunchNote(r.command, FRESHNESS_HOOK_OVERRIDE);
}

/** Lines describing a freshness-hook install for the TTY summaries. */
export function hookResultLines(r: InstallHookResult, root: string, indent: string): string[] {
  const note = freshnessHookNote(r);
  const lines = [
    `${indent}${kleur.green('✓')} ${relativize(r.settingsPath, root)} ${kleur.dim(
      r.replaced.length > 0 || r.removed.length > 0
        ? '(freshness hook updated)'
        : r.added
          ? '(freshness hook added)'
          : !r.explicit && r.kept.length > 0
            ? '(your own freshness hook, kept as is)'
            : '(freshness hook already present)',
    )}`,
    kleur.dim(`${indent}    runs: ${r.command}`),
    // Beside the command, in yellow — as mcpStatusLine flags the server.
    ...(note !== undefined ? [kleur.yellow(`${indent}  ! ${note}`)] : []),
  ];
  for (const old of r.replaced) lines.push(kleur.dim(`${indent}    replaced: ${old}`));
  for (const dup of r.removed) lines.push(kleur.dim(`${indent}    removed duplicate: ${dup}`));
  for (const k of r.kept) {
    if (!chainsOtherLogic(k)) {
      if (k !== r.command) lines.push(kleur.dim(`${indent}    also kept: ${k}`));
      continue;
    }
    lines.push(
      r.explicit
        ? kleur.yellow(
            `${indent}  ! kept: ${k} — it chains other logic, so it was not rewritten; it also runs analyze, so remove the analyze from it by hand for one analyze per edit`,
          )
        : kleur.dim(`${indent}    kept as is: ${k} (chains other logic — never rewritten)`),
    );
  }
  // A chained command is never rewritten, so only a plain one can be replaced.
  if (
    !r.explicit &&
    r.kept.length > 0 &&
    r.command !== FRESHNESS_HOOK_COMMAND &&
    !chainsOtherLogic(r.command)
  ) {
    lines.push(kleur.dim(`${indent}    (to replace it: ${FRESHNESS_HOOK_OVERRIDE})`));
  }
  if (r.gitignore === 'added') {
    lines.push(
      `${indent}${kleur.green('✓')} .gitignore ${kleur.dim('(+ .claude/settings.local.json — personal settings stay out of commits)')}`,
    );
  }
  return lines;
}

/**
 * One agent's MCP-registration line for the TTY summary. While the default
 * `npx -y factstack-mcp` launch cannot resolve (`serverNote` set: the package
 * is not on npm yet, owner decision — keep npx), a registration is NOT a
 * green check: the agent's MCP server will fail to start with an opaque npm
 * error. The line is yellow and says so beside the server (ux#3); the full
 * note follows the `server command:` line, also in yellow.
 */
export function mcpStatusLine(
  s: {
    mcpConfig: string;
    mcpStatus: 'written' | 'already-installed' | 'failed';
    mcpError?: string;
  },
  serverNote: string | undefined,
): string {
  if (s.mcpStatus === 'failed') return kleur.red(`✗ ${s.mcpConfig} — ${s.mcpError}`);
  const what = s.mcpStatus === 'written' ? 'factstack server registered' : 'already registered';
  if (serverNote !== undefined) {
    return kleur.yellow(
      `! ${s.mcpConfig} (${what} — it will not start until ${MCP_NPM_PACKAGE} is on npm; see the note below)`,
    );
  }
  return s.mcpStatus === 'written'
    ? kleur.green(`✓ ${s.mcpConfig} (${what})`)
    : kleur.dim(`✓ ${s.mcpConfig} (${what})`);
}

export interface InstallOptions {
  agent: string;
  serverCommand?: string;
  json?: boolean;
}

export async function installCommand(
  target: string | undefined,
  opts: InstallOptions,
  io: CliIO = processIO,
): Promise<void> {
  const root = installRoot(target);

  const agents: InstallAgent[] =
    opts.agent === 'all'
      ? [...INSTALL_AGENTS]
      : (INSTALL_AGENTS as readonly string[]).includes(opts.agent)
        ? [opts.agent as InstallAgent]
        : [];
  if (!agents.length) {
    io.stderr.write(
      kleur.red('factstack install: ') +
        `unknown agent "${opts.agent}". Supported: ${INSTALL_AGENTS.join(', ')}, all\n`,
    );
    io.exit(1);
  }

  /* Pre-flight: artifacts must exist — install renders the skills FROM the
   analysis, and (like export-skills) writing user-visible files should
   follow an explicit "analyze happened" decision. */
  const agentPath = path.join(root, '.facts', 'agent.json');
  const humanPath = path.join(root, '.facts', 'human.json');
  if (!existsSync(agentPath) || !existsSync(humanPath)) {
    io.stderr.write(kleur.red('factstack install: ') + 'no .facts artifacts found.\n');
    io.stderr.write(kleur.dim('  run `factstack analyze .` first; then re-run install.\n'));
    io.exit(1);
  }
  let agentArtifact: AgentArtifact;
  let human: HumanArtifact;
  try {
    agentArtifact = loadAndValidate<AgentArtifact>(agentPath, 'agent');
    human = loadAndValidate<HumanArtifact>(humanPath, 'human');
  } catch (err) {
    io.stderr.write(
      kleur.red('factstack install: ') + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    io.exit(1);
  }

  let server: McpServerCommand = DEFAULT_MCP_COMMAND;
  if (opts.serverCommand) {
    // Quote-aware parsing — a naive whitespace split would shred paths with
    // spaces ("C:\Program Files\...") into a broken command array.
    const parsed = parseServerCommand(opts.serverCommand);
    if (!parsed) {
      io.stderr.write(
        kleur.red('factstack install: ') +
          'bad --server-command (empty or unterminated quote). Quote paths with spaces: --server-command \'node "C:\\Program Files\\factstack\\server.js"\'\n',
      );
      io.exit(1);
    }
    server = parsed;
  }

  interface AgentSummary {
    agent: InstallAgent;
    skills: string[];
    /** Existing files left untouched: an AGENTS.md, or a rules file
     *  without the FACTS marker. */
    preserved: string[];
    mcpConfig: string;
    mcpStatus: 'written' | 'already-installed' | 'failed';
    mcpError?: string;
    hook: 'installed' | 'failed' | 'not-supported';
    hookError?: string;
    hookResult?: InstallHookResult;
  }
  const summaries: AgentSummary[] = [];
  let anyFailure = false;

  for (const a of agents) {
    const t = INSTALL_TARGETS[a];
    /* 1. Instruction files through the shared write path: an existing
     AGENTS.md is kept (export-skills' default rule; the agent's formats
     here are not a user's --format request); a .cursorrules /
     copilot-instructions.md is refreshed only when it carries the
     FACTS-managed marker (owner decision 2026-09-24). */
    const skills = await writeSkillFiles(root, agentArtifact, human, { formats: t.skillFormats });

    /* 2. MCP server registration — pure merge, never clobbers. `root`
     (absolute) pins the server with --root: it no longer analyzes
     whatever cwd the client launches it from (ux#8). A relative --root
     inside --server-command comes back as a failed merge with a reason. */
    const cfgPath = path.join(root, t.mcpConfigPath);
    const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
    const merged = mergeMcpConfig(a, existing, server, root);
    let mcpStatus: AgentSummary['mcpStatus'];
    let mcpError: string | undefined;
    if (!merged.ok) {
      mcpStatus = 'failed';
      mcpError = merged.reason;
      anyFailure = true;
    } else if (merged.changed) {
      mkdirSync(path.dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, merged.content, 'utf8');
      mcpStatus = 'written';
    } else {
      mcpStatus = 'already-installed';
    }

    /* 3. Freshness hook where the host supports hooks (Claude Code). The
     instruction files carry the query-first guidance everywhere else. */
    let hook: AgentSummary['hook'] = 'not-supported';
    let hookError: string | undefined;
    let hookResult: InstallHookResult | undefined;
    if (t.supportsHooks) {
      try {
        hookResult = installFreshnessHook(root, process.env.FACTSTACK_HOOK_COMMAND || undefined);
        hook = 'installed';
      } catch (e) {
        hook = 'failed';
        hookError = e instanceof Error ? e.message : String(e);
      }
    }

    summaries.push({
      agent: a,
      skills: Object.keys(skills.files),
      preserved: skills.preserved,
      mcpConfig: t.mcpConfigPath,
      mcpStatus,
      ...(mcpError !== undefined ? { mcpError } : {}),
      hook,
      ...(hookError !== undefined ? { hookError } : {}),
      ...(hookResult !== undefined ? { hookResult } : {}),
    });
  }

  /* Honest flag (owner decision: keep npx, the owner publishes the name):
     the default launch command resolves only once factstack-mcp is on npm
     — MCP_PUBLISHED, which only the owner flips. */
  const serverNote = mcpServerNote(server);
  /* What the configs actually launch: the command pinned to this project.
     null only for a relative --root in --server-command (every merge then
     failed with the reason) — the command as given is reported instead. */
  const registered = withProjectRoot(server, root) ?? server;
  /* cli-r3-1: an absolute --root is this machine's path; say so for the
     configs that now carry it (they are often committed). */
  const portabilityNote = mcpPortabilityNote(
    registered,
    summaries.filter((s) => s.mcpStatus !== 'failed').map((s) => s.mcpConfig),
  );

  if (opts.json) {
    io.stdout.write(
      JSON.stringify(
        {
          ok: !anyFailure,
          server: registered,
          ...(serverNote !== undefined ? { serverNote } : {}),
          ...(portabilityNote !== undefined ? { portabilityNote } : {}),
          agents: summaries.map(({ hookResult, ...s }) => {
            const hookNote = hookResult ? freshnessHookNote(hookResult) : undefined;
            return hookResult
              ? {
                  ...s,
                  hookCommand: hookResult.command,
                  ...(hookNote !== undefined ? { hookNote } : {}),
                  hookReplaced: hookResult.replaced,
                  hookRemoved: hookResult.removed,
                  hookKept: hookResult.kept,
                  gitignore: hookResult.gitignore,
                }
              : s;
          }),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    io.stderr.write(kleur.bold().green('FACTS') + kleur.dim(' · install\n'));
    for (const s of summaries) {
      const mcp = mcpStatusLine(s, serverNote);
      io.stderr.write(`  ${kleur.bold(s.agent)}\n`);
      for (const f of s.skills) io.stderr.write(`    ${kleur.green('✓')} ${f}\n`);
      for (const p of s.preserved)
        io.stderr.write(
          `    ${kleur.yellow('•')} ${p} ${kleur.dim(`— ${keptReason(p, INSTALL_AGENTS_MD_HINT)}`)}\n`,
        );
      io.stderr.write(`    ${mcp}\n`);
      if (s.hook === 'installed' && s.hookResult)
        io.stderr.write(hookResultLines(s.hookResult, root, '    ').join('\n') + '\n');
      if (s.hook === 'failed')
        io.stderr.write(`    ${kleur.yellow('!')} freshness hook failed: ${s.hookError}\n`);
    }
    io.stderr.write(kleur.dim(`  server command: ${formatServerCommand(registered)}\n`));
    // ux#3: beside the server line, in yellow — never a dim footnote.
    if (serverNote !== undefined) io.stderr.write(kleur.yellow(`  ! ${serverNote}\n`));
    if (portabilityNote !== undefined) io.stderr.write(kleur.dim(`  note: ${portabilityNote}\n`));
    io.stderr.write(
      kleur.dim(
        '  re-run after `factstack analyze` to refresh the instruction files; `factstack uninstall` reverses the MCP registration and the freshness hook.\n',
      ),
    );
  }
  if (anyFailure) io.exit(1);
}

export interface UninstallOptions {
  agent: string;
  json?: boolean;
}

export function uninstallCommand(
  target: string | undefined,
  opts: UninstallOptions,
  io: CliIO = processIO,
): void {
  const root = path.resolve(target ?? '.');
  const agents: InstallAgent[] =
    opts.agent === 'all'
      ? [...INSTALL_AGENTS]
      : (INSTALL_AGENTS as readonly string[]).includes(opts.agent)
        ? [opts.agent as InstallAgent]
        : [];
  if (!agents.length) {
    io.stderr.write(
      kleur.red('factstack uninstall: ') +
        `unknown agent "${opts.agent}". Supported: ${INSTALL_AGENTS.join(', ')}, all\n`,
    );
    io.exit(1);
  }
  const results: Array<{
    agent: InstallAgent;
    mcpConfig: string;
    status: 'removed' | 'not-registered' | 'absent' | 'failed';
    error?: string;
  }> = [];
  for (const a of agents) {
    const t = INSTALL_TARGETS[a];
    const cfgPath = path.join(root, t.mcpConfigPath);
    if (!existsSync(cfgPath)) {
      results.push({ agent: a, mcpConfig: t.mcpConfigPath, status: 'absent' });
      continue;
    }
    const removed = removeMcpConfig(a, readFileSync(cfgPath, 'utf8'));
    if (!removed.ok) {
      results.push({
        agent: a,
        mcpConfig: t.mcpConfigPath,
        status: 'failed',
        error: removed.reason,
      });
      continue;
    }
    if (removed.changed) writeFileSync(cfgPath, removed.content, 'utf8');
    results.push({
      agent: a,
      mcpConfig: t.mcpConfigPath,
      status: removed.changed ? 'removed' : 'not-registered',
    });
  }
  /* The freshness hook `install --agent claude` added (security#1). A
     malformed settings file is reported, never rewritten; a FACTS command
     chained with other logic is left for the user to edit (reported). */
  let hook: { removed: string[]; kept: string[]; error?: string } | null = null;
  if (agents.some((a) => INSTALL_TARGETS[a].supportsHooks)) {
    try {
      const r = uninstallFreshnessHook(root);
      hook = { removed: r.removed, kept: r.kept };
    } catch (e) {
      hook = { removed: [], kept: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
  const ok = results.every((r) => r.status !== 'failed') && !hook?.error;
  // A teardown script must see a failed removal, in both outputs.
  if (!ok) io.setExitCode(1);
  if (opts.json) {
    io.stdout.write(JSON.stringify({ ok, results, hook }, null, 2) + '\n');
    return;
  }
  io.stderr.write(kleur.bold().green('FACTS') + kleur.dim(' · uninstall\n'));
  for (const r of results) {
    const line =
      r.status === 'removed'
        ? kleur.green(`✓ ${r.mcpConfig} — factstack server removed`)
        : r.status === 'failed'
          ? kleur.red(`✗ ${r.mcpConfig} — ${r.error}`)
          : kleur.dim(
              `· ${r.mcpConfig} — ${r.status === 'absent' ? 'no config file' : 'factstack was not registered'}`,
            );
    io.stderr.write(`  ${kleur.bold(r.agent)}  ${line}\n`);
  }
  if (hook) {
    io.stderr.write(
      '  ' +
        (hook.error
          ? kleur.red(`✗ .claude/settings.local.json — ${hook.error}`)
          : hook.removed.length > 0
            ? kleur.green(`✓ .claude/settings.local.json — freshness hook removed`)
            : kleur.dim('· .claude/settings.local.json — no freshness hook')) +
        '\n',
    );
    for (const k of hook.kept) {
      io.stderr.write(
        kleur.yellow(
          `  ! kept: ${k} — it chains other logic, so it was not removed; edit the analyze out of it by hand\n`,
        ),
      );
    }
  }
  io.stderr.write(
    kleur.dim(
      '  instruction files are left in place — they are plain docs; remove manually if unwanted.\n',
    ),
  );
}

#!/usr/bin/env node
/**
 * factstack — CXO + AI-agent codebase analyzer.
 *
 * v0.2 commands:
 *   factstack [path]           analyze <path> (default cwd) + emit artifacts
 *   factstack analyze [path]   alias for the default
 *   factstack ui [path]        open the WebUI in a browser
 *   factstack watch [path]     ui + chokidar + SSE live-update
 *   factstack diff [a] [b]     compare two analyses (snapshots or live agent.json)
 *   factstack query <verb>     callers / imports / cycles / orphans
 *   factstack export [path]    emit a self-contained HTML report (offline, no CDN)
 *   factstack doctor           sanity-check Node version (≥ 24.3) + node:sqlite
 *
 * Top-level flags:
 *   --json                     machine-invocable mode for analyze/diff/query
 *
 * Companion: apps/mcp-server (factstack-mcp) — same artifacts over MCP stdio.
 *
 * Layout (tech-debt#6): this file is only the Commander registration — every
 * command, flag, default and help text. Each action runs a function from
 * ./commands/ (one module per command, or a small cohesive group), which
 * writes and exits through an injectable CliIO (./io.ts) so it can be tested
 * in-process. The `ui` server and its guards are ./ui-server.ts; analyze,
 * ui, watch, export and quick share ONE analyze pipeline (./pipeline.ts).
 */

import { Command } from 'commander';
import kleur from 'kleur';
import { CONTEXT_KINDS } from '@factstack/core';
import { ALL_FORMATS, INSTALL_AGENTS } from '@factstack/skills';
import { GIT_HOOK_COMMAND } from './gitHook.js';
import { freshnessHookCommandHelp, gitHookCommandHelp, serverCommandHelp } from './launchHelp.js';
import { analyzeCommand, type AnalyzeOptions } from './commands/analyze.js';
import { benchCommand, type BenchOptions } from './commands/bench.js';
import { ciReportCommand, type CiReportOptions } from './commands/ci-report.js';
import {
  contextCommand,
  contextStoreCommand,
  rememberCommand,
  type ContextOptions,
  type ContextStoreOptions,
  type RememberOptions,
} from './commands/context.js';
import { diffCommand, type DiffOptions } from './commands/diff.js';
import { doctorCommand } from './commands/doctor.js';
import { exportDiagramCommand, type ExportDiagramOptions } from './commands/export-diagram.js';
import { exportCommand, type ExportOptions } from './commands/export.js';
import { hookCommand, type HookOptions } from './commands/hook.js';
import {
  installCommand,
  uninstallCommand,
  type InstallOptions,
  type UninstallOptions,
} from './commands/install.js';
import { outdatedCommand, type OutdatedOptions } from './commands/outdated.js';
import { queryCommand, type QueryOptions } from './commands/query.js';
import { quickCommand, type QuickOptions } from './commands/quick.js';
import { reviewCommand, type ReviewOptions } from './commands/review.js';
import { scanVulnsCommand, type ScanVulnsOptions } from './commands/scan-vulns.js';
import {
  exportSkillsCommand,
  setupAgentsCommand,
  type ExportSkillsOptions,
  type SetupAgentsOptions,
} from './commands/skills.js';
import { telemetryCommand, type TelemetryOptions } from './commands/telemetry.js';
import { tokensCommand, type TokensOptions } from './commands/tokens.js';
import { uiCommand, type UiOptions } from './commands/ui.js';
import { whyCommand, type WhyOptions } from './commands/why.js';

const program = new Command();

program
  .name('factstack')
  .description(
    'FACTS — Fun AI Coding Tools. Analyse a project and emit AI-agent + CXO-readable artifacts.',
  )
  .version('0.1.0')
  // Top-level `--json` so `factstack --json .` matches the file-header
  // promise of "machine-invocable mode (no TTY chrome)". Subcommands
  // that also support `--json` (analyze, diff, query) read the same
  // flag from `program.opts()` if not passed locally.
  .option(
    '--json',
    'Machine-invocable mode: structured JSON on stdout (works with analyze, diff, query)',
  );

/** Subcommands with their own --json also honour the top-level flag
 *  (`factstack --json <cmd>`) when theirs is not given. */
function inheritJson<T extends { json?: boolean }>(opts: T): T {
  if (opts.json === undefined && program.opts().json) opts.json = true;
  return opts;
}

program
  .command('analyze [target]', { isDefault: true })
  .description('Analyze a project directory and write artifacts into <target>/.facts/')
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .option('--no-progress', 'Suppress progress output')
  .option('--no-gitignore-entry', 'Do not add .facts/ to the project .gitignore')
  .option(
    '--minimal',
    'Write the AI-first core: agent.pack + human.json + MEMORY.md, no snapshot. Never creates agent.json/agent.jsonl, but refreshes them when an earlier full analyze left them, so diff/scan-vulns/export-* never read a stale copy. Never replaces the review baseline (.facts/baseline/agent.json): it stays the last full analyze. Never reads agent session transcripts, even with --agent-requests or FACTSTACK_AGENT_REQUESTS=1. Reuses the cached git topology while no ref has moved (the per-edit hook path).',
  )
  .option(
    '--symbols',
    'F2 (beta): also build the symbol-level call/reference graph — declarations as nodes, refs as edges, each provenance-tagged (extracted/inferred/ambiguous). Adds a per-file AST ref walk; off by default until it stabilizes.',
  )
  .option(
    '--agent-requests',
    'Opt in: read your Claude Code / Codex session transcripts under your home dir so the Worktrees tab can show who asked for what, and when (prompts are secret-redacted and capped at 200 chars; they stay on this machine — .facts/ and local views like ui and quick — and are stripped from export and the published site). Off by default. Set FACTSTACK_AGENT_REQUESTS=1 to opt in on every surface (MCP server, ui, export).',
  )
  .option(
    '--no-agent-requests',
    'Force transcript reading off for this run, overriding FACTSTACK_AGENT_REQUESTS=1.',
  )
  .option(
    '--no-cache',
    'F8: disable the content-hash extraction cache (.facts/cache.db). Default-on caches per-file parse results keyed by content hash, so a re-analyze re-parses only changed files; output is byte-identical either way.',
  )
  .action((target: string | undefined, opts: AnalyzeOptions) =>
    analyzeCommand(target, inheritJson(opts)),
  );

program
  .command('ui [target]')
  .description('Open the WebUI in a browser, pointed at <target>/.facts/ artifacts')
  .option('-p, --port <port>', 'Port to serve on (default 4747)', '4747')
  .option('--no-open', "Don't auto-open the browser")
  .option('--reanalyze', 'Re-run analysis before starting the server')
  .option('-w, --watch', 'Watch source files and push live updates via SSE')
  .option(
    '--idle-timeout <min>',
    'Auto-shutdown after N minutes with no activity (0 disables)',
    '30',
  )
  .option('--no-stale-check', 'Skip the startup staleness check (serve the existing .facts/ as-is)')
  .action((target: string | undefined, opts: UiOptions) => uiCommand(target, opts));

// `factstack watch` — convenience alias for `factstack ui --watch`. Same
// server, same endpoints, just launches with the watcher on by default.
program
  .command('watch [target]')
  .description('Run the UI with live file-watching + SSE push. Alias for `ui --watch`.')
  .option('-p, --port <port>', 'Port to serve on (default 4747)', '4747')
  .option('--no-open', "Don't auto-open the browser")
  .action(async (target: string | undefined, opts: { port: string; open: boolean }) => {
    // Delegate to the `ui` command's action via the program's argv re-parse.
    const argv = ['node', 'factstack', 'ui', '--watch', '--port', opts.port];
    if (target) argv.splice(3, 0, target);
    if (opts.open === false) argv.push('--no-open');
    await program.parseAsync(argv);
  });

program
  .command('export [target]')
  .description(
    'Emit a self-contained HTML report — or the dependency/symbol graph with --graph (no server needed)',
  )
  .option('-o, --out <dir>', 'Output directory (default ./dist)', './dist')
  .option('--name <name>', 'Output filename (default facts-report.html)', 'facts-report.html')
  .option('--graph <format>', 'F14 — export the graph instead of HTML: graphml | json-graph')
  .option(
    '--include-private',
    'Keep agent session prompts, contributor emails and absolute local paths in the report (your own archive — not for sharing)',
  )
  .action((target: string | undefined, opts: ExportOptions) => exportCommand(target, opts));

program
  .command('why <target>')
  .description(
    'F10 — show the design rationale (NOTE/HACK/FIXME comments + docstrings) attached to a symbol, file, or name. e.g. `factstack why buildMemory`',
  )
  .option('--json', 'Emit structured JSON on stdout instead of a TTY list')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .action((target: string, opts: WhyOptions) => whyCommand(target, inheritJson(opts)));

program
  .command('quick [target]')
  .description(
    'Scan a project and open a self-contained viewer in your browser — no server, no setup. The 5-second look.',
  )
  .option('--reanalyze', 'Force a fresh analysis even if .facts/ already exists')
  .option('--no-open', "Write the HTML but don't auto-open the browser")
  .action((target: string | undefined, opts: QuickOptions) => quickCommand(target, opts));

program
  .command('outdated [target]')
  .description(
    'Check declared npm dependencies against the registry — how many are behind the latest published version',
  )
  .option('--fail-on <n>', 'Exit non-zero when at least N dependencies are outdated (CI gate)')
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .action((target: string | undefined, opts: OutdatedOptions) =>
    outdatedCommand(target, inheritJson(opts)),
  );

program
  .command('scan-vulns [target]')
  .description(
    'Query OSV.dev for CVEs in your dependencies + persist findings into <target>/.facts/agent.json. Versions come from the lockfile (what is installed) when there is one, else the declared range (labelled); transitive and dev findings are shown but not graded.',
  )
  .option(
    '--prod-only',
    'Scan direct runtime dependencies only — skip devDependencies and transitive packages',
  )
  .option('--no-cache', 'Bypass any local cache and force fresh OSV queries')
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .action((target: string | undefined, opts: ScanVulnsOptions) =>
    scanVulnsCommand(target, inheritJson(opts)),
  );

program
  .command('diff [snapshotA] [snapshotB]')
  .description(
    'Compare two analyses. Zero args: current agent.json vs the review baseline (.facts/baseline/agent.json, the previous full analyze; the previous snapshot when there is none yet). One arg: that endpoint vs agent.json. Two args: two endpoints (snapshot or agent.json paths).',
  )
  .option('--json', 'Emit the diff artifact as JSON on stdout instead of a TTY summary')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .action((snapA: string | undefined, snapB: string | undefined, opts: DiffOptions) =>
    diffCommand(snapA, snapB, inheritJson(opts)),
  );

program
  .command('review [base] [head]')
  .description(
    'Change Verdict: fuse diff + blast radius + structural deltas into one PR-ready risk verdict (Markdown or JSON). Zero args: the review baseline (.facts/baseline/agent.json — the previous full analyze) vs .facts/agent.json.',
  )
  .option('--json', 'Emit the verdict as JSON instead of Markdown')
  .option(
    '--fail-on <severity>',
    'Exit non-zero when verdict severity is >= this (low|medium|high|critical; none = never fail)',
  )
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .action((baseArg: string | undefined, headArg: string | undefined, opts: ReviewOptions) =>
    reviewCommand(baseArg, headArg, inheritJson(opts)),
  );

program
  .command('query <selector> [target...]')
  .description(
    'Query the graph. Structured: query <verb> <target...> (verbs: callers | imports | cycles | orphans | neighbors | references | implementers | impact | path-between <from> <to>). Free-text: query "who calls buildMemory" — resolved deterministically against real entity names.',
  )
  .option('--json', 'Emit structured JSON on stdout instead of a TTY list')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .option('-f, --filter <glob>', 'Restrict results to matching paths')
  .option('-l, --limit <n>', 'Max results (default 200)', '200')
  .option(
    '-d, --depth <n>',
    'Transitive depth (default: 1 for imports/neighbors/references, 3 for impact)',
  )
  .option('--direction <dir>', 'Direction for `neighbors`: out | in | both (default both)')
  .option(
    '--min-confidence <level>',
    'Keep only edges at least this certain: extracted | inferred | ambiguous',
  )
  .action((selector: string, targetArr: string[] | undefined, opts: QueryOptions) =>
    queryCommand(selector, targetArr, inheritJson(opts)),
  );

program
  .command('context <task...>')
  .description(
    'F4 — assemble a ranked, token-budgeted context block for a coding task. e.g. `factstack context "add a role field to User"`. Resolves seeds from the task against real entity names, expands the graph, ranks by importance + proximity + name-match + recency, and packs the best anchors under a token budget. Run `analyze . --symbols` first for symbol-level anchors.',
  )
  .option('--json', 'Emit structured JSON on stdout instead of a TTY list')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .option('-b, --budget <n>', 'Token budget for the assembled context (default 8000)', '8000')
  .option('--max-hops <n>', 'Graph expansion radius from the seeds (default 2)', '2')
  .option(
    '-s, --seeds <list>',
    'Comma-separated explicit seed file paths or symbol ids to anchor on',
  )
  .action((taskArr: string[], opts: ContextOptions) => contextCommand(taskArr, inheritJson(opts)));

program
  .command('remember <kind> <text...>')
  .description(
    `F9 — record durable working context in .facts/learnings.jsonl: a ${CONTEXT_KINDS.join(' | ')}. Tasks/questions start open; re-run with the same --key and --done to close one. Surfaces in MEMORY.md's "Working context" and biases \`factstack context\`. e.g. \`factstack remember decision "auth uses session cookies, not JWTs"\``,
  )
  .option(
    '-k, --key <key>',
    'Stable key so a later `remember` supersedes this one (default: the text itself)',
  )
  .option('--done', 'Close the task/question with this key (records outcome accepted)')
  .option('-e, --entities <list>', 'Comma-separated file paths / symbol ids this record is about')
  .option('-a, --agent <id>', 'Recording agent id', 'cli-user')
  .option('--json', 'Emit machine-readable JSON on stdout')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .action((kind: string, textArr: string[], opts: RememberOptions) =>
    rememberCommand(kind, textArr, inheritJson(opts)),
  );

program
  .command('context-store')
  .description(
    'F9 — show the durable working context aggregated from .facts/learnings.jsonl: recent decisions/facts, open tasks, open questions (most-recent-wins per key).',
  )
  .option('--json', 'Emit the aggregate as JSON on stdout')
  .option('-r, --root <path>', 'Project root (default cwd)', '.')
  .action((opts: ContextStoreOptions) => contextStoreCommand(inheritJson(opts)));

program
  .command('bench')
  .description(
    'F13 — reproducible context-savings benchmark. For each task in the committed set, compares tokens-to-context via graph-aware assembly (F4 get_context) vs a naive path-grep that reads every hit in full. Deterministic over the committed corpus bytes. `--update` pins the report as bench/expected.json; `--check` exits 1 on drift (CI).',
  )
  .option('-c, --corpus <dir>', 'Corpus project to analyze', 'bench/corpus')
  .option('-t, --tasks <file>', 'Task-set JSON', 'bench/tasks.json')
  .option(
    '--update',
    'Write the report as the committed expected output (expected.json beside the task file)',
  )
  .option('--check', 'Exit 1 unless the report matches the committed expected output')
  .option('--json', 'Emit the full report as JSON on stdout')
  .action((opts: BenchOptions) => benchCommand(inheritJson(opts)));

program
  .command('install [target]')
  .description(
    `F12 — wire FACTS into a coding agent in ONE command: instruction files (skills) + MCP server registration in the agent's config (+ the freshness hook where the agent supports hooks). Agents: ${INSTALL_AGENTS.join(' | ')} | all. Idempotent — safe to re-run after every analyze. e.g. \`factstack install --agent claude\``,
  )
  .option('-a, --agent <name>', `Agent to wire: ${INSTALL_AGENTS.join(' | ')} | all`, 'claude')
  .option('--server-command <cmd>', serverCommandHelp())
  .option('--json', 'Emit a machine-readable summary on stdout')
  .action((target: string | undefined, opts: InstallOptions) =>
    installCommand(target, inheritJson(opts)),
  );

program
  .command('uninstall [target]')
  .description(
    'F12 — reverse `factstack install`: remove the FACTS MCP server registration from agent configs and (for claude) the freshness hook from .claude/settings.local.json. Instruction files (SKILL.md / .cursorrules / copilot-instructions / AGENTS.md) are left in place — they are plain docs; delete manually if unwanted.',
  )
  .option('-a, --agent <name>', `Agent to unwire: ${INSTALL_AGENTS.join(' | ')} | all`, 'all')
  .option('--json', 'Emit a machine-readable summary on stdout')
  .action((target: string | undefined, opts: UninstallOptions) =>
    uninstallCommand(target, inheritJson(opts)),
  );

program
  .command('export-skills [target]')
  .description(
    'Emit project context as AI-agent skill files (Claude SKILL.md + Cursor .cursorrules + GitHub Copilot copilot-instructions.md)',
  )
  .option(
    '--format <ids>',
    `Comma-separated subset of formats to emit (default: all). Available: ${ALL_FORMATS.join(', ')}`,
  )
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .action((target: string | undefined, opts: ExportSkillsOptions) =>
    exportSkillsCommand(target, inheritJson(opts)),
  );

program
  .command('setup-agents [target]')
  .description(
    'Install/refresh the agent skill files + a PostToolUse freshness hook so AI coding agents read the FACTS pack instead of re-scanning the repo',
  )
  .option(
    '--format <ids>',
    `Comma-separated subset of skill formats (default: all). Available: ${ALL_FORMATS.join(', ')}`,
  )
  .option('--hook-command <cmd>', freshnessHookCommandHelp())
  .option('--no-hook', 'Install only the skill files; skip the PostToolUse freshness hook')
  .option('--json', 'Emit machine-readable JSON to stdout instead of a TTY summary')
  .action((target: string | undefined, opts: SetupAgentsOptions) =>
    setupAgentsCommand(target, inheritJson(opts)),
  );

program
  .command('hook <action> [target]')
  .description(
    'F8 — manage the git post-commit hook that auto-refreshes .facts/ after each commit (analyze makes no network call; never blocks the commit). Works in linked worktrees and with core.hooksPath (husky). Actions: install | uninstall',
  )
  .option(
    '--command <cmd>',
    gitHookCommandHelp(),
    process.env.FACTSTACK_HOOK_COMMAND || GIT_HOOK_COMMAND,
  )
  .option(
    '--shared',
    'Install/uninstall even when git runs hooks from a shared place: a core.hooksPath from your global/system git config (the hook runs in every repo on this machine) or a hooks dir inside the work tree such as .husky/ or .githooks/ (committed, it runs for every teammate). Without it, the line to add by hand is printed instead.',
  )
  .action((action: string, target: string | undefined, opts: HookOptions) =>
    hookCommand(action, target, opts),
  );

program
  .command('export-diagram [target]')
  .description('Emit a Mermaid flowchart of the project graph (package / hub / focal views)')
  .option('--view <view>', 'Diagram view: package | hub | focal (default: package)', 'package')
  .option('--focus <path>', 'Project-relative file path; required when --view=focal')
  .option('--depth <n>', 'Max BFS depth for focal view (default: 2)', '2')
  .option('--max-nodes <n>', 'Hard cap on node count across all views (default: 30)', '30')
  .option(
    '-o, --out <path>',
    'Write the diagram to <path> instead of stdout. Wraps in a ```mermaid block if the file ends in .md.',
  )
  .option(
    '--no-wrap',
    'When writing a .md file, skip the ```mermaid wrapper (emit bare flowchart source)',
  )
  .option('--json', 'Emit a JSON envelope with metadata + the diagram source')
  .action((target: string | undefined, opts: ExportDiagramOptions) =>
    exportDiagramCommand(target, inheritJson(opts)),
  );

program
  .command('ci-report [target]')
  .description(
    'Emit a markdown diff report (head vs base) suitable for posting as a PR comment or GitHub Actions step summary',
  )
  .requiredOption(
    '--base <path>',
    'Base endpoint to compare against (agent.json — e.g. .facts/baseline/agent.json — or a snapshot path/stamp; a snapshot carries counts only, so its CVE delta is reported as unavailable)',
  )
  .option('--head <path>', 'Head endpoint (default: <target>/.facts/agent.json)')
  .option(
    '--fail-on-shift <n>',
    'Exit non-zero if the graded severity shift >= n: advisories on direct runtime deps only — dev/transitive ones are listed in the report, not counted (use in CI to gate merges; default: no gate)',
  )
  .option(
    '--with-diagram',
    'Embed a Mermaid architecture diagram between vuln + files sections (auto-picks package or focal view based on the diff)',
  )
  .option(
    '--json',
    'Emit the underlying DiffArtifact as JSON on stdout instead of the markdown report',
  )
  .action((target: string | undefined, opts: CiReportOptions) =>
    ciReportCommand(target, inheritJson(opts)),
  );

program
  .command('tokens [target]')
  .description(
    'Estimate the AI-context token cost of a file (or stdin with `-`). Char-based cl100k approximation, within ~8% of tiktoken — the same estimate analyze uses for per-file tokenCost.',
  )
  .option('--json', 'Emit machine-readable JSON to stdout')
  .action((target: string | undefined, opts: TokensOptions) =>
    tokensCommand(target, inheritJson(opts)),
  );

program
  .command('telemetry [action]')
  .description(
    'Local-first usage metrics. action: status (default) | export | reset | opt-in | opt-out',
  )
  .option('--json', 'Emit machine-readable JSON to stdout')
  .action((action: string | undefined, opts: TelemetryOptions) =>
    telemetryCommand(action, inheritJson(opts)),
  );

program
  .command('doctor')
  .description('Verify FACTS can analyse this machine (Node version, permissions, etc.)')
  .action(() => doctorCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(kleur.red('factstack: ') + message + '\n');
  if (process.env.FACTSTACK_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exit(1);
});

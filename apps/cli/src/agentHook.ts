/**
 * Freshness-hook installer (ft-1, Layer 2).
 *
 * "Set up FACTS for agents" installs a Claude Code `PostToolUse` hook that
 * re-runs `factstack analyze --minimal` after every Edit/Write, so
 * `.facts/agent.pack` + MEMORY.md track the agent's changes. That's the
 * (A) half of the skill contract the renderers teach ("keep the pack
 * fresh") — automated instead of relying on the agent's goodwill.
 *
 * Lands in `.claude/settings.local.json` (personal, gitignored) rather than
 * the shared `settings.json`: it's a per-developer "set up my environment"
 * action, and a committed hook that shells out to a tool a teammate may not
 * have installed is a footgun. The merge is non-destructive and idempotent,
 * and the installer makes sure git really does ignore the file (CLI-10): a
 * stock machine has no global rule for it.
 *
 * Split into a pure merge (`ensureFreshnessHook`) + a thin fs wrapper
 * (`installFreshnessHook`) so the merge logic is unit-testable without
 * touching disk — mirrors @factstack/skills' FileWriter seam.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CLI_NPM_PACKAGE, CLI_NPX, CLI_PUBLISHED } from '@factstack/spec';

/**
 * How the default hooks launch the CLI. A hook never runs on a TTY,
 * and off a TTY `npx` assumes --yes: while the `factstack` name is unclaimed
 * on npm, `npx factstack` would fetch and run whatever package someone
 * registers under it, on every edit and every commit. So until the owner
 * flips CLI_PUBLISHED, hooks use `npm exec --no --`, which runs a project or
 * global install and FAILS when there is none — it never downloads. Once
 * published, the launch is spec's CLI_NPX.
 */
export function hookCliLaunch(published: boolean = CLI_PUBLISHED): string {
  return published ? CLI_NPX : `npm exec --no -- ${CLI_NPM_PACKAGE}`;
}

/** The command the hook runs. The launch (hookCliLaunch) resolves a local
 *  dep or a global install, so this works whether the consumer project has
 *  factstack as a devDependency or installed globally. `--minimal` is the
 *  fast path for a hot edit loop: agent.pack + human.json + MEMORY.md; an
 *  agent.json / agent.jsonl a full analyze left is marked stale
 *  (`<file>.stale`), not rewritten. It never moves the review baseline, so
 *  review_change still compares against the last full analyze. The
 *  `factstack` package is not on npm until the owner publishes it — until
 *  then `--hook-command` / FACTSTACK_HOOK_COMMAND point the hook at a local
 *  build. */
export const FRESHNESS_HOOK_COMMAND = `${hookCliLaunch()} analyze --minimal`;

/* `npx [flags] factstack[@ver] …` — a launch that downloads the package when
   it is not installed (no prompt off a TTY). */
const NPX_FACTSTACK = new RegExp(
  `^npx\\s+(?:-{1,2}[\\w-]+(?:=\\S*)?\\s+)*${CLI_NPM_PACKAGE}(?:@\\S*)?(?:\\s|$)`,
);

/**
 * The warning shown beside a hook whose command launches the `factstack`
 * npm package while it is not published — what install's MCP status line
 * says for the server. `override` names how to point the hook at a
 * local build. Undefined once published, and for any other command.
 */
export function hookLaunchNote(
  command: string,
  override: string,
  published: boolean = CLI_PUBLISHED,
): string | undefined {
  if (published) return undefined;
  const c = normalizeCommand(command);
  if (c.startsWith(`${hookCliLaunch(false)} `)) {
    return `${CLI_NPM_PACKAGE} is not on npm yet — this hook fails (it never downloads) until factstack is installed in the project or globally; or point it at a local build: ${override}`;
  }
  if (NPX_FACTSTACK.test(c)) {
    return `${CLI_NPM_PACKAGE} is not on npm yet — off a TTY \`npx\` installs without asking, so this hook would fetch and run whatever package claims the name; point it at a local build: ${override}`;
  }
  return undefined;
}

/** Fires after the agent's file-mutating tools. The harness exposes these
 *  as `Edit` and `Write`; the pipe is Claude Code's matcher-or syntax. */
export const FRESHNESS_HOOK_MATCHER = 'Edit|Write';

/** Project-relative path of the settings file the hook lives in. */
export const SETTINGS_LOCAL_PATH = '.claude/settings.local.json';

interface CommandHook {
  type: 'command';
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: CommandHook[];
}
export interface ClaudeSettings {
  hooks?: { PostToolUse?: HookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

/* `factstack` (or `@factstack/cli`) as a command token of its own — after
   the start, whitespace, a path separator or a quote; optionally `@version`
   and a script/shim extension — then global flags, then the `analyze`
   subcommand. `node scripts/factstack-analyze-report.js` is not ours. */
const FACTSTACK_ANALYZE =
  /(?:^|[\s/\\"'])(?:@factstack\/cli|factstack)(?:@[\w.^~-]+)?(?:\.(?:[cm]?[jt]s|cmd|exe|ps1))?["']?\s+(?:-{1,2}[\w-]+(?:=\S*)?\s+)*analyze(?![\w-])/;
/* This monorepo's self-hosting entry, `… apps/cli/(src|dist)/cli.(ts|js) analyze`. */
const MONOREPO_ANALYZE =
  /(?:^|[\s/\\"'])apps[\\/]cli[\\/](?:dist|src)[\\/]cli\.[cm]?[jt]s["']?\s+(?:-{1,2}[\w-]+(?:=\S*)?\s+)*analyze(?![\w-])/;

/**
 * Is `command` a FACTS freshness hook — ours, from any earlier version or
 * install flavour (`npx factstack analyze --minimal`, `pnpm exec factstack
 * analyze`, `node …/factstack.js analyze`, or this monorepo's self-hosting
 * `… apps/cli/src/cli.ts analyze`)? Used to keep ONE analyze per edit
 * (security#1 migration) and by uninstall (R6: a user script that merely
 * has "factstack" and "analyze" in its name is not ours).
 */
export function isFreshnessCommand(command: string): boolean {
  if (typeof command !== 'string') return false;
  return FACTSTACK_ANALYZE.test(command) || MONOREPO_ANALYZE.test(command);
}

const normalizeCommand = (c: string): string => c.trim().replace(/\s+/g, ' ');

/** Every default command the installer has ever written. Only these are
 *  ours to rewrite when the caller did not ask for a command. */
const KNOWN_DEFAULT_COMMANDS = new Set(
  [
    'npx factstack analyze --minimal',
    `${hookCliLaunch(true)} analyze --minimal`,
    `${hookCliLaunch(false)} analyze --minimal`,
    FRESHNESS_HOOK_COMMAND,
  ].map(normalizeCommand),
);

/** Was `command` written by an installer default (not by a person)? */
export function isKnownDefaultCommand(command: string): boolean {
  return KNOWN_DEFAULT_COMMANDS.has(normalizeCommand(command));
}

/**
 * Does `command` run more than one thing — `&&`, `||`, `;`, a pipe, `&` or
 * a newline? Redirections (`2>&1`, `>&2`, `&>`) do not count. Such a
 * command is never rewritten or removed: `factstack analyze --minimal &&
 * pnpm test` would lose the `pnpm test`.
 */
export function chainsOtherLogic(command: string): boolean {
  const bare = command.replace(/\d*[<>]&\d*-?|&>>?/g, ' ');
  return /[;&|\n]/.test(bare);
}

/** Deep-clone PostToolUse so the caller's object graph is never mutated. */
function clonePost(settings: ClaudeSettings): HookEntry[] {
  const existing = settings.hooks?.PostToolUse;
  /* Conditional spread (not `hooks: e.hooks`) so we never set
     `hooks: undefined` explicitly, which exactOptionalPropertyTypes rejects
     against `hooks?: CommandHook[]`. */
  return Array.isArray(existing)
    ? existing.map((e): HookEntry =>
        Array.isArray(e.hooks) ? { ...e, hooks: [...e.hooks] } : { ...e },
      )
    : [];
}

const isCommandHook = (h: unknown): h is CommandHook =>
  !!h && typeof h === 'object' && (h as CommandHook).type === 'command';

export interface FreshnessMerge {
  settings: ClaudeSettings;
  /** The settings changed (hook added or updated, or a duplicate dropped);
   *  `false` on an idempotent re-run, so callers can skip the disk write. */
  added: boolean;
  /** The command that now runs the analyze after each edit. */
  command: string;
  /** FACTS commands swapped for, or dropped in favour of, `command`. */
  replaced: string[];
  /** Exact duplicates of a kept command, dropped (two analyzes per edit). */
  removed: string[];
  /** FACTS commands left exactly as they were: the user's own command when
   *  none was asked for, and any command that chains other logic. */
  kept: string[];
}

/**
 * Pure, non-destructive merge: ensure `settings` runs the freshness analyze
 * once per edit. Returns a NEW settings object (the input is never mutated)
 * and what changed. Every other key and hook is preserved; a replaced
 * command keeps its entry's matcher and extra keys (timeout, …).
 *
 * `command` given (--hook-command / FACTSTACK_HOOK_COMMAND) — the caller's
 * choice wins: the first FACTS command is swapped for it in place and any
 * other FACTS command is dropped; with none, it is appended (to an existing
 * same-matcher entry when there is one).
 *
 * No `command` — the default: a FACTS command the user set up themselves
 * (`pnpm exec factstack …`, a local build) is KEPT as is; only an earlier
 * installer default is ours to update. When a user command runs the analyze,
 * installer defaults beside it are dropped as duplicates.
 *
 * Either way a command that chains other logic (see chainsOtherLogic) is
 * never rewritten or removed — it is reported in `kept`.
 */
export function ensureFreshnessHook(
  settings: ClaudeSettings,
  command?: string,
  matcher: string = FRESHNESS_HOOK_MATCHER,
): FreshnessMerge {
  const explicit = command !== undefined;
  const wanted = command ?? FRESHNESS_HOOK_COMMAND;
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const post = clonePost(settings);

  const isOurs = (c: string): boolean => c === wanted || isFreshnessCommand(c);
  const isChained = (c: string): boolean => c !== wanted && chainsOtherLogic(c);
  const all: string[] = post.flatMap((e) =>
    (Array.isArray(e.hooks) ? e.hooks : [])
      .filter(isCommandHook)
      .map((h) => h.command)
      .filter((c): c is string => typeof c === 'string' && isOurs(c)),
  );
  /* Default mode: the user's own FACTS set-up (a custom or chained command)
     already runs the analyze, so it is left alone and our defaults go. */
  const userOwned = !explicit && all.some((c) => isChained(c) || !isKnownDefaultCommand(c));

  const replaced: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  const seen = new Set<string>(); // normalised commands already kept
  let active: string | null = null;
  const emptied = new Set<HookEntry>();
  for (const e of post) {
    if (!Array.isArray(e.hooks)) continue;
    const out: CommandHook[] = [];
    for (const h of e.hooks) {
      const c = isCommandHook(h) && typeof h.command === 'string' ? h.command : null;
      if (c === null || !isOurs(c)) {
        out.push(h);
        continue;
      }
      if (isChained(c)) {
        out.push(h); // never rewritten, never removed
        kept.push(c);
        if (userOwned) active ??= c;
        continue;
      }
      if (seen.has(normalizeCommand(c))) {
        removed.push(c); // an exact duplicate of a command already kept
        continue;
      }
      if (userOwned) {
        if (isKnownDefaultCommand(c)) {
          replaced.push(c); // an installer default beside the user's own command
          continue;
        }
        out.push(h);
        kept.push(c);
        seen.add(normalizeCommand(c));
        active ??= c;
        continue;
      }
      if (active === null) {
        // In place: keeps the entry's matcher and any extra keys (timeout, …).
        out.push(c === wanted ? h : { ...h, command: wanted });
        if (c !== wanted) replaced.push(c);
        seen.add(normalizeCommand(wanted));
        active = wanted;
        continue;
      }
      replaced.push(c); // a second, different FACTS command: one analyze per edit
    }
    // Drop only entries this merge emptied (a removed duplicate), never a user's.
    if (out.length === 0 && e.hooks.length > 0) emptied.add(e);
    e.hooks = out;
  }
  if (active === null && !userOwned) {
    // Prefer attaching to an existing same-matcher entry; else add a new one.
    const sameMatcher = post.find((e) => e.matcher === matcher && !emptied.has(e));
    if (sameMatcher) {
      sameMatcher.hooks = [...(sameMatcher.hooks ?? []), { type: 'command', command: wanted }];
    } else {
      post.push({ matcher, hooks: [{ type: 'command', command: wanted }] });
    }
    active = wanted;
  }
  next.hooks!.PostToolUse = post.filter((e) => !emptied.has(e));
  /* Compare what is on disk with what would be: a dropped duplicate is a
     change too (R7 — it was deduped in memory and never written back). */
  const added =
    JSON.stringify(settings.hooks?.PostToolUse ?? null) !== JSON.stringify(next.hooks!.PostToolUse);
  return {
    settings: added ? next : settings,
    added,
    command: active ?? wanted,
    replaced,
    removed,
    kept,
  };
}

/**
 * Pure removal for `factstack uninstall`: drop every FACTS freshness command
 * (and any PostToolUse entry left with no hooks). Everything else is kept —
 * including a FACTS command that chains other logic, which is reported in
 * `kept` for the user to edit by hand.
 */
export function removeFreshnessHook(settings: ClaudeSettings): {
  settings: ClaudeSettings;
  removed: string[];
  kept: string[];
} {
  const post = clonePost(settings);
  const removed: string[] = [];
  const kept: string[] = [];
  const emptied = new Set<HookEntry>();
  for (const e of post) {
    if (!Array.isArray(e.hooks)) continue;
    const before = e.hooks.length;
    e.hooks = e.hooks.filter((h) => {
      if (!isCommandHook(h) || !isFreshnessCommand(h.command ?? '')) return true;
      if (chainsOtherLogic(h.command)) {
        kept.push(h.command);
        return true;
      }
      removed.push(h.command);
      return false;
    });
    if (before > 0 && e.hooks.length === 0) emptied.add(e);
  }
  if (removed.length === 0) return { settings, removed, kept };
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const left = post.filter((e) => !emptied.has(e));
  if (left.length > 0) next.hooks!.PostToolUse = left;
  else delete next.hooks!.PostToolUse;
  if (Object.keys(next.hooks!).length === 0) delete next.hooks;
  return { settings: next, removed, kept };
}

/**
 * Parse `.claude/settings.local.json` text. A leading UTF-8 BOM (PowerShell
 * 5 `Set-Content -Encoding UTF8` and some editors write one) is stripped.
 * Anything that is not a JSON object THROWS: the file holds the user's
 * permission allow/deny rules, and starting over from `{}` silently wiped
 * them (CLI-02 / SEC-4) — the same refusal mergeMcpConfig applies.
 */
export function parseSettings(text: string, label: string = SETTINGS_LOCAL_PATH): ClaudeSettings {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `${label} is not valid JSON (${(err as Error).message}) — fix or remove it, then re-run (refusing to overwrite it)`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${label} is not a JSON object — fix or remove it, then re-run (refusing to overwrite it)`,
    );
  }
  return parsed as ClaudeSettings;
}

export interface InstallHookResult {
  /** Absolute path to the settings file that was (or would be) written. */
  settingsPath: string;
  /** True when the settings file changed (hook added, an older FACTS
   *  command replaced, or a duplicate dropped); false when up to date. */
  added: boolean;
  /** Earlier FACTS freshness commands that were replaced or dropped. */
  replaced: string[];
  /** Exact duplicate FACTS commands that were dropped. */
  removed: string[];
  /** FACTS commands left as they were (the user's own, or chained). */
  kept: string[];
  /** Whether a command was asked for (--hook-command / env) or the default. */
  explicit: boolean;
  /** The command the hook runs (echoed for the caller's confirmation UI). */
  command: string;
  /** Whether `.claude/settings.local.json` had to be added to .gitignore. */
  gitignore: GitignoreStatus;
}

export interface HookFsOptions {
  /** Environment for the `git check-ignore` probe (tests pin git config). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Side-effecting install: read `.claude/settings.local.json` under `root`
 * (or start from `{}` when it does not exist), ensure the freshness hook,
 * and write it back pretty-printed. Creates `.claude/` if missing, then makes
 * sure git ignores the file.
 *
 * `command` undefined means the default (see ensureFreshnessHook): a FACTS
 * command the user set up is kept, not rewritten to FRESHNESS_HOOK_COMMAND.
 *
 * Throws — without touching the file — when it exists but is not a JSON
 * object: it carries the user's permission rules, and a reset would drop
 * them. Callers report the hook as failed and carry on. Write errors throw
 * too.
 */
export function installFreshnessHook(
  root: string,
  command?: string,
  opts: HookFsOptions = {},
): InstallHookResult {
  const settingsPath = join(root, ...SETTINGS_LOCAL_PATH.split('/'));
  const current: ClaudeSettings = existsSync(settingsPath)
    ? parseSettings(readFileSync(settingsPath, 'utf8'))
    : {};

  const merge = ensureFreshnessHook(current, command);
  if (merge.added) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(merge.settings, null, 2) + '\n', 'utf8');
  }
  const gitignore = ensureGitIgnored(root, SETTINGS_LOCAL_PATH, opts.env);
  return {
    settingsPath,
    added: merge.added,
    replaced: merge.replaced,
    removed: merge.removed,
    kept: merge.kept,
    explicit: command !== undefined,
    command: merge.command,
    gitignore,
  };
}

/**
 * Remove every FACTS freshness command from `.claude/settings.local.json`.
 * A missing file is a no-op; a malformed one throws (never rewritten). A
 * FACTS command chained with other logic is left in place and reported.
 */
export function uninstallFreshnessHook(root: string): {
  settingsPath: string;
  removed: string[];
  kept: string[];
} {
  const settingsPath = join(root, ...SETTINGS_LOCAL_PATH.split('/'));
  if (!existsSync(settingsPath)) return { settingsPath, removed: [], kept: [] };
  const { settings, removed, kept } = removeFreshnessHook(
    parseSettings(readFileSync(settingsPath, 'utf8')),
  );
  if (removed.length > 0) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return { settingsPath, removed, kept };
}

/** `added`: the path was appended to .gitignore. `ignored`: git already
 *  ignores it. `skipped`: not a git repo, or git is unavailable. */
export type GitignoreStatus = 'added' | 'ignored' | 'skipped';

/**
 * Make sure git ignores `rel` (a project-relative path) in the repo at
 * `root`. Asks git itself (`git check-ignore`), so global excludes and
 * .git/info/exclude count; only when git says "not ignored" is the path
 * appended to `<root>/.gitignore` (idempotent). Outside a repo, or without
 * git, nothing is written.
 */
export function ensureGitIgnored(
  root: string,
  rel: string,
  env: NodeJS.ProcessEnv = process.env,
): GitignoreStatus {
  let status: number | null;
  try {
    status = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', rel], {
      cwd: root,
      env,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    }).status;
  } catch {
    return 'skipped';
  }
  if (status === 0) return 'ignored';
  if (status !== 1) return 'skipped'; // 128: not a work tree; null: git missing / timed out
  const giPath = join(root, '.gitignore');
  let existing = '';
  try {
    existing = readFileSync(giPath, 'utf8');
  } catch {
    /* created below */
  }
  const line = `/${rel}`;
  const escaped = rel.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^/?${escaped}\\s*$`, 'm').test(existing)) return 'ignored';
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(
    giPath,
    `${sep}\n# FACTS freshness hook — personal Claude Code settings\n${line}\n`,
  );
  return 'added';
}

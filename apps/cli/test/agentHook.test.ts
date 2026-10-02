/**
 * Tests for the freshness-hook installer (ft-1, Layer 2).
 *
 * The pure `ensureFreshnessHook` merge carries the load-bearing logic
 * (idempotency, non-destructive merge, matcher reuse), so most assertions
 * live there — no disk, microseconds. A few fs-level tests cover
 * `installFreshnessHook` against a temp dir to prove the read/merge/write
 * round-trip and that a file it cannot parse is refused, never rewritten.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_NPM_PACKAGE, CLI_NPX, CLI_PUBLISHED } from '@factstack/spec';
import {
  chainsOtherLogic,
  ensureFreshnessHook,
  ensureGitIgnored,
  hookCliLaunch,
  hookLaunchNote,
  installFreshnessHook,
  isFreshnessCommand,
  isKnownDefaultCommand,
  removeFreshnessHook,
  uninstallFreshnessHook,
  FRESHNESS_HOOK_COMMAND,
  FRESHNESS_HOOK_MATCHER,
  type ClaudeSettings,
} from '../src/agentHook.js';

/** Every command in PostToolUse, in order. */
const commandsOf = (s: ClaudeSettings): string[] =>
  (s.hooks?.PostToolUse ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command));
const postToolUse = (...commands: string[]): ClaudeSettings => ({
  hooks: {
    PostToolUse: [
      { matcher: 'Edit|Write', hooks: commands.map((command) => ({ type: 'command', command })) },
    ],
  },
});

/** git with no global/system config, so the owner's personal excludes file
 *  cannot make an un-ignored path look ignored (CLI-10's stock machine). */
function hermeticGitEnv(dir: string): NodeJS.ProcessEnv {
  const empty = join(dir, '.empty-gitconfig');
  writeFileSync(empty, '');
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: empty,
  };
}

describe('ensureFreshnessHook (pure merge)', () => {
  it('adds a PostToolUse hook to empty settings', () => {
    const { settings, added } = ensureFreshnessHook({});
    expect(added).toBe(true);
    const post = settings.hooks?.PostToolUse;
    expect(post).toHaveLength(1);
    expect(post![0]!.matcher).toBe(FRESHNESS_HOOK_MATCHER);
    expect(post![0]!.hooks).toEqual([{ type: 'command', command: FRESHNESS_HOOK_COMMAND }]);
  });

  it('is idempotent — a second run adds nothing', () => {
    const first = ensureFreshnessHook({});
    const second = ensureFreshnessHook(first.settings);
    expect(second.added).toBe(false);
    expect(second.settings.hooks!.PostToolUse).toHaveLength(1);
    expect(second.settings.hooks!.PostToolUse![0]!.hooks).toHaveLength(1);
  });

  it('preserves unrelated settings + existing hooks', () => {
    const input = {
      model: 'opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo read' }] }],
      },
    };
    const { settings, added } = ensureFreshnessHook(input as never);
    expect(added).toBe(true);
    expect((settings as { model?: string }).model).toBe('opus');
    expect(settings.hooks!.PreToolUse).toEqual(input.hooks.PreToolUse);
    const matchers = settings.hooks!.PostToolUse!.map((e) => e.matcher);
    expect(matchers).toContain('Read');
    expect(matchers).toContain(FRESHNESS_HOOK_MATCHER);
  });

  it('attaches to an existing same-matcher entry instead of duplicating it', () => {
    const input = {
      hooks: {
        PostToolUse: [
          {
            matcher: FRESHNESS_HOOK_MATCHER,
            hooks: [{ type: 'command', command: 'echo existing' }],
          },
        ],
      },
    };
    const { settings, added } = ensureFreshnessHook(input as never);
    expect(added).toBe(true);
    expect(settings.hooks!.PostToolUse).toHaveLength(1); // matcher reused, not duplicated
    expect(settings.hooks!.PostToolUse![0]!.hooks).toHaveLength(2);
    expect(settings.hooks!.PostToolUse![0]!.hooks!.map((h) => h.command)).toEqual([
      'echo existing',
      FRESHNESS_HOOK_COMMAND,
    ]);
  });

  it('does not mutate the input object', () => {
    const input = { hooks: { PostToolUse: [] as unknown[] } };
    const snapshot = JSON.stringify(input);
    ensureFreshnessHook(input as never);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('honors a custom command (configurable for self-hosting repos)', () => {
    const cmd = 'npx tsx apps/cli/src/cli.ts analyze --minimal';
    const { settings, added } = ensureFreshnessHook({}, cmd);
    expect(added).toBe(true);
    expect(settings.hooks!.PostToolUse![0]!.hooks![0]!.command).toBe(cmd);
  });
});

describe('installFreshnessHook (fs round-trip)', () => {
  it('creates .claude/settings.local.json with the hook, idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      const r1 = installFreshnessHook(dir);
      expect(r1.added).toBe(true);
      expect(r1.settingsPath.endsWith(join('.claude', 'settings.local.json'))).toBe(true);
      expect(existsSync(r1.settingsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(r1.settingsPath, 'utf8'));
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(FRESHNESS_HOOK_COMMAND);

      const r2 = installFreshnessHook(dir);
      expect(r2.added).toBe(false); // already present
      const parsed2 = JSON.parse(readFileSync(r2.settingsPath, 'utf8'));
      expect(parsed2.hooks.PostToolUse).toHaveLength(1);
      expect(parsed2.hooks.PostToolUse[0].hooks).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges into a pre-existing settings.local.json without clobbering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(
        join(dir, '.claude', 'settings.local.json'),
        JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2),
      );
      const r = installFreshnessHook(dir);
      expect(r.added).toBe(true);
      const parsed = JSON.parse(readFileSync(r.settingsPath, 'utf8'));
      expect(parsed.permissions).toEqual({ allow: ['Bash'] }); // preserved
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(FRESHNESS_HOOK_COMMAND);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /* CLI-02 / SEC-4: the old "fall back to {}" rewrote the file with only the
     hook — every permission allow/deny rule gone (e.g. a deny on ./.env). */
  it('refuses a settings.local.json it cannot parse, leaving the bytes untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      const p = join(dir, '.claude', 'settings.local.json');
      const trailingComma =
        '{ "permissions": { "deny": ["Read(./.env)"], "allow": ["Bash(ls:*)"], } }';
      writeFileSync(p, trailingComma);
      expect(() => installFreshnessHook(dir)).toThrow(/not valid JSON.*refusing to overwrite/);
      expect(readFileSync(p, 'utf8')).toBe(trailingComma);

      writeFileSync(p, '[1, 2]');
      expect(() => installFreshnessHook(dir)).toThrow(/not a JSON object/);
      expect(readFileSync(p, 'utf8')).toBe('[1, 2]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a settings file saved with a UTF-8 BOM and keeps every rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      const p = join(dir, '.claude', 'settings.local.json');
      const rules = {
        permissions: { allow: ['Bash(ls:*)'], deny: ['Read(./.env)', 'Bash(rm -rf:*)'] },
        env: { FOO: '1' },
      };
      writeFileSync(p, String.fromCharCode(0xfeff) + JSON.stringify(rules, null, 2)); // PowerShell 5 style
      const r = installFreshnessHook(dir);
      expect(r.added).toBe(true);
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      expect(parsed.permissions).toEqual(rules.permissions);
      expect(parsed.env).toEqual(rules.env);
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(FRESHNESS_HOOK_COMMAND);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a custom command when given one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      const cmd = 'pnpm exec factstack analyze --minimal';
      const r = installFreshnessHook(dir, cmd);
      expect(r.added).toBe(true);
      expect(r.command).toBe(cmd);
      const parsed = JSON.parse(readFileSync(r.settingsPath, 'utf8'));
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(cmd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* security#1 migration: a second install used to ADD the new command next to
   the old one, so every edit ran two analyzes (one of them via npx). */
describe('an earlier FACTS hook command is replaced, not duplicated', () => {
  const legacy = {
    permissions: { deny: ['Read(./.env)'] },
    hooks: {
      PostToolUse: [
        {
          matcher: 'Edit|Write',
          hooks: [
            { type: 'command' as const, command: 'echo keep-me' },
            { type: 'command' as const, command: 'npx factstack analyze --minimal', timeout: 30 },
          ],
        },
        {
          matcher: 'Write',
          hooks: [{ type: 'command' as const, command: 'npx factstack analyze' }],
        },
      ],
    },
  };

  it('recognises every FACTS flavour and nothing else', () => {
    for (const c of [
      'npx factstack analyze --minimal',
      'npx --no factstack analyze',
      'pnpm exec factstack analyze --minimal',
      'node /opt/tools/factstack.js analyze --minimal',
      'npx tsx apps/cli/src/cli.ts analyze --minimal',
      'node ./apps/cli/dist/cli.js analyze . --minimal',
      'node .\\apps\\cli\\dist\\cli.js analyze --minimal',
      'npx factstack@latest analyze --minimal',
      '"C:\\tools\\factstack.cmd" analyze --minimal',
      'factstack --json analyze .',
      'npx @factstack/cli analyze --minimal',
      'pnpm exec factstack analyze --minimal && pnpm test',
    ]) {
      expect(isFreshnessCommand(c), c).toBe(true);
    }
    for (const c of [
      'echo analyze',
      'npm run lint',
      'node tools/cli.js analyze',
      'factstack-lint --fix',
      'npx prettier --write . && echo factstack; analyze',
      // R6: a user's own script with both words in its NAME is not ours.
      'node scripts/factstack-analyze-report.js',
      'node scripts/factstack_analyze.js',
      'npx factstack-analyze',
      'node factstack/analyze.js',
      'node ./my-factstack.js analyze',
      'factstack analyzer --x',
      'node apps/cli/dist/cli.js analyze-report',
    ]) {
      expect(isFreshnessCommand(c), c).toBe(false);
    }
  });

  it('tells chained commands (&&, ||, ;, |, &) from redirects', () => {
    for (const c of [
      'pnpm exec factstack analyze --minimal && pnpm test',
      'npx factstack analyze --minimal . >/dev/null 2>&1 || true',
      'factstack analyze; echo done',
      'factstack analyze | tee log',
      'factstack analyze &',
      'factstack analyze\necho two',
    ]) {
      expect(chainsOtherLogic(c), c).toBe(true);
    }
    for (const c of [
      'npx factstack analyze --minimal',
      'npx factstack analyze --minimal >/dev/null 2>&1',
      'factstack analyze >&2',
      'factstack analyze &>/dev/null',
    ]) {
      expect(chainsOtherLogic(c), c).toBe(false);
    }
  });

  it('swaps the old command in place, keeps its entry keys, drops duplicates', () => {
    const cmd = 'node ./apps/cli/dist/cli.js analyze --minimal';
    const { settings, added, replaced } = ensureFreshnessHook(legacy, cmd);
    expect(added).toBe(true);
    expect(replaced).toEqual(['npx factstack analyze --minimal', 'npx factstack analyze']);
    const post = settings.hooks!.PostToolUse!;
    expect(post).toHaveLength(1); // the emptied duplicate entry is gone
    expect(post[0]!.hooks).toEqual([
      { type: 'command', command: 'echo keep-me' },
      { type: 'command', command: cmd, timeout: 30 },
    ]);
    expect((settings as typeof legacy).permissions).toEqual(legacy.permissions);
    expect(JSON.stringify(legacy)).toContain('npx factstack analyze --minimal'); // input untouched
    // …and a re-run is a no-op.
    const again = ensureFreshnessHook(settings, cmd);
    expect(again.added).toBe(false);
    expect(again.replaced).toEqual([]);
  });

  it('keeps a user entry that was already empty', () => {
    const input = { hooks: { PostToolUse: [{ matcher: 'Read', hooks: [] }] } };
    const { settings } = ensureFreshnessHook(input);
    expect(settings.hooks!.PostToolUse!.map((e) => e.matcher)).toEqual(['Read', 'Edit|Write']);
  });

  it('on disk: switching --hook-command leaves exactly one freshness hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      installFreshnessHook(dir); // default npx command
      const r = installFreshnessHook(dir, 'node ./apps/cli/dist/cli.js analyze --minimal');
      expect(r.replaced).toEqual([FRESHNESS_HOOK_COMMAND]);
      const parsed = JSON.parse(readFileSync(r.settingsPath, 'utf8'));
      const cmds = parsed.hooks.PostToolUse.flatMap((e: { hooks: { command: string }[] }) =>
        e.hooks.map((h) => h.command),
      );
      expect(cmds).toEqual(['node ./apps/cli/dist/cli.js analyze --minimal']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* R3: with no --hook-command the migration rewrote a working local command
   (`pnpm exec factstack …`, this monorepo's tsx entry) to the unpublished
   `npx factstack` default — and dropped any `&& …` chained after it. */
describe('the default keeps a FACTS hook the user set up (R3)', () => {
  const mine = 'pnpm exec factstack analyze --minimal';
  const selfHost = 'node node_modules/tsx/dist/cli.mjs apps/cli/src/cli.ts analyze --minimal';
  const chained = 'pnpm exec factstack analyze --minimal && pnpm test';

  it('knows which commands an installer default wrote', () => {
    expect(isKnownDefaultCommand(FRESHNESS_HOOK_COMMAND)).toBe(true);
    expect(isKnownDefaultCommand('  npx   factstack analyze --minimal ')).toBe(true);
    expect(isKnownDefaultCommand(mine)).toBe(false);
    expect(isKnownDefaultCommand('npx factstack analyze')).toBe(false);
  });

  it.each([[mine], [selfHost]])('keeps %s as is when no command is given', (cmd) => {
    const r = ensureFreshnessHook(postToolUse(cmd));
    expect(r.added).toBe(false); // nothing to write
    expect(r.command).toBe(cmd);
    expect(r.kept).toEqual([cmd]);
    expect(r.replaced).toEqual([]);
    expect(commandsOf(r.settings)).toEqual([cmd]);
  });

  it('never rewrites a chained command, with or without --hook-command', () => {
    const byDefault = ensureFreshnessHook(postToolUse('echo a', chained));
    expect(byDefault.added).toBe(false);
    expect(byDefault.kept).toEqual([chained]);
    expect(commandsOf(byDefault.settings)).toEqual(['echo a', chained]);

    const asked = 'node ./apps/cli/dist/cli.js analyze --minimal';
    const explicit = ensureFreshnessHook(postToolUse(chained), asked);
    expect(explicit.added).toBe(true);
    expect(explicit.kept).toEqual([chained]); // reported, untouched
    expect(explicit.replaced).toEqual([]);
    expect(commandsOf(explicit.settings)).toEqual([chained, asked]);
  });

  it('drops an installer default sitting beside the user command, in either order', () => {
    for (const input of [
      postToolUse(mine, FRESHNESS_HOOK_COMMAND),
      postToolUse(FRESHNESS_HOOK_COMMAND, mine),
    ]) {
      const r = ensureFreshnessHook(input);
      expect(r.added).toBe(true);
      expect(r.replaced).toEqual([FRESHNESS_HOOK_COMMAND]);
      expect(commandsOf(r.settings)).toEqual([mine]);
    }
  });

  it('an explicit --hook-command still replaces a custom (unchained) command', () => {
    const asked = 'node ./apps/cli/dist/cli.js analyze --minimal';
    const r = ensureFreshnessHook(postToolUse(mine), asked);
    expect(r.replaced).toEqual([mine]);
    expect(r.command).toBe(asked);
    expect(commandsOf(r.settings)).toEqual([asked]);
  });

  it('on disk: install and setup-agents defaults leave the chained command byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      const p = join(dir, '.claude', 'settings.local.json');
      const before = JSON.stringify(postToolUse(chained), null, 2) + '\n';
      writeFileSync(p, before);
      const r = installFreshnessHook(dir);
      expect(r.added).toBe(false);
      expect(r.explicit).toBe(false);
      expect(r.kept).toEqual([chained]);
      expect(readFileSync(p, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* R7: identical duplicates were deduped in memory but `added` stayed false,
   so the file was never rewritten and both analyzes kept running. */
describe('duplicate freshness hooks are written back as one (R7)', () => {
  it.each([[FRESHNESS_HOOK_COMMAND], ['pnpm exec factstack analyze --minimal']])(
    'two identical %s entries become one on disk',
    (cmd) => {
      const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
      try {
        mkdirSync(join(dir, '.claude'), { recursive: true });
        const p = join(dir, '.claude', 'settings.local.json');
        writeFileSync(
          p,
          JSON.stringify({
            hooks: {
              PostToolUse: [
                { matcher: 'Edit|Write', hooks: [{ type: 'command', command: cmd }] },
                { matcher: 'Edit|Write', hooks: [{ type: 'command', command: cmd }] },
              ],
            },
          }),
        );
        const r = installFreshnessHook(dir);
        expect(r.added).toBe(true);
        expect(r.removed).toEqual([cmd]);
        const onDisk = JSON.parse(readFileSync(p, 'utf8')) as ClaudeSettings;
        expect(commandsOf(onDisk)).toEqual([cmd]);
        expect(onDisk.hooks!.PostToolUse).toHaveLength(1);
        expect(installFreshnessHook(dir).added).toBe(false); // now a no-op
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('uninstall removes the freshness hook', () => {
  it('drops only FACTS commands (pure)', () => {
    const input = {
      model: 'opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'x' }] }],
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command' as const, command: FRESHNESS_HOOK_COMMAND }],
          },
          { matcher: 'Read', hooks: [{ type: 'command' as const, command: 'echo read' }] },
        ],
      },
    };
    const { settings, removed } = removeFreshnessHook(input);
    expect(removed).toEqual([FRESHNESS_HOOK_COMMAND]);
    expect(settings.hooks!.PostToolUse).toEqual([input.hooks.PostToolUse[1]]);
    expect(settings.hooks!.PreToolUse).toEqual(input.hooks.PreToolUse);
    expect((settings as { model?: string }).model).toBe('opus');
    // Only-ours → the hooks key disappears entirely.
    const only = removeFreshnessHook(ensureFreshnessHook({}).settings);
    expect(only.settings).toEqual({});
  });

  it("leaves a user's look-alike script and a chained command (R6, R3)", () => {
    const own = 'node scripts/factstack-analyze-report.js';
    const chained = 'pnpm exec factstack analyze --minimal && pnpm test';
    const r = removeFreshnessHook(postToolUse(own, chained, FRESHNESS_HOOK_COMMAND));
    expect(r.removed).toEqual([FRESHNESS_HOOK_COMMAND]);
    expect(r.kept).toEqual([chained]);
    expect(commandsOf(r.settings)).toEqual([own, chained]);
  });

  it('round-trips on disk and is a no-op without a hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      expect(uninstallFreshnessHook(dir).removed).toEqual([]); // no file
      installFreshnessHook(dir);
      const r = uninstallFreshnessHook(dir);
      expect(r.removed).toEqual([FRESHNESS_HOOK_COMMAND]);
      expect(JSON.parse(readFileSync(r.settingsPath, 'utf8'))).toEqual({});
      expect(uninstallFreshnessHook(dir).removed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* CLI-10: the file is "personal, gitignored" only if something ignores it —
   on a stock machine nothing did, so `git add -A` committed the hook. */
describe('ensureGitIgnored', () => {
  const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync('git', args, { cwd, env, encoding: 'utf8' });

  it('adds the settings file to .gitignore when git does not ignore it, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      const env = hermeticGitEnv(dir);
      git(dir, env, 'init', '-q');
      writeFileSync(join(dir, '.gitignore'), 'node_modules/');
      expect(ensureGitIgnored(dir, '.claude/settings.local.json', env)).toBe('added');
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
        'node_modules/\n\n# FACTS freshness hook — personal Claude Code settings\n/.claude/settings.local.json\n',
      );
      expect(
        git(dir, env, 'check-ignore', '-q', '--no-index', '.claude/settings.local.json').status,
      ).toBe(0);
      expect(ensureGitIgnored(dir, '.claude/settings.local.json', env)).toBe('ignored');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      const env = { ...hermeticGitEnv(dir), GIT_CEILING_DIRECTORIES: tmpdir() };
      expect(ensureGitIgnored(dir, '.claude/settings.local.json', env)).toBe('skipped');
      expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installFreshnessHook reports the .gitignore it added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      const env = hermeticGitEnv(dir);
      git(dir, env, 'init', '-q');
      expect(installFreshnessHook(dir, undefined, { env }).gitignore).toBe('added');
      expect(installFreshnessHook(dir, undefined, { env }).gitignore).toBe('ignored');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('launch name (owner decision 2026-09-24: keep npx, one name)', () => {
  it('the hook command derives from hookCliLaunch over @factstack/spec', () => {
    expect(FRESHNESS_HOOK_COMMAND).toBe(`${hookCliLaunch()} analyze --minimal`);
    expect(FRESHNESS_HOOK_COMMAND).not.toMatch(/@factstack\/cli/);
    // Once the owner publishes the name, the launch is spec's CLI_NPX.
    expect(hookCliLaunch(true)).toBe(CLI_NPX);
  });
});

/* A hook never runs on a TTY, and off a TTY `npx` assumes --yes. While
   the `factstack` name is unclaimed on npm, `npx factstack` in a hook would
   fetch and run whatever package someone registers under it. */
describe('hooks never download the unpublished CLI', () => {
  it('while unpublished, the launch fails instead of fetching from npm', () => {
    expect(hookCliLaunch(false)).toBe(`npm exec --no -- ${CLI_NPM_PACKAGE}`);
    if (!CLI_PUBLISHED) {
      expect(FRESHNESS_HOOK_COMMAND).toBe('npm exec --no -- factstack analyze --minimal');
      expect(FRESHNESS_HOOK_COMMAND).not.toMatch(/^npx\b/);
    }
  });

  it('the no-download launch is still a FACTS freshness command, and an installer default', () => {
    const cmd = `${hookCliLaunch(false)} analyze --minimal`;
    expect(isFreshnessCommand(cmd)).toBe(true);
    expect(isKnownDefaultCommand(cmd)).toBe(true);
    expect(isKnownDefaultCommand(`${hookCliLaunch(true)} analyze --minimal`)).toBe(true);
  });

  it('a re-install migrates an earlier `npx factstack` default to the current one', () => {
    const r = ensureFreshnessHook(postToolUse('npx factstack analyze --minimal'));
    expect(commandsOf(r.settings)).toEqual([FRESHNESS_HOOK_COMMAND]);
    if (!CLI_PUBLISHED) expect(r.replaced).toEqual(['npx factstack analyze --minimal']);
  });

  it('hookLaunchNote flags the unpublished launch, and an npx one louder', () => {
    const local = hookLaunchNote(`${hookCliLaunch(false)} analyze --minimal`, '<how>', false);
    expect(local).toMatch(/not on npm yet.*never downloads.*<how>/);
    for (const c of ['npx factstack analyze --minimal', 'npx -y factstack@latest analyze']) {
      expect(hookLaunchNote(c, '<how>', false), c).toMatch(/would fetch and run.*<how>/);
    }
    // Any other command, and everything once published: no note.
    expect(hookLaunchNote('pnpm exec factstack analyze --minimal', '<how>', false)).toBeUndefined();
    expect(hookLaunchNote('npx factstack-analyze', '<how>', false)).toBeUndefined();
    expect(hookLaunchNote(FRESHNESS_HOOK_COMMAND, '<how>', true)).toBeUndefined();
  });
});

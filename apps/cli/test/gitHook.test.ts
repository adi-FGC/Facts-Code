/**
 * Tests for the F8 git post-commit hook installer.
 *
 * Load-bearing logic is the pure merge/strip (`ensureGitHook` / `stripGitHook`):
 * idempotency + non-destructive preservation of any pre-existing hook. The
 * fs-level tests run against REAL git repos (worktrees, core.hooksPath, a
 * commit that fires the hook); the `.git`-pointer fallback is tested alone.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_NPX, CLI_PUBLISHED } from '@factstack/spec';
import { hookCliLaunch } from '../src/agentHook.js';
import {
  factstackGitHookBlock,
  gitHookLine,
  ensureGitHook,
  endsWithExit,
  stripGitHook,
  resolveHooks,
  resolveHooksDir,
  resolveHooksDirFromDotGit,
  installGitHook,
  uninstallGitHook,
  GitHookRefusal,
  GIT_HOOK_COMMAND,
} from '../src/gitHook.js';

/* The real-repo tests spawn ~16-22 git processes each, and process spawns are
   5-10x slower on the Windows CI runner. vitest's 5 s default measures the
   runner, not the code (same budget as the fs-node git suites). */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MARKER_START = '# >>> factstack post-commit (auto-refresh .facts) >>>';
const MARKER_END = '# <<< factstack post-commit <<<';

/* Real git, hermetic: no global/system config (a personal core.hooksPath or
   template dir must not steer where these tests write), and discovery never
   climbs above the temp dir. installGitHook reads process.env, so it is
   pinned for this file (vitest isolates files) and restored after. */
const PINNED = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES'] as const;
const saved: Record<string, string | undefined> = {};
let gitHome = '';
beforeAll(() => {
  gitHome = mkdtempSync(join(tmpdir(), 'facts-githome-'));
  const cfg = join(gitHome, 'gitconfig');
  writeFileSync(
    cfg,
    '[user]\n\tname = FACTS test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n',
  );
  for (const k of PINNED) saved[k] = process.env[k];
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(tmpdir());
});
afterAll(() => {
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(gitHome, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A real repo with one commit, at its canonical path (macOS /var → /private/var,
 *  Windows 8.3 short names → long) — the form git reports. */
function realRepo(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'facts-git-')));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('factstackGitHookBlock (pure)', () => {
  it('embeds the command, the repo-root target, and the never-block guard', () => {
    const block = factstackGitHookBlock(GIT_HOOK_COMMAND);
    expect(block).toContain(MARKER_START);
    expect(block).toContain(MARKER_END);
    expect(block).toContain(`${GIT_HOOK_COMMAND} . >/dev/null 2>&1 || true`);
  });

  it('honors a custom command', () => {
    const cmd = 'npx tsx apps/cli/src/cli.ts analyze';
    expect(factstackGitHookBlock(cmd)).toContain(`${cmd} . >/dev/null 2>&1 || true`);
  });
});

describe('ensureGitHook (pure merge)', () => {
  it('creates a fresh sh hook from empty/null input', () => {
    const out = ensureGitHook(null);
    expect(out.startsWith('#!/bin/sh\n')).toBe(true);
    expect(out).toContain(MARKER_START);
    expect(out).toContain(GIT_HOOK_COMMAND);
    // Same for empty string.
    expect(ensureGitHook('')).toBe(out);
    expect(ensureGitHook('   \n ')).toBe(out);
  });

  it('is idempotent — re-running yields byte-identical content', () => {
    const first = ensureGitHook(null);
    const second = ensureGitHook(first);
    expect(second).toBe(first);
  });

  it('replaces an existing factstack block in place, preserving surroundings', () => {
    const existing =
      '#!/bin/sh\n' +
      'echo "pre-existing CI notifier"\n' +
      factstackGitHookBlock('OLD-COMMAND') +
      '\n' +
      'echo "trailing user logic"\n';
    const out = ensureGitHook(existing, 'npx factstack analyze');
    // Old command gone, new command present, exactly one block.
    expect(out).not.toContain('OLD-COMMAND');
    expect(out).toContain('npx factstack analyze . >/dev/null 2>&1 || true');
    // Exactly one block (literal count — MARKER_START has regex metachars).
    expect(out.split(MARKER_START).length - 1).toBe(1);
    // User's surrounding logic preserved.
    expect(out).toContain('echo "pre-existing CI notifier"');
    expect(out).toContain('echo "trailing user logic"');
  });

  it('appends to a pre-existing hook that has no factstack block', () => {
    const existing = '#!/bin/sh\necho "lint on commit"\n';
    const out = ensureGitHook(existing);
    expect(out).toContain('echo "lint on commit"');
    expect(out).toContain(MARKER_START);
    // The user's line comes first; our block after.
    expect(out.indexOf('lint on commit')).toBeLessThan(out.indexOf(MARKER_START));
  });

  it('adds a shebang when an existing hook lacks one', () => {
    const out = ensureGitHook('echo no-shebang\n');
    expect(out.startsWith('#!/bin/sh\n')).toBe(true);
    expect(out).toContain('echo no-shebang');
  });
});

describe('stripGitHook (pure removal)', () => {
  it('signals full delete when only our block remains', () => {
    const onlyOurs = ensureGitHook(null);
    const { content, removed } = stripGitHook(onlyOurs);
    expect(removed).toBe(true);
    expect(content).toBeNull();
  });

  it('preserves other hook logic, removing only our block', () => {
    const existing = '#!/bin/sh\necho keep-me\n' + factstackGitHookBlock() + '\n';
    const { content, removed } = stripGitHook(existing);
    expect(removed).toBe(true);
    expect(content).toContain('echo keep-me');
    expect(content).not.toContain(MARKER_START);
  });

  it('is a no-op when no factstack block is present', () => {
    const existing = '#!/bin/sh\necho unrelated\n';
    const { content, removed } = stripGitHook(existing);
    expect(removed).toBe(false);
    expect(content).toBe(existing);
  });
});

describe('resolveHooksDirFromDotGit (fallback without git)', () => {
  it('resolves a .git directory to <root>/.git/hooks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    try {
      mkdirSync(join(dir, '.git'), { recursive: true });
      expect(resolveHooksDirFromDotGit(dir)).toBe(join(dir, '.git', 'hooks'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('follows a .git pointer file (submodule)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    try {
      const realGit = join(dir, 'realgit');
      mkdirSync(realGit, { recursive: true });
      writeFileSync(join(dir, '.git'), `gitdir: ${realGit}\n`);
      expect(resolveHooksDirFromDotGit(dir)).toBe(join(realGit, 'hooks'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows a linked worktree's commondir to the SHARED hooks dir", () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    try {
      const wtGit = join(dir, 'main', '.git', 'worktrees', 'wt');
      mkdirSync(wtGit, { recursive: true });
      writeFileSync(join(wtGit, 'commondir'), '../..\n');
      writeFileSync(join(dir, '.git'), `gitdir: ${wtGit}\n`);
      expect(resolveHooksDirFromDotGit(dir)).toBe(join(dir, 'main', '.git', 'hooks'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    try {
      expect(() => resolveHooksDirFromDotGit(dir)).toThrow(/not a git repository/);
      expect(() => resolveHooksDir(dir)).toThrow(/not a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* CLI-04: the hook used to land in <main>/.git/worktrees/<name>/hooks (never
   run — git runs the COMMON dir's hooks) and ignored core.hooksPath, while
   the CLI printed "installed". */
describe('resolveHooks asks git where hooks run (CLI-04)', () => {
  it('a linked worktree installs into the common hooks dir — and the hook RUNS', () => {
    const main = realRepo();
    const wt = realpathSync.native(mkdtempSync(join(tmpdir(), 'facts-wt-')));
    rmSync(wt, { recursive: true, force: true });
    try {
      git(main, 'worktree', 'add', '-q', wt, '-b', 'feature');
      const r = installGitHook(wt, 'touch hook-ran');
      expect(r.hookPath).toBe(join(main, '.git', 'hooks', 'post-commit'));
      writeFileSync(join(wt, 'b.txt'), 'b\n');
      git(wt, 'add', 'b.txt');
      git(wt, 'commit', '-q', '-m', 'second');
      expect(existsSync(join(wt, 'hook-ran'))).toBe(true); // git ran it from the worktree
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('installs from a subdirectory into the repo hooks', () => {
    const repo = realRepo();
    try {
      mkdirSync(join(repo, 'pkg', 'sub'), { recursive: true });
      expect(installGitHook(join(repo, 'pkg', 'sub')).hookPath).toBe(
        join(repo, '.git', 'hooks', 'post-commit'),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('honours core.hooksPath and says so', () => {
    const repo = realRepo();
    try {
      git(repo, 'config', 'core.hooksPath', '.githooks');
      const info = resolveHooks(repo);
      expect(info.dir).toBe(join(repo, '.githooks'));
      expect(info.note).toMatch(/core\.hooksPath/);
      expect(installGitHook(repo, undefined, { shared: true }).hookPath).toBe(
        join(repo, '.githooks', 'post-commit'),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('husky 9 (core.hooksPath=.husky/_) installs into .husky/post-commit', () => {
    const repo = realRepo();
    try {
      git(repo, 'config', 'core.hooksPath', '.husky/_');
      const r = installGitHook(repo, undefined, { shared: true });
      expect(r.hookPath).toBe(join(repo, '.husky', 'post-commit'));
      expect(r.note).toMatch(/husky/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/* R2: the CLI-04 fix followed core.hooksPath wherever it pointed — into a
   GLOBAL hooks dir (the hook then ran `npx factstack analyze` in every repo
   on the machine) or a committed .husky/ / .githooks/ file (every teammate).
   Such a dir now needs an explicit opt-in; the refusal prints the line. */
describe('a shared hooks dir needs --shared (R2)', () => {
  /** git env whose GLOBAL config sets core.hooksPath (a machine-wide dir). */
  function globalHooksEnv(): { env: NodeJS.ProcessEnv; globalHooks: string; cfgDir: string } {
    const cfgDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'facts-globalcfg-')));
    const globalHooks = join(cfgDir, 'globalhooks');
    const cfg = join(cfgDir, 'gitconfig');
    writeFileSync(
      cfg,
      readFileSync(process.env.GIT_CONFIG_GLOBAL!, 'utf8') +
        `[core]\n\thooksPath = ${globalHooks.replaceAll('\\', '/')}\n`,
    );
    return { env: { ...process.env, GIT_CONFIG_GLOBAL: cfg }, globalHooks, cfgDir };
  }

  it('refuses a GLOBAL core.hooksPath, writes nothing, and prints the line', () => {
    const repo = realRepo();
    const { env, globalHooks, cfgDir } = globalHooksEnv();
    try {
      const info = resolveHooks(repo, env);
      expect(info.dir).toBe(globalHooks);
      expect(info.shared).toMatch(/global git config.*every repository on this machine/);
      let err: unknown;
      try {
        installGitHook(repo, 'npx factstack analyze', { env });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(GitHookRefusal);
      expect((err as Error).message).toContain('--shared');
      expect((err as Error).message).toContain('npx factstack analyze . >/dev/null 2>&1 || true');
      expect(existsSync(join(globalHooks, 'post-commit'))).toBe(false);
      expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it('installs into the global dir only with shared: true, and uninstall mirrors it', () => {
    const repo = realRepo();
    const { env, globalHooks, cfgDir } = globalHooksEnv();
    try {
      const r = installGitHook(repo, 'npx factstack analyze', { env, shared: true });
      expect(r.hookPath).toBe(join(globalHooks, 'post-commit'));
      expect(r.shared).toMatch(/every repository/);
      expect(() => uninstallGitHook(repo, { env })).toThrow(/--shared/);
      expect(existsSync(r.hookPath)).toBe(true); // refused: left alone
      expect(uninstallGitHook(repo, { env, shared: true }).changed).toBe(true);
      expect(existsSync(r.hookPath)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it.each([['.githooks'], ['.husky/_']])(
    'refuses an in-tree hooks dir (core.hooksPath=%s) that teammates would share',
    (hooksPath) => {
      const repo = realRepo();
      try {
        git(repo, 'config', 'core.hooksPath', hooksPath);
        expect(resolveHooks(repo).shared).toMatch(/inside the work tree.*every teammate/);
        expect(() => installGitHook(repo)).toThrow(GitHookRefusal);
        expect(existsSync(join(repo, '.githooks', 'post-commit'))).toBe(false);
        expect(existsSync(join(repo, '.husky', 'post-commit'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it('an in-tree hooks dir git ignores, or one inside .git, stays personal', () => {
    const repo = realRepo();
    try {
      git(repo, 'config', 'core.hooksPath', '.myhooks');
      writeFileSync(join(repo, '.gitignore'), '/.myhooks/\n');
      expect(resolveHooks(repo).shared).toBeUndefined();
      expect(installGitHook(repo).hookPath).toBe(join(repo, '.myhooks', 'post-commit'));

      git(repo, 'config', 'core.hooksPath', '.git/hooks');
      expect(resolveHooks(repo).shared).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a repo-local core.hooksPath outside the work tree is allowed', () => {
    const repo = realRepo();
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'facts-hooks-')));
    try {
      git(repo, 'config', 'core.hooksPath', elsewhere.replaceAll('\\', '/'));
      const r = installGitHook(repo);
      expect(r.hookPath).toBe(join(elsewhere, 'post-commit'));
      expect(r.shared).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

/* CLI-05: appending a sh line to a node/python hook broke the user's hook. */
describe('ensureGitHook refuses hooks it cannot safely extend (CLI-05)', () => {
  it.each([
    ['#!/usr/bin/env node\nrequire("fs").writeFileSync("x", "1");\n'],
    ['#!/usr/bin/python3\nprint("hi")\n'],
    ['#!/usr/bin/env pwsh\nWrite-Host hi\n'],
  ])('refuses a non-sh hook: %s', (hook) => {
    expect(() => ensureGitHook(hook)).toThrow(GitHookRefusal);
  });

  it.each([
    ['#!/bin/sh\necho a\n'],
    ['#!/bin/bash\necho a\n'],
    ['#!/usr/bin/env bash\necho a\n'],
    ['#!/usr/bin/env zsh\necho a\n'],
  ])('extends a sh-family hook: %s', (hook) => {
    expect(ensureGitHook(hook)).toContain(MARKER_START);
  });

  it('refuses a start marker with no end marker instead of truncating', () => {
    const mangled = `#!/bin/sh\n${MARKER_START}\nnpx factstack analyze .\necho "user logic after"\n`;
    expect(() => ensureGitHook(mangled)).toThrow(/no end marker/);
  });

  it('flags a hook whose own logic ends in exit (the block would never run)', () => {
    expect(endsWithExit(ensureGitHook('#!/bin/sh\necho a\nexit 0\n'))).toBe(true);
    expect(endsWithExit(ensureGitHook('#!/bin/sh\necho a\n'))).toBe(false);
    expect(endsWithExit(ensureGitHook(null))).toBe(false);
  });

  it('install leaves a refused hook byte-identical', () => {
    const repo = realRepo();
    try {
      const hookPath = join(repo, '.git', 'hooks', 'post-commit');
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
      const node = '#!/usr/bin/env node\nconsole.log(1)\n';
      writeFileSync(hookPath, node);
      expect(() => installGitHook(repo)).toThrow(GitHookRefusal);
      expect(readFileSync(hookPath, 'utf8')).toBe(node);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('launch name (owner decision 2026-09-24: keep npx, one name)', () => {
  it('the default hook command derives from the shared hook launch', () => {
    expect(GIT_HOOK_COMMAND).toBe(`${hookCliLaunch()} analyze`);
  });

  /* Git runs hooks with no stdin TTY, so `npx` would install whatever
     package claims the unpublished `factstack` name, on every commit. */
  it('while unpublished, the post-commit hook never downloads', () => {
    if (CLI_PUBLISHED) {
      expect(GIT_HOOK_COMMAND).toBe(`${CLI_NPX} analyze`);
      return;
    }
    expect(GIT_HOOK_COMMAND).toBe('npm exec --no -- factstack analyze');
    expect(gitHookLine()).toBe('npm exec --no -- factstack analyze . >/dev/null 2>&1 || true');
    expect(GIT_HOOK_COMMAND).not.toMatch(/^npx\b/);
  });
});

describe('installGitHook / uninstallGitHook (fs round-trip)', () => {
  const fakeRepo = realRepo;

  it('installs post-commit, idempotently', () => {
    const dir = fakeRepo();
    try {
      const r1 = installGitHook(dir);
      expect(r1.changed).toBe(true);
      expect(r1.hookPath.endsWith(join('.git', 'hooks', 'post-commit'))).toBe(true);
      expect(existsSync(r1.hookPath)).toBe(true);
      expect(readFileSync(r1.hookPath, 'utf8')).toContain(
        `${GIT_HOOK_COMMAND} . >/dev/null 2>&1 || true`,
      );

      const r2 = installGitHook(dir);
      expect(r2.changed).toBe(false); // byte-identical → no rewrite
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a pre-existing post-commit hook', () => {
    const dir = fakeRepo();
    try {
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(dir, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho "my notifier"\n');
      const r = installGitHook(dir);
      expect(r.changed).toBe(true);
      const content = readFileSync(r.hookPath, 'utf8');
      expect(content).toContain('echo "my notifier"'); // preserved
      expect(content).toContain(MARKER_START);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('embeds a custom command', () => {
    const dir = fakeRepo();
    try {
      const cmd = 'pnpm exec factstack analyze';
      const r = installGitHook(dir, cmd);
      expect(r.command).toBe(cmd);
      expect(readFileSync(r.hookPath, 'utf8')).toContain(`${cmd} . >/dev/null 2>&1 || true`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when target is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    try {
      expect(() => installGitHook(dir)).toThrow(/not a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uninstall deletes a factstack-only hook', () => {
    const dir = fakeRepo();
    try {
      const r1 = installGitHook(dir);
      expect(existsSync(r1.hookPath)).toBe(true);
      const r2 = uninstallGitHook(dir);
      expect(r2.changed).toBe(true);
      expect(existsSync(r2.hookPath)).toBe(false); // file removed entirely
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uninstall keeps other hook logic, removing only our block', () => {
    const dir = fakeRepo();
    try {
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(dir, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho keep\n');
      installGitHook(dir);
      const r = uninstallGitHook(dir);
      expect(r.changed).toBe(true);
      const content = readFileSync(r.hookPath, 'utf8');
      expect(content).toContain('echo keep');
      expect(content).not.toContain(MARKER_START);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uninstall is a no-op when there is no hook', () => {
    const dir = fakeRepo();
    try {
      const r = uninstallGitHook(dir);
      expect(r.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

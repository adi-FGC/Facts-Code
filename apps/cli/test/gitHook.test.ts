/**
 * Tests for the F8 git post-commit hook installer.
 *
 * Load-bearing logic is the pure merge/strip (`ensureGitHook` / `stripGitHook`):
 * idempotency + non-destructive preservation of any pre-existing hook. A few
 * fs-level tests prove the read/merge/write round-trip + `.git`-pointer
 * resolution against a temp "repo".
 */

import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  factstackGitHookBlock,
  ensureGitHook,
  stripGitHook,
  resolveHooksDir,
  installGitHook,
  uninstallGitHook,
  GIT_HOOK_COMMAND,
} from '../src/gitHook.js';

const MARKER_START = '# >>> factstack post-commit (auto-refresh .facts) >>>';
const MARKER_END = '# <<< factstack post-commit <<<';

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
      factstackGitHookBlock('OLD-COMMAND') + '\n' +
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
    const existing =
      '#!/bin/sh\necho keep-me\n' + factstackGitHookBlock() + '\n';
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

describe('resolveHooksDir', () => {
  it('resolves a .git directory to <root>/.git/hooks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    try {
      mkdirSync(join(dir, '.git'), { recursive: true });
      expect(resolveHooksDir(dir)).toBe(join(dir, '.git', 'hooks'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('follows a .git pointer file (worktree/submodule)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    try {
      const realGit = join(dir, 'realgit');
      mkdirSync(realGit, { recursive: true });
      writeFileSync(join(dir, '.git'), `gitdir: ${realGit}\n`);
      expect(resolveHooksDir(dir)).toBe(join(realGit, 'hooks'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    try {
      expect(() => resolveHooksDir(dir)).toThrow(/not a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installGitHook / uninstallGitHook (fs round-trip)', () => {
  function fakeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'facts-git-'));
    mkdirSync(join(dir, '.git'), { recursive: true });
    return dir;
  }

  it('installs post-commit, idempotently', () => {
    const dir = fakeRepo();
    try {
      const r1 = installGitHook(dir);
      expect(r1.changed).toBe(true);
      expect(r1.hookPath.endsWith(join('.git', 'hooks', 'post-commit'))).toBe(true);
      expect(existsSync(r1.hookPath)).toBe(true);
      expect(readFileSync(r1.hookPath, 'utf8')).toContain('npx factstack analyze . >/dev/null 2>&1 || true');

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

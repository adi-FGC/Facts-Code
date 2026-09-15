/**
 * gitGlobalExcludes — the Node-side lookup of the rules git applies from
 * outside a repository's tracked files: `core.excludesFile` and
 * `.git/info/exclude`.
 *
 * Hermetic by construction: the function under test spawns git with the
 * INHERITED environment, so `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` are
 * pinned on `process.env` for the whole file (a previous version pinned them
 * only for the test's own git calls and therefore read — and failed on — the
 * developer's real global config).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitGlobalExcludes } from '../src/global-excludes.js';

const NUL = process.platform === 'win32' ? 'NUL' : '/dev/null';
const saved: Record<string, string | undefined> = {};
let tmp = '';
let repo = '';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
/** Forward slashes: git config values are POSIX-ish even on Windows. */
const cfgPath = (p: string): string => p.replace(/\\/g, '/');

beforeAll(() => {
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'XDG_CONFIG_HOME'])
    saved[k] = process.env[k];
  process.env['GIT_CONFIG_GLOBAL'] = NUL;
  process.env['GIT_CONFIG_SYSTEM'] = NUL;
  delete process.env['XDG_CONFIG_HOME'];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-node-excludes-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
});
afterEach(() => {
  try {
    git(repo, 'config', '--unset', 'core.excludesFile');
  } catch {
    /* not set */
  }
  fs.rmSync(path.join(repo, '.git', 'info', 'exclude'), { force: true });
  delete process.env['XDG_CONFIG_HOME'];
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('gitGlobalExcludes', () => {
  it('returns the lines of the configured core.excludesFile', () => {
    const ex = path.join(tmp, 'global-ignore');
    fs.writeFileSync(ex, '# personal\n\n.claude/settings.local.json\n*.local.md\n');
    git(repo, 'config', 'core.excludesFile', cfgPath(ex));
    const lines = gitGlobalExcludes(repo);
    expect(lines).toContain('.claude/settings.local.json');
    expect(lines).toContain('*.local.md');
    // Comments and blanks pass through; the walker's parser drops them.
    expect(lines.some((l) => l.startsWith('#'))).toBe(true);
  });

  it('splits CRLF files without leaving carriage returns in the rules', () => {
    const ex = path.join(tmp, 'crlf-ignore');
    fs.writeFileSync(ex, 'one.md\r\ntwo.md\r\n');
    git(repo, 'config', 'core.excludesFile', cfgPath(ex));
    const lines = gitGlobalExcludes(repo);
    expect(lines).toContain('one.md');
    expect(lines).toContain('two.md');
    expect(lines.some((l) => l.includes('\r'))).toBe(false);
  });

  it('also applies .git/info/exclude, after the global file', () => {
    const ex = path.join(tmp, 'g2');
    fs.writeFileSync(ex, 'from-global.md\n');
    git(repo, 'config', 'core.excludesFile', cfgPath(ex));
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'from-info-exclude.md\n');
    const lines = gitGlobalExcludes(repo);
    expect(lines).toContain('from-global.md');
    expect(lines).toContain('from-info-exclude.md');
    expect(lines.indexOf('from-global.md')).toBeLessThan(lines.indexOf('from-info-exclude.md'));
  });

  it('returns [] when the configured file does not exist (git does not fall back)', () => {
    git(repo, 'config', 'core.excludesFile', cfgPath(path.join(tmp, 'does-not-exist')));
    expect(gitGlobalExcludes(repo)).toEqual([]);
  });

  it('treats an existing but empty file as no rules', () => {
    const ex = path.join(tmp, 'empty-ignore');
    fs.writeFileSync(ex, '');
    git(repo, 'config', 'core.excludesFile', cfgPath(ex));
    expect(gitGlobalExcludes(repo)).toEqual([]);
  });

  it('resolves a relative core.excludesFile against the repository, not the cwd', () => {
    fs.writeFileSync(path.join(repo, 'repo-relative-ignore'), 'relative-hit.md\n');
    git(repo, 'config', 'core.excludesFile', 'repo-relative-ignore');
    const here = process.cwd();
    process.chdir(os.tmpdir()); // a cwd that is NOT the repo
    try {
      expect(gitGlobalExcludes(repo)).toContain('relative-hit.md');
    } finally {
      process.chdir(here);
    }
  });

  it('expands a ~ path and ignores the unportable ~user form', () => {
    const marker = `.factstack-tilde-test-${process.pid}`;
    const inHome = path.join(os.homedir(), marker);
    fs.writeFileSync(inHome, 'tilde-hit.md\n');
    try {
      git(repo, 'config', 'core.excludesFile', `~/${marker}`);
      expect(gitGlobalExcludes(repo)).toContain('tilde-hit.md');
      git(repo, 'config', 'core.excludesFile', `~someone/${marker}`);
      expect(gitGlobalExcludes(repo)).toEqual([]);
    } finally {
      fs.rmSync(inHome, { force: true });
    }
  });

  it('falls back to XDG_CONFIG_HOME/git/ignore when nothing is configured', () => {
    const xdg = path.join(tmp, 'xdg');
    fs.mkdirSync(path.join(xdg, 'git'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'git', 'ignore'), 'from-xdg.md\n');
    process.env['XDG_CONFIG_HOME'] = xdg;
    expect(gitGlobalExcludes(repo)).toContain('from-xdg.md');
  });

  it('returns [] outside a git repository, and never throws', () => {
    const plain = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    expect(() => gitGlobalExcludes(plain)).not.toThrow();
    expect(gitGlobalExcludes(plain)).toEqual([]);
    expect(gitGlobalExcludes(path.join(tmp, 'does-not-exist-at-all'))).toEqual([]);
  });

  it('caps a pathological excludes file instead of reading it whole', () => {
    const ex = path.join(tmp, 'huge-ignore');
    const body = Array.from({ length: 40_000 }, (_, i) => `rule-${i}.md`).join('\n'); // > 256 KB
    fs.writeFileSync(ex, body);
    git(repo, 'config', 'core.excludesFile', cfgPath(ex));
    const lines = gitGlobalExcludes(repo);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(40_000);
    expect(lines).toContain('rule-0.md');
    // The truncated tail is dropped rather than turned into a half rule.
    expect(lines.every((l) => /^rule-\d+\.md$/.test(l))).toBe(true);
  });
});

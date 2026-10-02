/**
 * mineGitStats keys must match the walker's paths, which are relative to the
 * ANALYZED root — not to the repo top-level. Analyzing a subdirectory of a
 * repo (`factstack analyze packages/x`) used to key every file as
 * `packages/x/src/…`, so no walker path matched: every file fell back to fs
 * mtime and churn/authors/topContributors came out empty while
 * project.gitAvailable still said true.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mineGitStats } from '../src/git.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fs-node test',
  GIT_AUTHOR_EMAIL: 'test@factstack.invalid',
  GIT_COMMITTER_NAME: 'fs-node test',
  GIT_COMMITTER_EMAIL: 'test@factstack.invalid',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}
const write = (p: string, body: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

let repo = '';
beforeAll(() => {
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-node-git-')));
  git(repo, 'init', '-q');
  write(path.join(repo, 'README.md'), '# root\n');
  write(path.join(repo, 'packages', 'x', 'src', 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  write(path.join(repo, 'packages', 'x', 'src', 'a.ts'), 'export const a = 2;\n');
  git(repo, 'commit', '-q', '-am', 'bump a');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('mineGitStats — keys relative to the analyzed root', () => {
  it('keys files by the repo-relative path at the top level', () => {
    const stats = mineGitStats(repo);
    expect(stats.get('packages/x/src/a.ts')?.churnScore).toBe(2);
    expect(stats.has('README.md')).toBe(true);
  });

  it('keys files relative to a SUBDIRECTORY root, and only mines that subtree', () => {
    const stats = mineGitStats(path.join(repo, 'packages', 'x'));
    expect([...stats.keys()]).toEqual(['src/a.ts']);
    const a = stats.get('src/a.ts')!;
    expect(a.churnScore).toBe(2);
    expect(a.authorCount).toBe(1);
    expect(a.topContributors[0]?.email).toBe('test@factstack.invalid');
  });
});

describe('mineGitStats — uncommitted edits carry their real mtime (HUNT-CORE-03)', () => {
  /* core prefers the git time over fs mtime, so a file edited but not
     committed used to keep its old COMMIT time and `since` never saw the
     edit. Commits here are backdated (inside the 180-day log window) so an
     edit's mtime is clearly later than its commit. */
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (ms: number): string => new Date(ms).toISOString();
  let dirty = '';
  let commitMs = 0;
  const editedMs = Date.now() - DAY; // what utimes stamps on the edited files
  const gitAt = (cwd: string, at: number, ...args: string[]): void => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...ENV, GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  const touch = (rel: string, body: string): void => {
    const p = path.join(dirty, ...rel.split('/'));
    write(p, body);
    fs.utimesSync(p, editedMs / 1000, editedMs / 1000);
  };

  beforeAll(() => {
    dirty = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-node-dirty-')));
    commitMs = Math.floor((Date.now() - 10 * DAY) / 1000) * 1000; // git keeps whole seconds
    git(dirty, 'init', '-q');
    for (const f of ['clean.ts', 'edited.ts', 'staged.ts', 'gone.ts', 'pkg/sub/deep.ts']) {
      write(path.join(dirty, ...f.split('/')), `export const v = '${f}';\n`);
    }
    git(dirty, 'add', '-A');
    gitAt(dirty, commitMs, 'commit', '-q', '-m', 'init');
    gitAt(dirty, commitMs + 1000, 'rm', '-q', 'gone.ts');
    gitAt(dirty, commitMs + 1000, 'commit', '-q', '-m', 'drop gone');

    touch('edited.ts', 'export const v = 2;\n'); // modified, unstaged
    touch('staged.ts', 'export const v = 3;\n');
    git(dirty, 'add', 'staged.ts'); // modified, staged
    touch('gone.ts', 'back again\n'); // untracked, but has history
    touch('pkg/sub/deep.ts', 'export const v = 4;\n');
  });
  afterAll(() => fs.rmSync(dirty, { recursive: true, force: true }));

  it('uses the real mtime for modified, staged and re-created untracked files', () => {
    const stats = mineGitStats(dirty);
    const mtime = (rel: string): number => fs.statSync(path.join(dirty, rel)).mtimeMs;
    for (const rel of ['edited.ts', 'staged.ts', 'gone.ts']) {
      expect(stats.get(rel)!.lastModifiedMs).toBe(mtime(rel));
      expect(stats.get(rel)!.lastModifiedMs).toBeGreaterThan(commitMs + 1000);
    }
    // A clean file keeps its commit time even though its fs mtime is newer
    // (that is clone/checkout time, not authoring time).
    expect(stats.get('clean.ts')!.lastModifiedMs).toBe(commitMs);
    expect(mtime('clean.ts')).toBeGreaterThan(commitMs);
    // Churn is still commit-derived: the edit is not a commit.
    expect(stats.get('edited.ts')!.churnScore).toBe(1);
  });

  it('maps status paths to a SUBDIRECTORY root like the log keys', () => {
    const stats = mineGitStats(path.join(dirty, 'pkg'));
    expect([...stats.keys()]).toEqual(['sub/deep.ts']);
    expect(stats.get('sub/deep.ts')!.lastModifiedMs).toBe(
      fs.statSync(path.join(dirty, 'pkg', 'sub', 'deep.ts')).mtimeMs,
    );
  });
});

describe('mineGitStats — a hostile .git/config never runs a command (EMIT-ADV-1)', () => {
  /* analyze shells git inside checkouts we did not create, and an archive
     keeps its .git/config and .git/info/attributes. Each key below is a shell
     command git runs on its own: core.fsmonitor and filter.<driver>.clean /
     .process during `git status` (a stat-dirty file goes through its clean
     filter), gpg.program during `git log` when log.showSignature is on, and a
     promisor remote's upload-pack when a partial clone lazily fetches. */
  const DAY = 24 * 60 * 60 * 1000;
  const editedMs = Date.now() - DAY;
  const commitMs = Math.floor((Date.now() - 10 * DAY) / 1000) * 1000;
  const posix = (p: string): string => p.replace(/\\/g, '/');
  let hits = '';
  const hit = (name: string): string => path.join(hits, `${name}.hit`);
  const touchHit = (name: string): string => `touch '${posix(hit(name))}'`;
  const fired = (...names: string[]): string[] => names.filter((n) => fs.existsSync(hit(n)));
  const tmpRepo = (tag: string): string =>
    fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `fs-node-${tag}-`)));
  const commitAt = (cwd: string, at: number): void => {
    const d = new Date(at).toISOString();
    const r = spawnSync('git', ['commit', '-q', '-m', 'init'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...ENV, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d },
    });
    if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  };
  /** Same size, new content: only a content check (the clean filter) can tell. */
  const edit = (repo: string, rel: string): void => {
    const p = path.join(repo, rel);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('v =', 'w ='));
    fs.utimesSync(p, editedMs / 1000, editedMs / 1000);
  };
  /** Rewrite HEAD with a (bogus) gpgsig header, so showSignature verifies it. */
  const fakeSign = (repo: string): void => {
    const run = (args: string[], input?: string): string => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: ENV, input });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    const [head, ...msg] = run(['cat-file', 'commit', 'HEAD']).split('\n\n');
    const sig =
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAd\n -----END PGP SIGNATURE-----';
    const oid = run(
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      `${head}\n${sig}\n\n${msg.join('\n\n')}`,
    );
    run(['update-ref', 'HEAD', oid.trim()]);
  };
  const gitVersion = ((): number[] => {
    const m = /(\d+)\.(\d+)/.exec(spawnSync('git', ['version'], { encoding: 'utf8' }).stdout ?? '');
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  })();
  // GIT_NO_LAZY_FETCH arrived in git 2.44; older git has no off switch.
  const hasNoLazyFetch = gitVersion[0]! > 2 || (gitVersion[0] === 2 && gitVersion[1]! >= 44);

  const repos: string[] = [];
  beforeAll(() => {
    hits = tmpRepo('hits');
  });
  afterAll(() => {
    for (const d of [hits, ...repos]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('runs no command from core.fsmonitor, a filter driver or gpg.program', () => {
    const evil = tmpRepo('evil');
    repos.push(evil);
    git(evil, 'init', '-q');
    for (const f of ['clean.ts', 'a.ts', 'b.md'])
      write(path.join(evil, f), `export const v = 1;\n`);
    git(evil, 'add', '-A');
    commitAt(evil, commitMs);
    fakeSign(evil);
    git(evil, 'config', 'core.fsmonitor', `${touchHit('fsmonitor')}; true`);
    git(evil, 'config', 'filter.evil.clean', `${touchHit('clean')}; cat`);
    git(evil, 'config', 'filter.evil.required', 'true');
    git(evil, 'config', 'filter.evil2.process', `sh -c "${touchHit('process')}; exit 1"`);
    git(evil, 'config', 'log.showSignature', 'true');
    const gpg = path.join(hits, 'fake-gpg.sh');
    fs.writeFileSync(gpg, `#!/bin/sh\n${touchHit('gpg')}\nexit 1\n`);
    fs.chmodSync(gpg, 0o755);
    git(evil, 'config', 'gpg.program', posix(gpg));
    fs.writeFileSync(
      path.join(evil, '.git', 'info', 'attributes'),
      '*.ts filter=evil\n*.md filter=evil2\n',
    );
    edit(evil, 'a.ts');
    edit(evil, 'b.md');

    const stats = mineGitStats(evil);
    expect(fired('fsmonitor', 'clean', 'process', 'gpg')).toEqual([]);
    // ...and the status pass still ran: dirty files carry their real mtime.
    const mtime = (rel: string): number => fs.statSync(path.join(evil, rel)).mtimeMs;
    expect(stats.get('a.ts')!.lastModifiedMs).toBe(mtime('a.ts'));
    expect(stats.get('b.md')!.lastModifiedMs).toBe(mtime('b.md'));
    expect(stats.get('clean.ts')!.lastModifiedMs).toBe(commitMs);
  });

  it('skips the status pass when a filter driver cannot be disarmed', () => {
    /* `-c` splits at the first '=', so a driver named `a=b` cannot be
       overridden. The pass fails closed: commit times stand, nothing runs. */
    const evil = tmpRepo('evil-eq');
    repos.push(evil);
    git(evil, 'init', '-q');
    write(path.join(evil, 'a.ts'), 'export const v = 1;\n');
    git(evil, 'add', '-A');
    commitAt(evil, commitMs);
    git(evil, 'config', 'filter.a=b.clean', `${touchHit('eq')}; cat`);
    fs.writeFileSync(path.join(evil, '.git', 'info', 'attributes'), '*.ts filter=a=b\n');
    edit(evil, 'a.ts');

    const stats = mineGitStats(evil);
    expect(fired('eq')).toEqual([]);
    expect(stats.get('a.ts')!.lastModifiedMs).toBe(commitMs);
  });

  it("never recurses into a submodule, whose own config the overrides don't cover", () => {
    const sub = tmpRepo('sub-src');
    const top = tmpRepo('sub-top');
    repos.push(sub, top);
    git(sub, 'init', '-q');
    write(path.join(sub, 'x.ts'), 'export const v = 1;\n');
    git(sub, 'add', '-A');
    git(sub, 'commit', '-q', '-m', 'sub');
    git(top, 'init', '-q');
    write(path.join(top, 'a.ts'), 'export const v = 1;\n');
    git(top, 'add', '-A');
    commitAt(top, commitMs);
    git(top, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', posix(sub), 'mod');
    commitAt(top, commitMs + 1000);
    const mod = path.join(top, 'mod');
    git(mod, 'config', 'filter.evil.clean', `${touchHit('submodule')}; cat`);
    const modGit = path.join(top, '.git', 'modules', 'mod', 'info');
    fs.mkdirSync(modGit, { recursive: true });
    fs.writeFileSync(path.join(modGit, 'attributes'), '* filter=evil\n');
    edit(mod, 'x.ts');
    edit(top, 'a.ts');

    const stats = mineGitStats(top);
    expect(fired('submodule')).toEqual([]);
    expect(stats.get('a.ts')!.lastModifiedMs).toBe(fs.statSync(path.join(top, 'a.ts')).mtimeMs);
  });

  it.skipIf(!hasNoLazyFetch)(
    'never lazily fetches from a promisor remote (INV6), so its upload-pack never runs',
    () => {
      const src = tmpRepo('promisor-src');
      const parent = tmpRepo('promisor-clone');
      repos.push(src, parent);
      git(src, 'init', '-q');
      write(path.join(src, 'd', 'a.ts'), 'export const v = 1;\n');
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', 'one');
      write(path.join(src, 'd', 'b.ts'), 'export const v = 2;\n');
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', 'two');
      git(src, 'config', 'uploadpack.allowFilter', 'true');
      // A treeless clone: every tree `git log --name-only` needs is missing.
      git(parent, 'clone', '-q', '--no-checkout', '--filter=tree:0', `file://${posix(src)}`, 'c');
      const clone = path.join(parent, 'c');
      git(
        clone,
        'config',
        'remote.origin.uploadpack',
        `${touchHit('uploadpack')}; git-upload-pack`,
      );

      mineGitStats(clone);
      expect(fired('uploadpack')).toEqual([]);
    },
  );
});

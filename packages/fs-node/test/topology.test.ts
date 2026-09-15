/**
 * mineGitTopology — end-to-end against a throwaway repo: a bare origin,
 * a main checkout, a linked worktree with unique + dirty work, a merged
 * branch, and synthetic Claude Code / Codex transcripts in a fake home
 * dir. Everything is created under os.tmpdir() and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mineGitTopology } from '../src/topology.js';
import { repoDisplayName } from '../src/repo-name.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fs-node test',
  GIT_AUTHOR_EMAIL: 'test@factstack.invalid',
  GIT_COMMITTER_NAME: 'fs-node test',
  GIT_COMMITTER_EMAIL: 'test@factstack.invalid',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (p: string, body: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const norm = (p: string): string => p.replace(/\\/g, '/');
/** Mirrors Claude Code's project-dir slug (every non-alphanumeric → `-`). */
const slugOf = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');

let tmp = '';
let repo = '';
let wt = '';
let home = '';
const NOW = Date.parse('2026-01-10T00:00:00Z');

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-node-topology-')));
  repo = path.join(tmp, 'repo');
  const origin = path.join(tmp, 'origin.git');
  home = path.join(tmp, 'home');
  fs.mkdirSync(repo, { recursive: true });

  // main checkout with a bare origin; the linked-worktree slot dir is ignored
  git(repo, 'init');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write(path.join(repo, 'README.md'), '# fixture\n');
  write(path.join(repo, '.gitignore'), '.claude/worktrees/\n');
  write(path.join(repo, 'package.json'), '{"name":"fixture","scripts":{"test":"vitest run"}}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: init');
  git(tmp, 'init', '-q', '--bare', 'origin.git');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin'); // creates FETCH_HEAD → remote refs are fresh
  git(repo, 'branch', 'old'); // same commit as main → contained in origin/main, deletable

  // linked worktree carrying one unique commit + staged + untracked work
  wt = path.join(repo, '.claude', 'worktrees', 'feature-x');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  write(path.join(wt, 'src', 'x.ts'), 'export const x = 1;\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'feat(x): add the x panel');
  write(path.join(wt, 'staged.txt'), 'staged\n');
  git(wt, 'add', 'staged.txt');
  write(path.join(wt, 'untracked.txt'), 'untracked\n');

  // synthetic transcripts: a Claude Code session in the worktree, a Codex session in the main checkout
  const claudeDir = path.join(home, '.claude', 'projects', slugOf(wt));
  write(
    path.join(claudeDir, 'abcdef12-3456-7890-abcd-ef1234567890.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        cwd: wt,
        timestamp: '2020-01-02T03:04:05.000Z',
        message: { role: 'user', content: '<command-name>/status</command-name>' },
      }),
      JSON.stringify({
        type: 'user',
        cwd: wt,
        timestamp: '2020-01-02T03:05:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'build the x panel please. Then test it.' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2020-01-02T03:06:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      }),
      JSON.stringify({ type: 'summary', summary: 'X panel build', leafUuid: 'x' }),
    ].join('\n') + '\n',
  );
  write(
    path.join(
      home,
      '.codex',
      'sessions',
      '2020',
      '01',
      '03',
      'rollout-2020-01-03T10-00-00-aaaa.jsonl',
    ),
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2020-01-03T10:00:00.000Z',
        payload: { id: 'codex-1', cwd: repo },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2020-01-03T10:00:05.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'add a README badge, token sk-abcdefghijklmnop please' },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2020-01-03T10:01:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      }),
    ].join('\n') + '\n',
  );
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('mineGitTopology', () => {
  it('returns null outside a git working tree', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'plain-'));
    expect(mineGitTopology(dir, { homeDir: home, now: NOW })).toBeNull();
  });

  it('maps the main checkout, the linked worktree and every branch with readiness + request records', () => {
    const g = mineGitTopology(repo, { homeDir: home, now: NOW })!;
    expect(g).not.toBeNull();
    expect(g.repoRoot).toBe(norm(repo));
    expect(g.defaultBranch).toBe('main');
    expect(g.originDefault).toBe('origin/main');
    expect(g.remotes.map((r) => r.name)).toEqual(['origin']);
    expect(g.remoteRefsAgeDays).not.toBeNull();
    expect(g.requestsCoverage).toBe('full');
    expect(g.gaps).toEqual([]);
    expect(g.stashes).toBe(0);

    expect(g.worktrees).toHaveLength(2);
    const [main, linked] = g.worktrees;

    // main checkout: pushed, clean, nothing to commit; the Codex session ran here
    expect(main!.kind).toBe('main');
    expect(main!.isCurrent).toBe(true);
    expect(main!.relPath).toBe('.');
    expect(main!.branch).toBe('main');
    expect(main!.integration).toBe('default');
    expect(main!.publish).toBe('pushed');
    expect(main!.tree).toBe('clean');
    expect(main!.uniqueCount).toBe(0);
    expect(main!.readiness.commit).toBe('nothing');
    expect(main!.readiness.deploy).toBe('no-target'); // clean + pushed + default, but no deploy config
    expect(main!.testScript).toBe(true);
    expect(main!.sessions).toBe(1);
    expect(main!.requests[0]!.agent).toBe('codex');
    expect(main!.requests[0]!.prompt).toContain('<redacted>');
    expect(main!.requests[0]!.prompt).not.toContain('sk-abc');
    expect(main!.requestedAt).toBe('2020-01-03T10:00:05Z');
    expect(main!.gaps).toEqual(['no-deploy-config', 'no-ci']);

    // linked worktree: one unique commit, partly staged, asked for in a Claude Code session
    expect(linked!.kind).toBe('linked');
    expect(linked!.relPath).toBe('.claude/worktrees/feature-x');
    expect(linked!.branch).toBe('feat/x');
    expect(linked!.integration).toBe('unmerged');
    expect(linked!.publish).toBe('no-upstream');
    expect(linked!.compareBase).toBe('refs/heads/main');
    expect(linked!.uniqueCount).toBe(1);
    expect(linked!.uniqueCommits[0]!.subject).toBe('feat(x): add the x panel');
    expect(linked!.dirty).toEqual({ staged: 1, modified: 0, untracked: 1, conflicts: 0 });
    expect(linked!.tree).toBe('dirty');
    expect(linked!.readiness.commit).toBe('partial');
    expect(linked!.readiness.commitReasons).toEqual(['1 file staged', '1 untracked file']);
    expect(linked!.readiness.deploy).toBe('blocked');
    expect(linked!.readiness.deployReasons[0]).toBe('commit or discard 2 changes first');
    expect(linked!.requests).toHaveLength(1);
    expect(linked!.requests[0]).toMatchObject({
      agent: 'claude-code',
      sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
      startedAt: '2020-01-02T03:05:00Z',
      prompt: 'build the x panel please. Then test it.',
      title: 'X panel build',
      via: 'cwd',
    });
    expect(linked!.requestedAt).toBe('2020-01-02T03:05:00Z'); // the request predates the commit
    expect(linked!.features.map((f) => f.source)).toEqual(['commit', 'request', 'branch']);
    expect(linked!.features[0]!.label).toBe('x: add the x panel');
    expect(linked!.features[1]!.label).toBe('build the x panel please.');
    expect(linked!.features[2]!.label).toBe('x');
    expect(linked!.stale).toBe(false);
    expect(linked!.gaps).toEqual(['no-upstream', 'no-deploy-config', 'no-ci', 'untracked-work']);

    // branches: the merged `old` branch is the only deletable one
    const byName = new Map(g.branches.map((b) => [b.name, b]));
    expect([...byName.keys()].sort()).toEqual(['feat/x', 'main', 'old']);
    expect(byName.get('main')).toMatchObject({
      isDefault: true,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      containedInOrigin: true,
      deletable: false,
    });
    expect(byName.get('old')).toMatchObject({
      containedInOrigin: true,
      containedInLocal: true,
      worktree: null,
      deletable: true,
      deleteBlockers: [],
    });
    const fx = byName.get('feat/x')!;
    expect(fx.containedInOrigin).toBe(false);
    expect(fx.uniqueCount).toBe(1);
    expect(fx.worktree).toBe(norm(wt));
    expect(fx.deletable).toBe(false);
    expect(fx.deleteBlockers).toEqual([
      'checked out at .claude/worktrees/feature-x',
      '1 commit not in origin/main',
    ]);
  });

  it('runs from inside the linked worktree and marks it current', () => {
    const g = mineGitTopology(wt, { homeDir: home, now: NOW, agentRequests: false })!;
    expect(g.currentPath).toBe(norm(wt));
    const cur = g.worktrees.find((w) => w.isCurrent)!;
    expect(cur.branch).toBe('feat/x');
    expect(cur.kind).toBe('linked');
  });

  it('honours agentRequests:false and reports it as a gap', () => {
    const g = mineGitTopology(repo, { homeDir: home, now: NOW, agentRequests: false })!;
    expect(g.requestsCoverage).toBe('disabled');
    expect(g.gaps).toContain('requests-disabled');
    expect(g.worktrees.every((w) => w.sessions === 0 && w.requests.length === 0)).toBe(true);
    expect(g.worktrees[1]!.gaps).not.toContain('no-request-record');
    // request dates fall back to the oldest unique commit
    expect(g.worktrees[1]!.requestedAt).toBe(g.worktrees[1]!.uniqueCommits.at(-1)!.at);
  });

  it('flags no-request-record when no transcript matches and stale when nothing moved for 90 days', () => {
    const emptyHome = fs.mkdtempSync(path.join(tmp, 'home-empty-'));
    fs.mkdirSync(path.join(emptyHome, '.claude', 'projects'), { recursive: true });
    const g = mineGitTopology(repo, {
      homeDir: emptyHome,
      now: Date.parse('2030-01-01T00:00:00Z'),
    })!;
    expect(g.requestsCoverage).toBe('full');
    expect(g.worktrees[0]!.gaps).toContain('no-request-record');
    expect(g.worktrees.every((w) => w.stale)).toBe(true);
  });

  /* ── review regressions (2026-09-06) ────────────────────────────────── */

  it('does not claim sessions from another repo that reuses a worktree slot name', () => {
    /* `feature-x` is not a unique name. A second repo with the same slot must
       never contribute its prompts here — that would put someone else's
       private request text into this repo's artifacts. */
    const other = path.join(tmp, 'other-repo');
    const otherWt = path.join(other, '.claude', 'worktrees', 'feature-x');
    fs.mkdirSync(otherWt, { recursive: true });
    const foreignHome = fs.mkdtempSync(path.join(tmp, 'home-foreign-'));
    write(
      path.join(
        foreignHome,
        '.claude',
        'projects',
        slugOf(otherWt),
        'ffffffff-0000-0000-0000-000000000000.jsonl',
      ),
      JSON.stringify({
        type: 'user',
        cwd: otherWt,
        timestamp: '2020-02-02T02:02:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'refactor the OTHER project billing module' }],
        },
      }) + '\n',
    );
    const g = mineGitTopology(repo, { homeDir: foreignHome, now: NOW })!;
    expect(g.worktrees.every((w) => w.sessions === 0)).toBe(true);
    expect(JSON.stringify(g)).not.toContain('billing module');
    expect(g.worktrees[1]!.gaps).toContain('no-request-record');
  });

  it("never lets a nested repo's git config execute a command", () => {
    /* `git status` runs core.fsmonitor as a shell command straight from the
       repo's own .git/config, and we shell git INTO nested repos we do not
       own. SAFE_GIT_ARGS must make that inert. */
    const host = path.join(tmp, 'fsmonitor-host');
    fs.mkdirSync(host, { recursive: true });
    git(host, 'init');
    write(path.join(host, 'a.ts'), 'export const a = 1;\n');
    git(host, 'add', '-A');
    git(host, 'commit', '-q', '-m', 'chore: host');
    const evil = path.join(host, 'examples', 'evil');
    fs.mkdirSync(evil, { recursive: true });
    git(evil, 'init');
    write(path.join(evil, 'b.ts'), 'export const b = 2;\n');
    git(evil, 'add', '-A');
    git(evil, 'commit', '-q', '-m', 'chore: nested');
    const marker = path.join(tmp, 'fsmonitor-marker.txt');
    git(
      evil,
      'config',
      'core.fsmonitor',
      `${process.platform === 'win32' ? 'cmd /c echo HIT >>' : 'sh -c "echo HIT >>'} ${marker}${process.platform === 'win32' ? '' : '"'}`,
    );

    const g = mineGitTopology(host, { homeDir: home, now: NOW, agentRequests: false })!;
    expect(g.worktrees.some((w) => w.kind === 'nested')).toBe(true); // the nested repo WAS probed
    expect(fs.existsSync(marker)).toBe(false); // ...but its config never ran
  });

  it('keeps the remote default branch when it does not exist locally', () => {
    /* A clone whose default is `master` plus a local-only `main` used to elect
       `main` as the default and measure every verdict against the wrong line. */
    const src = path.join(tmp, 'md-origin.git');
    const work = path.join(tmp, 'md-work');
    fs.mkdirSync(work, { recursive: true });
    git(work, 'init', '-b', 'master');
    write(path.join(work, 'r.md'), '# r\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'chore: init');
    git(tmp, 'init', '-q', '--bare', 'md-origin.git');
    git(work, 'remote', 'add', 'origin', src);
    git(work, 'push', '-q', '-u', 'origin', 'master');
    git(work, 'remote', 'set-head', 'origin', 'master');
    git(work, 'branch', '-m', 'master', 'main'); // local default renamed away; origin still says master
    const g = mineGitTopology(work, { homeDir: home, now: NOW, agentRequests: false })!;
    expect(g.defaultBranch).toBe('master');
    expect(g.originDefault).toBe('origin/master');
    expect(g.worktrees[0]!.compareBase).toBe('refs/remotes/origin/master');
  });

  it('calls a merge with its conflicts resolved and staged ready to commit', () => {
    const mr = path.join(tmp, 'merge-ready');
    fs.mkdirSync(mr, { recursive: true });
    git(mr, 'init', '-b', 'main');
    write(path.join(mr, 'f.txt'), 'base\n');
    git(mr, 'add', '-A');
    git(mr, 'commit', '-q', '-m', 'chore: base');
    git(mr, 'checkout', '-q', '-b', 'side');
    write(path.join(mr, 'f.txt'), 'side\n');
    git(mr, 'commit', '-q', '-am', 'feat: side');
    git(mr, 'checkout', '-q', 'main');
    write(path.join(mr, 'f.txt'), 'main\n');
    git(mr, 'commit', '-q', '-am', 'feat: main');
    spawnSync('git', ['merge', 'side'], { cwd: mr, encoding: 'utf8', env: ENV, windowsHide: true }); // conflicts
    write(path.join(mr, 'f.txt'), 'resolved\n');
    git(mr, 'add', 'f.txt'); // resolved + staged: `git commit` is what finishes the merge
    const g = mineGitTopology(mr, { homeDir: home, now: NOW, agentRequests: false })!;
    const w = g.worktrees[0]!;
    expect(w.inProgress).toBe('merge');
    expect(w.dirty.conflicts).toBe(0);
    expect(w.readiness.commit).toBe('ready');
    expect(w.readiness.commitReasons[0]).toContain('git commit');
  });

  it("decodes git's C-quoted lock reason", () => {
    const lockRepo = path.join(tmp, 'locked');
    fs.mkdirSync(lockRepo, { recursive: true });
    git(lockRepo, 'init', '-b', 'main');
    write(path.join(lockRepo, 'x.txt'), 'x\n');
    git(lockRepo, 'add', '-A');
    git(lockRepo, 'commit', '-q', '-m', 'chore: init');
    const lockedWt = path.join(lockRepo, 'wt-locked');
    git(lockRepo, 'worktree', 'add', '-q', '-b', 'held', lockedWt);
    git(lockRepo, 'worktree', 'lock', '--reason', 'café break', lockedWt);
    const g = mineGitTopology(lockRepo, { homeDir: home, now: NOW, agentRequests: false })!;
    const locked = g.worktrees.find((w) => w.branch === 'held')!;
    expect(locked.locked).toBe(true);
    expect(locked.lockReason).toBe('café break');
  });
  /* ── review follow-ups (2026-09-07) ───────────────────────── */

  it("redacts every credential format the repo's own scanner knows", () => {
    /* Prompts persist into agent.json / agent.pack / MEMORY.md. The format
       list mirrors packages/scanners/src/secrets.ts — keep both in step.
       Every value is assembled from two pieces so the SOURCE never contains a
       provider token shape: GitHub push protection rejects a push that adds
       one (it blocked this file's Stripe sample once), and this repo's own
       scanner would list it. The runtime strings are unchanged. */
    const secrets = [
      'sk' + '-abcdefghijklmnopqrstuvwx', // OpenAI
      'sk-ant' + '-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', // Anthropic
      'sk_' + 'live_abcdefghijklmnopqrstuvwx', // Stripe
      'AIza' + 'SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q', // Google
      'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789', // GitHub
      'github' + '_pat_11ABCDEFG0abcdefghijklmnop', // GitHub PAT
      'npm' + '_abcdefghijklmnopqrstuvwxyz0123456789', // npm
      'AKIA' + 'IOSFODNN7EXAMPLE', // AWS key id
      'xoxb' + '-123456789012-abcdefghijkl', // Slack
      'eyJhbGciOiJIUzI1NiJ9' +
        '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', // JWT
      'password: hunter2hunter2', // key=value
    ];
    const secretHome = fs.mkdtempSync(path.join(tmp, 'home-secrets-'));
    write(
      path.join(
        secretHome,
        '.claude',
        'projects',
        slugOf(wt),
        'aaaaaaaa-1111-2222-3333-444444444444.jsonl',
      ),
      JSON.stringify({
        type: 'user',
        cwd: wt,
        timestamp: '2020-03-03T03:03:03.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'ship it with ' + secrets.join(' and ') }],
        },
      }) + '\n',
    );
    const g = mineGitTopology(repo, { homeDir: secretHome, now: NOW })!;
    const blob = JSON.stringify(g);
    for (const secret of secrets) {
      const body = secret.includes(': ') ? secret.split(': ')[1]! : secret;
      expect(blob).not.toContain(body);
    }
    expect(blob).toContain('<redacted>');
  });

  it('honours FACTSTACK_NO_AGENT_REQUESTS for adapters that pass no flag', () => {
    /* The MCP server, the ui watcher and open call the collector with no
       option of their own; without an env switch there was no way to opt
       out of transcript reading on those paths. */
    const prev = process.env.FACTSTACK_NO_AGENT_REQUESTS;
    try {
      process.env.FACTSTACK_NO_AGENT_REQUESTS = '1';
      const off = mineGitTopology(repo, { homeDir: home, now: NOW })!;
      expect(off.requestsCoverage).toBe('disabled');
      expect(off.gaps).toContain('requests-disabled');
      // An explicit opt-in still wins over the env var.
      const on = mineGitTopology(repo, { homeDir: home, now: NOW, agentRequests: true })!;
      expect(on.requestsCoverage).toBe('full');
    } finally {
      if (prev === undefined) delete process.env.FACTSTACK_NO_AGENT_REQUESTS;
      else process.env.FACTSTACK_NO_AGENT_REQUESTS = prev;
    }
  });

  it('reports a nested repo as external and never judges it against this repo', () => {
    const host = path.join(tmp, 'nested-host');
    fs.mkdirSync(path.join(host, 'examples', 'sample'), { recursive: true });
    git(host, 'init', '-b', 'main');
    write(path.join(host, 'h.ts'), 'export const h = 1;\n');
    git(host, 'add', '-A');
    git(host, 'commit', '-q', '-m', 'chore: host');
    const nested = path.join(host, 'examples', 'sample');
    git(nested, 'init', '-b', 'dev');
    write(path.join(nested, 'n.ts'), 'export const n = 2;\n');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-q', '-m', 'chore: nested');

    const g = mineGitTopology(host, { homeDir: home, now: NOW, agentRequests: false })!;
    const inner = g.worktrees.find((w) => w.kind === 'nested')!;
    expect(inner.relPath).toBe('examples/sample');
    expect(inner.branch).toBe('dev');
    expect(inner.integration).toBe('external');
    expect(inner.readiness.deploy).toBe('unknown');
    expect(inner.readiness.deployReasons[0]).toContain('separate repo');
    // A nested repo's branch is not offered as a feature of THIS repo.
    expect(inner.features.some((f) => f.source === 'branch')).toBe(false);
  });

  it('includes a linked worktree that lives outside the repo root', () => {
    const outside = path.join(tmp, 'outside-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'out', outside);
    try {
      const g = mineGitTopology(repo, { homeDir: home, now: NOW, agentRequests: false })!;
      const out = g.worktrees.find((w) => w.branch === 'out')!;
      expect(out.kind).toBe('linked');
      expect(out.relPath).toBeNull(); // outside the root: no relative form
      expect(out.path).toBe(norm(outside));
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', outside], {
        cwd: repo,
        encoding: 'utf8',
        env: ENV,
        windowsHide: true,
      });
    }
  });

  it('caps per-branch git work and reports uncounted branches as null, never 0', () => {
    const many = path.join(tmp, 'many-branches');
    fs.mkdirSync(many, { recursive: true });
    git(many, 'init', '-b', 'main');
    write(path.join(many, 'm.txt'), 'm\n');
    git(many, 'add', '-A');
    git(many, 'commit', '-q', '-m', 'chore: base');
    for (let i = 0; i < 8; i++) git(many, 'branch', 'b' + i);
    const g = mineGitTopology(many, {
      homeDir: home,
      now: NOW,
      agentRequests: false,
      maxBranches: 3,
    })!;
    expect(g.branches.filter((b) => b.uniqueCount !== null)).toHaveLength(3);
    expect(g.branches.filter((b) => b.uniqueCount === null).length).toBeGreaterThan(0);
    expect(g.branches).toHaveLength(9); // nothing dropped, only uncounted
  });

  it('strips credentials from a remote URL', () => {
    const creds = path.join(tmp, 'creds-remote');
    fs.mkdirSync(creds, { recursive: true });
    git(creds, 'init', '-b', 'main');
    write(path.join(creds, 'c.txt'), 'c\n');
    git(creds, 'add', '-A');
    git(creds, 'commit', '-q', '-m', 'chore: init');
    git(
      creds,
      'remote',
      'add',
      'origin',
      'https://user:ghp' + '_supersecrettokenvalue@example.invalid/repo.git',
    );
    const g = mineGitTopology(creds, { homeDir: home, now: NOW, agentRequests: false })!;
    expect(g.remotes[0]!.url).toBe('https://<redacted>@example.invalid/repo.git');
    expect(JSON.stringify(g)).not.toContain('ghp' + '_supersecrettokenvalue');
  });
  it('names the project after the main checkout, even from a linked worktree', () => {
    expect(repoDisplayName(repo)).toBe('repo');
    expect(repoDisplayName(wt)).toBe('repo'); // not 'feature-x'
    const plain = fs.mkdtempSync(path.join(tmp, 'plain-name-'));
    expect(repoDisplayName(plain)).toBe(path.basename(plain)); // no git: the folder name
  });
});
